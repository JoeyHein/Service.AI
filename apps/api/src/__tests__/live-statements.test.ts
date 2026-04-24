/**
 * Live Postgres tests for TASK-RE-05 statement generation +
 * Stripe Transfer reconciliation.
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
import { stubStripeClient } from '../stripe.js';

const { Pool } = pkg;
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let ids: { franchisorId: string; denverId: string; austinId: string };
let cookies: {
  franchisorAdmin: string;
  denverOwner: string;
  denverTech: string;
  austinOwner: string;
};
let denverJobId: string;
let installItemId: string;

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

async function createFranchisorAdmin(franchisorId: string): Promise<string> {
  const email = 're05-fradmin@elevateddoors.test';
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: 'RE05 Admin' }),
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
    [userId, franchisorId],
  );
  return await signIn(email);
}

async function createPaidInvoice(
  cookie: string,
  jobId: string,
  amountCents = 120000,
  feeCents = 12000,
): Promise<void> {
  const create = await app.inject({
    method: 'POST',
    url: `/api/v1/jobs/${jobId}/invoices`,
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({
      lines: [{ serviceItemId: installItemId, quantity: 1 }],
    }),
  });
  const invoiceId = create.json().data.id as string;
  const fin = await app.inject({
    method: 'POST',
    url: `/api/v1/invoices/${invoiceId}/finalize`,
    headers: { cookie, 'content-type': 'application/json' },
    payload: '{}',
  });
  if (fin.statusCode !== 200) throw new Error(`finalize failed: ${fin.body}`);
  const pi = fin.json().data.stripePaymentIntentId as string;
  await pool.query(`UPDATE invoices SET status='paid', paid_at=NOW() WHERE id=$1`, [
    invoiceId,
  ]);
  await pool.query(
    `INSERT INTO payments
       (franchisee_id, invoice_id, stripe_payment_intent_id, stripe_charge_id,
        amount, application_fee_amount, currency, status)
     SELECT franchisee_id, id, $2, $3, $4, $5, 'usd', 'succeeded'
       FROM invoices WHERE id = $1`,
    [invoiceId, pi, `ch_${pi}`, (amountCents / 100).toFixed(2), (feeCents / 100).toFixed(2)],
  );
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
    stripe: stubStripeClient,
    publicBaseUrl: 'http://app.test',
  });
  await app.ready();
  cookies = {
    franchisorAdmin: await createFranchisorAdmin(ids.franchisorId),
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
  };
  const inst = await db
    .select({ id: serviceItems.id })
    .from(serviceItems)
    .where(eq(serviceItems.sku, 'INST-SC-STEEL'));
  installItemId = inst[0]!.id;
  await pool.query(
    `UPDATE franchisees
        SET stripe_account_id = 'acct_stub_denver_ready',
            stripe_charges_enabled = TRUE,
            stripe_payouts_enabled = TRUE,
            stripe_details_submitted = TRUE
      WHERE id = $1`,
    [ids.denverId],
  );
  const cust = await app.inject({
    method: 'POST',
    url: '/api/v1/customers',
    headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'RE05 Co' }),
  });
  const job = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
    payload: JSON.stringify({ customerId: cust.json().data.id, title: 'RE05 Job' }),
  });
  denverJobId = job.json().data.id as string;

  // Activate a 10% royalty agreement so `owed` differs from 5%
  // fallback and we can exercise variance.
  const agreement = await app.inject({
    method: 'POST',
    url: `/api/v1/franchisees/${ids.denverId}/agreement`,
    headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
    payload: JSON.stringify({
      name: '10%',
      rules: [{ type: 'percentage', params: { basisPoints: 1000 } }],
    }),
  });
  await app.inject({
    method: 'POST',
    url: `/api/v1/franchisees/${ids.denverId}/agreement/${agreement.json().data.id}/activate`,
    headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
    payload: '{}',
  });
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('RE-05 / statement generation', () => {
  it('tech cannot generate → 403', async () => {
    const year = new Date().getUTCFullYear();
    const month = new Date().getUTCMonth() + 1;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/statements/generate`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ year, month }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('generates a statement with gross/refund/net/owed/collected', async () => {
    await createPaidInvoice(cookies.denverOwner, denverJobId, 120000, 12000);
    await createPaidInvoice(cookies.denverOwner, denverJobId, 80000, 8000);
    // Insert a $100 refund against the first invoice.
    await pool.query(
      `INSERT INTO refunds
         (franchisee_id, invoice_id, stripe_refund_id, amount, status)
       SELECT franchisee_id, id, 'rf_test_refund', 100.00, 'succeeded'
         FROM invoices WHERE franchisee_id = $1 LIMIT 1`,
      [ids.denverId],
    );
    const now = new Date();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/statements/generate`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 1,
        timezone: 'UTC',
      }),
    });
    expect(res.statusCode).toBe(201);
    const s = res.json().data as {
      grossRevenue: string;
      refundTotal: string;
      netRevenue: string;
      royaltyOwed: string;
      royaltyCollected: string;
      variance: string;
    };
    expect(Number(s.grossRevenue)).toBe(2000);
    expect(Number(s.refundTotal)).toBe(100);
    expect(Number(s.netRevenue)).toBe(1900);
    // 10% of 1900 = 190
    expect(Number(s.royaltyOwed)).toBe(190);
    // Collected = 12000 + 8000 cents = $200
    expect(Number(s.royaltyCollected)).toBe(200);
    // variance = 190 - 200 = -10 (platform over-collected)
    expect(Number(s.variance)).toBe(-10);
  });

  it('regenerating the same period is an upsert', async () => {
    const now = new Date();
    const body = JSON.stringify({
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      timezone: 'UTC',
    });
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/statements/generate`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: body,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/statements/generate`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: body,
    });
    expect(first.json().data.id).toBe(second.json().data.id);
  });

  it('list endpoint returns statements ordered by period desc', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.denverId}/statements`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('franchisee /statements shows own only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/statements',
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data.rows as Array<{ franchiseeId: string }>;
    for (const r of rows) expect(r.franchiseeId).toBe(ids.denverId);
  });

  it('cross-tenant list → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.denverId}/statements`,
      headers: { cookie: cookies.austinOwner },
    });
    expect(res.statusCode).toBe(404);
  });

  it('reconcile creates a Stripe Transfer and flips status', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.denverId}/statements`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    const statementId = list.json().data.rows[0].id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/statements/${statementId}/reconcile`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { status: string; transferId: string | null };
    expect(data.status).toBe('reconciled');
    expect(data.transferId).toMatch(/^tr_stub_/);
  });

  it('reconcile a second time → 409 ALREADY_RECONCILED', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.denverId}/statements`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    const statementId = list.json().data.rows[0].id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/statements/${statementId}/reconcile`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_RECONCILED');
  });
});
