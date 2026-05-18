/**
 * Live tests for the /api/v1/corporate/* surface (CHR-06).
 *
 * Auto-skip-when-unreachable: the suite bails silently if Postgres is not
 * reachable at DATABASE_URL — same pattern as the rest of the live tests.
 *
 * Coverage:
 *   1. 401 when unauthenticated
 *   2. 404 when caller is csr / tech / manager (cross-tenant pattern)
 *   3. corporate_admin happy path: create branch, assign manager,
 *      create comp plan, list, drill into one
 *   4. invalid comp plan body → 400 INVALID_COMP_PLAN with details[]
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createAuth } from '@service-ai/auth';
import * as schema from '@service-ai/db';
import {
  users,
  sessions,
  accounts,
  verifications,
} from '@service-ai/db';
import { buildApp } from '../app.js';
import { runReset, runSeed, DEV_SEED_PASSWORD } from '../seed/index.js';
import {
  membershipResolver,
  auditLogWriter,
} from '../production-resolvers.js';
import type { MagicLinkSender } from '@service-ai/auth';

const { Pool } = pkg;

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;

async function checkReachable(): Promise<boolean> {
  const p = new Pool({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 3000,
  });
  try {
    await p.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await p.end();
  }
}

function normalizeSetCookie(sc: string | string[] | undefined): string {
  if (!sc) return '';
  return Array.isArray(sc) ? sc.join('\n') : sc;
}

function extractCookieHeader(setCookieStr: string): string | null {
  const firstLine = setCookieStr.split('\n')[0];
  if (!firstLine) return null;
  const match = firstLine.match(/^([^=]+=[^;]+)/);
  return match ? match[1]! : null;
}

async function signIn(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD }),
  });
  if (res.statusCode !== 200) {
    throw new Error(
      `sign-in failed for ${email}: ${res.statusCode} ${res.body}`,
    );
  }
  const setCookie = normalizeSetCookie(res.headers['set-cookie']);
  const cookie = extractCookieHeader(setCookie);
  if (!cookie) throw new Error(`no cookie for ${email}`);
  return cookie;
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
    authSchema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
    baseUrl: 'http://localhost',
    secret: 'x'.repeat(32),
    magicLinkSender: { send: async () => {} } as MagicLinkSender,
  });

  app = await buildApp({
    drizzle: db,
    auth,
    membershipResolver: membershipResolver(db),
    auditWriter: auditLogWriter(db),
    publicBaseUrl: 'http://localhost:3000',
  });
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

describe.runIf(() => reachable)('CHR-06 / corporate routes', () => {
  it('unauthenticated → 401 on /api/v1/corporate/branches', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/corporate/branches',
    });
    expect(res.statusCode).toBe(401);
  });

  it.each(['csr', 'tech1', 'dispatcher', 'owner'])(
    'Denver %s → 404 on /api/v1/corporate/branches',
    async (subrole) => {
      if (!reachable) return;
      const email = `denver.${subrole}@elevateddoors.test`;
      const cookie = await signIn(email);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/corporate/branches',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
    },
  );

  it('corporate_admin happy path: list, create branch, assign manager, comp plan, drill in', async () => {
    if (!reachable) return;
    const cookie = await signIn('joey@opendc.ca');

    // List existing branches first.
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/corporate/branches',
      headers: { cookie },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json() as {
      ok: true;
      data: Array<{ id: string; name: string; slug: string }>;
    };
    expect(listBody.data.length).toBeGreaterThanOrEqual(2);

    // Create a fresh branch.
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/corporate/branches',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'CHR-06 Test Branch',
        slug: `chr06-${Date.now()}`,
        timezone: 'America/Denver',
      }),
    });
    expect(createRes.statusCode).toBe(201);
    const createBody = createRes.json() as {
      ok: true;
      data: { id: string; slug: string };
    };
    const newBranchId = createBody.data.id;

    // Assign a manager (re-use the denver owner user).
    const db = drizzle(pool, { schema });
    const [ownerRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'denver.owner@elevateddoors.test'));
    expect(ownerRow).toBeDefined();
    const assignRes = await app.inject({
      method: 'POST',
      url: `/api/v1/corporate/branches/${newBranchId}/managers`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ userId: ownerRow!.id }),
    });
    expect(assignRes.statusCode).toBe(201);

    // Create a comp plan with a single flat-percent rule.
    const planRes = await app.inject({
      method: 'POST',
      url: '/api/v1/corporate/comp-plans',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'CHR-06 Test Plan',
        kind: 'base_plus_commission',
        baseSalaryCents: 500000,
        payPeriod: 'monthly',
        commissionRules: [
          { kind: 'flat_percent_of_invoice_paid', percent: 5 },
        ],
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
      }),
    });
    expect(planRes.statusCode).toBe(201);
    const planBody = planRes.json() as {
      ok: true;
      data: { id: string };
    };

    // List comp plans + drill into the new one.
    const allPlans = await app.inject({
      method: 'GET',
      url: '/api/v1/corporate/comp-plans',
      headers: { cookie },
    });
    expect(allPlans.statusCode).toBe(200);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/corporate/comp-plans/${planBody.data.id}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);

    // Drill into the new branch detail.
    const branchDetail = await app.inject({
      method: 'GET',
      url: `/api/v1/corporate/branches/${newBranchId}`,
      headers: { cookie },
    });
    expect(branchDetail.statusCode).toBe(200);
  });

  it('invalid comp plan body → 400 INVALID_COMP_PLAN with details', async () => {
    if (!reachable) return;
    const cookie = await signIn('joey@opendc.ca');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/corporate/comp-plans',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Bad plan',
        kind: 'commission_only',
        // commission_only must have baseSalaryCents = 0 — superRefine
        // catches this with a field-level message.
        baseSalaryCents: 100000,
        payPeriod: 'monthly',
        commissionRules: [
          { kind: 'flat_percent_of_invoice_paid', percent: 200 },
        ],
        effectiveFrom: '2026-01-01',
      }),
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as {
      ok: false;
      error: { code: string; details: Array<{ path: string; message: string }> };
    };
    expect(body.error.code).toBe('INVALID_COMP_PLAN');
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details.length).toBeGreaterThan(0);
  });
});
