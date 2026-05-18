/**
 * Corporate hub security matrix (CHR-03 replacement for live-security.test.ts).
 *
 * Exercises the API against a seeded live Postgres under the post-CHR-01
 * tenant model:
 *   - corporate_admin: can read every branch's data, write anywhere.
 *   - manager (branch X): can read/write branch X only; cross-branch access
 *     returns 404 (NOT 403 — the 404 pattern matches the rest of the API so
 *     callers cannot infer the existence of rows they shouldn't see).
 *   - csr / tech / dispatcher (branch X): same as manager — branch X only.
 *   - unauthenticated callers get 401 on every protected endpoint.
 *
 * Follows the existing skip-when-unreachable pattern: every test bails
 * silently if Postgres isn't on the configured `DATABASE_URL`. Tests do
 * not need to run in CI yet — they exercise live RLS and live route
 * handlers, both of which need a real DB to be meaningful.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createAuth } from '@service-ai/auth';
import * as schema from '@service-ai/db';
import {
  users,
  sessions,
  accounts,
  verifications,
  branches,
} from '@service-ai/db';
import { buildApp } from '../app.js';
import { runReset, runSeed, DEV_SEED_PASSWORD } from '../seed/index.js';
import {
  membershipResolver,
  auditLogWriter,
} from '../production-resolvers.js';
import type { MagicLinkSender } from '@service-ai/auth';

const { Pool } = pkg;

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let denverId = '';
let austinId = '';

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

function normalizeSetCookie(sc: string | string[] | undefined): string {
  if (!sc) return '';
  return Array.isArray(sc) ? sc.join('\n') : sc;
}

function extractCookieHeader(setCookieStr: string): string | null {
  const firstLine = setCookieStr.split('\n')[0];
  if (!firstLine) return null;
  const match = firstLine.match(/^([^=]+=[^;]+)/);
  return match ? match[1]! : null;
}

async function signIn(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD }),
  });
  if (res.statusCode !== 200) {
    throw new Error(`sign-in failed for ${email}: ${res.statusCode} ${res.body}`);
  }
  const setCookie = normalizeSetCookie(res.headers['set-cookie']);
  const cookie = extractCookieHeader(setCookie);
  if (!cookie) throw new Error(`no cookie for ${email}`);
  return cookie;
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;

  pool = new Pool({ connectionString: DATABASE_URL });
  await runReset(pool);
  await runSeed(pool);

  const db = drizzle(pool, { schema });
  const denver = await db
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.slug, 'denver'));
  const austin = await db
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.slug, 'austin'));
  denverId = denver[0]!.id;
  austinId = austin[0]!.id;

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
    magicLinkSender: { send: async () => {} } as MagicLinkSender,
  });

  app = buildApp({
    db: { query: async () => ({ rows: [] }) },
    redis: { ping: async () => 'PONG' },
    logger: false,
    auth,
    drizzle: db,
    membershipResolver: membershipResolver(db),
    auditWriter: auditLogWriter(db),
    magicLinkSender: { async send() {} },
    acceptUrlBase: 'http://localhost:3000',
  });
  await app.ready();
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

describe.runIf(() => reachable)('corporate role matrix', () => {
  it('unauthenticated → 401 on /api/v1/me', async () => {
    if (!reachable) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
  });

  it('unauthenticated → 401 on /api/v1/jobs', async () => {
    if (!reachable) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/jobs' });
    expect(res.statusCode).toBe(401);
  });

  it('corporate_admin sees every branch in /api/v1/corporate/branches', async () => {
    if (!reachable) return;
    const cookie = await signIn(app, 'joey@opendc.ca');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/corporate/branches',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: true; data: Array<{ id: string }> };
    const ids = body.data.map((r) => r.id);
    expect(ids).toContain(denverId);
    expect(ids).toContain(austinId);
  });

  it('manager(Denver) cannot list /api/v1/corporate/branches (corporate-only)', async () => {
    if (!reachable) return;
    const cookie = await signIn(app, 'denver.owner@elevateddoors.test');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/corporate/branches',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it.each(['dispatcher', 'tech1', 'csr'])(
    'Denver %s cannot list /api/v1/corporate/branches (corporate-only)',
    async (subrole) => {
      if (!reachable) return;
      const email = `denver.${subrole}@elevateddoors.test`;
      const cookie = await signIn(app, email);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/corporate/branches',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
    },
  );

  it('manager(Denver) cannot read /api/v1/pricebook for Austin', async () => {
    if (!reachable) return;
    const cookie = await signIn(app, 'denver.owner@elevateddoors.test');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/pricebook?branchId=${austinId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('manager(Denver) sees Denver pricebook', async () => {
    if (!reachable) return;
    const cookie = await signIn(app, 'denver.owner@elevateddoors.test');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pricebook',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: true;
      data: { branchId: string; rows: unknown[] };
    };
    expect(body.data.branchId).toBe(denverId);
    expect(body.data.rows.length).toBeGreaterThan(0);
  });

  it('corporate_admin can hit /api/v1/audit-log; managers cannot', async () => {
    if (!reachable) return;
    const adminCookie = await signIn(app, 'joey@opendc.ca');
    const ok = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log',
      headers: { cookie: adminCookie },
    });
    expect(ok.statusCode).toBe(200);

    const managerCookie = await signIn(app, 'denver.owner@elevateddoors.test');
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log',
      headers: { cookie: managerCookie },
    });
    expect(forbidden.statusCode).toBe(403);
  });

});
