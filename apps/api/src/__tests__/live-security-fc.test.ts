/**
 * TASK-FC-05 — phase_franchisor_console security suite.
 *
 * The franchisor console was removed by the corporate hub redesign
 * (CHR-01). The route group `/api/v1/franchisor/*` no longer exists.
 * What remains is the audit-log surface, which moved fully under
 * corporate-only access. This file exercises the portion of the
 * original FC-05 matrix that is still meaningful: anonymous 401,
 * branch-scoped 403, and corporate_admin 200 against /api/v1/audit-log,
 * plus the legacy /franchisor/network-metrics returning 404 NOT_FOUND
 * because the route is gone.
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
  denverTech: string;
  denverCsr: string;
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
  if (!c) throw new Error(`no cookie for ${email}`);
  return c;
}

async function createCorporateAdmin(corporateId: string, email: string): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: email }),
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
  ids = {
    corporateId: seed.corporateId,
    denverId: seed.branches.find((b) => b.slug === 'denver')!.id,
    austinId: seed.branches.find((b) => b.slug === 'austin')!.id,
  };
  void ids.austinId;

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
    corporateAdmin: await createCorporateAdmin(
      ids.corporateId,
      'fc-coadmin@elevateddoors.test',
    ),
    denverManager: await signIn('denver.owner@elevateddoors.test'),
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    denverCsr: await signIn('denver.csr@elevateddoors.test'),
  };
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

// ---------------------------------------------------------------------------
// Anonymous
// ---------------------------------------------------------------------------

describe('FC-05 / anonymous 401 (audit log)', () => {
  it('GET /api/v1/audit-log anonymous → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log',
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/v1/audit-log?kind=invoice anonymous → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log?kind=invoice',
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Role boundary
// ---------------------------------------------------------------------------

describe('FC-05 / role boundary (audit log)', () => {
  it('tech cannot read audit-log → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log',
      headers: { cookie: cookies.denverTech },
    });
    expect(res.statusCode).toBe(403);
  });

  it('CSR cannot read audit log → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log?q=invoice',
      headers: { cookie: cookies.denverCsr },
    });
    expect(res.statusCode).toBe(403);
  });

  it('branch manager cannot read audit log → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log',
      headers: { cookie: cookies.denverManager },
    });
    expect(res.statusCode).toBe(403);
  });

  it('corporate admin CAN read audit log', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log',
      headers: { cookie: cookies.corporateAdmin },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Legacy /franchisor/* routes — removed in CHR-01.
// ---------------------------------------------------------------------------

describe('FC-05 / removed franchisor_console routes', () => {
  it('GET /api/v1/franchisor/network-metrics → 404 (route removed)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/franchisor/network-metrics',
      headers: { cookie: cookies.corporateAdmin },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/v1/franchisor/onboard → 404 (route removed)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisor/onboard',
      headers: { cookie: cookies.corporateAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x', slug: 'x' }),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('FC-05 / audit-log validation', () => {
  it('bad kind on audit-log → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log?kind=whatever',
      headers: { cookie: cookies.corporateAdmin },
    });
    expect(res.statusCode).toBe(400);
  });

  it('SQL-injection attempt in ?q= → 0 rows, 200 OK', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/audit-log?q=${encodeURIComponent("' OR 1=1--")}`,
      headers: { cookie: cookies.corporateAdmin },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { total: number };
    expect(data.total).toBe(0);
  });
});
