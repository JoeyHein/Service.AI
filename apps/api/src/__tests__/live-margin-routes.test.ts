/**
 * Live tests for the margin-policy + category-override routes (SQB-08).
 *
 * Auto-skips when Postgres is unreachable on DATABASE_URL — matches the
 * pattern used by every other live-*.test.ts in this folder. Exercises:
 *
 *   - Auth: 401 for unauthenticated; 404 for branch-scoped users.
 *   - GET happy path returns default + min + max + (empty) overrides.
 *   - POST creates a category override; UNIQUE collision returns 409
 *     `CATEGORY_EXISTS`.
 *   - PATCH `/policy` rejects `defaultPct < minPct` with 422
 *     `BOUNDS_INVALID`.
 *   - DELETE removes the override and returns the deleted row.
 *
 * Uses the same stub-auth + injected MembershipResolver pattern as
 * `live-quote-routes.test.ts` so a single test seeds its own corporate /
 * branch / users without depending on the full DB seed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const CORP_USER = 'mr-corp-user-id-xxxxxxxxxxxxxxxxx';
const BRANCH_USER = 'mr-branch-user-id-xxxxxxxxxxxxxxx';

const CORPORATE_ID = '00000000-0000-0000-0000-00000000c108';
const BRANCH_ID = '00000000-0000-0000-0000-00000000b108';

async function checkReachable(): Promise<boolean> {
  const p = new Pool({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 3000,
  });
  try {
    await p.query('SELECT 1 FROM margin_overrides LIMIT 0');
    return true;
  } catch {
    return false;
  } finally {
    await p.end();
  }
}

function makeResolver(): MembershipResolver {
  return {
    async memberships(userId: string): Promise<MembershipRow[]> {
      if (userId === CORP_USER) {
        return [{ scopeType: 'branch', role: 'corporate_admin', branchId: null }];
      }
      if (userId === BRANCH_USER) {
        return [{ scopeType: 'branch', role: 'manager', branchId: BRANCH_ID }];
      }
      return [];
    },
  };
}

async function clean(): Promise<void> {
  await pool.query(
    `DELETE FROM margin_overrides WHERE item_category LIKE 'MR-%'`,
  );
  await pool.query(
    `DELETE FROM audit_log WHERE action LIKE 'corporate.margin.%'`,
  );
  await pool.query(`DELETE FROM branches WHERE id = $1`, [BRANCH_ID]);
  await pool.query(`DELETE FROM corporate WHERE id = $1`, [CORPORATE_ID]);
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2)`, [
    CORP_USER,
    BRANCH_USER,
  ]);
}

async function seed(): Promise<void> {
  for (const [id, email, name] of [
    [CORP_USER, 'mr-corp@test.local', 'MR Corp Admin'],
    [BRANCH_USER, 'mr-branch@test.local', 'MR Branch Manager'],
  ] as const) {
    await pool.query(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`,
      [id, email, name],
    );
  }
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM corporate ORDER BY created_at LIMIT 1`,
  );
  if (existing.rows.length === 0) {
    await pool.query(
      `INSERT INTO corporate (id, name, slug, default_margin_pct, min_margin_pct, max_margin_pct)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [CORPORATE_ID, 'MR Corp', 'mr-corp', '55.00', '15.00', '200.00'],
    );
  } else {
    await pool.query(
      `UPDATE corporate
         SET default_margin_pct = '55.00',
             min_margin_pct = '15.00',
             max_margin_pct = '200.00'
       WHERE id = $1`,
      [existing.rows[0]!.id],
    );
  }
  const corpId = existing.rows[0]?.id ?? CORPORATE_ID;
  await pool.query(
    `INSERT INTO branches (id, corporate_id, name, slug) VALUES ($1, $2, $3, $4)`,
    [BRANCH_ID, corpId, 'MR Branch', 'mr-branch'],
  );
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  db = drizzle(pool, { schema });
  await clean();
  await seed();

  const stubAuth = {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const userId = headers.get('x-test-user');
        return userId ? { session: { id: `stub-${userId}` }, user: { id: userId } } : null;
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

beforeEach(async () => {
  if (!reachable) return;
  await pool.query(
    `DELETE FROM margin_overrides WHERE item_category LIKE 'MR-%'`,
  );
  await pool.query(
    `DELETE FROM audit_log WHERE action LIKE 'corporate.margin.%'`,
  );
  await pool.query(
    `UPDATE corporate
       SET default_margin_pct = '55.00',
           min_margin_pct = '15.00',
           max_margin_pct = '200.00'`,
  );
});

describe('SQB-08 / margin routes — auth matrix', () => {
  it('returns 401 when unauthenticated', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/corporate/margins',
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { ok: boolean; error?: { code: string } };
    expect(body.error?.code).toBe('UNAUTHENTICATED');
  });

  it('returns 404 for branch-scoped users (corporate-only surface)', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/corporate/margins',
      headers: { 'x-test-user': BRANCH_USER },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { ok: boolean; error?: { code: string } };
    expect(body.error?.code).toBe('NOT_FOUND');
  });
});

describe('SQB-08 / margin routes — happy path', () => {
  it('GET returns default + min + max + (empty) overrides initially', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/corporate/margins',
      headers: { 'x-test-user': CORP_USER },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: true;
      data: {
        defaultPct: number;
        minPct: number;
        maxPct: number;
        overrides: unknown[];
      };
    };
    expect(body.data.defaultPct).toBe(55);
    expect(body.data.minPct).toBe(15);
    expect(body.data.maxPct).toBe(200);
    expect(body.data.overrides).toEqual([]);
  });

  it('POST creates a category override; UNIQUE collision → 409', async () => {
    if (!reachable) return;
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/corporate/margin-overrides',
      headers: { 'x-test-user': CORP_USER, 'content-type': 'application/json' },
      payload: {
        itemCategory: 'MR-SPRINGS',
        marginPct: 40,
        notes: 'lower margin for this category',
      },
    });
    expect(create.statusCode).toBe(201);
    const createBody = create.json() as {
      ok: true;
      data: { id: string; itemCategory: string; marginPct: number };
    };
    expect(createBody.data.itemCategory).toBe('MR-SPRINGS');
    expect(createBody.data.marginPct).toBe(40);

    // Collision: same item_category → 409 CATEGORY_EXISTS.
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/corporate/margin-overrides',
      headers: { 'x-test-user': CORP_USER, 'content-type': 'application/json' },
      payload: { itemCategory: 'MR-SPRINGS', marginPct: 35 },
    });
    expect(dup.statusCode).toBe(409);
    const dupBody = dup.json() as { ok: boolean; error?: { code: string } };
    expect(dupBody.error?.code).toBe('CATEGORY_EXISTS');
  });

  it('PATCH /policy rejects defaultPct < minPct with 422 BOUNDS_INVALID', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/corporate/margins/policy',
      headers: { 'x-test-user': CORP_USER, 'content-type': 'application/json' },
      payload: { defaultPct: 10 }, // below min (15)
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { ok: boolean; error?: { code: string } };
    expect(body.error?.code).toBe('BOUNDS_INVALID');
  });

  it('DELETE removes the override', async () => {
    if (!reachable) return;
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/corporate/margin-overrides',
      headers: { 'x-test-user': CORP_USER, 'content-type': 'application/json' },
      payload: { itemCategory: 'MR-RAILS', marginPct: 45 },
    });
    expect(create.statusCode).toBe(201);
    const createBody = create.json() as { data: { id: string } };
    const id = createBody.data.id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/corporate/margin-overrides/${id}`,
      headers: { 'x-test-user': CORP_USER },
    });
    expect(del.statusCode).toBe(200);
    const delBody = del.json() as { ok: true; data: { id: string } };
    expect(delBody.data.id).toBe(id);

    // Second DELETE: 404.
    const again = await app.inject({
      method: 'DELETE',
      url: `/api/v1/corporate/margin-overrides/${id}`,
      headers: { 'x-test-user': CORP_USER },
    });
    expect(again.statusCode).toBe(404);
  });
});
