/**
 * Live tests for network metrics + onboarding (TASK-FC-01).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
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

const { Pool } = pkg;
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let ids: { franchisorId: string; denverId: string; austinId: string };
let cookies: { franchisorAdmin: string; denverOwner: string; denverTech: string };

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

async function createFranchisorAdmin(franchisorId: string): Promise<string> {
  const email = 'fc-fradmin@elevateddoors.test';
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: 'FC Admin' }),
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
  });
  await app.ready();
  cookies = {
    franchisorAdmin: await createFranchisorAdmin(ids.franchisorId),
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
  };
  // Seed a completed payment for denver so revenue tile is non-zero.
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (franchisee_id, name) VALUES ($1, 'FC Customer') RETURNING id`,
    [ids.denverId],
  );
  const job = await pool.query<{ id: string }>(
    `INSERT INTO jobs (franchisee_id, customer_id, title, status)
       VALUES ($1, $2, 'fc job', 'completed') RETURNING id`,
    [ids.denverId, cust.rows[0]!.id],
  );
  const inv = await pool.query<{ id: string }>(
    `INSERT INTO invoices
         (franchisee_id, job_id, customer_id, status, subtotal, tax_rate, tax_amount, total,
          application_fee_amount, finalized_at, paid_at)
       VALUES ($1, $2, $3, 'paid', 500.00, 0, 0, 500.00, 25.00, NOW(), NOW()) RETURNING id`,
    [ids.denverId, job.rows[0]!.id, cust.rows[0]!.id],
  );
  await pool.query(
    `INSERT INTO payments
       (franchisee_id, invoice_id, stripe_payment_intent_id, stripe_charge_id,
        amount, application_fee_amount, currency, status)
     VALUES ($1, $2, 'pi_fc_1', 'ch_fc_1', 500.00, 25.00, 'usd', 'succeeded')`,
    [ids.denverId, inv.rows[0]!.id],
  );
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('FC-01 / network metrics', () => {
  it('anonymous → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/franchisor/network-metrics',
    });
    expect(res.statusCode).toBe(401);
  });

  it('tech → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/franchisor/network-metrics',
      headers: { cookie: cookies.denverTech },
    });
    expect(res.statusCode).toBe(403);
  });

  it('denver owner (franchisee scope) → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/franchisor/network-metrics',
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(403);
  });

  it('franchisor admin gets totals + perFranchisee', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/franchisor/network-metrics',
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      totals: {
        revenueCents: number;
        franchiseeCount: number;
      };
      perFranchisee: Array<{ franchiseeId: string; name: string; revenueCents: number }>;
    };
    expect(data.totals.franchiseeCount).toBeGreaterThanOrEqual(2);
    expect(data.totals.revenueCents).toBeGreaterThanOrEqual(50000);
    const denver = data.perFranchisee.find((p) => p.franchiseeId === ids.denverId);
    expect(denver?.revenueCents).toBe(50000);
  });

  it('bad periodStart → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/franchisor/network-metrics?periodStart=not-a-date',
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('FC-01 / onboarding', () => {
  it('anonymous → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisor/onboard',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x', slug: 'x' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('tech → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisor/onboard',
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x', slug: 'x' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates a franchisee under caller scope + ignores client franchisorId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisor/onboard',
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Aurora Elevated',
        slug: 'aurora',
        legalEntityName: 'Aurora Elevated LLC',
        locationName: 'Aurora HQ',
        timezone: 'America/Denver',
        franchisorId: '00000000-0000-0000-0000-000000000000', // ignored
      }),
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { id: string; franchisorId: string; slug: string };
    expect(data.franchisorId).toBe(ids.franchisorId);
    expect(data.slug).toBe('aurora');
  });

  it('slug collision → 409 SLUG_TAKEN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisor/onboard',
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Denver 2', slug: 'denver' }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SLUG_TAKEN');
  });

  it('bad slug → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisor/onboard',
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Bad', slug: 'NOT Lowercase!' }),
    });
    expect(res.statusCode).toBe(400);
  });
});
