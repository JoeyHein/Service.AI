/**
 * Live Postgres tests for TASK-TM-05a invoice draft endpoints.
 *
 * Uses the seeded Elevated Doors catalog (already published by
 * runSeed) so each test can reference real service-item ids without
 * rebuilding a template inside beforeAll. Test ids INVOICE-INST-01
 * corresponds to `INST-SC-STEEL` (base 1200, floor 1000, ceiling
 * 1600) and INVOICE-INST-02 corresponds to `REP-ROLLER` (150 / 120 /
 * 220).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createAuth } from '@service-ai/auth';
import * as schema from '@service-ai/db';
import { users, sessions, accounts, verifications, serviceItems } from '@service-ai/db';
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
let cookies: { denverOwner: string; austinOwner: string };
let denverCustomerId: string;
let denverJobId: string;
let austinJobId: string;
let installItemId: string; // INST-SC-STEEL: 1200 floor 1000 ceiling 1600
let rollerItemId: string; // REP-ROLLER: 150 floor 120 ceiling 220

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

async function createCustomerAndJob(cookie: string, name: string) {
  const cust = await app.inject({
    method: 'POST',
    url: '/api/v1/customers',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ name }),
  });
  const customerId = cust.json().data.id as string;
  const job = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ customerId, title: `${name} job` }),
  });
  return { customerId, jobId: job.json().data.id as string };
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await runReset(pool);
  await runSeed(pool);
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
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
  };

  // Resolve the two seeded item ids we'll use as line-item references.
  const inst = await db
    .select({ id: serviceItems.id })
    .from(serviceItems)
    .where(eq(serviceItems.sku, 'INST-SC-STEEL'));
  installItemId = inst[0]!.id;
  const roll = await db
    .select({ id: serviceItems.id })
    .from(serviceItems)
    .where(eq(serviceItems.sku, 'REP-ROLLER'));
  rollerItemId = roll[0]!.id;

  // One Denver + one Austin job for cross-tenancy checks.
  const denver = await createCustomerAndJob(cookies.denverOwner, 'Denver Invoice Co');
  denverCustomerId = denver.customerId;
  denverJobId = denver.jobId;
  const austin = await createCustomerAndJob(cookies.austinOwner, 'Austin Invoice Co');
  austinJobId = austin.jobId;
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('TM-05a / invoice drafts', () => {
  it('anonymous: 401 on create', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [] }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('happy path: creates draft with lines; subtotal/tax/total computed server-side', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [
          { serviceItemId: installItemId, quantity: 1 },       // 1200 default
          { serviceItemId: rollerItemId, quantity: 2, unitPrice: 180 }, // 2 * 180 = 360
        ],
        taxRate: 0.08,
        notes: 'First draft',
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json().data as {
      id: string;
      status: string;
      subtotal: string;
      taxRate: string;
      taxAmount: string;
      total: string;
      jobId: string;
      customerId: string;
      lines: Array<{ sku: string; quantity: string; unitPrice: string; lineTotal: string }>;
    };
    expect(body.status).toBe('draft');
    expect(body.jobId).toBe(denverJobId);
    expect(body.customerId).toBe(denverCustomerId);
    expect(Number(body.subtotal)).toBe(1560);
    // tax = 1560 * 0.08 = 124.8
    expect(Number(body.taxAmount)).toBeCloseTo(124.8, 2);
    expect(Number(body.total)).toBeCloseTo(1684.8, 2);
    expect(body.lines).toHaveLength(2);
    const inst = body.lines.find((l) => l.sku === 'INST-SC-STEEL')!;
    expect(Number(inst.unitPrice)).toBe(1200);
    expect(Number(inst.lineTotal)).toBe(1200);
  });

  it('GET returns the invoice + ordered lines', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [{ serviceItemId: rollerItemId, quantity: 1 }],
      }),
    });
    const invId = create.json().data.id as string;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${invId}`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data as { lines: Array<{ sku: string }> };
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]!.sku).toBe('REP-ROLLER');
  });

  it('unit price below floor → 400 PRICE_OUT_OF_BOUNDS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [{ serviceItemId: installItemId, quantity: 1, unitPrice: 500 }],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PRICE_OUT_OF_BOUNDS');
    expect(res.json().error.message).toContain('below floor');
  });

  it('unit price above ceiling → 400 PRICE_OUT_OF_BOUNDS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [{ serviceItemId: installItemId, quantity: 1, unitPrice: 9999 }],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PRICE_OUT_OF_BOUNDS');
    expect(res.json().error.message).toContain('above ceiling');
  });

  it('PATCH replaces the line set and recomputes totals atomically', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [{ serviceItemId: installItemId, quantity: 1 }],
      }),
    });
    const invId = create.json().data.id as string;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/invoices/${invId}`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [
          { serviceItemId: rollerItemId, quantity: 3 },
          { serviceItemId: rollerItemId, quantity: 1, unitPrice: 200 },
        ],
        taxRate: 0,
      }),
    });
    expect(patch.statusCode).toBe(200);
    const body = patch.json().data as {
      subtotal: string;
      total: string;
      lines: Array<{ quantity: string; unitPrice: string; lineTotal: string }>;
    };
    expect(body.lines).toHaveLength(2);
    // 3 * 150 + 1 * 200 = 650
    expect(Number(body.subtotal)).toBe(650);
    expect(Number(body.total)).toBe(650);
  });

  it('cross-franchisee job id on create → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${austinJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [] }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('cross-franchisee GET on an invoice owned by another franchisee → 404', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${austinJobId}/invoices`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [] }),
    });
    const invId = create.json().data.id as string;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${invId}`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH on a non-draft invoice → 409 INVOICE_NOT_EDITABLE', async () => {
    // Phase 6 doesn't implement finalize; set the status directly via SQL
    // so we can still verify the app-layer gate fires.
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [] }),
    });
    const invId = create.json().data.id as string;
    await pool.query(
      `UPDATE invoices SET status = 'finalized', finalized_at = NOW() WHERE id = $1`,
      [invId],
    );
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/invoices/${invId}`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ notes: 'nope' }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVOICE_NOT_EDITABLE');
  });

  it('DELETE on draft soft-deletes; GET afterwards → 404; replay idempotent', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [] }),
    });
    const invId = create.json().data.id as string;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${invId}`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().data.deleted).toBe(true);

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${invId}`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(get.statusCode).toBe(404);

    const replay = await app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${invId}`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.alreadyDeleted).toBe(true);
  });

  it('DELETE on a non-draft invoice → 409 INVOICE_NOT_EDITABLE', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [] }),
    });
    const invId = create.json().data.id as string;
    await pool.query(
      `UPDATE invoices SET status = 'finalized', finalized_at = NOW() WHERE id = $1`,
      [invId],
    );
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${invId}`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVOICE_NOT_EDITABLE');
  });
});
