/**
 * RequestScope Fastify plugin.
 *
 * Decorates every request with `request.scope` — a discriminated-union
 * description of "which slice of the tenant tree is this call allowed to
 * touch". Resolved from:
 *   1. Better Auth session (userId)
 *   2. Memberships of that user (returned by the injected MembershipResolver)
 *   3. Optional X-Impersonate-Franchisee header, validated against the
 *      caller's franchisor scope via the injected FranchiseeLookup
 *
 * When a valid impersonation is detected, the effective scope narrows to a
 * `franchisee` variant so Postgres RLS policies match on the target
 * franchisee. The original actor is preserved on `request.impersonation`
 * for the audit log and for the UI banner in later phases.
 *
 * Handlers that need a scope call `request.requireScope()`, which throws a
 * structured 401/403 when unauthenticated or when no active membership can
 * be resolved. Public routes (/healthz, /api/v1/me's unauth branch) use
 * `request.scope` directly and decide their own auth behaviour.
 *
 * This plugin does NOT itself set the Postgres GUCs. That is the job of
 * `withScope` from @service-ai/db, which takes the scope and wraps a
 * transaction. Route handlers opt in per-query.
 */
import fastifyPlugin from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Auth } from '@service-ai/auth';
import { getSession } from '@service-ai/auth';
import type { RequestScope, FranchiseeRole } from '@service-ai/db';

/**
 * Minimal shape of a resolved membership for scope picking. A user with no
 * memberships is treated as authenticated-but-unscoped: they can hit
 * /api/v1/me to see their profile but not any tenant-scoped data.
 */
export interface MembershipRow {
  scopeType: 'platform' | 'franchisor' | 'franchisee' | 'location';
  role:
    | 'platform_admin'
    | 'franchisor_admin'
    | 'franchisee_owner'
    | 'location_manager'
    | 'dispatcher'
    | 'tech'
    | 'csr';
  franchisorId: string | null;
  franchiseeId: string | null;
  locationId: string | null;
}

export interface MembershipResolver {
  /** Return every ACTIVE membership (deleted_at IS NULL) for the given user. */
  memberships(userId: string): Promise<MembershipRow[]>;
}

/**
 * Lookup a franchisee's parent franchisor. Returns null when the franchisee
 * id does not exist. Used during impersonation to verify the target belongs
 * to the acting franchisor.
 */
export interface FranchiseeLookup {
  franchisorIdFor(franchiseeId: string): Promise<string | null>;
}

/**
 * Writes one row to the audit_log. Injected so tests observe writes without
 * hitting Postgres and production wires a DB-backed implementation.
 */
export interface AuditLogWriter {
  write(entry: AuditLogEntry): Promise<void>;
}

export interface AuditLogEntry {
  actorUserId: string;
  targetFranchiseeId: string | null;
  action: string;
  scopeType: 'platform' | 'franchisor' | 'franchisee' | 'location' | null;
  scopeId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Metadata about an active impersonation. Attached to `request.impersonation`
 * when X-Impersonate-Franchisee has been validated. Route handlers and
 * audit writers read this to distinguish "franchisor admin acting directly"
 * from "franchisor admin acting as a franchisee".
 */
export interface ImpersonationContext {
  actorUserId: string;
  actorFranchisorId: string;
  targetFranchiseeId: string;
}

export interface RequestScopeOptions {
  auth: Auth;
  membershipResolver: MembershipResolver;
  /**
   * Validates impersonation targets. Required when X-Impersonate-Franchisee
   * is expected to be honoured; if omitted, the header is always rejected
   * with IMPERSONATION_DISABLED (suitable for test environments that never
   * exercise impersonation).
   */
  franchiseeLookup?: FranchiseeLookup;
  /** Writes audit_log rows for impersonated requests. Required iff franchiseeLookup is provided. */
  auditWriter?: AuditLogWriter;
}

export const IMPERSONATION_HEADER = 'x-impersonate-franchisee';

/**
 * Pick the strongest-privilege membership so downstream handlers always see
 * the most capable scope available. Ordering: platform_admin >
 * franchisor_admin > any franchisee-scoped role.
 */
export function resolveScope(
  userId: string,
  memberships: MembershipRow[],
): RequestScope | null {
  const platform = memberships.find((m) => m.role === 'platform_admin');
  if (platform) {
    return { type: 'platform', userId, role: 'platform_admin' };
  }

  const franchisor = memberships.find(
    (m) => m.role === 'franchisor_admin' && m.franchisorId,
  );
  if (franchisor && franchisor.franchisorId) {
    return {
      type: 'franchisor',
      userId,
      role: 'franchisor_admin',
      franchisorId: franchisor.franchisorId,
    };
  }

  const franchisee = memberships.find(
    (m) => m.franchiseeId !== null && m.franchisorId !== null,
  );
  if (franchisee && franchisee.franchisorId && franchisee.franchiseeId) {
    return {
      type: 'franchisee',
      userId,
      role: franchisee.role as FranchiseeRole,
      franchisorId: franchisee.franchisorId,
      franchiseeId: franchisee.franchiseeId,
      locationId: franchisee.locationId ?? null,
    };
  }

  return null;
}

function headersFromRequest(req: FastifyRequest): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) h.set(k, v.join(', '));
    else if (typeof v === 'string') h.set(k, v);
  }
  return h;
}

