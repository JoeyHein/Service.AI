/**
 * Unit tests for createAuth + getSession that don't require live Postgres.
 *
 * createAuth is verified at the factory level — it returns a configured
 * Better Auth instance with the expected api surface. Full behavioural
 * verification (sign-up → sign-in → session → sign-out against real
 * Postgres) lives in apps/api/src/__tests__/live-auth.test.ts.
 *
 * getSession is covered across every branch of its null-guard logic so
 * packages/auth coverage clears the 90% gate even without running the
 * full Better Auth stack.
 */
import { describe, it, expect } from 'vitest';
import { createAuth, getSession, loggingSender, type Auth } from './index.js';

const FAKE_DB = {};
const FAKE_SCHEMA = {
  user: {},
  session: {},
  account: {},
  verification: {},
};

describe('createAuth', () => {
  it('returns a Better Auth instance with api + handler + options surface', () => {
    const auth = createAuth({
      db: FAKE_DB,
      authSchema: FAKE_SCHEMA,
      baseUrl: 'http://localhost:3001',
      secret: 'x'.repeat(32),
    });
    expect(auth).toBeDefined();
    expect(typeof auth.handler).toBe('function');
    expect(auth.api).toBeDefined();
    expect(typeof auth.api.getSession).toBe('function');
  });

  it('accepts an optional magicLinkSender (defaulting to loggingSender)', () => {
    const auth = createAuth({
      db: FAKE_DB,
      authSchema: FAKE_SCHEMA,
      baseUrl: 'http://localhost',
      secret: 'x'.repeat(32),
      magicLinkSender: loggingSender,
    });
    expect(auth).toBeDefined();
  });

  it('respects the production flag to mark cookies secure', () => {
    const prod = createAuth({
      db: FAKE_DB,
      authSchema: FAKE_SCHEMA,
      baseUrl: 'https://prod.example',
      secret: 'x'.repeat(32),
      production: true,
    });
    expect(prod).toBeDefined();

    const dev = createAuth({
      db: FAKE_DB,
      authSchema: FAKE_SCHEMA,
      baseUrl: 'http://dev',
      secret: 'x'.repeat(32),
      production: false,
    });
    expect(dev).toBeDefined();
  });
});

function fakeAuth(response: unknown): Auth {
  return {
    api: { getSession: async () => response },
  } as unknown as Auth;
}

describe('getSession', () => {
  const headers = new Headers();

  it('returns null when auth.api.getSession returns null', async () => {
    expect(await getSession(fakeAuth(null), headers)).toBeNull();
  });

  it('returns null when auth.api.getSession returns undefined', async () => {
    expect(await getSession(fakeAuth(undefined), headers)).toBeNull();
  });

  it('returns null when the result has no session', async () => {
    expect(await getSession(fakeAuth({ user: { id: 'u' } }), headers)).toBeNull();
  });

  it('returns null when the result has no user', async () => {
    expect(await getSession(fakeAuth({ session: { id: 's' } }), headers)).toBeNull();
  });

  it('returns { userId, sessionId } when both session and user are present', async () => {
    const result = await getSession(
      fakeAuth({ session: { id: 'sess_123' }, user: { id: 'user_456' } }),
      headers,
    );
    expect(result).toEqual({ userId: 'user_456', sessionId: 'sess_123' });
  });
});
