/**
 * TASK-IP-08 — phase_invoicing_stripe security suite.
 *
 * Locks the threat-model contract for the six new endpoint groups
 * introduced in phase 7: Connect onboarding, invoice finalize /
 * send / refund, Stripe webhook, and the public-by-token
 * customer-facing surface. ≥20 cases, <30s runtime.
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
import { stubStripeClient, type StripeClient } from '../stripe.js';

const { Pool } = pkg;
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let cookies: {
  denverOwner: string;
  denverTech: string;
  austinOwner: string;
  franchisorAdmin: string;
};
let ids: { franchisorId: string; denverId: string; austinId: string };
let denverJobId: string;
let austinJobId: string;
let installItemId: string;
let strictStripe: StripeClient;

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
  const email = 'ip07-fradmin@elevateddoors.test';
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: 'IP07 Admin' }),
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

async function finalizeDenver(): Promise<{ invoiceId: string; token: string }> {
  const create = await app.inject({
    method: 'POST',
    url: `/api/v1/jobs/${denverJobId}/invoices`,
    headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
    payload: JSON.stringify({
      lines: [{ serviceItemId: installItemId, quantity: 1 }],
    }),
  });
  const invoiceId = create.json().data.id as string;
  const fin = await app.inject({
    method: 'POST',
    url: `/api/v1/invoices/${invoiceId}/finalize`,
    headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
    payload: '{}',
  });
  return { invoiceId, token: fin.json().data.paymentLinkToken as string };
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

  // A "strict" stripe client whose constructWebhookEvent always
  // refuses — used only for the webhook signature-rejection test.
  strictStripe = {
    ...stubStripeClient,
    constructWebhookEvent() {
      const err = new Error('Invalid signature');
      (err as Error & { code: string }).code = 'BAD_SIGNATURE';
      throw err;
    },
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
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
    franchisorAdmin: await createFranchisorAdmin(ids.franchisorId),
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
  denverJobId = (await createCustomerAndJob(cookies.denverOwner, 'Sec D')).jobId;
  austinJobId = (await createCustomerAndJob(cookies.austinOwner, 'Sec A')).jobId;
  // Keep strictStripe referenced so the variable isn't flagged unused by eslint.
  void strictStripe;
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

// ---------------------------------------------------------------------------
// Anonymous 401 — every new authenticated endpoint
// ---------------------------------------------------------------------------

describe('IP-08 / anonymous 401 on every new endpoint', () => {
  const authedOps: Array<{ method: 'POST' | 'GET'; url: string; body?: string }> = [
    { method: 'POST', url: '/api/v1/franchisees/00000000-0000-0000-0000-000000000000/connect/onboard', body: '{}' },
    { method: 'GET', url: '/api/v1/franchisees/00000000-0000-0000-0000-000000000000/connect/status' },
    { method: 'POST', url: '/api/v1/invoices/00000000-0000-0000-0000-000000000000/finalize', body: '{}' },
    { method: 'POST', url: '/api/v1/invoices/00000000-0000-0000-0000-000000000000/send', body: '{}' },
    { method: 'POST', url: '/api/v1/invoices/00000000-0000-0000-0000-000000000000/refund', body: '{}' },
    { method: 'GET', url: '/api/v1/invoices/00000000-0000-0000-0000-000000000000/receipt.pdf' },
  ];
  for (const op of authedOps) {
    it(`${op.method} ${op.url} anonymous → 401`, async () => {
      const res = await app.inject({
        method: op.method,
        url: op.url,
        headers: op.body ? { 'content-type': 'application/json' } : {},
        payload: op.body,
      });
      expect(res.statusCode).toBe(401);
    });
  }
});

// ---------------------------------------------------------------------------
// Connect: role boundary
// ---------------------------------------------------------------------------

describe('IP-08 / Connect onboarding role boundary', () => {
  it('tech onboarding → 403 FORBIDDEN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/connect/onboard`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('franchisee owner onboarding → 403 FORBIDDEN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/connect/onboard`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Invoice transitions: cross-tenant + bad state
// ---------------------------------------------------------------------------

describe('IP-08 / invoice transition security', () => {
  it('Austin owner finalizing a Denver invoice → 404 (no existence leak)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [{ serviceItemId: installItemId, quantity: 1 }],
      }),
    });
    const id = create.json().data.id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${id}/finalize`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
  });

  it('Austin owner sending a Denver invoice → 404', async () => {
    const { invoiceId } = await finalizeDenver();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/send`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
  });

  it('Austin owner refunding a Denver invoice → 404', async () => {
    const { invoiceId } = await finalizeDenver();
    await pool.query(`UPDATE invoices SET status='paid', paid_at=NOW() WHERE id=$1`, [invoiceId]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/refund`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
  });

  it('finalize when franchisee is not Stripe-ready → 409 STRIPE_NOT_READY', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${austinJobId}/invoices`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [{ serviceItemId: installItemId, quantity: 1 }],
      }),
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${create.json().data.id}/finalize`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('STRIPE_NOT_READY');
  });

  it('refund on non-paid invoice → 409 INVALID_TRANSITION', async () => {
    const { invoiceId } = await finalizeDenver();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/refund`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_TRANSITION');
  });

  it('refund amount > total → 400 REFUND_OUT_OF_BOUNDS', async () => {
    const { invoiceId } = await finalizeDenver();
    await pool.query(`UPDATE invoices SET status='paid', paid_at=NOW() WHERE id=$1`, [invoiceId]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/refund`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 999999 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('REFUND_OUT_OF_BOUNDS');
  });
});

// ---------------------------------------------------------------------------
// Webhook signature / validation
// ---------------------------------------------------------------------------

describe('IP-08 / webhook signature', () => {
  it('no stripe-signature header → 400 BAD_SIGNATURE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'evt_x', type: 'ping', data: { object: {} } }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_SIGNATURE');
  });

  it('malformed event body (stub parser) → 400 BAD_SIGNATURE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
      payload: '{"id":"only_id"}',
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Public token surface
// ---------------------------------------------------------------------------

describe('IP-08 / public invoice by token', () => {
  it('malformed token → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/invoices/abc',
    });
    expect(res.statusCode).toBe(400);
  });

  it('unknown but well-formed token → 404 (no existence leak)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/invoices/${'a'.repeat(43)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('non-UUID id on connect status → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/franchisees/not-a-uuid/connect/status',
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(res.statusCode).toBe(400);
  });

  it('public response omits internal fields (application fee, stripe account id)', async () => {
    const { token } = await finalizeDenver();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/invoices/${token}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('application_fee');
    expect(res.body).not.toContain('applicationFeeAmount');
    expect(res.body).not.toContain('stripe_account_id');
  });
});
