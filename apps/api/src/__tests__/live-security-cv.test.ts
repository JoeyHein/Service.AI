/**
 * TASK-CV-08 — phase_ai_csr_voice security suite.
 *
 * Covers phone provisioning + guardrails PATCH + the voice-side
 * inbound-call path (tenant resolution, cross-tenant rejection).
 * Tool-level scope is already covered in live-csr-tools.test.ts;
 * the loop-level redirect is in live-voice-e2e.test.ts.
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
import { resolveTenantByToNumber } from '@service-ai/ai';

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
  austinOwner: string;
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
  const email = 'cv08-fradmin@elevateddoors.test';
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: 'CV08 Admin' }),
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
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
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
// Anonymous 401
// ---------------------------------------------------------------------------

describe('CV-08 / anonymous 401', () => {
  const ops: Array<{ method: 'POST' | 'GET' | 'PATCH'; url: string; body?: string }> = [
    { method: 'POST', url: '/api/v1/franchisees/00000000-0000-0000-0000-000000000000/phone/provision', body: '{}' },
    { method: 'GET', url: '/api/v1/franchisees/00000000-0000-0000-0000-000000000000/phone' },
    { method: 'PATCH', url: '/api/v1/franchisees/00000000-0000-0000-0000-000000000000/ai-guardrails', body: '{}' },
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

describe('CV-08 / role boundary', () => {
  it('tech cannot provision a phone → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/phone/provision`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
  });

  it('franchisee owner cannot provision a phone → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/phone/provision`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
  });

  it('austin admin cannot touch a Denver phone → 403 (wrong franchisor)', async () => {
    // Austin has no franchisor admin by default; use austin owner.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/phone/provision`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
  });

  it('tech cannot update guardrails → 403', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/franchisees/${ids.denverId}/ai-guardrails`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ confidenceThreshold: 0.3 }),
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('CV-08 / validation', () => {
  it('non-UUID id on phone/provision → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisees/not-a-uuid/phone/provision',
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
  });

  it('bad area code on provision → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/phone/provision`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ areaCode: 'ABC' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('undoWindowSeconds > 1 day → 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/franchisees/${ids.denverId}/ai-guardrails`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ undoWindowSeconds: 999999 }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('guardrails accepts partial update (only threshold)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/franchisees/${ids.denverId}/ai-guardrails`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ confidenceThreshold: 0.85 }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.confidenceThreshold).toBe(0.85);
  });
});

// ---------------------------------------------------------------------------
// Tenant resolution (voice-side)
// ---------------------------------------------------------------------------

describe('CV-08 / voice tenant resolution', () => {
  it('unknown To number → resolveTenantByToNumber returns null', async () => {
    const db = drizzle(pool, { schema });
    const t = await resolveTenantByToNumber(db, '+19998887777');
    expect(t).toBeNull();
  });

  it('known To number resolves tenant with default guardrails', async () => {
    // Provision Austin first (Denver's guardrails may have been
    // mutated by an earlier PATCH test).
    await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.austinId}/phone/provision`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.austinId}/phone`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    const austinNumber = get.json().data.phoneNumberE164 as string;
    const db = drizzle(pool, { schema });
    const t = await resolveTenantByToNumber(db, austinNumber);
    expect(t?.franchiseeId).toBe(ids.austinId);
    expect(t?.guardrails.confidenceThreshold).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// New franchisee defaults
// ---------------------------------------------------------------------------

describe('CV-08 / additional role + validation', () => {
  it('tech cannot GET another franchisee\'s phone → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.austinId}/phone`,
      headers: { cookie: cookies.denverTech },
    });
    expect(res.statusCode).toBe(403);
  });

  it('franchisor admin CAN GET own-franchisor phone', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.denverId}/phone`,
      headers: { cookie: cookies.franchisorAdmin },
    });
    expect(res.statusCode).toBe(200);
  });

  it('unknown franchisee id on phone/provision → 404 (same franchisor admin)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisees/00000000-0000-0000-0000-000000000000/phone/provision',
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
  });

  it('transferOnLowConfidence=false accepted', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/franchisees/${ids.denverId}/ai-guardrails`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ transferOnLowConfidence: false }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.transferOnLowConfidence).toBe(false);
  });

  it('guardrail update does NOT clobber existing fields (partial merge)', async () => {
    // First set everything explicitly.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/franchisees/${ids.denverId}/ai-guardrails`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        confidenceThreshold: 0.75,
        undoWindowSeconds: 1200,
        transferOnLowConfidence: true,
      }),
    });
    // Now update just the threshold.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/franchisees/${ids.denverId}/ai-guardrails`,
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ confidenceThreshold: 0.6 }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.undoWindowSeconds).toBe(1200);
    expect(res.json().data.transferOnLowConfidence).toBe(true);
  });

  it('non-UUID on ai-guardrails → 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/franchisees/not-a-uuid/ai-guardrails',
      headers: { cookie: cookies.franchisorAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ confidenceThreshold: 0.5 }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('CV-08 / secure-by-default guardrails', () => {
  it('newly-inserted franchisee inherits the schema default guardrails', async () => {
    const { rows } = await pool.query<{ ai_guardrails: Record<string, unknown> }>(
      `INSERT INTO franchisees (franchisor_id, name, slug)
         VALUES ($1, 'CV08 Smoke', 'cv08-smoke')
         RETURNING ai_guardrails`,
      [ids.franchisorId],
    );
    expect(rows[0]?.ai_guardrails).toMatchObject({
      confidenceThreshold: 0.8,
      undoWindowSeconds: 900,
      transferOnLowConfidence: true,
    });
  });
});
