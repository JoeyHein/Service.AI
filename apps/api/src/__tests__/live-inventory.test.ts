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

  it('valuation: sums on-hand value by category (INV-04)', async () => {
    const cat = `VAL-${Date.now()}`;
    await createItem(cookies.denverManager, { sku: `V1-${Date.now()}`, name: 'A', category: cat, qtyOnHand: 4, unitCostCents: 500 });
    await createItem(cookies.denverManager, { sku: `V2-${Date.now()}`, name: 'B', category: cat, qtyOnHand: 2, unitCostCents: 1000 });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/inventory/valuation',
      headers: { cookie: cookies.denverManager },
    });
    expect(res.statusCode).toBe(200);
    const row = (res.json().data.byCategory as Array<{ category: string; onHandValueCents: number; items: number }>).find((r) => r.category === cat);
    expect(row).toBeTruthy();
    expect(row!.onHandValueCents).toBe(4 * 500 + 2 * 1000); // 4000
    expect(row!.items).toBe(2);
    expect(res.json().data.totalValueCents).toBeGreaterThanOrEqual(4000);
  });

  it('transfer: corporate moves stock between branches (INV-03)', async () => {
    const { rows: au } = await pool.query<{ id: string }>(`SELECT id FROM branches WHERE slug = 'austin'`);
    const austinBranchId = au[0]!.id;
    const sku = `TR-${Date.now()}`;
    const created = await createItem(cookies.denverManager, { sku, name: 'Transferable', qtyOnHand: 10 });
    const fromItemId = created.json().data.id as string;

    // Branch manager cannot transfer (corporate-only).
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/transfer',
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ fromItemId, toBranchId: austinBranchId, quantity: 3 }),
    });
    expect(denied.statusCode).toBe(403);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/transfer',
      headers: { cookie: cookies.corporate, 'content-type': 'application/json' },
      payload: JSON.stringify({ fromItemId, toBranchId: austinBranchId, quantity: 3 }),
    });
    expect(res.statusCode).toBe(200);

    const { rows: src } = await pool.query<{ qty_on_hand: string }>(
      `SELECT qty_on_hand FROM inventory_items WHERE id = $1`,
      [fromItemId],
    );
    expect(Number(src[0]!.qty_on_hand)).toBe(7);
    const { rows: dst } = await pool.query<{ qty_on_hand: string }>(
      `SELECT qty_on_hand FROM inventory_items WHERE branch_id = $1 AND sku = $2`,
      [austinBranchId, sku],
    );
    expect(Number(dst[0]!.qty_on_hand)).toBe(3);
  });
});

