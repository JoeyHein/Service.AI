/**
 * TASK-CO-07 — phase_ai_collections security suite.
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
import { stubAIClient } from '@service-ai/ai';
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
  denverCsr: string;
  austinOwner: string;
};
let denverDraftId: string;
let austinDraftId: string;
let denverRetryId: string;
let austinRetryId: string;

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
  if (!c) throw new Error(`no cookie for ${email}`);
  return c;
}

async function seedDraft(franchiseeId: string, tokenPrefix: string): Promise<{ draftId: string; retryId: string }> {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (franchisee_id, name) VALUES ($1, $2) RETURNING id`,
    [franchiseeId, `sec-${tokenPrefix}`],
  );
  const job = await pool.query<{ id: string }>(
    `INSERT INTO jobs (franchisee_id, customer_id, title, status)
       VALUES ($1, $2, 'sec job', 'completed') RETURNING id`,
    [franchiseeId, cust.rows[0]!.id],
  );
  const inv = await pool.query<{ id: string }>(
    `INSERT INTO invoices
         (franchisee_id, job_id, customer_id, status, subtotal, tax_rate,
          tax_amount, total, application_fee_amount, finalized_at,
          stripe_payment_intent_id, payment_link_token)
       VALUES ($1, $2, $3, 'sent', 100.00, 0, 0, 100.00, 5.00,
               NOW() - INTERVAL '8 days', $4, $5)
       RETURNING id`,
    [franchiseeId, job.rows[0]!.id, cust.rows[0]!.id, `pi_sec_${tokenPrefix}`, `${tokenPrefix}-tok-00000000000000000000000000000`],
  );
  const draft = await pool.query<{ id: string }>(
    `INSERT INTO collections_drafts
         (franchisee_id, invoice_id, tone, sms_body, email_subject, email_body)
       VALUES ($1, $2, 'friendly', 'hi', 's', 'b') RETURNING id`,
    [franchiseeId, inv.rows[0]!.id],
  );
  const retry = await pool.query<{ id: string }>(
    `INSERT INTO payment_retries
         (franchisee_id, invoice_id, failure_code, scheduled_for, status)
       VALUES ($1, $2, 'card_declined', NOW(), 'scheduled') RETURNING id`,
    [franchiseeId, inv.rows[0]!.id],
  );
  return { draftId: draft.rows[0]!.id, retryId: retry.rows[0]!.id };
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
    aiClient: stubAIClient({ script: [] }),
    stripe: stubStripeClient,
    publicBaseUrl: 'http://app.test',
  });
  await app.ready();
  cookies = {
    denverDispatcher: await signIn('denver.dispatcher@elevateddoors.test'),
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    denverCsr: await signIn('denver.csr@elevateddoors.test'),
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
  };
  const d = await seedDraft(ids.denverId, 'den');
  denverDraftId = d.draftId;
  denverRetryId = d.retryId;
  const a = await seedDraft(ids.austinId, 'aus');
  austinDraftId = a.draftId;
  austinRetryId = a.retryId;
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

// ---------------------------------------------------------------------------
// Anonymous
// ---------------------------------------------------------------------------

describe('CO-07 / anonymous 401', () => {
  const ops: Array<{ method: 'POST' | 'GET'; url: string; body?: string }> = [
    { method: 'POST', url: '/api/v1/collections/run', body: '{}' },
    { method: 'GET', url: '/api/v1/collections/drafts' },
    { method: 'GET', url: '/api/v1/collections/metrics' },
    { method: 'POST', url: '/api/v1/collections/drafts/00000000-0000-0000-0000-000000000000/approve', body: '{}' },
    { method: 'POST', url: '/api/v1/collections/drafts/00000000-0000-0000-0000-000000000000/edit', body: '{}' },
    { method: 'POST', url: '/api/v1/collections/drafts/00000000-0000-0000-0000-000000000000/reject', body: '{}' },
    { method: 'POST', url: '/api/v1/payments/retries/00000000-0000-0000-0000-000000000000/run', body: '{}' },
  ];
  for (const op of ops) {
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
// Role boundary
// ---------------------------------------------------------------------------

describe('CO-07 / role boundary', () => {
  it('tech cannot approve → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/drafts/${denverDraftId}/approve`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
  });

  it('csr cannot list → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/drafts',
      headers: { cookie: cookies.denverCsr },
    });
    expect(res.statusCode).toBe(403);
  });

  it('tech cannot run retry → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/retries/${denverRetryId}/run`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
  });

  it('denver owner CAN list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/drafts',
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant
// ---------------------------------------------------------------------------

describe('CO-07 / cross-tenant', () => {
  it('denver owner cannot see austin drafts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/drafts',
      headers: { cookie: cookies.denverOwner },
    });
    const rows = res.json().data.rows as Array<{ id: string }>;
    expect(rows.some((r) => r.id === austinDraftId)).toBe(false);
  });

  it('denver owner approve on austin draft → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/drafts/${austinDraftId}/approve`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
  });

  it('denver owner edit on austin draft → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/drafts/${austinDraftId}/edit`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ smsBody: 'hack' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('denver owner reject on austin draft → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/drafts/${austinDraftId}/reject`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
  });

  it('denver owner retry run on austin retry → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/retries/${austinRetryId}/run`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// State machine + validation
// ---------------------------------------------------------------------------

describe('CO-07 / state machine + validation', () => {
  it('edit with bad tone → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/drafts/${denverDraftId}/edit`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ tone: 'hostile' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('non-UUID id → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/collections/drafts/not-a-uuid/approve',
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
  });

  it('reject a pending draft → 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/drafts/${denverDraftId}/reject`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('rejected');
  });

  it('reject on already-rejected draft → 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/drafts/${denverDraftId}/reject`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DRAFT_NOT_PENDING');
  });

  it('retry run on already-succeeded → 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/retries/${denverRetryId}/run`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    // Second run → 409
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/payments/retries/${denverRetryId}/run`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('RETRY_NOT_SCHEDULED');
  });

  it('metrics endpoint returns shape for franchisee-scoped caller', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/collections/metrics',
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { dsoDays: number };
    expect(typeof data.dsoDays).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Webhook payment_intent.payment_failed enqueues idempotently
// ---------------------------------------------------------------------------

describe('CO-07 / webhook retry scheduling', () => {
  it('webhook schedules one retry row per failed event id', async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (franchisee_id, name) VALUES ($1, 'Dup') RETURNING id`,
      [ids.denverId],
    );
    const job = await pool.query<{ id: string }>(
      `INSERT INTO jobs (franchisee_id, customer_id, title, status)
         VALUES ($1, $2, 'dup', 'scheduled') RETURNING id`,
      [ids.denverId, cust.rows[0]!.id],
    );
    const inv = await pool.query<{ id: string }>(
      `INSERT INTO invoices
           (franchisee_id, job_id, customer_id, status, subtotal, tax_rate,
            tax_amount, total, finalized_at, stripe_payment_intent_id)
         VALUES ($1, $2, $3, 'sent', 100.00, 0, 0, 100.00, NOW(), 'pi_dup_retry')
         RETURNING id`,
      [ids.denverId, job.rows[0]!.id, cust.rows[0]!.id],
    );
    const payload = JSON.stringify({
      id: 'evt_dup_fail',
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_dup_retry',
          last_payment_error: { code: 'card_declined' },
        },
      },
    });
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const { rows } = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM payment_retries WHERE invoice_id = $1`,
      [inv.rows[0]!.id],
    );
    expect(Number(rows[0]?.c)).toBe(1);
  });
});
