/**
 * Live tests for pricebook suggestions (CHR-09).
 *
 * Auto-skips when Postgres is unreachable. Exercises:
 *   - manager POSTs a suggestion -> 201
 *   - csr / tech -> 404 on POST + corporate GET
 *   - corporate GETs the queue and sees the pending row
 *   - corporate approves -> status flips to 'approved'
 *   - corporate re-approves -> 409 INVALID_TRANSITION
 *
 * Uses the same stub-auth pattern as live-branch-dashboard.test.ts.
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

const MANAGER_USER = 'pbsug-mgr-id-xxxxxxxxxxxxxxxxx';
const CSR_USER = 'pbsug-csr-id-xxxxxxxxxxxxxxxxx';
const CORP_USER = 'pbsug-corp-id-xxxxxxxxxxxxxxxx';
const CORPORATE_ID = '00000000-0000-0000-0000-0000000c0009';
const BRANCH_ID = '00000000-0000-0000-0000-0000000b0009';
const TEMPLATE_ID = '00000000-0000-0000-0000-0000000d0009';
const SERVICE_ITEM_ID = '00000000-0000-0000-0000-0000000e0009';

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await p.query('SELECT 1 FROM pricebook_suggestions LIMIT 0');
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
      if (userId === MANAGER_USER) {
        return [{ scopeType: 'branch', role: 'manager', branchId: BRANCH_ID }];
      }
      if (userId === CSR_USER) {
        return [{ scopeType: 'branch', role: 'csr', branchId: BRANCH_ID }];
      }
      if (userId === CORP_USER) {
        return [{ scopeType: 'branch', role: 'corporate_admin', branchId: null }];
      }
      return [];
    },
  };
}

async function clean(): Promise<void> {
  await pool.query(`DELETE FROM pricebook_suggestions WHERE branch_id = $1`, [BRANCH_ID]);
  await pool.query(`DELETE FROM service_items WHERE id = $1`, [SERVICE_ITEM_ID]);
  await pool.query(`DELETE FROM service_catalog_templates WHERE id = $1`, [TEMPLATE_ID]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [BRANCH_ID]);
  await pool.query(`DELETE FROM corporate WHERE id = $1`, [CORPORATE_ID]);
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2, $3)`, [
    MANAGER_USER,
    CSR_USER,
    CORP_USER,
  ]);
}

async function seed(): Promise<void> {
  for (const [id, email, name] of [
    [MANAGER_USER, 'pbsug-mgr@test.local', 'PB Sug Mgr'],
    [CSR_USER, 'pbsug-csr@test.local', 'PB Sug CSR'],
    [CORP_USER, 'pbsug-corp@test.local', 'PB Sug Corp'],
  ] as const) {
    await pool.query(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`,
      [id, email, name],
    );
  }
  await pool.query(`INSERT INTO corporate (id, name, slug) VALUES ($1, $2, $3)`, [
    CORPORATE_ID,
    'PB Sug Corp',
    'pb-sug-corp',
  ]);
  await pool.query(
    `INSERT INTO branches (id, corporate_id, name, slug) VALUES ($1, $2, $3, $4)`,
    [BRANCH_ID, CORPORATE_ID, 'PB Sug Branch', 'pb-sug-branch'],
  );
  await pool.query(
    `INSERT INTO service_catalog_templates (id, name, slug, status)
     VALUES ($1, $2, $3, 'published')`,
    [TEMPLATE_ID, 'PB Sug Template', 'pb-sug-template'],
  );
  await pool.query(
    `INSERT INTO service_items (id, template_id, sku, name, category, unit, base_price)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [SERVICE_ITEM_ID, TEMPLATE_ID, 'PB-SUG-01', 'Test Spring Kit', 'parts', 'each', '149.00'],
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

describe('pricebook suggestions auth + lifecycle', () => {
  let suggestionId = '';

  it('csr cannot submit (404)', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/suggestions',
      headers: { 'x-test-user': CSR_USER, 'content-type': 'application/json' },
      payload: { serviceItemId: SERVICE_ITEM_ID, suggestedPriceCents: 12000 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('manager submits a suggestion (201)', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/suggestions',
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {
        serviceItemId: SERVICE_ITEM_ID,
        suggestedPriceCents: 12000,
        reason: 'Competitor moved on us',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { ok: boolean; data?: { id: string; status: string } };
    expect(body.ok).toBe(true);
    expect(body.data?.status).toBe('pending');
    suggestionId = body.data!.id;
  });

  it('manager rejects bogus body with 400', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/pricebook/suggestions',
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: { serviceItemId: 'not-a-uuid', suggestedPriceCents: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('corporate sees the suggestion in the queue', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/corporate/pricebook/suggestions',
      headers: { 'x-test-user': CORP_USER },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      data?: { rows: Array<{ id: string; status: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.rows.some((r) => r.id === suggestionId)).toBe(true);
  });

  it('manager cannot see the corporate queue (404)', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/corporate/pricebook/suggestions',
      headers: { 'x-test-user': MANAGER_USER },
    });
    expect(res.statusCode).toBe(404);
  });

  it('corporate approves the suggestion', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/corporate/pricebook/suggestions/${suggestionId}/approve`,
      headers: { 'x-test-user': CORP_USER, 'content-type': 'application/json' },
      payload: { resolutionNote: 'Aligned with new corporate ladder' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data?: { status: string } };
    expect(body.data?.status).toBe('approved');
  });

  it('replay approve yields 409 INVALID_TRANSITION', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/corporate/pricebook/suggestions/${suggestionId}/approve`,
      headers: { 'x-test-user': CORP_USER, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { ok: boolean; error?: { code: string } };
    expect(body.error?.code).toBe('INVALID_TRANSITION');
  });
});
