/**
 * Live Postgres tests for TASK-PB-03 branch pricebook + overrides.
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
  denverManager: string;
  denverDispatcher: string;
  austinManager: string;
  corporateAdmin: string;
};
let templateId: string;
let itemIdPrimary: string;   // has floor 1500 / ceiling 2200

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
  if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.body}`);
  const c = extractCookie(res.headers['set-cookie']);
  if (!c) throw new Error('no cookie');
  return c;
}

async function createCorporateAdmin(corporateId: string): Promise<string> {
  const email = 'pricebook-coadmin@elevateddoors.test';
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: 'PB Admin' }),
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
    austinManager: await signIn('austin.owner@elevateddoors.test'),
    corporateAdmin: await createCorporateAdmin(ids.corporateId),
  };

  // Build a template with two items and publish it.
  const tRes = await app.inject({
    method: 'POST',
    url: '/api/v1/catalog/templates',
    headers: { cookie: cookies.corporateAdmin, 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'PB Test', slug: 'pb-test' }),
  });
  templateId = tRes.json().data.id as string;
  const i1 = await app.inject({
    method: 'POST',
    url: `/api/v1/catalog/templates/${templateId}/items`,
    headers: { cookie: cookies.corporateAdmin, 'content-type': 'application/json' },
    payload: JSON.stringify({
      sku: 'PB-INST',
      name: 'Install',
      category: 'Installs',
      unit: 'each',
      basePrice: 1800,
      floorPrice: 1500,
      ceilingPrice: 2200,
    }),
  });
  itemIdPrimary = i1.json().data.id as string;
  await app.inject({
    method: 'POST',
    url: `/api/v1/catalog/templates/${templateId}/items`,
    headers: { cookie: cookies.corporateAdmin, 'content-type': 'application/json' },
    payload: JSON.stringify({
      sku: 'PB-OPEN',
      name: 'Free spec',
      category: 'Parts',
      unit: 'each',
      basePrice: 50,
    }),
  });
  await app.inject({
    method: 'POST',
    url: `/api/v1/catalog/templates/${templateId}/publish`,
    headers: { cookie: cookies.corporateAdmin },
  });
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('PB-03 / resolved pricebook', () => {
  it('anonymous: 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/pricebook' });
    expect(res.statusCode).toBe(401);
  });

  it('branch sees both items with effectivePrice = basePrice', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pricebook',
      headers: { cookie: cookies.denverManager },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data.rows as Array<{
      sku: string;
      basePrice: string;
      effectivePrice: string;
    }>;
    const byS = Object.fromEntries(rows.map((r) => [r.sku, r]));
    expect(byS['PB-INST']?.effectivePrice).toBe('1800.00');
    expect(byS['PB-OPEN']?.effectivePrice).toBe('50.00');
  });

  it('returns the caller branchId in the response envelope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/pricebook',
      headers: { cookie: cookies.denverManager },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.branchId).toBe(ids.denverId);
  });

  it('POST /pricebook/overrides → 410 OVERRIDES_REMOVED (table dropped by CHR-01)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/overrides',
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({
        serviceItemId: itemIdPrimary,
        overridePrice: 2000,
      }),
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('OVERRIDES_REMOVED');
  });

  it('DELETE /pricebook/overrides/:id → 410 OVERRIDES_REMOVED', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/pricebook/overrides/00000000-0000-0000-0000-000000000000',
      headers: { cookie: cookies.denverManager },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('OVERRIDES_REMOVED');
  });
});