type RequireScopeCode =
  | 'UNAUTHENTICATED'
  | 'NO_ACTIVE_MEMBERSHIP'
  | 'IMPERSONATION_FORBIDDEN'
  | 'IMPERSONATION_INVALID_TARGET'
  | 'IMPERSONATION_DISABLED';

interface RequireScopeError extends Error {
  statusCode: number;
  code: RequireScopeCode;
}

function makeError(code: RequireScopeCode, message: string): RequireScopeError {
  const err = new Error(message) as RequireScopeError;
  err.statusCode = code === 'UNAUTHENTICATED' ? 401 : 403;
  err.code = code;
  return err;
}

function isValidUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Narrow a franchisor-admin scope to a specific franchisee target, preserving
 * the original actor's id and franchisor. Uses `franchisee_owner` as the
 * synthetic role so RLS policies match with full permissions at the target
 * franchisee — the actor's real franchisor_admin role is preserved via
 * request.impersonation for audit and UI banners.
 */
function narrowForImpersonation(
  base: Extract<RequestScope, { type: 'franchisor' }>,
  targetFranchiseeId: string,
): Extract<RequestScope, { type: 'franchisee' }> {
  return {
    type: 'franchisee',
    userId: base.userId,
    role: 'franchisee_owner',
    franchisorId: base.franchisorId,
    franchiseeId: targetFranchiseeId,
    locationId: null,
  };
}

const plugin: FastifyPluginAsync<RequestScopeOptions> = async (app, opts) => {
  const { auth, membershipResolver, franchiseeLookup, auditWriter } = opts;

  app.decorateRequest<RequestScope | null>('scope', null);
  app.decorateRequest<string | null>('userId', null);
  app.decorateRequest<ImpersonationContext | null>('impersonation', null);

  app.addHook('preHandler', async (req) => {
    const headers = headersFromRequest(req);
    const session = await getSession(auth, headers);
    if (!session) return;
    req.userId = session.userId;
    const memberships = await membershipResolver.memberships(session.userId);
    const baseScope = resolveScope(session.userId, memberships);
    req.scope = baseScope;

    const rawHeader = req.headers[IMPERSONATION_HEADER];
    const targetId = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (!targetId) return;

    if (!baseScope || baseScope.type !== 'franchisor') {
      throw makeError(
        'IMPERSONATION_FORBIDDEN',
        'Only franchisor admins may set X-Impersonate-Franchisee',
      );
    }
    if (!isValidUuid(targetId)) {
      throw makeError(
        'IMPERSONATION_INVALID_TARGET',
        'X-Impersonate-Franchisee must be a UUID',
      );
    }
    if (!franchiseeLookup) {
      throw makeError(
        'IMPERSONATION_DISABLED',
        'Impersonation is not configured for this environment',
      );
    }

    const parentFranchisorId = await franchiseeLookup.franchisorIdFor(targetId);
    if (parentFranchisorId === null) {
      throw makeError(
        'IMPERSONATION_INVALID_TARGET',
        'Target franchisee does not exist',
      );
    }
    if (parentFranchisorId !== baseScope.franchisorId) {
      throw makeError(
        'IMPERSONATION_FORBIDDEN',
        'Target franchisee does not belong to the acting franchisor',
      );
    }

    req.scope = narrowForImpersonation(baseScope, targetId);
    req.impersonation = {
      actorUserId: session.userId,
      actorFranchisorId: baseScope.franchisorId,
      targetFranchiseeId: targetId,
    };

    if (auditWriter) {
      await auditWriter.write({
        actorUserId: session.userId,
        targetFranchiseeId: targetId,
        action: 'impersonate.request',
        scopeType: 'franchisee',
        scopeId: targetId,
        metadata: {
          method: req.method,
          url: req.url,
          actorFranchisorId: baseScope.franchisorId,
        },
        ipAddress: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });
    }
  });

  app.decorateRequest(
    'requireScope',
    function requireScope(this: FastifyRequest): RequestScope {
      if (this.userId === null) {
        throw makeError('UNAUTHENTICATED', 'Valid session cookie required');
      }
      if (this.scope === null) {
        throw makeError(
          'NO_ACTIVE_MEMBERSHIP',
          'Authenticated user has no active membership',
        );
      }
      return this.scope;
    },
  );
};

declare module 'fastify' {
  interface FastifyRequest {
    scope: RequestScope | null;
    userId: string | null;
    impersonation: ImpersonationContext | null;
    requireScope(): RequestScope;
  }
}

export const requestScopePlugin = fastifyPlugin(plugin, {
  name: 'request-scope',
  fastify: '5.x',
});
