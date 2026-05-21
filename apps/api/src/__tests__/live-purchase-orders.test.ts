/**
 * Live Postgres tests for PO-02 (purchase order API) + PO-03 (receiving).
 *
 * Covers: anonymous 401, role gating, create + PO number + subtotal,
 * corporate-must-pass-branchId, supplier 404, list/filter, cross-tenant 404,
 * submit/cancel transitions, from-low-stock, and receiving (full/partial,
 * over-receipt guard, receive-on-draft, inventory upsert + receipt movement).
 * Auto-skips when Postgres is unreachable.
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
let cookies: { denverManager: string; austinManager: string; denverCsr: string; corporate: string };
let denverBranchId: string;
let supplierId: string;

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await p.query('SELECT 1 FROM purchase_orders LIMIT 0');
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

function createPO(cookie: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/purchase-orders',
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
  const sup = await pool.query<{ id: string }>(
    `INSERT INTO suppliers (name, provider_kind, endpoint_url, api_key_secret_ref, supplier_account_code)
     VALUES ('PO Supplier', 'bc_ai_agent', 'http://x', 'ref', 'PO') RETURNING id`,
  );
  supplierId = sup.rows[0]!.id;
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

describe('PO-02 / purchase order API', () => {
  it('anonymous 401; csr cannot create (403)', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/v1/purchase-orders' });
    expect(anon.statusCode).toBe(401);
    const csr = await createPO(cookies.denverCsr, {
      supplierId,
      lines: [{ sku: 'X', quantity: 1, unitCostCents: 100 }],
    });
    expect(csr.statusCode).toBe(403);
  });

  it('manager creates a draft with a PO number + computed subtotal', async () => {
    const res = await createPO(cookies.denverManager, {
      supplierId,
      lines: [
        { sku: 'SP-1', description: 'Spring', quantity: 2, unitCostCents: 4200 },
        { sku: 'RL-1', quantity: 4, unitCostCents: 1000 },
      ],
    });
    expect(res.statusCode).toBe(201);
    const po = res.json().data.po;
    expect(po.status).toBe('draft');
    expect(po.poNumber).toMatch(/^PO-\d{6}$/);
    expect(po.subtotalCents).toBe(2 * 4200 + 4 * 1000);
    expect(res.json().data.lines.length).toBe(2);
  });

  it('supplier not found → 404; corporate must pass branchId', async () => {
    const bad = await createPO(cookies.denverManager, {
      supplierId: '11111111-1111-1111-1111-111111111111',
      lines: [{ sku: 'X', quantity: 1, unitCostCents: 1 }],
    });
    expect(bad.statusCode).toBe(404);

    const noBranch = await createPO(cookies.corporate, {
      supplierId,
      lines: [{ sku: 'X', quantity: 1, unitCostCents: 1 }],
    });
    expect(noBranch.statusCode).toBe(400);
    const withBranch = await createPO(cookies.corporate, {
      supplierId,
      branchId: denverBranchId,
      lines: [{ sku: 'X', quantity: 1, unitCostCents: 1 }],
    });
    expect(withBranch.statusCode).toBe(201);
  });

  it('submit then cancel transitions; re-submit is 409', async () => {
    const created = await createPO(cookies.denverManager, {
      supplierId,
      lines: [{ sku: 'T-1', quantity: 1, unitCostCents: 100 }],
    });
    const id = created.json().data.po.id as string;

    const submit = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${id}/submit`,
      headers: { cookie: cookies.denverManager },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().data.status).toBe('submitted');

    const resubmit = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${id}/submit`,
      headers: { cookie: cookies.denverManager },
    });
    expect(resubmit.statusCode).toBe(409);

    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${id}/cancel`,
      headers: { cookie: cookies.denverManager },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().data.status).toBe('canceled');
  });

  it('cross-tenant: austin cannot read a denver PO', async () => {
    const created = await createPO(cookies.denverManager, {
      supplierId,
      lines: [{ sku: 'XT', quantity: 1, unitCostCents: 1 }],
    });
    const id = created.json().data.po.id as string;
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/purchase-orders/${id}`,
      headers: { cookie: cookies.austinManager },
    });
    expect(read.statusCode).toBe(404);
  });

  it('from-low-stock builds a draft from low items (422 when nothing low)', async () => {
    // austin has no inventory yet → nothing low.
    const empty = await app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders/from-low-stock',
      headers: { cookie: cookies.austinManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ supplierId }),
    });
    expect(empty.statusCode).toBe(422);

    // Seed a denver low-stock item.
    const sku = `LOWPO-${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/items',
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ sku, name: 'Low part', qtyOnHand: 0, reorderPoint: 5, reorderQty: 12, unitCostCents: 250 }),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/purchase-orders/from-low-stock',
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ supplierId }),
    });
    expect(res.statusCode).toBe(201);
    const line = (res.json().data.lines as Array<{ sku: string; quantity: string }>).find((l) => l.sku === sku);
    expect(line).toBeTruthy();
    expect(Number(line!.quantity)).toBe(12); // reorderQty wins
  });
});

describe('PO-03 / receiving replenishes inventory', () => {
  async function draftAndSubmit(lines: Array<{ sku: string; quantity: number; unitCostCents: number }>): Promise<string> {
    const created = await createPO(cookies.denverManager, { supplierId, lines });
    const id = created.json().data.po.id as string;
    await app.inject({ method: 'POST', url: `/api/v1/purchase-orders/${id}/submit`, headers: { cookie: cookies.denverManager } });
    return id;
  }
  async function getPO(id: string) {
    const res = await app.inject({ method: 'GET', url: `/api/v1/purchase-orders/${id}`, headers: { cookie: cookies.denverManager } });
    return res.json().data as { po: { status: string }; lines: Array<{ id: string; sku: string; quantity: string; receivedQty: string }> };
  }
  async function onHand(sku: string): Promise<number> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/inventory/items?search=${encodeURIComponent(sku)}`,
      headers: { cookie: cookies.denverManager },
    });
    const row = (res.json().data.rows as Array<{ sku: string; qtyOnHand: string }>).find((r) => r.sku === sku);
    return row ? Number(row.qtyOnHand) : NaN;
  }

  it('receive on a draft is rejected (409)', async () => {
    const created = await createPO(cookies.denverManager, { supplierId, lines: [{ sku: 'D-1', quantity: 1, unitCostCents: 1 }] });
    const id = created.json().data.po.id as string;
    const lineId = created.json().data.lines[0].id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${id}/receive`,
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [{ lineId, receiveQty: 1 }] }),
    });
    expect(res.statusCode).toBe(409);
  });

  it('full receipt → received, creates the stocked item, writes a receipt movement', async () => {
    const sku = `RCV-${Date.now()}`;
    const id = await draftAndSubmit([{ sku, quantity: 5, unitCostCents: 700 }]);
    const { lines } = await getPO(id);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${id}/receive`,
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [{ lineId: lines[0]!.id, receiveQty: 5 }] }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('received');
    expect(await onHand(sku)).toBe(5);

    const { rows } = await pool.query(
      `SELECT reason, ref_type FROM inventory_movements WHERE ref_type='po' AND ref_id=$1`,
      [id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toBe('receipt');
  });

  it('partial receipt → partial; over-receipt is rejected', async () => {
    const sku = `PRT-${Date.now()}`;
    const id = await draftAndSubmit([{ sku, quantity: 5, unitCostCents: 100 }]);
    const { lines } = await getPO(id);
    const lineId = lines[0]!.id;

    const partial = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${id}/receive`,
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [{ lineId, receiveQty: 2 }] }),
    });
    expect(partial.json().data.status).toBe('partial');
    expect(await onHand(sku)).toBe(2);

    const over = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${id}/receive`,
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [{ lineId, receiveQty: 99 }] }),
    });
    expect(over.statusCode).toBe(422);

    // Finish the rest → received.
    const rest = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${id}/receive`,
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [{ lineId, receiveQty: 3 }] }),
    });
    expect(rest.json().data.status).toBe('received');
    expect(await onHand(sku)).toBe(5);
  });

  it('receiving into an existing stocked SKU increments its on-hand', async () => {
    const sku = `EXIST-${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/items',
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ sku, name: 'Existing', qtyOnHand: 10 }),
    });
    const id = await draftAndSubmit([{ sku, quantity: 3, unitCostCents: 500 }]);
    const { lines } = await getPO(id);
    await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${id}/receive`,
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [{ lineId: lines[0]!.id, receiveQty: 3 }] }),
    });
    expect(await onHand(sku)).toBe(13);
  });
});
