/**
 * Live Postgres tests for TASK-TEN-08 audit log viewer.
 *
 * Resets + seeds + writes a couple audit rows directly, then queries
 * /api/v1/audit-log as various roles to assert:
 *   - 401 for anonymous
 *   - 403 for branch-scoped users
 *   - corporate_admin sees every entry under corporate
 *   - filters combine (actorEmail + action + date range)
 *   - pagination returns total alongside the page slice
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
  auditLogWriter,
} from '../production-resolvers.js';

const { Pool } = pkg;

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let ids: { corporateId: string; denverId: string; austinId: string };
let cookies: {
  corporateAdmin: string;
  denverManager: string;
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

async function createCorporateAdmin(): Promise<string> {
  const email = 'audit-coadmin@elevateddoors.test';
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
       SELECT $1, 'corporate'::scope_type, $2, 'corporate_admin'::role
       WHERE NOT EXISTS (
         SELECT 1 FROM memberships
          WHERE user_id=$1 AND scope_type='corporate' AND scope_id=$2 AND deleted_at IS NULL
       )`,
    [userId, ids.corporateId],
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
    corporateId: seed.corporateId,
    denverId: seed.branches.find((b) => b.slug === 'denver')!.id,
    austinId: seed.branches.find((b) => b.slug === 'austin')!.id,
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
    auditWriter: auditLogWriter(db),
    magicLinkSender: { async send() {} },
    acceptUrlBase: 'http://localhost:3000',
  });
  await app.ready();

  cookies = {
    denverManager: await signIn('denver.owner@elevateddoors.test'),
    denverDispatcher: await signIn('denver.dispatcher@elevateddoors.test'),
    corporateAdmin: await createCorporateAdmin(),
  };

  // Seed deterministic audit rows directly so the filter assertions
  // have something to match. The corporate admin we just created is the
  // actor; both rows reference branches that corporate can see.
  const [{ id: actorUserId }] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'audit-coadmin@elevateddoors.test'));
  for (const targetBranchId of [ids.denverId, ids.austinId]) {
    await pool.query(
      `INSERT INTO audit_log
         (actor_user_id, target_branch_id, action, scope_type, scope_id, metadata)
       VALUES ($1, $2, 'impersonate.request', 'corporate'::scope_type, $3, '{}'::jsonb)`,
      [actorUserId, targetBranchId, ids.corporateId],
    );
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

  it('returns 403 for branch-scoped users', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log',
      headers: { cookie: cookies.denverDispatcher },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUDIT_FORBIDDEN');

    const managerRes = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log',
      headers: { cookie: cookies.denverManager },
    });
    expect(managerRes.statusCode).toBe(403);
  });

  it('corporate admin sees every audit row', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log',
      headers: { cookie: cookies.corporateAdmin },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data as {
      rows: Array<{ action: string; targetBranchId: string | null }>;
      total: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(2);
    const actions = body.rows.map((r) => r.action);
    expect(actions).toContain('impersonate.request');
    const targets = body.rows.map((r) => r.targetBranchId).filter(Boolean);
    expect(targets).toContain(ids.denverId);
    expect(targets).toContain(ids.austinId);
  });

  it('filters combine: action + branchId narrows the result set', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/audit-log?action=impersonate&branchId=${ids.denverId}`,
      headers: { cookie: cookies.corporateAdmin },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data as {
      rows: Array<{ action: string; targetBranchId: string | null }>;
      total: number;
    };
    expect(body.total).toBeGreaterThan(0);
    for (const row of body.rows) {
      expect(row.action).toContain('impersonate');
      expect(row.targetBranchId).toBe(ids.denverId);
    }
  });

  it('actorEmail filter matches the acting user (case-insensitive LIKE)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log?actorEmail=audit-coadmin',
      headers: { cookie: cookies.corporateAdmin },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data as {
      rows: Array<{ actorEmail: string | null }>;
    };
    expect(body.rows.length).toBeGreaterThan(0);
    for (const row of body.rows) {
      expect(row.actorEmail).toMatch(/audit-coadmin/i);
    }
  });

  it('pagination returns total alongside the slice', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log?limit=1',
      headers: { cookie: cookies.corporateAdmin },
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

  it('returned rows are ordered by createdAt DESC (newest first)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log',
      headers: { cookie: cookies.corporateAdmin },
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
      headers: { cookie: cookies.corporateAdmin },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as { total: number }).total).toBe(0);
  });
});
