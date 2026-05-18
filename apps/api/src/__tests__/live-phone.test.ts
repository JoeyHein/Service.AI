/**
 * Live Postgres tests for TASK-CV-06 phone provisioning +
 * AI guardrails PATCH.
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

const { Pool } = pkg;
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let ids: { corporateId: string; denverId: string; austinId: string };
let cookies: { corporateAdmin: string; denverManager: string; denverTech: string };

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
  const email = 'cv06-coadmin@elevateddoors.test';
  await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD, name: 'CV06 Admin' }),
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
  };
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('CV-06 / phone provisioning', () => {
  it('provisions a stable number for a branch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/phone/provision`,
      headers: { cookie: cookies.corporateAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { phoneNumberE164: string };
    expect(data.phoneNumberE164).toMatch(/^\+1555\d{7}$/);
  });

  it('re-provisioning is idempotent', async () => {
    const a = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/phone/provision`,
      headers: { cookie: cookies.corporateAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    const b = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/phone/provision`,
      headers: { cookie: cookies.corporateAdmin, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(b.statusCode).toBe(200);
    expect(b.json().data.alreadyProvisioned).toBe(true);
    expect(b.json().data.phoneNumberE164).toBe(a.json().data.phoneNumberE164);
  });

  it('tech → 403 FORBIDDEN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/phone/provision`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
  });

  it('manager → 403 FORBIDDEN', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/phone/provision`,
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(403);
  });

  it('anonymous → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/franchisees/${ids.denverId}/phone/provision`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /phone returns the provisioned number', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/franchisees/${ids.denverId}/phone`,
      headers: { cookie: cookies.corporateAdmin },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.phoneNumberE164).toMatch(/^\+1555/);
  });
});

describe('CV-06 / guardrails PATCH', () => {
  // Per-branch ai_guardrails was removed by the corporate hub redesign
  // (migration 0016 dropped the column). The route is preserved as a
  // 410 GONE stub so the web UI gets a deterministic error code.
  it('returns 410 GUARDRAILS_REMOVED for corporate admin', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/franchisees/${ids.austinId}/ai-guardrails`,
      headers: { cookie: cookies.corporateAdmin, 'content-type': 'application/json' },
      payload: JSON.stringify({ confidenceThreshold: 0.9, undoWindowSeconds: 1800 }),
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('GUARDRAILS_REMOVED');
  });

  it('returns 410 GUARDRAILS_REMOVED for non-admin too (gate is gone, not access)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/franchisees/${ids.denverId}/ai-guardrails`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ confidenceThreshold: 0.1 }),
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('GUARDRAILS_REMOVED');
  });
});