describe('INV-03 / auto-consume on job completion + reconciliation', () => {
  let customerId: string;
  let supplierId: string;

  beforeAll(async () => {
    if (!reachable) return;
    const cust = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'INV Job Customer' }),
    });
    customerId = cust.json().data.id as string;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO suppliers (name, provider_kind, endpoint_url, api_key_secret_ref, supplier_account_code)
       VALUES ('INV Supplier', 'bc_ai_agent', 'http://x', 'ref', 'INV') RETURNING id`,
    );
    supplierId = rows[0]!.id;
  });

  async function seedQuoteJob(matchSku: string, noMatchSku: string): Promise<string> {
    const { rows: qr } = await pool.query<{ id: string }>(
      `INSERT INTO quotes (branch_id, customer_id, supplier_id, status, total_cents)
       VALUES ($1,$2,$3,'accepted',100000) RETURNING id`,
      [denverBranchId, customerId, supplierId],
    );
    const quoteId = qr[0]!.id;
    for (const [pos, sku, qty] of [
      [1, matchSku, 2],
      [2, noMatchSku, 1],
    ] as const) {
      await pool.query(
        `INSERT INTO quote_line_items
           (quote_id, branch_id, position, supplier_sku, description, quantity,
            unit_price_cents, line_total_cents, applied_margin_pct, applied_margin_source)
         VALUES ($1,$2,$3,$4,$5,$6,1000,1000,'40.00','corporate_default')`,
        [quoteId, denverBranchId, pos, sku, `${sku} desc`, qty],
      );
    }
    const { rows: jr } = await pool.query<{ id: string }>(
      `INSERT INTO jobs (branch_id, customer_id, quote_id, status, title)
       VALUES ($1,$2,$3,'in_progress','Install') RETURNING id`,
      [denverBranchId, customerId, quoteId],
    );
    return jr[0]!.id;
  }

  function complete(jobId: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/transition`,
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ toStatus: 'completed' }),
    });
  }

  it('decrements matched stock and queues unmatched SKUs as exceptions', async () => {
    const matchSku = `JOB-MATCH-${Date.now()}`;
    const noMatchSku = `JOB-NOMATCH-${Date.now()}`;
    const created = await createItem(cookies.denverManager, {
      sku: matchSku,
      name: 'Matched Part',
      qtyOnHand: 10,
    });
    const itemId = created.json().data.id as string;
    const jobId = await seedQuoteJob(matchSku, noMatchSku);

    const res = await complete(jobId);
    expect(res.statusCode).toBe(200);

    // Matched item: 10 - 2 = 8, with a consumption movement referencing the job.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/inventory/items/${itemId}`,
      headers: { cookie: cookies.denverManager },
    });
    expect(Number(detail.json().data.item.qtyOnHand)).toBe(8);
    const consumption = (detail.json().data.movements as Array<{ reason: string; refId: string }>).find(
      (m) => m.reason === 'consumption' && m.refId === jobId,
    );
    expect(consumption).toBeTruthy();

    // Unmatched SKU is a pending exception.
    const exc = await app.inject({
      method: 'GET',
      url: '/api/v1/inventory/exceptions',
      headers: { cookie: cookies.denverManager },
    });
    expect(exc.statusCode).toBe(200);
    expect(exc.json().data.rows.map((r: { sku: string }) => r.sku)).toContain(noMatchSku);
  });

  it('resolve creates a stocked item and consumes the exception quantity', async () => {
    const matchSku = `R-MATCH-${Date.now()}`;
    const noMatchSku = `R-NOMATCH-${Date.now()}`;
    await createItem(cookies.denverManager, { sku: matchSku, name: 'M', qtyOnHand: 5 });
    const jobId = await seedQuoteJob(matchSku, noMatchSku);
    await complete(jobId);

    const exc = await app.inject({
      method: 'GET',
      url: '/api/v1/inventory/exceptions',
      headers: { cookie: cookies.denverManager },
    });
    const excId = (exc.json().data.rows as Array<{ id: string; sku: string }>).find(
      (r) => r.sku === noMatchSku,
    )!.id;

    const resolve = await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/exceptions/${excId}/resolve`,
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ create: { sku: noMatchSku, name: 'Newly stocked' } }),
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().data.status).toBe('resolved');

    // The new item exists and was consumed (1 used from 0 = -1).
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/inventory/items?search=${encodeURIComponent(noMatchSku)}`,
      headers: { cookie: cookies.denverManager },
    });
    const row = (list.json().data.rows as Array<{ sku: string; qtyOnHand: string }>).find(
      (r) => r.sku === noMatchSku,
    );
    expect(row).toBeTruthy();
    expect(Number(row!.qtyOnHand)).toBe(-1);
  });

  it('ignore marks an exception ignored', async () => {
    const jobId = await seedQuoteJob(`IG-M-${Date.now()}`, `IG-N-${Date.now()}`);
    await complete(jobId);
    const exc = await app.inject({
      method: 'GET',
      url: '/api/v1/inventory/exceptions',
      headers: { cookie: cookies.denverManager },
    });
    // Two unmatched SKUs from this job (neither was stocked).
    const mine = (exc.json().data.rows as Array<{ id: string; jobId: string }>).filter(
      (r) => r.jobId === jobId,
    );
    expect(mine.length).toBe(2);
    const ignore = await app.inject({
      method: 'POST',
      url: `/api/v1/inventory/exceptions/${mine[0]!.id}/ignore`,
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(ignore.statusCode).toBe(200);
    expect(ignore.json().data.status).toBe('ignored');
  });
});
