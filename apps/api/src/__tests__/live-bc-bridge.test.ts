/**
 * Live tests for BCB-03 — Service.AI wiring of the BC purchasing bridge.
 *
 * Builds the app with a MockSupplierProvider registry so submit can push a
 * (fake) BC PO and stamp the ref, and so check-availability returns a
 * deterministic envelope. Auto-skips when Postgres is unreachable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { createAuth } from '@service-ai/auth';
import { MockSupplierProvider, ProviderRegistry } from '@service-ai/suppliers';
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
let mock: MockSupplierProvider;
let cookies: { denverManager: string };
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
  const sup = await pool.query<{ id: string }>(
    `INSERT INTO suppliers (name, provider_kind, endpoint_url, api_key_secret_ref, supplier_account_code)
     VALUES ('Bridge Supplier', 'bc_ai_agent', 'http://x', 'BRIDGE_KEY', 'ED-001') RETURNING id`,
  );
  supplierId = sup.rows[0]!.id;

  mock = new MockSupplierProvider({
    catalog: [
      { sku: 'PN10', name: 'Spring', category: 'spring', unitPriceCents: 100, unitCostCents: 50 },
    ],
  });
  const registry = new ProviderRegistry();
  registry.registerFactory('bc_ai_agent', () => mock);

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
    providerRegistry: registry,
    membershipResolver: membershipResolver(db),
    auditWriter: auditLogWriter(db),
    magicLinkSender: { async send() {} },
    acceptUrlBase: 'http://localhost:3000',
  });
  await app.ready();
  cookies = { denverManager: await signIn('denver.owner@elevateddoors.test') };
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('BCB-03 / submit pushes a BC PO and stamps the ref', () => {
  it('stamps supplier_po_ref on a successful BC create', async () => {
    const created = await createPO(cookies.denverManager, {
      supplierId,
      lines: [{ sku: 'PN10', quantity: 5, unitCostCents: 700 }],
    });
    const id = created.json().data.po.id as string;
    const submit = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${id}/submit`,
      headers: { cookie: cookies.denverManager },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().data.status).toBe('submitted');
    expect(submit.json().data.supplierPoRef).toMatch(/^BCPO-\d{6}$/);
    expect(submit.json().data.bcSyncedAt).toBeTruthy();
  });

  it('leaves the PO submitted with a null ref when BC sync fails', async () => {
    const created = await createPO(cookies.denverManager, {
      supplierId,
      lines: [{ sku: 'PN10', quantity: 1, unitCostCents: 100 }],
    });
    const id = created.json().data.po.id as string;
    mock.injectFailure('createPurchaseOrder', { code: 'UPSTREAM_ERROR', message: 'BC down', retryable: true });
    const submit = await app.inject({
      method: 'POST',
      url: `/api/v1/purchase-orders/${id}/submit`,
      headers: { cookie: cookies.denverManager },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().data.status).toBe('submitted');
    expect(submit.json().data.supplierPoRef).toBeNull();
  });
});

describe('TD-BCB-02 / sync-bc retries a failed BC push', () => {
  it('stamps the ref on a PO whose submit push failed', async () => {
    const created = await createPO(cookies.denverManager, {
      supplierId,
      lines: [{ sku: 'PN10', quantity: 2, unitCostCents: 100 }],
    });
    const id = created.json().data.po.id as string;
    // Make the submit-time BC push fail (single-use injection).
    mock.injectFailure('createPurchaseOrder', { code: 'UPSTREAM_ERROR', message: 'BC down', retryable: true });
    const submit = await app.inject({ method: 'POST', url: `/api/v1/purchase-orders/${id}/submit`, headers: { cookie: cookies.denverManager } });
    expect(submit.json().data.supplierPoRef).toBeNull();

    // Now sync — the injected failure is cleared, so it succeeds.
    const sync = await app.inject({ method: 'POST', url: `/api/v1/purchase-orders/${id}/sync-bc`, headers: { cookie: cookies.denverManager } });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().data.supplierPoRef).toMatch(/^BCPO-\d{6}$/);

    // Re-sync is an idempotent no-op (already synced).
    const again = await app.inject({ method: 'POST', url: `/api/v1/purchase-orders/${id}/sync-bc`, headers: { cookie: cookies.denverManager } });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.supplierPoRef).toBe(sync.json().data.supplierPoRef);
  });

  it('409 when the PO is still a draft', async () => {
    const created = await createPO(cookies.denverManager, {
      supplierId,
      lines: [{ sku: 'PN10', quantity: 1, unitCostCents: 100 }],
    });
    const id = created.json().data.po.id as string;
    const sync = await app.inject({ method: 'POST', url: `/api/v1/purchase-orders/${id}/sync-bc`, headers: { cookie: cookies.denverManager } });
    expect(sync.statusCode).toBe(409);
  });
});

describe('BCB-03 / check-availability', () => {
  it('returns the supplier availability envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/check-availability',
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ supplierId, items: [{ sku: 'PN10', quantity: 2 }, { sku: 'UNKNOWN', quantity: 1 }] }),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.items.find((i: { sku: string }) => i.sku === 'PN10').status).toBe('available');
    expect(data.items.find((i: { sku: string }) => i.sku === 'UNKNOWN').status).toBe('unavailable');
    expect(data.allAvailable).toBe(false);
  });

  it('404 for an unknown supplier', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/inventory/check-availability',
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ supplierId: '11111111-1111-1111-1111-111111111111', items: [{ sku: 'X', quantity: 1 }] }),
    });
    expect(res.statusCode).toBe(404);
  });
});
