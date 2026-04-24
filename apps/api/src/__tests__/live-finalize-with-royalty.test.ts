/**
 * Live test for TASK-RE-04 — finalize resolves the platform fee
 * through the royalty engine using the franchisee's active
 * agreement instead of a hard-coded 5%.
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
let cookies: { denverOwner: string; franchisorAdmin: string };
let ids: { franchisorId: string; denverId: string };
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
  const email = 're04-fradmin@elevateddoors.test';
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: 'RE04 Admin' }),
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

async function createAndFinalize(cookie: string): Promise<{ invoiceId: string; feeDollars: number }> {
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
    throw new Error(`finalize failed: ${fin.body}`);
  }
  return {
    invoiceId,
    feeDollars: Number(fin.json().data.applicationFeeAmount),
  };
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
  const cust = await app.inject({
    method: 'POST',
    url: '/api/v1/customers',
    headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'RE04 Co' }),
  });
  const job = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
    payload: JSON.stringify({ customerId: cust.json().data.id, title: 'RE04 Job' }),
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

describe('RE-04 / finalize via royalty engine', () => {
  it('no agreement → falls back to 5% (phase-7 behaviour)', async () => {
    const { feeDollars } = await createAndFinalize(cookies.denverOwner);
    // INST-SC-STEEL base price is 1200; 5% = 60.
    expect(feeDollars).toBe(60);
  });

  it('active 10% agreement → 10% fee on the invoice', async () => {
    // Create + activate a 10% agreement.
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/agreement`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: '10% royalty',
        rules: [{ type: 'percentage', params: { basisPoints: 1000 } }],
      }),
    });
    const aid = create.json().data.id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/agreement/${aid}/activate`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });

    const { feeDollars } = await createAndFinalize(cookies.denverOwner);
    // 10% of 1200 = 120.
    expect(feeDollars).toBe(120);
  });

  it('replacing rules with flat $25 changes the fee on next finalize', async () => {
    // End the current active (by creating + activating a new one).
    const next = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/agreement`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'flat $25',
        rules: [{ type: 'flat_per_job', params: { amountCents: 2500 } }],
      }),
    });
    const aid = next.json().data.id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/agreement/${aid}/activate`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });

    const { feeDollars } = await createAndFinalize(cookies.denverOwner);
    expect(feeDollars).toBe(25);
  });
});
