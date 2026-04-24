/**
 * TASK-FC-05 — phase_franchisor_console security suite.
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
let ids: {
  franchisorAId: string;
  franchisorBId: string;
  denverId: string;
  austinId: string;
};
let cookies: {
  franchisorAAdmin: string;
  franchisorBAdmin: string;
  denverOwner: string;
  denverTech: string;
  denverCsr: string;
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
  if (!c) throw new Error(`no cookie for ${email}`);
  return c;
}

async function createFranchisorAdmin(
  franchisorId: string,
  email: string,
): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: email }),
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
    franchisorAId: seed.franchisorId,
    franchisorBId: '', // set below
    denverId: seed.franchisees.find((f) => f.slug === 'denver')!.id,
    austinId: seed.franchisees.find((f) => f.slug === 'austin')!.id,
  };

  // Insert a completely separate franchisor + franchisee so we can
  // test the cross-franchisor visibility constraints.
  const franchisorB = await pool.query<{ id: string }>(
    `INSERT INTO franchisors (name, slug)
       VALUES ('Alt Franchisor', 'alt-franchisor') RETURNING id`,
  );
  ids.franchisorBId = franchisorB.rows[0]!.id;
  await pool.query(
    `INSERT INTO franchisees (franchisor_id, name, slug)
       VALUES ($1, 'Altopia', 'altopia')`,
    [ids.franchisorBId],
  );

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
    franchisorAAdmin: await createFranchisorAdmin(
      ids.franchisorAId,
      'fc-a-fradmin@elevateddoors.test',
    ),
    franchisorBAdmin: await createFranchisorAdmin(
      ids.franchisorBId,
      'fc-b-fradmin@elevateddoors.test',
    ),
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    denverCsr: await signIn('denver.csr@elevateddoors.test'),
  };
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

describe('FC-05 / anonymous 401', () => {
  const ops: Array<{ method: 'GET' | 'POST'; url: string; body?: string }> = [
    { method: 'GET', url: '/api/v1/franchisor/network-metrics' },
    {
      method: 'POST',
      url: '/api/v1/franchisor/onboard',
      body: JSON.stringify({ name: 'x', slug: 'x' }),
    },
    { method: 'GET', url: '/api/v1/audit-log?q=test' },
    { method: 'GET', url: '/api/v1/audit-log?kind=invoice' },
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

describe('FC-05 / role boundary', () => {
  it('tech cannot read network metrics → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/franchisor/network-metrics',
      headers: { cookie: cookies.denverTech },
    });
    expect(res.statusCode).toBe(403);
  });

  it('franchisee owner cannot read network metrics → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/franchisor/network-metrics',
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(403);
  });

  it('CSR cannot read audit log filters → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log?q=invoice',
      headers: { cookie: cookies.denverCsr },
    });
    expect(res.statusCode).toBe(403);
  });

  it('tech cannot onboard → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisor/onboard',
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Hack', slug: 'hack' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('CSR cannot onboard → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisor/onboard',
      headers: { cookie: cookies.denverCsr, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Hack', slug: 'hack-csr' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('franchisee owner cannot onboard → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisor/onboard',
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Hack', slug: 'hack-owner' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('franchisor admin CAN read network metrics', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/franchisor/network-metrics',
      headers: { cookie: cookies.franchisorAAdmin },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Cross-franchisor visibility
// ---------------------------------------------------------------------------

describe('FC-05 / cross-franchisor', () => {
  it('franchisor A admin sees only franchisor A franchisees in metrics', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/franchisor/network-metrics',
      headers: { cookie: cookies.franchisorAAdmin },
    });
    const data = res.json().data as {
      perFranchisee: Array<{ franchiseeId: string }>;
    };
    const denverIncluded = data.perFranchisee.some(
      (p) => p.franchiseeId === ids.denverId,
    );
    expect(denverIncluded).toBe(true);
    // And the altopia franchisee (franchisor B) is NOT in the list.
    const altRows = await pool.query<{ id: string }>(
      `SELECT id FROM franchisees WHERE franchisor_id = $1`,
      [ids.franchisorBId],
    );
    const altId = altRows.rows[0]!.id;
    expect(
      data.perFranchisee.some((p) => p.franchiseeId === altId),
    ).toBe(false);
  });

  it('franchisor B admin sees only franchisor B franchisees in metrics', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/franchisor/network-metrics',
      headers: { cookie: cookies.franchisorBAdmin },
    });
    const data = res.json().data as {
      perFranchisee: Array<{ franchiseeId: string }>;
      totals: { franchiseeCount: number };
    };
    expect(data.totals.franchiseeCount).toBe(1);
    expect(
      data.perFranchisee.some((p) => p.franchiseeId === ids.denverId),
    ).toBe(false);
  });

  it('onboard POST with a foreign franchisorId in body is ignored', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisor/onboard',
      headers: {
        cookie: cookies.franchisorAAdmin,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        name: 'Sneaky',
        slug: 'sneaky',
        franchisorId: ids.franchisorBId, // should be ignored
      }),
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { franchisorId: string };
    expect(data.franchisorId).toBe(ids.franchisorAId);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('FC-05 / validation', () => {
  it('missing slug → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisor/onboard',
      headers: {
        cookie: cookies.franchisorAAdmin,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ name: 'No slug' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('uppercase slug → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisor/onboard',
      headers: {
        cookie: cookies.franchisorAAdmin,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ name: 'Bad', slug: 'BadSlug' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('duplicate slug inside same franchisor → 409 SLUG_TAKEN', async () => {
    // Seed uses slug 'denver', so re-creating it throws 409.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisor/onboard',
      headers: {
        cookie: cookies.franchisorAAdmin,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ name: 'Dup', slug: 'denver' }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SLUG_TAKEN');
  });

  it('bad periodStart ISO → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/franchisor/network-metrics?periodStart=not-iso',
      headers: { cookie: cookies.franchisorAAdmin },
    });
    expect(res.statusCode).toBe(400);
  });

  it('bad kind on audit-log → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log?kind=whatever',
      headers: { cookie: cookies.franchisorAAdmin },
    });
    expect(res.statusCode).toBe(400);
  });

  it('SQL-injection attempt in ?q= → 0 rows, 200 OK', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/audit-log?q=${encodeURIComponent("' OR 1=1--")}`,
      headers: { cookie: cookies.franchisorAAdmin },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { total: number };
    expect(data.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Metrics shape
// ---------------------------------------------------------------------------

describe('FC-05 / metrics shape', () => {
  it('returns totals + perFranchisee with numeric fields', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/franchisor/network-metrics',
      headers: { cookie: cookies.franchisorAAdmin },
    });
    const data = res.json().data as {
      totals: { revenueCents: number; franchiseeCount: number };
      perFranchisee: Array<{
        franchiseeId: string;
        revenueCents: number;
        aiCostUsd: number;
      }>;
    };
    expect(typeof data.totals.revenueCents).toBe('number');
    expect(typeof data.totals.franchiseeCount).toBe('number');
    for (const p of data.perFranchisee) {
      expect(typeof p.revenueCents).toBe('number');
      expect(typeof p.aiCostUsd).toBe('number');
    }
  });
});
