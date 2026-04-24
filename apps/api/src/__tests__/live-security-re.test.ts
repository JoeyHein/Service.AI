/**
 * TASK-RE-08 — phase_royalty_engine security suite.
 *
 * Locks the threat-model contract for the new endpoint groups:
 * agreement CRUD + activate, statement generation + reconcile +
 * list. ≥20 cases, <30s runtime.
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
let cookies: {
  franchisorAdmin: string;
  denverOwner: string;
  denverTech: string;
  austinOwner: string;
};
let ids: { franchisorId: string; denverId: string; austinId: string };
let denverAgreementId: string;

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
  const email = 're08-fradmin@elevateddoors.test';
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: 'RE08 Admin' }),
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
    publicBaseUrl: 'http://app.test',
  });
  await app.ready();
  cookies = {
    franchisorAdmin: await createFranchisorAdmin(ids.franchisorId),
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
  };
  // Seed a draft denver agreement the tests can refer to.
  const draft = await app.inject({
    method: 'POST',
    url: `/api/v1/franchisees/${ids.denverId}/agreement`,
    headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'RE08 draft', rules: [] }),
  });
  denverAgreementId = draft.json().data.id as string;
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

// ---------------------------------------------------------------------------
// Anonymous 401 — every new endpoint
// ---------------------------------------------------------------------------

describe('RE-08 / anonymous 401', () => {
  const ops: Array<{ method: 'POST' | 'GET' | 'PATCH'; url: string; body?: string }> = [
    { method: 'POST', url: '/api/v1/franchisees/00000000-0000-0000-0000-000000000000/agreement', body: '{}' },
    { method: 'GET', url: '/api/v1/franchisees/00000000-0000-0000-0000-000000000000/agreement' },
    { method: 'PATCH', url: '/api/v1/franchisees/00000000-0000-0000-0000-000000000000/agreement/00000000-0000-0000-0000-000000000000', body: '{}' },
    { method: 'POST', url: '/api/v1/franchisees/00000000-0000-0000-0000-000000000000/agreement/00000000-0000-0000-0000-000000000000/activate', body: '{}' },
    { method: 'POST', url: '/api/v1/franchisees/00000000-0000-0000-0000-000000000000/statements/generate', body: '{}' },
    { method: 'GET', url: '/api/v1/franchisees/00000000-0000-0000-0000-000000000000/statements' },
    { method: 'GET', url: '/api/v1/statements' },
    { method: 'POST', url: '/api/v1/statements/00000000-0000-0000-0000-000000000000/reconcile', body: '{}' },
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
// Role boundary — tech / owner / cross-franchisor
// ---------------------------------------------------------------------------

describe('RE-08 / role boundary', () => {
  it('tech POST agreement → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/agreement`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'tech', rules: [] }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('franchisee owner POST agreement → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/agreement`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'owner', rules: [] }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('austin owner PATCH a Denver agreement → 403 (not their franchisor)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/franchisees/${ids.denverId}/agreement/${denverAgreementId}`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'forbidden' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('tech statement generate → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/statements/generate`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ year: 2026, month: 1 }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('franchisee owner cannot reconcile → 403', async () => {
    // Create a statement first via admin.
    await pool.query(
      `INSERT INTO royalty_statements
         (franchisee_id, franchisor_id, period_start, period_end,
          gross_revenue, refund_total, net_revenue, royalty_owed,
          royalty_collected, variance, status)
       VALUES ($1, $2, '2026-01-01', '2026-02-01', 0, 0, 0, 0, 0, 0, 'open')
       ON CONFLICT DO NOTHING`,
      [ids.denverId, ids.franchisorId],
    );
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM royalty_statements WHERE franchisee_id = $1 LIMIT 1`,
      [ids.denverId],
    );
    const sid = rows[0]!.id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/statements/${sid}/reconcile`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Visibility: franchisee self-view + cross-tenant reads
// ---------------------------------------------------------------------------

describe('RE-08 / visibility', () => {
  it('austin owner listing Denver statements → 404 (no existence leak)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.denverId}/statements`,
      headers: { cookie: cookies.austinOwner },
    });
    expect(res.statusCode).toBe(404);
  });

  it('franchisee owner reading own agreement → 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.denverId}/agreement`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(200);
  });

  it('franchisee owner reading cross-franchisee agreement → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.austinId}/agreement`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/v1/statements by franchisee owner returns only own rows', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/statements',
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data.rows as Array<{ franchiseeId: string }>;
    for (const r of rows) expect(r.franchiseeId).toBe(ids.denverId);
  });
});

// ---------------------------------------------------------------------------
// Rule validation + state machine
// ---------------------------------------------------------------------------

describe('RE-08 / rule validation', () => {
  it('percentage with basisPoints > 10000 → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/agreement`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'bad pct',
        rules: [{ type: 'percentage', params: { basisPoints: 20000 } }],
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('tiered with null upToCents not at the tail → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/agreement`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'bad tiers',
        rules: [
          {
            type: 'tiered',
            params: {
              tiers: [
                { upToCents: null, basisPoints: 1000 },
                { upToCents: 100000, basisPoints: 500 },
              ],
            },
          },
        ],
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH on an active agreement → 409 AGREEMENT_LOCKED', async () => {
    // Create + activate a dedicated agreement for this test so we
    // don't perturb the denverAgreementId used elsewhere.
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.austinId}/agreement`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'austin active', rules: [] }),
    });
    const aid = create.json().data.id as string;
    await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.austinId}/agreement/${aid}/activate`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/franchisees/${ids.austinId}/agreement/${aid}`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'renamed' }),
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error.code).toBe('AGREEMENT_LOCKED');
  });

  it('non-UUID ids → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/franchisees/not-a-uuid/agreement',
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(res.statusCode).toBe(400);
  });

  it('statement generate with bad month → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/statements/generate`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ year: 2026, month: 13 }),
    });
    expect(res.statusCode).toBe(400);
  });
});
