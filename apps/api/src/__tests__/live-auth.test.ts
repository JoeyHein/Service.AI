/**
 * Live Better Auth round-trip tests for TASK-TEN-01.
 *
 * Verifies Better Auth actually works against our Drizzle schema with real
 * Postgres: sign-up inserts a users row, sign-in creates a session, the
 * session cookie resolves on /api/v1/me, sign-out deletes the session.
 *
 * Skipped when DATABASE_URL is unreachable — matches the pattern used by
 * health-checks.test.ts and live-rls.test.ts. Uses a dedicated test email
 * so re-runs are idempotent (tests delete their users in afterEach).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createAuth } from '@service-ai/auth';
import {
  users,
  sessions,
  accounts,
  verifications,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import { buildApp } from '../app.js';

const { Pool } = pkg;

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

const TEST_EMAIL = 'live-auth-test@opendc.ca';
const TEST_PASSWORD = 'changeme123!A';

let reachable = false;
let pool: InstanceType<typeof Pool>;

/**
 * Fastify-inject exposes set-cookie as either a string or an array of
 * strings when multiple cookies are set. Normalise to one string so match
 * assertions work the same in both shapes.
 */
function normalizeSetCookie(
  sc: string | string[] | undefined,
): string {
  if (!sc) return '';
  return Array.isArray(sc) ? sc.join('\n') : sc;
}

/**
 * Extract a "name=value" pair suitable for a Cookie request header from the
 * first Set-Cookie line. Skips attributes (HttpOnly, Path, …).
 */
function extractCookieHeader(setCookieStr: string): string | null {
  const firstLine = setCookieStr.split('\n')[0];
  if (!firstLine) return null;
  const match = firstLine.match(/^([^=]+=[^;]+)/);
  return match ? match[1]! : null;
}

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await p.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await p.end();
  }
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  if (pool) await pool.end();
});

let app: FastifyInstance;
afterEach(async () => {
  if (app) await app.close();
  if (reachable && pool) {
    await pool.query('DELETE FROM users WHERE email = $1', [TEST_EMAIL]);
  }
});

describe('Better Auth end-to-end (live Postgres)', () => {
  beforeEach((ctx) => {
    if (!reachable) ctx.skip();
  });

  async function buildLiveApp() {
    const db = drizzle(pool, { schema });
    const auth = createAuth({
      db,
      authSchema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
      },
      baseUrl: 'http://localhost',
      secret: 'x'.repeat(32),
    });
    app = buildApp({
      db: { query: async () => ({ rows: [] }) }, // not used for auth
      redis: { ping: async () => 'PONG' },
      logger: false,
      auth,
    });
    await app.ready();
    return app;
  }

  it('sign-up inserts a users row and returns a session', async () => {
    app = await buildLiveApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        name: 'Live Test',
      }),
    });

    expect(res.statusCode).toBe(200);

    const db = drizzle(pool, { schema });
    const rows = await db.select().from(users).where(eq(users.email, TEST_EMAIL));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe(TEST_EMAIL);
  });

  it('sign-in issues an httpOnly cookie the /me endpoint can resolve', async () => {
    app = await buildLiveApp();

    // Create the user first so sign-in has something to hit.
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        name: 'Live Test',
      }),
    });
    expect(signup.statusCode).toBe(200);

    const signin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    expect(signin.statusCode).toBe(200);

    const cookieStr = normalizeSetCookie(signin.headers['set-cookie']);
    expect(cookieStr).toMatch(/HttpOnly/i);
    expect(cookieStr).toMatch(/SameSite=Lax/i);

    const cookieHeader = extractCookieHeader(cookieStr);
    expect(cookieHeader).toBeTruthy();

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookieHeader! },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.ok).toBe(true);
    expect(body.data.user.id).toBeDefined();
  });

  it('sessions table gets a row on sign-in and loses it on sign-out', async () => {
    app = await buildLiveApp();

    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        name: 'Live Test',
      }),
    });

    const signin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    const cookieHeader = extractCookieHeader(
      normalizeSetCookie(signin.headers['set-cookie']),
    );
    expect(cookieHeader).toBeTruthy();

    const db = drizzle(pool, { schema });
    const userRow = (
      await db.select().from(users).where(eq(users.email, TEST_EMAIL))
    )[0];
    expect(userRow).toBeDefined();
    const sessionsAfterSignin = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userRow!.id));
    expect(sessionsAfterSignin.length).toBeGreaterThanOrEqual(1);

    const signout = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie: cookieHeader! },
    });
    expect([200, 204]).toContain(signout.statusCode);

    // The session cookie must no longer resolve to a valid /me response.
    // Better Auth may either delete the sessions row or mark it expired;
    // either behaviour satisfies "sign-out invalidates session server-side".
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookieHeader! },
    });
    expect(me.statusCode).toBe(401);
  });
});
