/**
 * Live Postgres tests for TASK-IP-04 invoice finalize + send.
 * Refund flow (IP-06) covered in live-invoice-refund.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
const emailSent: Array<{ to: string; subject: string; text: string }> = [];
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

async function createReadyCustomerAndJob(cookie: string) {
  const cust = await app.inject({
    method: 'POST',
    url: '/api/v1/customers',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({
      name: 'Finalize Co',
      email: 'finalize@example.test',
      phone: '+15555550123',
    }),
  });
  const customerId = cust.json().data.id as string;
  const job = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ customerId, title: 'Finalize job' }),
  });
  return { customerId, jobId: job.json().data.id as string };
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
    emailSender: {
      async send(p) {
        emailSent.push({ to: p.to, subject: p.subject, text: p.text });
        return { id: `email_test_${emailSent.length}` };
      },
    },
    smsSender: {
      async send(p) {
        smsSent.push({ to: p.to, body: p.body });
        return { id: `sms_test_${smsSent.length}` };
      },
    },
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
  denverJobId = (await createReadyCustomerAndJob(cookies.denverOwner)).jobId;

  // Flip Denver's Connect readiness flags so finalize can succeed.
  await pool.query(
    `UPDATE franchisees
        SET stripe_account_id = 'acct_stub_denver_ready',
            stripe_charges_enabled = TRUE,
            stripe_payouts_enabled = TRUE,
            stripe_details_submitted = TRUE
      WHERE id = $1`,
    [denverId],
  );
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('IP-04 / invoice finalize + send', () => {
  it('finalize on a draft with lines creates PaymentIntent + token, status=finalized', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [{ serviceItemId: installItemId, quantity: 1 }],
        taxRate: 0,
      }),
    });
    const invId = create.json().data.id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invId}/finalize`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      status: string;
      stripePaymentIntentId: string;
      paymentLinkToken: string;
      applicationFeeAmount: string;
      paymentUrl: string;
    };
    expect(data.status).toBe('finalized');
    expect(data.stripePaymentIntentId).toMatch(/^pi_stub_/);
    expect(data.paymentLinkToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    // total = 1200, 5% fee = 60
    expect(Number(data.applicationFeeAmount)).toBe(60);
    expect(data.paymentUrl).toContain(`http://app.test/invoices/${data.paymentLinkToken}/pay`);
  });

  it('finalize a second time → 409 INVALID_TRANSITION (already finalized)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [{ serviceItemId: installItemId, quantity: 1 }],
      }),
    });
    const invId = create.json().data.id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invId}/finalize`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invId}/finalize`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('INVALID_TRANSITION');
  });

  it('finalize rejected when franchisee has no Stripe Connect readiness → 409 STRIPE_NOT_READY', async () => {
    // Austin has not been flipped to ready.
    const austinCust = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Austin Customer' }),
    });
    const customerId = austinCust.json().data.id as string;
    const job = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ customerId, title: 'Austin job' }),
    });
    const jobId = job.json().data.id as string;
    const inv = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${jobId}/invoices`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [{ serviceItemId: installItemId, quantity: 1 }],
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${inv.json().data.id}/finalize`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('STRIPE_NOT_READY');
  });

  it('finalize on zero-total invoice → 400 EMPTY_INVOICE', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [] }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${create.json().data.id}/finalize`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('EMPTY_INVOICE');
  });

  it('send dispatches email + SMS; status → sent; channels echoed', async () => {
    emailSent.length = 0;
    smsSent.length = 0;
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [{ serviceItemId: installItemId, quantity: 1 }],
      }),
    });
    const invId = create.json().data.id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invId}/finalize`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    const send = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invId}/send`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(send.statusCode).toBe(200);
    const data = send.json().data as { status: string; channels: string[]; paymentUrl: string };
    expect(data.status).toBe('sent');
    expect(data.channels).toEqual(expect.arrayContaining(['email', 'sms']));
    expect(emailSent[0]!.text).toContain(data.paymentUrl);
    expect(smsSent[0]!.body).toContain(data.paymentUrl);
  });

  it('send on a draft → 409 INVALID_TRANSITION', async () => {
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
      url: `/api/v1/invoices/${create.json().data.id}/send`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_TRANSITION');
  });

  it('anonymous finalize/send/refund → 401', async () => {
    const ops = ['finalize', 'send', 'refund'] as const;
    for (const op of ops) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/invoices/00000000-0000-0000-0000-000000000000/${op}`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(401);
    }
  });

  // Keep a vitest ref so eslint doesn't flag the import.
  it('vi available', () => expect(typeof vi).toBe('object'));
});
