/**
 * Scaffolding tests for TASK-TEN-01 (Better Auth mount) + TASK-TEN-03
 * (requestScopePlugin + /api/v1/me scope population).
 *
 * Verifies:
 *   - /api/v1/me returns 401 with the structured error envelope when no
 *     session cookie is present.
 *   - /api/v1/me returns 200 + user id + resolved scope when a session and
 *     at least one membership exist.
 *   - /api/v1/me returns 200 + user id + scope=null when authenticated but
 *     without any active membership.
 *   - /api/auth/* is mounted when auth is provided and absent otherwise.
 *   - resolveScope picks platform_admin > franchisor_admin > franchisee.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { resolveScope, type MembershipRow } from '../request-scope.js';

const mockDb = {
  query: async (): Promise<unknown> => ({ rows: [{ '?column?': 1 }] }),
};
const mockRedis = { ping: async (): Promise<string> => 'PONG' };

function mockAuth(opts: {
  session?: { userId: string; sessionId: string } | null;
  handlerStatus?: number;
  handlerBody?: string;
} = {}) {
  return {
    api: {
      getSession: async () =>
        opts.session == null
          ? null
          : {
              session: { id: opts.session.sessionId },
              user: { id: opts.session.userId },
            },
    },
    handler: async () =>
      new Response(opts.handlerBody ?? '', {
        status: opts.handlerStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as import('@service-ai/auth').Auth;
}

function mockResolver(memberships: MembershipRow[]) {
  return { memberships: async () => memberships };
}

let app: FastifyInstance;

afterEach(async () => {
  if (app) await app.close();
});

describe('TASK-TEN-01 / /api/v1/me', () => {
  it('returns 401 with UNAUTHENTICATED when no session', async () => {
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth({ session: null }),
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 200 with scope=null when authenticated but unscoped', async () => {
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth({ session: { userId: 'user_123', sessionId: 'sess_abc' } }),
      membershipResolver: mockResolver([]),
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.user.id).toBe('user_123');
    expect(body.data.scope).toBeNull();
  });

  it('returns the strongest membership as the resolved scope', async () => {
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth({ session: { userId: 'user_123', sessionId: 'sess_abc' } }),
      membershipResolver: mockResolver([
        {
          scopeType: 'franchisee',
          role: 'dispatcher',
          franchisorId: '11111111-1111-1111-1111-111111111111',
          franchiseeId: '22222222-2222-2222-2222-222222222222',
          locationId: null,
        },
      ]),
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.scope.type).toBe('franchisee');
    expect(body.data.scope.role).toBe('dispatcher');
    expect(body.data.scope.franchiseeId).toBe(
      '22222222-2222-2222-2222-222222222222',
    );
  });

  it('is not mounted when auth is omitted (returns 404)', async () => {
    app = buildApp({ db: mockDb, redis: mockRedis, logger: false });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(404);
  });
});

describe('TASK-TEN-01 / /api/auth/* passthrough', () => {
  it('delegates to the Better Auth handler when auth is provided', async () => {
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth({
        handlerStatus: 200,
        handlerBody: JSON.stringify({ ok: true, handler: 'better-auth' }),
      }),
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('better-auth');
  });

  it('is absent when auth is not provided', async () => {
    app = buildApp({ db: mockDb, redis: mockRedis, logger: false });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('TASK-TEN-03 / resolveScope privilege ordering', () => {
  const FRANCHISOR = '11111111-1111-1111-1111-111111111111';
  const FRANCHISEE = '22222222-2222-2222-2222-222222222222';

  it('picks platform_admin over any other membership', () => {
    const scope = resolveScope('u', [
      {
        scopeType: 'franchisee',
        role: 'tech',
        franchisorId: FRANCHISOR,
        franchiseeId: FRANCHISEE,
        locationId: null,
      },
      {
        scopeType: 'platform',
        role: 'platform_admin',
        franchisorId: null,
        franchiseeId: null,
        locationId: null,
      },
    ]);
    expect(scope).toEqual({ type: 'platform', userId: 'u', role: 'platform_admin' });
  });

  it('picks franchisor_admin over franchisee-scoped roles', () => {
    const scope = resolveScope('u', [
      {
        scopeType: 'franchisee',
        role: 'tech',
        franchisorId: FRANCHISOR,
        franchiseeId: FRANCHISEE,
        locationId: null,
      },
      {
        scopeType: 'franchisor',
        role: 'franchisor_admin',
        franchisorId: FRANCHISOR,
        franchiseeId: null,
        locationId: null,
      },
    ]);
    expect(scope?.type).toBe('franchisor');
    expect(scope).toMatchObject({ role: 'franchisor_admin', franchisorId: FRANCHISOR });
  });

  it('returns null when memberships is empty', () => {
    expect(resolveScope('u', [])).toBeNull();
  });

  it('returns null when only scopeless memberships exist', () => {
    const scope = resolveScope('u', [
      {
        scopeType: 'franchisee',
        role: 'tech',
        franchisorId: null,
        franchiseeId: null,
        locationId: null,
      },
    ]);
    expect(scope).toBeNull();
  });
});
