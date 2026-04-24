/**
 * Live Postgres tests for TASK-IP-03 Stripe Connect onboarding.
 *
 * Uses stubStripeClient so no network is required. Verifies
 * end-to-end that the franchisee row picks up an acct_stub_* id,
 * account-link URL is returned, and cross-franchisor access is
 * forbidden.
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
  denverOwner: string;
  denverTech: string;
  austinOwner: string;
  franchisorAdmin: string;
};

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

async function createFranchisorAdmin(franchisorId: string): Promise<string> {
  const email = 'connect-fradmin@elevateddoors.test';
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: 'Connect Admin' }),
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
    stripe: stubStripeClient,
    publicBaseUrl: 'http://localhost:3000',
  });
  await app.ready();
  cookies = {
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
    franchisorAdmin: await createFranchisorAdmin(ids.franchisorId),
  };
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('IP-03 / Connect onboarding', () => {
  it('anonymous onboard → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/connect/onboard`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('franchisor admin onboarding creates an acct_stub_* account and returns onboarding URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/connect/onboard`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { accountId: string; onboardingUrl: string };
    expect(data.accountId).toMatch(/^acct_stub_/);
    expect(data.onboardingUrl).toContain('connect.stripe.test');

    const { rows } = await pool.query<{ stripe_account_id: string | null }>(
      `SELECT stripe_account_id FROM franchisees WHERE id = $1`,
      [ids.denverId],
    );
    expect(rows[0]?.stripe_account_id).toBe(data.accountId);
  });

  it('second onboard call reuses the existing account id', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/connect/onboard`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/connect/onboard`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.accountId).toBe(first.json().data.accountId);
  });

  it('tech → 403 FORBIDDEN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/connect/onboard`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('franchisee owner → 403 FORBIDDEN (admin-only, not owner-in-scope)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/connect/onboard`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
  });

  it('franchisor admin status returns current booleans + syncs on retrieve', async () => {
    // First populate the account via onboard (so stripeAccountId is set).
    await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.austinId}/connect/onboard`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    // Manually flip the stub's signal so retrieveAccount returns ready=true
    // by giving the franchisee an account id ending in _ready.
    await pool.query(
      `UPDATE franchisees SET stripe_account_id = $1 WHERE id = $2`,
      ['acct_stub_austin_ready', ids.austinId],
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.austinId}/connect/status`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { chargesEnabled: boolean };
    expect(data.chargesEnabled).toBe(true);

    const { rows } = await pool.query<{ stripe_charges_enabled: boolean }>(
      `SELECT stripe_charges_enabled FROM franchisees WHERE id = $1`,
      [ids.austinId],
    );
    expect(rows[0]?.stripe_charges_enabled).toBe(true);
  });

  it('non-UUID id → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisees/not-a-uuid/connect/onboard',
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
  });
});
