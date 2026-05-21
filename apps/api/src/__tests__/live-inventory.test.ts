/**
 * Live Postgres tests for INV-02 (branch inventory API).
 *
 * Covers: anonymous 401, role gating (csr/tech read-only), create + duplicate
 * SKU, list/search/lowStock filter, cross-tenant 404, adjust receipt/consume +
 * below-zero guard, corporate-must-pass-branchId. Auto-skips when Postgres is
 * unreachable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { createAuth } from '@service-ai/auth';
import * as schema from '@service-ai/db';
import { users, sessions, accounts, verifications } from '@service-ai/db';
import { buildApp } from '../app.js';
import { runReset, runSeed, DEV_SEED_PASSWORD } from '../seed/index.js';
import { membershipResolver, auditLogWriter } from '../production-resolvers.js';

const { Pool } = pkg;

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let cookies: {
  denverManager: string;
  austinManager: string;
  denverCsr: string;
  corporate: string;
};
let denverBranchId: string;

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await p.query('SELECT 1 FROM inventory_items LIMIT 0');
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

async function createItem(cookie: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/inventory/items',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await runReset(pool);
  await runSeed(pool);
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM branches WHERE slug = 'denver'`);
  denverBranchId = rows[0]!.id;
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
    austinManager: await signIn('austin.owner@elevateddoors.test'),
    denverCsr: await signIn('denver.csr@elevateddoors.test'),
    corporate: await signIn('joey@opendc.ca'),
  };
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('INV-02 / inventory API', () => {
  it('anonymous returns 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/inventory/items' });
    expect(res.statusCode).toBe(401);
  });

  it('manager creates an item; csr cannot (403); list + search find it', async () => {
    const sku = `SPRING-${Date.now()}`;
    const create = await createItem(cookies.denverManager, {
      sku,
      name: 'Torsion Spring 0.250',
      category: 'spring',
      unitCostCents: 4200,
      reorderPoint: 5,
    });
    expect(create.statusCode).toBe(201);

    const csr = await createItem(cookies.denverCsr, { sku: `X-${Date.now()}`, name: 'nope' });
    expect(csr.statusCode).toBe(403);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/inventory/items?search=${encodeURIComponent(sku)}`,
      headers: { cookie: cookies.denverManager },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.rows.map((r: { sku: string }) => r.sku)).toContain(sku);

    // csr can read.
    const csrRead = await app.inject({
      method: 'GET',
      url: '/api/v1/inventory/items',
      headers: { cookie: cookies.denverCsr },
    });
    expect(csrRead.statusCode).toBe(200);
  });

  it('duplicate SKU at the same branch returns 409', async () => {
    const sku = `DUP-${Date.now()}`;
    await createItem(cookies.denverManager, { sku, name: 'A' });
    const second = await createItem(cookies.denverManager, { sku, name: 'B' });
    expect(second.statusCode).toBe(409);
  });

  it('corporate must pass branchId; then it works', async () => {
    const sku = `CORP-${Date.now()}`;
    const noBranch = await createItem(cookies.corporate, { sku, name: 'Corp Item' });
    expect(noBranch.statusCode).toBe(400);
    const withBranch = await createItem(cookies.corporate, {
      sku,
      name: 'Corp Item',
      branchId: denverBranchId,
    });
    expect(withBranch.statusCode).toBe(201);
  });

  it('adjust: receipt then consume; consuming below zero is rejected', async () => {
    const sku = `ADJ-${Date.now()}`;
    const created = await createItem(cookies.denverManager, { sku, name: 'Roller' });
    const itemId = created.json().data.id as string;

    const receive = await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/items/${itemId}/adjust`,
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ deltaQty: 10, reason: 'receipt', unitCostCents: 300 }),
    });
    expect(receive.statusCode).toBe(200);
    expect(Number(receive.json().data.qtyOnHand)).toBe(10);

    const consume = await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/items/${itemId}/adjust`,
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ deltaQty: -3, reason: 'consumption' }),
    });
    expect(Number(consume.json().data.qtyOnHand)).toBe(7);

    const over = await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/items/${itemId}/adjust`,
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ deltaQty: -100, reason: 'consumption' }),
    });
    expect(over.statusCode).toBe(422);

    // Detail shows the two movements.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/inventory/items/${itemId}`,
      headers: { cookie: cookies.denverManager },
    });
    expect(detail.json().data.movements.length).toBe(2);
  });

  it('low-stock report + filter surfaces items at/below reorder point', async () => {
    const sku = `LOW-${Date.now()}`;
    await createItem(cookies.denverManager, {
      sku,
      name: 'Low Roller',
      qtyOnHand: 1,
      reorderPoint: 5,
    });
    const low = await app.inject({
      method: 'GET',
      url: '/api/v1/inventory/low-stock',
      headers: { cookie: cookies.denverManager },
    });
    expect(low.statusCode).toBe(200);
    expect(low.json().data.rows.map((r: { sku: string }) => r.sku)).toContain(sku);

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/v1/inventory/items?lowStock=true',
      headers: { cookie: cookies.denverManager },
    });
    expect(filtered.json().data.rows.map((r: { sku: string }) => r.sku)).toContain(sku);
  });

  it('cross-tenant: austin cannot read a denver item', async () => {
    const sku = `XT-${Date.now()}`;
    const created = await createItem(cookies.denverManager, { sku, name: 'Private' });
    const itemId = created.json().data.id as string;
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/inventory/items/${itemId}`,
      headers: { cookie: cookies.austinManager },
    });
    expect(read.statusCode).toBe(404);
  });
});
