/**
 * Scaffolding tests for TASK-TEN-01: Better Auth mount.
 *
 * Verifies:
 *   - /api/v1/me returns 401 with the structured error envelope when no
 *     session cookie is present.
 *   - /api/v1/me returns 200 + user id when a session resolves.
 *   - /api/auth/* is mounted when auth is provided and absent otherwise.
 *
 * The auth instance is mocked so these tests do not require Postgres. Real
 * Better Auth integration (sign-up → sign-in → sign-out round-trip) is
 * exercised by later tests that use the memory adapter.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';

const mockDb = {
  query: async (): Promise<unknown> => ({ rows: [{ '?column?': 1 }] }),
};
const mockRedis = { ping: async (): Promise<string> => 'PONG' };

// A minimal stand-in that satisfies the subset of `Auth` used by the mount.
// Cast through `unknown` because the real `Auth` type carries generics that
// aren't relevant to these scaffolding tests.
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

  it('returns 200 with the user id when a session resolves', async () => {
    app = buildApp({
      db: mockDb,
      redis: mockRedis,
      logger: false,
      auth: mockAuth({ session: { userId: 'user_123', sessionId: 'sess_abc' } }),
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.user.id).toBe('user_123');
    expect(body.data.scopes).toEqual([]);
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
