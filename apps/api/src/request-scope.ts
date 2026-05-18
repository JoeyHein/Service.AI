/**
 * RequestScope Fastify plugin (corporate hub model — CHR phase).
 *
 * Decorates every request with `request.scope` — a discriminated-union
 * description of "which slice of the tenant tree this call is allowed to
 * touch". Resolved from:
 *   1. Better Auth session (userId)
 *   2. Memberships of that user (returned by the injected MembershipResolver)
 *
 * The corporate hub model is gone. Corporate sees every branch
 * natively; there is no impersonation flow. Branch-scoped users
 * (manager / dispatcher / tech / csr) are pinned to a single branch and
 * cannot read sibling-branch data even with a forged request body — RLS
 * enforces the same `branch_id` filter that the route handlers do.
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
import type { RequestScope, BranchRole } from '@service-ai/db';

/**
 * Minimal shape of a resolved membership for scope picking. A user with no
 * memberships is treated as authenticated-but-unscoped: they can hit
 * /api/v1/me to see their profile but not any tenant-scoped data.
 *
 * `scopeType` retains the literal 'corporate' / 'branch' values so the
 * resolver can pattern-match without inspecting `role`. Legacy enum values
 * (`platform_admin`, `franchisor_admin`, `franchisee_owner`,
 * `location_manager`) are accepted as legacy aliases and promoted to their
 * corporate-model equivalent — keeps the plugin tolerant of partially-
 * migrated rows in test fixtures.
 */
export interface MembershipRow {
  scopeType: 'corporate' | 'branch';
  role:
    | 'corporate_admin'
    | 'manager'
    | 'dispatcher'
    | 'tech'
    | 'csr'
    // Legacy enum values (still present in the SQL enum after CHR-01);
    // resolveScope() promotes them to corporate_admin or manager.
    | 'platform_admin'
    | 'franchisor_admin'
    | 'franchisee_owner'
    | 'location_manager';
  branchId: string | null;
}

export interface MembershipResolver {
  /** Return every ACTIVE membership (deleted_at IS NULL) for the given user. */
  memberships(userId: string): Promise<MembershipRow[]>;
}

/**
 * Writes one row to the audit_log. Injected so tests observe writes without
 * hitting Postgres and production wires a DB-backed implementation. Most
 * routes log via this writer; the plugin itself does not write impersonation
 * audit rows any more because impersonation is gone.
 */
export interface AuditLogWriter {
  write(entry: AuditLogEntry): Promise<void>;
}

export interface AuditLogEntry {
  actorUserId: string;
  targetBranchId: string | null;
  action: string;
  scopeType: 'corporate' | 'branch' | null;
  scopeId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface RequestScopeOptions {
  auth: Auth;
  membershipResolver: MembershipResolver;
  /**
   * Optional audit writer. Retained for symmetry with the franchise-era
   * plugin shape so consumers can pass an injector without conditional
   * wiring. The plugin itself no longer writes audit rows — handlers do.
   */
  auditWriter?: AuditLogWriter;
}

/**
 * Backwards-compat: ImpersonationContext is still exported as a no-op type
 * so consumers that imported it from this module keep compiling during the
 * CHR-02 -> CHR-03 transition. The decorator on FastifyRequest is no longer
 * populated; CHR-03 removes the alias once every consumer has been swept.
 *
 * @deprecated impersonation is removed in the corporate model. Removed in CHR-03.
 */
export interface ImpersonationContext {
  actorUserId: string;
  targetBranchId: string;
  targetBranchName?: string;
}

/**
 * Pick the strongest-privilege membership so downstream handlers always see
 * the most capable scope available. Corporate beats branch.
 *
 * Legacy role names are promoted: 'platform_admin' / 'franchisor_admin' ->
 * 'corporate_admin'; 'franchisee_owner' / 'location_manager' -> 'manager'.
 * This lets the plugin work against both freshly-migrated DBs (post-CHR-01,
 * where row values are still legacy) and against future seeds that use the
 * new enum values directly.
 */
export function resolveScope(
  userId: string,
  memberships: MembershipRow[],
): RequestScope | null {
  const corporateRoles = new Set(['corporate_admin', 'platform_admin', 'franchisor_admin']);
  const corporate = memberships.find((m) => corporateRoles.has(m.role));
  if (corporate) {
    return { type: 'corporate', userId, role: 'corporate_admin' };
  }

  const branchRoleAliases: Record<string, BranchRole> = {
    manager: 'manager',
    franchisee_owner: 'manager',
    location_manager: 'manager',
    dispatcher: 'dispatcher',
    tech: 'tech',
    csr: 'csr',
  };
  const branch = memberships.find(
    (m) => m.branchId !== null && m.role in branchRoleAliases,
  );
  if (branch && branch.branchId) {
    return {
      type: 'branch',
      userId,
      role: branchRoleAliases[branch.role]!,
      branchId: branch.branchId,
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

type RequireScopeCode = 'UNAUTHENTICATED' | 'NO_ACTIVE_MEMBERSHIP';

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

const plugin: FastifyPluginAsync<RequestScopeOptions> = async (app, opts) => {
  const { auth, membershipResolver } = opts;

  app.decorateRequest<RequestScope | null>('scope', null);
  app.decorateRequest<string | null>('userId', null);
  // Legacy decorator retained for CHR-02 transition — always null under
  // the corporate model. CHR-03 removes it.
  app.decorateRequest<ImpersonationContext | null>('impersonation', null);

  app.addHook('preHandler', async (req) => {
    const headers = headersFromRequest(req);
    const session = await getSession(auth, headers);
    if (!session) return;
    req.userId = session.userId;
    const memberships = await membershipResolver.memberships(session.userId);
    req.scope = resolveScope(session.userId, memberships);
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
    /** @deprecated removed in CHR-03 — always null under the corporate model. */
    impersonation: ImpersonationContext | null;
    requireScope(): RequestScope;
  }
}

export const requestScopePlugin = fastifyPlugin(plugin, {
  name: 'request-scope',
  fastify: '5.x',
});
