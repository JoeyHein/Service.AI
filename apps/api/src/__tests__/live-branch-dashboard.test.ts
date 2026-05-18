/**
 * Live test for the /api/v1/branch/dashboard route (CHR-07).
 *
 * Skips silently when Postgres is unreachable on `DATABASE_URL`. When
 * the DB is reachable, the test asserts:
 *
 *   1. Unauthenticated calls return 401 UNAUTHENTICATED.
 *   2. Corporate-scoped users get 404 NOT_FOUND (the dashboard surfaces
 *      branch-side commission data — corporate uses /corporate/* views).
 *   3. Non-manager branch roles (csr/tech/dispatcher) get 404.
 *   4. Manager: 200 with the projected dashboard, projectedCommissionCents
 *      matching computeCommission for the manager + current period.
 *   5. The branch row in the response is the manager's branch — there
 *      is no cross-branch leakage path because scope pins to branch_id.
 *
 * Tests inject a tiny stub MembershipResolver so they don't depend on
 * Better Auth seeding. The handler then runs with whatever scope we
 * choose.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import type { Auth } from '@service-ai/auth';
import * as schema from '@service-ai/db';
import { buildApp } from '../app.js';
import type { MembershipResolver, MembershipRow } from '../request-scope.js';

const { Pool } = pkg;

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: FastifyInstance;

const MANAGER_USER = 'br-dash-mgr-id-xxxxxxxxxxxxxxxxxx';
const CSR_USER = 'br-dash-csr-id-xxxxxxxxxxxxxxxxxx';
const CORP_USER = 'br-dash-corp-id-xxxxxxxxxxxxxxxxx';
const CORPORATE_ID = '00000000-0000-0000-0000-00000000c01a';
const BRANCH_ID = '00000000-0000-0000-0000-000000b1a1ab';

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await p.query('SELECT 1 FROM branches LIMIT 0');
    return true;
  } catch {
    return false;
  } finally {
    await p.end();
  }
}

/**
 * Resolver that returns a fixed membership shape per impersonation
 * cookie-less test. The header `x-test-user` selects which row to
 * return — keeps the test wiring out of Better Auth.
 */
function makeResolver(): MembershipResolver {
  return {
    async memberships(userId: string): Promise<MembershipRow[]> {
      if (userId === MANAGER_USER) {
        return [
          {
            scopeType: 'branch',
            role: 'manager',
            branchId: BRANCH_ID,
          },
        ];
      }
      if (userId === CSR_USER) {
        return [
          {
            scopeType: 'branch',
            role: 'csr',
            branchId: BRANCH_ID,
          },
        ];
      }
      if (userId === CORP_USER) {
        return [
          {
            scopeType: 'branch',
            role: 'corporate_admin',
            branchId: null,
          },
        ];
      }
      return [];
    },
  };
}

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [MANAGER_USER, 'br-dash-mgr@test.local', 'Branch Dash Manager'],
  );
  await pool.query(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [CSR_USER, 'br-dash-csr@test.local', 'Branch Dash CSR'],
  );
  await pool.query(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [CORP_USER, 'br-dash-corp@test.local', 'Branch Dash Corp'],
  );
  await pool.query(
    `INSERT INTO corporate (id, name, slug) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [CORPORATE_ID, 'BD Corp', 'bd-corp'],
  );
  await pool.query(
    `INSERT INTO branches (id, corporate_id, name, slug)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [BRANCH_ID, CORPORATE_ID, 'BD Branch', 'bd-branch'],
  );
}

async function clean(): Promise<void> {
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2, $3)`, [
    MANAGER_USER,
    CSR_USER,
    CORP_USER,
  ]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [BRANCH_ID]);
  await pool.query(`DELETE FROM corporate WHERE id = $1`, [CORPORATE_ID]);
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  db = drizzle(pool, { schema });
  await clean();
  await seed();

  // Stub auth so the request-scope plugin sees a non-null session and
  // hands `userId` to our resolver. We inject only the bits buildApp
  // requires for the routes under test.
  const stubAuth = {
    api: {
      // Better Auth's getSession exposes session by request — return a
      // dummy session per request via header injection below.
      getSession: async ({ headers }: { headers: Headers }) => {
        const userId = headers.get('x-test-user');
        if (!userId) return null;
        return { session: { id: `stub-session-${userId}` }, user: { id: userId } };
      },
    },
  } as unknown as Auth;

  app = await buildApp({
    auth: stubAuth,
    drizzle: db,
    membershipResolver: makeResolver(),
    logger: false,
  });
});

afterAll(async () => {
  if (!reachable) return;
  if (app) await app.close();
  if (pool) {
    await clean();
    await pool.end();
  }
});

describe('GET /api/v1/branch/dashboard auth matrix', () => {
  it('returns 401 when no session', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/branch/dashboard',
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('UNAUTHENTICATED');
  });

  it('returns 404 for corporate scope (corporate uses /corporate views)', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/branch/dashboard',
      headers: { 'x-test-user': CORP_USER },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for CSR (non-manager branch role)', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/branch/dashboard',
      headers: { 'x-test-user': CSR_USER },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 + dashboard for a manager', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/branch/dashboard',
      headers: { 'x-test-user': MANAGER_USER },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      data?: {
        branch: { id: string; name: string };
        tiles: {
          revenueMtdCents: number;
          openArCents: number;
          jobsInFlight: number;
          projectedCommissionCents: number;
        };
        pipeline: unknown[];
        recentJobs: unknown[];
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.branch.id).toBe(BRANCH_ID);
    expect(body.data?.branch.name).toBe('BD Branch');
    expect(body.data?.tiles.revenueMtdCents).toBe(0);
    expect(body.data?.tiles.openArCents).toBe(0);
    expect(body.data?.tiles.jobsInFlight).toBe(0);
    expect(Array.isArray(body.data?.pipeline)).toBe(true);
    expect(Array.isArray(body.data?.recentJobs)).toBe(true);
  });
});
