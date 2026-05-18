/**
 * Live tests for the phase-13 audit-log filter additions:
 * ?q= and ?kind= params (TASK-FC-02).
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
let corporateAdminCookie: string;
let ids: { corporateId: string };

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

function extractCookie(set: string | string[] | undefined): string | null {
  if (!set) return null;
  const s = Array.isArray(set) ? set[0]! : set;
  const m = s.match(/^([^=]+=[^;]+)/);
  return m ? m[1]! : null;
}

async function signIn(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD }),
  });
  const c = extractCookie(res.headers['set-cookie']);
  if (!c) throw new Error('no cookie');
  return c;
}

async function createCorporateAdmin(corporateId: string): Promise<string> {
  const email = 'fc02-coadmin@elevateddoors.test';
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: 'FC02' }),
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
    [userId, corporateId],
  );
  return await signIn(email);
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await runReset(pool);
  const seed = await runSeed(pool);
  ids = { corporateId: seed.corporateId };
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
  corporateAdminCookie = await createCorporateAdmin(ids.corporateId);
  // Insert a few distinct audit rows so filter matching has
  // something to discriminate on.
  await pool.query(
    `INSERT INTO audit_log (action, scope_type, scope_id, metadata)
     VALUES
       ('impersonate.request', 'corporate', $1, '{"note":"hq start"}'::jsonb),
       ('invoice.finalized',   'corporate', $1, '{"note":"final"}'::jsonb),
       ('payment.captured',    'corporate', $1, '{"note":"paid"}'::jsonb),
       ('agreement.activated', 'corporate', $1, '{"note":"active"}'::jsonb)`,
    [ids.corporateId],
  );
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('FC-02 / audit-log filters', () => {
  it('?q=impersonate matches only impersonation rows', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log?q=impersonate',
      headers: { cookie: corporateAdminCookie },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data.rows as Array<{ action: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.action).toContain('impersonate');
  });

  it('?kind=invoice matches invoice rows only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log?kind=invoice',
      headers: { cookie: corporateAdminCookie },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data.rows as Array<{ action: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.action).toContain('invoice');
  });

  it('?kind=bogus → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log?kind=bogus',
      headers: { cookie: corporateAdminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('?q= with SQL-injection attempt is treated as a LIKE param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/audit-log?q=${encodeURIComponent("' OR 1=1--")}`,
      headers: { cookie: corporateAdminCookie },
    });
    // No rows match literal `' OR 1=1--` so total should be 0.
    // (If interpolated into SQL, total would be every row.)
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { total: number };
    expect(data.total).toBe(0);
  });
});
