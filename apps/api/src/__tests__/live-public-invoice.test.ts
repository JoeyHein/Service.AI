/**
 * Live Postgres tests for TASK-IP-07 public invoice surface.
 *
 *   GET /api/v1/public/invoices/:token
 *   GET /api/v1/invoices/:id/receipt.pdf
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
let austinOwnerCookie: string;
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

async function finalizeInvoice(cookie: string): Promise<{
  invoiceId: string;
  token: string;
}> {
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
  return { invoiceId, token: fin.json().data.paymentLinkToken as string };
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
  denverOwnerCookie = await signIn('denver.owner@elevateddoors.test');
  austinOwnerCookie = await signIn('austin.owner@elevateddoors.test');
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
    payload: JSON.stringify({ name: 'Public Co', email: 'pub@example.test' }),
  });
  const job = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: { cookie: denverOwnerCookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ customerId: cust.json().data.id, title: 'Public Job' }),
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

describe('IP-07 / public invoice by token', () => {
  it('valid token returns invoice summary (no secrets)', async () => {
    const { token } = await finalizeInvoice(denverOwnerCookie);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/invoices/${token}`,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      total: string;
      customerName: string;
      franchiseeName: string;
      paymentIntentId: string | null;
    };
    expect(data.customerName).toBe('Public Co');
    expect(data.paymentIntentId).toMatch(/^pi_stub_/);
    // Envelope must not contain stripe payment link tokens, raw
    // charge ids, etc. — only what the pay page needs.
    const bodyText = res.body;
    expect(bodyText).not.toContain('application_fee');
    expect(bodyText).not.toContain('stripe_account_id');
  });

  it('malformed token → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/invoices/short',
    });
    expect(res.statusCode).toBe(400);
  });

  it('unknown but well-formed token → 404', async () => {
    const fake = 'z'.repeat(43);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/invoices/${fake}`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('IP-07 / receipt PDF', () => {
  it('returns a valid PDF for a finalized invoice', async () => {
    const { invoiceId } = await finalizeInvoice(denverOwnerCookie);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${invoiceId}/receipt.pdf`,
      headers: { cookie: denverOwnerCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.slice(0, 4).toString()).toBe('%PDF');
  });

  it('draft invoice → 409 INVALID_TRANSITION', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: denverOwnerCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [{ serviceItemId: installItemId, quantity: 1 }],
      }),
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${create.json().data.id}/receipt.pdf`,
      headers: { cookie: denverOwnerCookie },
    });
    expect(res.statusCode).toBe(409);
  });

  it('cross-tenant → 404', async () => {
    const { invoiceId } = await finalizeInvoice(denverOwnerCookie);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/invoices/${invoiceId}/receipt.pdf`,
      headers: { cookie: austinOwnerCookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('anonymous → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/invoices/00000000-0000-0000-0000-000000000000/receipt.pdf',
    });
    expect(res.statusCode).toBe(401);
  });
});
