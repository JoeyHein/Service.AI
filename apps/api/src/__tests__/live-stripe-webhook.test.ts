/**
 * Live Postgres tests for TASK-IP-05 Stripe webhook handler.
 *
 * Uses stubStripeClient whose constructWebhookEvent accepts any
 * signature and parses the raw body, so each test can hand-craft
 * the event payload directly and exercise the dispatch logic.
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
let denverOwnerCookie: string;
let denverId: string;
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

async function finalizeInvoice(cookie: string, jobId: string): Promise<{
  invoiceId: string;
  paymentIntentId: string;
}> {
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
  if (fin.statusCode !== 200) {
    throw new Error(
      `finalize failed (${fin.statusCode}): ${fin.body}`,
    );
  }
  return {
    invoiceId,
    paymentIntentId: fin.json().data.stripePaymentIntentId as string,
  };
}

async function postEvent(payload: object, extraHeaders?: Record<string, string>) {
  return await app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/stripe',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': 'sig-ignored-by-stub',
      ...(extraHeaders ?? {}),
    },
    payload: JSON.stringify(payload),
  });
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await runReset(pool);
  const seed = await runSeed(pool);
  denverId = seed.franchisees.find((f) => f.slug === 'denver')!.id;
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
  denverOwnerCookie = await signIn('denver.owner@elevateddoors.test');
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
    headers: { cookie: denverOwnerCookie, 'content-type': 'application/json' },
    payload: JSON.stringify({
      name: 'Webhook Co',
      email: 'wh@example.test',
      phone: '+15555550124',
    }),
  });
  const job = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: { cookie: denverOwnerCookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ customerId: cust.json().data.id, title: 'WH Job' }),
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

describe('IP-05 / Stripe webhook', () => {
  it('missing stripe-signature header → 400 BAD_SIGNATURE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: '{"id":"evt_1","type":"payment_intent.succeeded","data":{"object":{}}}',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_SIGNATURE');
  });

  it('payment_intent.succeeded inserts payment row + marks invoice paid', async () => {
    const { invoiceId, paymentIntentId } = await finalizeInvoice(
      denverOwnerCookie,
      denverJobId,
    );
    const res = await postEvent({
      id: `evt_pi_${paymentIntentId}`,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: paymentIntentId,
          amount: 120000,
          application_fee_amount: 6000,
          currency: 'usd',
          status: 'succeeded',
          latest_charge: `ch_${paymentIntentId}`,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    expect(rows[0]?.status).toBe('paid');
    const pay = await pool.query<{ amount: string }>(
      `SELECT amount FROM payments WHERE invoice_id = $1`,
      [invoiceId],
    );
    expect(pay.rows[0]?.amount).toBe('1200.00');
  });

  it('replaying the same event is a no-op', async () => {
    const { paymentIntentId } = await finalizeInvoice(denverOwnerCookie, denverJobId);
    const payload = {
      id: `evt_replay_${paymentIntentId}`,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: paymentIntentId,
          amount: 120000,
          currency: 'usd',
          status: 'succeeded',
          latest_charge: `ch_replay_${paymentIntentId}`,
        },
      },
    };
    const first = await postEvent(payload);
    expect(first.statusCode).toBe(200);
    expect(first.json().data.received).toBe('payment_intent.succeeded');

    const second = await postEvent(payload);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.replay).toBe(true);

    const { rows } = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM payments WHERE stripe_payment_intent_id = $1`,
      [paymentIntentId],
    );
    expect(rows[0]?.c).toBe('1');
  });

  it('payment_intent.payment_failed is logged but does not change invoice status', async () => {
    const { invoiceId, paymentIntentId } = await finalizeInvoice(
      denverOwnerCookie,
      denverJobId,
    );
    const res = await postEvent({
      id: `evt_fail_${paymentIntentId}`,
      type: 'payment_intent.payment_failed',
      data: {
        object: { id: paymentIntentId, status: 'requires_payment_method' },
      },
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    expect(rows[0]?.status).toBe('finalized');
  });

  it('charge.refunded inserts refund rows keyed by Stripe refund id', async () => {
    const { invoiceId, paymentIntentId } = await finalizeInvoice(
      denverOwnerCookie,
      denverJobId,
    );
    await postEvent({
      id: `evt_paid_${paymentIntentId}`,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: paymentIntentId,
          amount: 120000,
          currency: 'usd',
          status: 'succeeded',
          latest_charge: `ch_rf_${paymentIntentId}`,
        },
      },
    });

    const res = await postEvent({
      id: `evt_rf_${paymentIntentId}`,
      type: 'charge.refunded',
      data: {
        object: {
          id: `ch_rf_${paymentIntentId}`,
          payment_intent: paymentIntentId,
          amount_refunded: 120000,
          refunds: {
            data: [
              {
                id: `re_full_${paymentIntentId}`,
                amount: 120000,
                reason: 'requested_by_customer',
                status: 'succeeded',
              },
            ],
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query<{ amount: string; reason: string | null }>(
      `SELECT amount, reason FROM refunds WHERE invoice_id = $1`,
      [invoiceId],
    );
    expect(rows[0]?.amount).toBe('1200.00');
    expect(rows[0]?.reason).toBe('requested_by_customer');
  });

  // Runs last because it disables Denver's Stripe readiness; any
  // finalize test that came after would fail with STRIPE_NOT_READY.
  it('account.updated flips franchisee booleans', async () => {
    await postEvent({
      id: 'evt_acct_updated_1',
      type: 'account.updated',
      data: {
        object: {
          id: 'acct_stub_denver_ready',
          charges_enabled: false,
          payouts_enabled: false,
          details_submitted: true,
        },
      },
    });
    const { rows } = await pool.query<{
      stripe_charges_enabled: boolean;
      stripe_payouts_enabled: boolean;
    }>(
      `SELECT stripe_charges_enabled, stripe_payouts_enabled
         FROM franchisees WHERE id = $1`,
      [denverId],
    );
    expect(rows[0]?.stripe_charges_enabled).toBe(false);
    expect(rows[0]?.stripe_payouts_enabled).toBe(false);
  });
});
