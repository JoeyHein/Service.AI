/**
 * TASK-TM-07 — phase_tech_mobile_pwa security suite.
 *
 * Locks the threat-model contract for the three new endpoint
 * families in this phase:
 *   - invoices      /api/v1/jobs/:id/invoices, /api/v1/invoices/*
 *   - push          /api/v1/push/*
 *
 * Gate floor is ≥20 cases, <30s runtime. Test cases grouped by
 * shared beforeAll state so the whole suite runs in a single
 * process on one seeded DB.
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
let cookies: {
  denverOwner: string;
  denverTech: string;
  denverTech2: string;
  austinOwner: string;
};
let denverJobId: string;
let austinJobId: string;
let installItemId: string;
let rollerItemId: string;

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
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    denverTech2: await signIn('denver.tech2@elevateddoors.test'),
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
  };

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

  denverJobId = (await createCustomerAndJob(cookies.denverOwner, 'Sec D')).jobId;
  austinJobId = (await createCustomerAndJob(cookies.austinOwner, 'Sec A')).jobId;
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

// ---------------------------------------------------------------------------
// Invoices — anonymous, validation, cross-tenancy, bounds, not-editable
// ---------------------------------------------------------------------------

describe('TM-07 / invoices — auth + validation', () => {
  it('anonymous POST /jobs/:id/invoices → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [] }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('anonymous GET /invoices/:id → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/invoices/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(401);
  });

  it('anonymous PATCH /invoices/:id → 401', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/invoices/00000000-0000-0000-0000-000000000000',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(401);
  });

  it('anonymous DELETE /invoices/:id → 401', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/invoices/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(401);
  });

  it('non-UUID :id → 400 VALIDATION_ERROR on create', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs/not-a-uuid/invoices',
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('missing body lines schema → still accepts (lines optional defaults to [])', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('TM-07 / invoices — cross-tenancy', () => {
  it('Denver tech creating an invoice for Austin\'s job → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${austinJobId}/invoices`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [] }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('Denver tech GETting an Austin-owned invoice → 404', async () => {
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
      headers: { cookie: cookies.denverTech },
    });
    expect(res.statusCode).toBe(404);
  });

  it('Austin owner PATCHing a Denver invoice → 404', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [] }),
    });
    const invId = create.json().data.id as string;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/invoices/${invId}`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ notes: 'nope' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('Austin owner DELETEing a Denver invoice → 404', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [] }),
    });
    const invId = create.json().data.id as string;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/invoices/${invId}`,
      headers: { cookie: cookies.austinOwner },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('TM-07 / invoices — bounds + state machine', () => {
  it('line unit_price below floor → 400 PRICE_OUT_OF_BOUNDS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [{ serviceItemId: installItemId, quantity: 1, unitPrice: 500 }],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PRICE_OUT_OF_BOUNDS');
  });

  it('line unit_price above ceiling → 400 PRICE_OUT_OF_BOUNDS', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [{ serviceItemId: installItemId, quantity: 1, unitPrice: 9999 }],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PRICE_OUT_OF_BOUNDS');
  });

  it('PATCH line with out-of-bounds override → 400 PRICE_OUT_OF_BOUNDS', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ lines: [] }),
    });
    const invId = create.json().data.id as string;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/invoices/${invId}`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [{ serviceItemId: rollerItemId, quantity: 1, unitPrice: 9999 }],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PRICE_OUT_OF_BOUNDS');
  });

  it('PATCH a finalised invoice → 409 INVOICE_NOT_EDITABLE', async () => {
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
      payload: JSON.stringify({ notes: 'no' }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVOICE_NOT_EDITABLE');
  });

  it('DELETE a finalised invoice → 409 INVOICE_NOT_EDITABLE', async () => {
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
  });

  it('line with a non-existent service_item_id → 400 INVALID_TARGET', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/invoices`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        lines: [
          { serviceItemId: '00000000-0000-0000-0000-000000000000', quantity: 1 },
        ],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TARGET');
  });
});

// ---------------------------------------------------------------------------
// Push subscribe
// ---------------------------------------------------------------------------

describe('TM-07 / push — auth + validation', () => {
  it('anonymous POST /push/subscribe → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        endpoint: 'https://example.com/x',
        keys: { p256dh: 'a', auth: 'b' },
      }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('anonymous DELETE /push/subscribe → 401', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/push/subscribe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ endpoint: 'https://example.com/x' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('malformed endpoint → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({
        endpoint: 'not a url',
        keys: { p256dh: 'a', auth: 'b' },
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('missing keys → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ endpoint: 'https://a.test/x' }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('TM-07 / push — one-user-one-sub ownership', () => {
  it('tech1 cannot delete tech2\'s subscription by id → 404', async () => {
    const sub = {
      endpoint: 'https://fcm.googleapis.com/wp/tm07-own',
      keys: { p256dh: 'p', auth: 'a' },
    };
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify(sub),
    });
    const id = create.json().data.id as string;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/push/subscriptions/${id}`,
      headers: { cookie: cookies.denverTech2 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('tech1 cannot delete tech2\'s subscription by endpoint → 404', async () => {
    const sub = {
      endpoint: 'https://fcm.googleapis.com/wp/tm07-own-endpoint',
      keys: { p256dh: 'p', auth: 'a' },
    };
    await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify(sub),
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookies.denverTech2, 'content-type': 'application/json' },
      payload: JSON.stringify({ endpoint: sub.endpoint }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('tech1 deleting tech1\'s own subscription by id → 200', async () => {
    const sub = {
      endpoint: 'https://fcm.googleapis.com/wp/tm07-ok-delete',
      keys: { p256dh: 'p', auth: 'a' },
    };
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify(sub),
    });
    const id = create.json().data.id as string;
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/push/subscriptions/${id}`,
      headers: { cookie: cookies.denverTech },
    });
    expect(res.statusCode).toBe(200);
  });
});
