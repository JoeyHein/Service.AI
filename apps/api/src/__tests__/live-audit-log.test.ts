/**
 * Live Postgres tests for TASK-TEN-08 audit log viewer.
 *
 * Resets + seeds + writes a couple audit rows by triggering impersonation
 * requests from a franchisor_admin, then queries /api/v1/audit-log as
 * various roles to assert:
 *   - 401 for anonymous
 *   - 403 for franchisee-scoped users
 *   - franchisor_admin sees only entries under their franchisor
 *   - filters combine (actorEmail + action + date range)
 *   - pagination returns total alongside the page slice
 *   - platform_admin sees every row
 *
 * Auto-skips when DATABASE_URL is unreachable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createAuth } from '@service-ai/auth';
import * as schema from '@service-ai/db';
import { users, sessions, accounts, verifications } from '@service-ai/db';
import { buildApp } from '../app.js';
import { runReset, runSeed, DEV_SEED_PASSWORD } from '../seed/index.js';
import {
  membershipResolver,
  franchiseeLookup,
  auditLogWriter,
} from '../production-resolvers.js';

const { Pool } = pkg;

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let ids: { franchisorId: string; denverId: string; austinId: string };
let cookies: {
  platform: string;
  franchisorAdmin: string;
  denverOwner: string;
  denverDispatcher: string;
};

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
function extractCookie(setCookieStr: string): string | null {
  const firstLine = setCookieStr.split('\n')[0];
  if (!firstLine) return null;
  const m = firstLine.match(/^([^=]+=[^;]+)/);
  return m ? m[1]! : null;
}

async function signIn(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD }),
  });
  if (res.statusCode !== 200) throw new Error(`sign-in failed for ${email}: ${res.body}`);
  const c = extractCookie(normalizeSetCookie(res.headers['set-cookie']));
  if (!c) throw new Error(`no cookie for ${email}`);
  return c;
}

async function createFranchisorAdmin(): Promise<string> {
  const email = 'audit-fradmin@elevateddoors.test';
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: 'Audit Admin' }),
  });
  const db = drizzle(pool, { schema });
  const [{ id: userId }] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  await pool.query(
    `INSERT INTO memberships (user_id, scope_type, scope_id, role)
       SELECT $1, 'franchisor'::scope_type, $2, 'franchisor_admin'::role
       WHERE NOT EXISTS (
         SELECT 1 FROM memberships
          WHERE user_id=$1 AND scope_type='franchisor' AND scope_id=$2 AND deleted_at IS NULL
       )`,
    [userId, ids.franchisorId],
  );
  return await signIn(email);
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });

  await runReset(pool);
  const seed = await runSeed(pool);
  ids = {
    franchisorId: seed.franchisorId,
    denverId: seed.franchisees.find((f) => f.slug === 'denver')!.id,
    austinId: seed.franchisees.find((f) => f.slug === 'austin')!.id,
  };

  const db = drizzle(pool, { schema });
  const auth = createAuth({
    db,
    authSchema: { user: users, session: sessions, account: accounts, verification: verifications },
    baseUrl: 'http://localhost',
    secret: 'x'.repeat(32),
  });
  app = buildApp({
    db: { query: async () => ({ rows: [] }) },
    redis: { ping: async () => 'PONG' },
    logger: false,
    auth,
    drizzle: db,
    membershipResolver: membershipResolver(db),
    franchiseeLookup: franchiseeLookup(db),
    auditWriter: auditLogWriter(db),
    magicLinkSender: { async send() {} },
    acceptUrlBase: 'http://localhost:3000',
  });
  await app.ready();

  cookies = {
    platform: await signIn('joey@opendc.ca'),
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
    denverDispatcher: await signIn('denver.dispatcher@elevateddoors.test'),
    franchisorAdmin: await createFranchisorAdmin(),
  };

  // Write audit rows by performing two impersonated requests.
  for (const target of [ids.denverId, ids.austinId]) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: {
        cookie: cookies.franchisorAdmin,
        'x-impersonate-franchisee': target,
      },
    });
    if (res.statusCode !== 200) {
      throw new Error(`seed impersonation failed: ${res.statusCode} ${res.body}`);
    }
  }
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('GET /api/v1/audit-log (live Postgres)', () => {
  it('returns 401 for anonymous callers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/audit-log' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for franchisee-scoped users', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log',
      headers: { cookie: cookies.denverDispatcher },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUDIT_FORBIDDEN');

    const ownerRes = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log',
      headers: { cookie: cookies.denverOwner },
    });
    expect(ownerRes.statusCode).toBe(403);
  });

  it('franchisor admin sees audit rows scoped to their franchisor', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log',
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data as {
      rows: Array<{ action: string; targetFranchiseeId: string | null }>;
      total: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(2);
    const actions = body.rows.map((r) => r.action);
    expect(actions).toContain('impersonate.request');
    const targets = body.rows.map((r) => r.targetFranchiseeId).filter(Boolean);
    expect(targets).toContain(ids.denverId);
    expect(targets).toContain(ids.austinId);
  });

  it('filters combine: action + franchiseeId narrows the result set', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/audit-log?action=impersonate&franchiseeId=${ids.denverId}`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data as {
      rows: Array<{ action: string; targetFranchiseeId: string | null }>;
      total: number;
    };
    expect(body.total).toBeGreaterThan(0);
    for (const row of body.rows) {
      expect(row.action).toContain('impersonate');
      expect(row.targetFranchiseeId).toBe(ids.denverId);
    }
  });

  it('actorEmail filter matches the acting user (case-insensitive LIKE)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log?actorEmail=audit-fradmin',
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data as {
      rows: Array<{ actorEmail: string | null }>;
    };
    expect(body.rows.length).toBeGreaterThan(0);
    for (const row of body.rows) {
      expect(row.actorEmail).toMatch(/audit-fradmin/i);
    }
  });

  it('pagination returns total alongside the slice', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log?limit=1',
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data as {
      rows: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.rows.length).toBeLessThanOrEqual(1);
    expect(body.total).toBeGreaterThanOrEqual(body.rows.length);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(0);
  });

  it('platform admin sees every audit row', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log',
      headers: { cookie: cookies.platform },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data as { total: number };
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  it('returned rows are ordered by createdAt DESC (newest first)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log',
      headers: { cookie: cookies.franchisorAdmin },
    });
    const rows = (res.json().data as { rows: Array<{ createdAt: string }> }).rows;
    if (rows.length < 2) return;
    for (let i = 1; i < rows.length; i++) {
      expect(
        new Date(rows[i - 1]!.createdAt).getTime(),
      ).toBeGreaterThanOrEqual(new Date(rows[i]!.createdAt).getTime());
    }
  });

  it('fromDate filter in the future returns zero rows', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/audit-log?fromDate=${encodeURIComponent(future)}`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as { total: number }).total).toBe(0);
  });
});
