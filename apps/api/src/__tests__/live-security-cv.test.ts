/**
 * TASK-CV-08 — phase_ai_csr_voice security suite.
 *
 * Covers phone provisioning + guardrails PATCH + the voice-side
 * inbound-call path (tenant resolution, cross-tenant rejection).
 * Tool-level scope is already covered in live-csr-tools.test.ts;
 * the loop-level redirect is in live-voice-e2e.test.ts.
 *
 * After the corporate hub redesign (CHR-01) the per-branch
 * ai_guardrails column is gone — PATCH .../ai-guardrails returns
 * 410 GONE for everyone. Phone provisioning is corporate-admin
 * only (no branch role can call it).
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
let ids: { corporateId: string; denverId: string; austinId: string };
let cookies: {
  corporateAdmin: string;
  denverManager: string;
  denverTech: string;
  austinManager: string;
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

async function createCorporateAdmin(corporateId: string): Promise<string> {
  const email = 'cv08-coadmin@elevateddoors.test';
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
       SELECT $1, 'corporate'::scope_type, $2, 'corporate_admin'::role
       WHERE NOT EXISTS (
         SELECT 1 FROM memberships
          WHERE user_id=$1 AND scope_type='corporate' AND scope_id=$2 AND deleted_at IS NULL
       )`,
    [userId, corporateId],
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
    corporateId: seed.corporateId,
    denverId: seed.branches.find((b) => b.slug === 'denver')!.id,
    austinId: seed.branches.find((b) => b.slug === 'austin')!.id,
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
    auditWriter: auditLogWriter(db),
    magicLinkSender: { async send() {} },
    acceptUrlBase: 'http://localhost:3000',
  });
  await app.ready();
  cookies = {
    corporateAdmin: await createCorporateAdmin(ids.corporateId),
    denverManager: await signIn('denver.owner@elevateddoors.test'),
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    austinManager: await signIn('austin.owner@elevateddoors.test'),
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

  it('branch manager cannot provision a phone → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/phone/provision`,
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
  });

  it('austin manager cannot touch a Denver phone → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/phone/provision`,
      headers: { cookie: cookies.austinManager, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
  });

  it('PATCH /ai-guardrails returns 410 GUARDRAILS_REMOVED for every role', async () => {
    for (const cookie of [
      cookies.corporateAdmin,
      cookies.denverManager,
      cookies.denverTech,
    ]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/franchisees/${ids.denverId}/ai-guardrails`,
        headers: { cookie, 'content-type': 'application/json' },
        payload: JSON.stringify({ confidenceThreshold: 0.3 }),
      });
      expect(res.statusCode).toBe(410);
      expect(res.json().error.code).toBe('GUARDRAILS_REMOVED');
    }
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
      headers: { cookie: cookies.corporateAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
  });

  it('bad area code on provision → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/phone/provision`,
      headers: { cookie: cookies.corporateAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ areaCode: 'ABC' }),
    });
    expect(res.statusCode).toBe(400);
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
    await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.austinId}/phone/provision`,
      headers: { cookie: cookies.corporateAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.austinId}/phone`,
      headers: { cookie: cookies.corporateAdmin },
    });
    const austinNumber = get.json().data.phoneNumberE164 as string;
    const db = drizzle(pool, { schema });
    const t = await resolveTenantByToNumber(db, austinNumber);
    expect(t?.branchId).toBe(ids.austinId);
    expect(t?.guardrails.confidenceThreshold).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// Additional role + validation
// ---------------------------------------------------------------------------

describe('CV-08 / additional role + validation', () => {
  it('tech cannot GET another branch phone → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.austinId}/phone`,
      headers: { cookie: cookies.denverTech },
    });
    expect(res.statusCode).toBe(403);
  });

  it('corporate admin CAN GET branch phone', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.denverId}/phone`,
      headers: { cookie: cookies.corporateAdmin },
    });
    expect(res.statusCode).toBe(200);
  });

  it('unknown branch id on phone/provision → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/franchisees/00000000-0000-0000-0000-000000000000/phone/provision',
      headers: { cookie: cookies.corporateAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
  });
});
