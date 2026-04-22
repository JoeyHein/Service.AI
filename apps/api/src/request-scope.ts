/**
 * RequestScope Fastify plugin.
 *
 * Decorates every request with `request.scope` — a discriminated-union
 * description of "which slice of the tenant tree is this call allowed to
 * touch". Resolved from:
 *   1. Better Auth session (userId)
 *   2. Memberships of that user (returned by the injected MembershipResolver)
 *   3. [TEN-04, deferred] X-Impersonate-Franchisee header validated against
 *      the caller's franchisor scope
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

export interface RequestScopeOptions {
  auth: Auth;
  membershipResolver: MembershipResolver;
}

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

interface RequireScopeError extends Error {
  statusCode: number;
  code: 'UNAUTHENTICATED' | 'NO_ACTIVE_MEMBERSHIP';
}

function makeError(
  code: RequireScopeError['code'],
  message: string,
): RequireScopeError {
  const err = new Error(message) as RequireScopeError;
  err.statusCode = code === 'UNAUTHENTICATED' ? 401 : 403;
  err.code = code;
  return err;
}

const plugin: FastifyPluginAsync<RequestScopeOptions> = async (app, opts) => {
  const { auth, membershipResolver } = opts;

  app.decorateRequest<RequestScope | null>('scope', null);
  app.decorateRequest<string | null>('userId', null);

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
    requireScope(): RequestScope;
  }
}

export const requestScopePlugin = fastifyPlugin(plugin, {
  name: 'request-scope',
  fastify: '5.x',
});
