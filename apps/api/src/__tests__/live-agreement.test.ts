/**
 * Live Postgres tests for TASK-RE-03 agreement CRUD.
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
let cookies: {
  franchisorAdmin: string;
  denverOwner: string;
  denverTech: string;
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
  const c = extractCookie(res.headers['set-cookie']);
  if (!c) throw new Error('no cookie');
  return c;
}

async function createFranchisorAdmin(franchisorId: string): Promise<string> {
  const email = 're-fradmin@elevateddoors.test';
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: 'RE Admin' }),
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
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('RE-03 / agreement CRUD', () => {
  it('creates a draft agreement with rules', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/agreement`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Elevated 2026 Denver',
        rules: [{ type: 'percentage', params: { basisPoints: 800 } }],
      }),
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as {
      status: string;
      rules: Array<{ ruleType: string }>;
    };
    expect(data.status).toBe('draft');
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0]!.ruleType).toBe('percentage');
  });

  it('tech cannot create → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/agreement`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'tech try', rules: [] }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('franchisee owner cannot create → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/agreement`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'owner try', rules: [] }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET returns null when no agreement exists; populated after creation', async () => {
    const before = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.austinId}/agreement`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(before.json().data).toBeNull();

    await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.austinId}/agreement`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'austin', rules: [] }),
    });
    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.austinId}/agreement`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(after.json().data?.name).toBe('austin');
  });

  it('PATCH replaces rule set on a draft agreement', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/agreement`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Denver draft',
        rules: [{ type: 'percentage', params: { basisPoints: 500 } }],
      }),
    });
    const aid = create.json().data.id as string;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/franchisees/${ids.denverId}/agreement/${aid}`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        rules: [
          { type: 'percentage', params: { basisPoints: 800 } },
          { type: 'minimum_floor', params: { perMonthCents: 50000 } },
        ],
      }),
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.rules).toHaveLength(2);
  });

  it('activate transitions draft → active and ends prior active', async () => {
    const c1 = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/agreement`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'a1', rules: [] }),
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/agreement/${c1.json().data.id}/activate`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    const c2 = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/agreement`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'a2', rules: [] }),
    });
    const act = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/agreement/${c2.json().data.id}/activate`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(act.statusCode).toBe(200);
    const { rows } = await pool.query<{ status: string; count: number }>(
      `SELECT status, count(*)::int AS count FROM franchise_agreements
         WHERE franchisee_id = $1 GROUP BY status`,
      [ids.denverId],
    );
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));
    expect(byStatus['active']).toBe(1);
    expect((byStatus['ended'] ?? 0) + (byStatus['draft'] ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('PATCH on an active agreement → 409 AGREEMENT_LOCKED', async () => {
    const c = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.austinId}/agreement`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'austin live', rules: [] }),
    });
    const aid = c.json().data.id as string;
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
      payload: JSON.stringify({ name: 'nope' }),
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error.code).toBe('AGREEMENT_LOCKED');
  });

  it('malformed tiered rule (descending upToCents) → 400', async () => {
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
                { upToCents: 100000, basisPoints: 500 },
                { upToCents: 50000, basisPoints: 300 },
              ],
            },
          },
        ],
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('franchisee owner can GET their own agreement', async () => {
    // Denver already has at least one active agreement from prior tests.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.denverId}/agreement`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(200);
    // Just verifies the read path works; may be null or populated
    // depending on test ordering.
    expect(res.json().ok).toBe(true);
  });
});
