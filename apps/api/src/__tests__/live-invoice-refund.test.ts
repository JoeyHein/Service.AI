/**
 * Live Postgres tests for TASK-IP-06 invoice refund.
 *
 * Uses stubStripeClient so createRefund is deterministic; the
 * tests verify the app-layer rules:
 *   - only paid invoices are refundable
 *   - amount cannot exceed (total - previously refunded)
 *   - a full refund voids the invoice
 *   - partial refund leaves status = 'paid'
 *   - cross-tenant refund → 404
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
let cookies: { denverOwner: string; austinOwner: string };
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

/**
 * Build a paid invoice in one step: create draft → finalize →
 * mark paid + insert a payment row via raw SQL so subsequent
 * refunds exercise the app-layer rules without depending on the
 * webhook dispatch in this test file.
 */
async function createPaidInvoice(cookie: string, totalCents = 120000): Promise<string> {
  const create = await app.inject({
    method: 'POST',
    url: `/api/v1/jobs/${denverJobId}/invoices`,
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
  if (fin.statusCode !== 200) {
    throw new Error(`finalize failed (${fin.statusCode}): ${fin.body}`);
  }
  const pi = fin.json().data.stripePaymentIntentId as string;
  await pool.query(
    `UPDATE invoices SET status='paid', paid_at=NOW() WHERE id=$1`,
    [invoiceId],
  );
  await pool.query(
    `INSERT INTO payments
       (franchisee_id, invoice_id, stripe_payment_intent_id,
        stripe_charge_id, amount, application_fee_amount, currency, status)
     SELECT franchisee_id, id, $2, $3, $4, $5, 'usd', 'succeeded'
       FROM invoices WHERE id = $1`,
    [invoiceId, pi, `ch_${pi}`, (totalCents / 100).toFixed(2), (totalCents * 0.05 / 100).toFixed(2)],
  );
  return invoiceId;
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await runReset(pool);
  const seed = await runSeed(pool);
  const denverId = seed.franchisees.find((f) => f.slug === 'denver')!.id;
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
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
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
    [denverId],
  );

  const cust = await app.inject({
    method: 'POST',
    url: '/api/v1/customers',
    headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Refund Co' }),
  });
  const job = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
    payload: JSON.stringify({ customerId: cust.json().data.id, title: 'Refund Job' }),
  });
  denverJobId = job.json().data.id as string;
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('IP-06 / invoice refund', () => {
  it('full refund on paid invoice voids it and inserts a refund row', async () => {
    const id = await createPaidInvoice(cookies.denverOwner);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${id}/refund`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json().data as {
      refund: { amount: string; stripeRefundId: string };
      invoice: { status: string };
    };
    expect(body.invoice.status).toBe('void');
    expect(body.refund.stripeRefundId).toMatch(/^re_stub_/);
    expect(Number(body.refund.amount)).toBe(1200);
  });

  it('partial refund leaves invoice paid and accumulates', async () => {
    const id = await createPaidInvoice(cookies.denverOwner);
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${id}/refund`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 300 }),
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().data.invoice.status).toBe('paid');

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${id}/refund`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 900 }),
    });
    expect(second.statusCode).toBe(201);
    // 300 + 900 = 1200 = full → invoice void
    expect(second.json().data.invoice.status).toBe('void');
  });

  it('refund amount > remaining balance → 400 REFUND_OUT_OF_BOUNDS', async () => {
    const id = await createPaidInvoice(cookies.denverOwner);
    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${id}/refund`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 1000 }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${id}/refund`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 500 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('REFUND_OUT_OF_BOUNDS');
  });

  it('refund on a draft → 409 INVALID_TRANSITION', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [{ serviceItemId: installItemId, quantity: 1 }],
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${create.json().data.id}/refund`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_TRANSITION');
  });

  it('cross-tenant refund → 404', async () => {
    const id = await createPaidInvoice(cookies.denverOwner);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${id}/refund`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
  });
});
