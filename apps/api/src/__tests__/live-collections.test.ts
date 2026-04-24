/**
 * Live Postgres tests for AI collections (TASK-CO-02 + CO-03 +
 * CO-04 + CO-05).
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
import {
  membershipResolver,
  franchiseeLookup,
  auditLogWriter,
} from '../production-resolvers.js';
import { stubAIClient, type AssistantTurn } from '@service-ai/ai';
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
  denverDispatcher: string;
  denverOwner: string;
  denverTech: string;
  austinOwner: string;
};
let denverInvoiceId: string;
const emailSent: Array<{ to: string; subject: string }> = [];
const smsSent: Array<{ to: string; body: string }> = [];

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

function text(t: string): AssistantTurn {
  return {
    role: 'assistant',
    kind: 'text',
    text: t,
    confidence: 1,
    costUsd: 0.0003,
    provider: 'stub',
    model: 'stub-1',
  };
}

async function buildApplication(script: AssistantTurn[] = []): Promise<FastifyInstance> {
  const ai = stubAIClient({ script });
  const db = drizzle(pool, { schema });
  const auth = createAuth({
    db,
    authSchema: { user: users, session: sessions, account: accounts, verification: verifications },
    baseUrl: 'http://localhost',
    secret: 'x'.repeat(32),
  });
  const a = buildApp({
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
    aiClient: ai,
    stripe: stubStripeClient,
    publicBaseUrl: 'http://app.test',
    emailSender: {
      async send(p) {
        emailSent.push({ to: p.to, subject: p.subject });
        return { id: `email_co_${emailSent.length}` };
      },
    },
    smsSender: {
      async send(p) {
        smsSent.push({ to: p.to, body: p.body });
        return { id: `sms_co_${smsSent.length}` };
      },
    },
  });
  await a.ready();
  return a;
}

async function signIn(a: FastifyInstance, email: string): Promise<string> {
  const res = await a.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD }),
  });
  const c = extractCookie(res.headers['set-cookie']);
  if (!c) throw new Error(`signIn ${email} failed`);
  return c;
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
  app = await buildApplication([]);
  cookies = {
    denverDispatcher: await signIn(app, 'denver.dispatcher@elevateddoors.test'),
    denverOwner: await signIn(app, 'denver.owner@elevateddoors.test'),
    denverTech: await signIn(app, 'denver.tech1@elevateddoors.test'),
    austinOwner: await signIn(app, 'austin.owner@elevateddoors.test'),
  };

  // Seed an aged denver invoice: status='sent', finalized 10 days
  // ago so the 7-day friendly cadence lights it up.
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (franchisee_id, name, email, phone)
       VALUES ($1, 'Late Lucy', 'late@lucy.test', '+15555550004') RETURNING id`,
    [ids.denverId],
  );
  const job = await pool.query<{ id: string }>(
    `INSERT INTO jobs (franchisee_id, customer_id, title, status)
       VALUES ($1, $2, 'Aged job', 'completed') RETURNING id`,
    [ids.denverId, cust.rows[0]!.id],
  );
  const inv = await pool.query<{ id: string }>(
    `INSERT INTO invoices
         (franchisee_id, job_id, customer_id, status, subtotal, tax_rate,
          tax_amount, total, finalized_at, sent_at, payment_link_token)
       VALUES ($1, $2, $3, 'sent', 120.00, 0, 0, 120.00,
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days',
               'testtoken0000000000000000000000000000000000')
       RETURNING id`,
    [ids.denverId, job.rows[0]!.id, cust.rows[0]!.id],
  );
  denverInvoiceId = inv.rows[0]!.id;
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('CO-02 / collections.draft', () => {
  it('sweep produces exactly 1 draft for the aged invoice + friendly tone', async () => {
    const a = await buildApplication([
      text(
        JSON.stringify({
          sms: 'Hi Late Lucy, a quick note about invoice ABC.',
          email: {
            subject: 'Invoice ABC — Denver',
            body: 'Hi Late Lucy, your invoice is open.',
          },
        }),
      ),
    ]);
    const cookie = await signIn(a, 'denver.dispatcher@elevateddoors.test');
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/collections/run',
      headers: { cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { inspected: number; drafted: number };
    expect(data.drafted).toBe(1);
    await a.close();
  });

  it('second sweep is idempotent — no duplicate pending row', async () => {
    const a = await buildApplication([text(JSON.stringify({ sms: '', email: { subject: '', body: '' } }))]);
    const cookie = await signIn(a, 'denver.dispatcher@elevateddoors.test');
    const second = await a.inject({
      method: 'POST',
      url: '/api/v1/collections/run',
      headers: { cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(second.statusCode).toBe(201);
    const { rows } = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM collections_drafts
         WHERE invoice_id = $1 AND status = 'pending'`,
      [denverInvoiceId],
    );
    expect(Number(rows[0]?.c)).toBe(1);
    await a.close();
  });
});

describe('CO-04 / review queue', () => {
  it('anonymous list → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/drafts',
    });
    expect(res.statusCode).toBe(401);
  });

  it('tech list → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/drafts',
      headers: { cookie: cookies.denverTech },
    });
    expect(res.statusCode).toBe(403);
  });

  it('denver dispatcher list shows pending draft', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/drafts?status=pending',
      headers: { cookie: cookies.denverDispatcher },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data.rows as Array<{
      invoiceId: string;
      franchiseeId: string;
    }>;
    expect(rows.some((r) => r.invoiceId === denverInvoiceId)).toBe(true);
    for (const r of rows) expect(r.franchiseeId).toBe(ids.denverId);
  });

  it('austin owner list does NOT see denver drafts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/drafts?status=pending',
      headers: { cookie: cookies.austinOwner },
    });
    const rows = res.json().data.rows as Array<{ invoiceId: string }>;
    expect(rows.some((r) => r.invoiceId === denverInvoiceId)).toBe(false);
  });

  it('edit replaces smsBody + flips status to edited', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/drafts?status=pending',
      headers: { cookie: cookies.denverDispatcher },
    });
    const pending = (list.json().data.rows as Array<{ id: string; invoiceId: string }>).find(
      (r) => r.invoiceId === denverInvoiceId,
    )!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/drafts/${pending.id}/edit`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({ smsBody: 'Edited SMS' }),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { status: string; smsBody: string };
    expect(data.status).toBe('edited');
    expect(data.smsBody).toBe('Edited SMS');
  });

  it('approve sends email + sms + flips status to sent', async () => {
    emailSent.length = 0;
    smsSent.length = 0;
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/drafts',
      headers: { cookie: cookies.denverDispatcher },
    });
    const target = (list.json().data.rows as Array<{ id: string; status: string; invoiceId: string }>)
      .filter((r) => r.invoiceId === denverInvoiceId && (r.status === 'pending' || r.status === 'edited'))[0]!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/drafts/${target.id}/approve`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { status: string; channels: string[] };
    expect(data.status).toBe('sent');
    expect(data.channels).toEqual(expect.arrayContaining(['email', 'sms']));
    expect(emailSent.length).toBeGreaterThan(0);
    expect(smsSent.length).toBeGreaterThan(0);
  });

  it('approve on an already-sent draft → 409', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/drafts?status=sent',
      headers: { cookie: cookies.denverDispatcher },
    });
    const sent = (list.json().data.rows as Array<{ id: string }>)[0]!;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/drafts/${sent.id}/approve`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DRAFT_NOT_PENDING');
  });

  it('reject flips to rejected and does not send', async () => {
    // Create another aged invoice so we have a fresh pending to reject.
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (franchisee_id, name, email, phone)
         VALUES ($1, 'Reject Co', 'rej@ect.test', '+15555550005') RETURNING id`,
      [ids.denverId],
    );
    const job = await pool.query<{ id: string }>(
      `INSERT INTO jobs (franchisee_id, customer_id, title, status)
         VALUES ($1, $2, 'reject job', 'completed') RETURNING id`,
      [ids.denverId, cust.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO invoices
          (franchisee_id, job_id, customer_id, status, subtotal, tax_rate,
           tax_amount, total, finalized_at, sent_at, payment_link_token)
        VALUES ($1, $2, $3, 'sent', 50.00, 0, 0, 50.00,
                NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days',
                'rejectedtoken0000000000000000000000000000')`,
      [ids.denverId, job.rows[0]!.id, cust.rows[0]!.id],
    );
    const a = await buildApplication([
      text(JSON.stringify({ sms: 'x', email: { subject: 'x', body: 'x' } })),
    ]);
    const cookie = await signIn(a, 'denver.dispatcher@elevateddoors.test');
    await a.inject({
      method: 'POST',
      url: '/api/v1/collections/run',
      headers: { cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    const list = await a.inject({
      method: 'GET',
      url: '/api/v1/collections/drafts?status=pending',
      headers: { cookie },
    });
    const pending = (list.json().data.rows as Array<{ id: string }>)[0]!;
    const res = await a.inject({
      method: 'POST',
      url: `/api/v1/collections/drafts/${pending.id}/reject`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('rejected');
    await a.close();
  });
});

describe('CO-05 / payment retry', () => {
  it('schedules a retry on payment_intent.payment_failed webhook', async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (franchisee_id, name) VALUES ($1, 'Retry Co') RETURNING id`,
      [ids.denverId],
    );
    const job = await pool.query<{ id: string }>(
      `INSERT INTO jobs (franchisee_id, customer_id, title, status)
         VALUES ($1, $2, 'retry', 'scheduled') RETURNING id`,
      [ids.denverId, cust.rows[0]!.id],
    );
    const inv = await pool.query<{ id: string }>(
      `INSERT INTO invoices
           (franchisee_id, job_id, customer_id, status, subtotal, tax_rate,
            tax_amount, total, finalized_at, stripe_payment_intent_id)
         VALUES ($1, $2, $3, 'sent', 100.00, 0, 0, 100.00,
                 NOW(), 'pi_retry_test') RETURNING id`,
      [ids.denverId, job.rows[0]!.id, cust.rows[0]!.id],
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 'ignored-by-stub',
      },
      payload: JSON.stringify({
        id: 'evt_fail_retry_1',
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_retry_test',
            last_payment_error: { code: 'card_declined' },
          },
        },
      }),
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query<{
      failure_code: string;
      status: string;
      attempt_index: number;
    }>(
      `SELECT failure_code, status, attempt_index FROM payment_retries WHERE invoice_id = $1`,
      [inv.rows[0]!.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.failure_code).toBe('card_declined');
    expect(rows[0]?.status).toBe('scheduled');
    expect(rows[0]?.attempt_index).toBe(1);
  });

  it('run endpoint flips status to succeeded via stub Stripe', async () => {
    // Seed a standalone retry row + ensure the franchisee has a
    // stripe_account so the retry can create a PaymentIntent.
    await pool.query(
      `UPDATE franchisees SET stripe_account_id = 'acct_stub_retry_ready',
          stripe_charges_enabled = TRUE, stripe_payouts_enabled = TRUE,
          stripe_details_submitted = TRUE
        WHERE id = $1`,
      [ids.denverId],
    );
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (franchisee_id, name) VALUES ($1, 'Retry Run') RETURNING id`,
      [ids.denverId],
    );
    const job = await pool.query<{ id: string }>(
      `INSERT INTO jobs (franchisee_id, customer_id, title, status)
         VALUES ($1, $2, 'retry run', 'scheduled') RETURNING id`,
      [ids.denverId, cust.rows[0]!.id],
    );
    const inv = await pool.query<{ id: string }>(
      `INSERT INTO invoices
           (franchisee_id, job_id, customer_id, status, subtotal, tax_rate,
            tax_amount, total, application_fee_amount, finalized_at, stripe_payment_intent_id)
         VALUES ($1, $2, $3, 'sent', 100.00, 0, 0, 100.00, 5.00,
                 NOW(), 'pi_retry_run_old') RETURNING id`,
      [ids.denverId, job.rows[0]!.id, cust.rows[0]!.id],
    );
    const retry = await pool.query<{ id: string }>(
      `INSERT INTO payment_retries
           (franchisee_id, invoice_id, failure_code, scheduled_for, status)
         VALUES ($1, $2, 'card_declined', NOW(), 'scheduled') RETURNING id`,
      [ids.denverId, inv.rows[0]!.id],
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/retries/${retry.rows[0]!.id}/run`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { status: string; resultRef: { paymentIntentId?: string } };
    expect(data.status).toBe('succeeded');
    expect(data.resultRef.paymentIntentId).toMatch(/^pi_stub_/);
  });
});

describe('CO-06 / metrics', () => {
  it('metrics endpoint returns DSO + recovered revenue shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/metrics',
      headers: { cookie: cookies.denverDispatcher },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      dsoDays: number;
      recoveredRevenueCents: number;
    };
    expect(typeof data.dsoDays).toBe('number');
    expect(typeof data.recoveredRevenueCents).toBe('number');
  });
});
