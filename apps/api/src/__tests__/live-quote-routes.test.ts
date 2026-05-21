/**
 * Live tests for the quote routes (SQB-07c).
 *
 * Auto-skips when Postgres is unreachable on `DATABASE_URL`. When the
 * DB IS reachable, exercises:
 *
 *   - Auth matrix (401 / 404 cross-branch / manager 200 / corporate 200).
 *   - Margin engine integration (resolution order, bounds, reason).
 *   - Role gating (csr can't set marginOverridePct).
 *   - Cost-forgery: client-supplied cost is ignored; supplier wins.
 *   - Frozen totals on category override edit.
 *   - Status machine: draft→priced→committed legal; draft→commit 409.
 *   - Commission integration (one ledger row on commit).
 *   - Void reversal (balancing -cents ledger row).
 *
 * Uses the same stub-auth + injected MembershipResolver pattern as
 * `live-branch-dashboard.test.ts`. The test seeds a single supplier
 * row with provider_kind='bc_ai_agent' and registers a MockSupplier
 * factory under that kind so the route layer's `bind()` call resolves
 * to an in-memory provider that never hits the network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import type { Auth } from '@service-ai/auth';
import * as schema from '@service-ai/db';
import {
  MockSupplierProvider,
  ProviderRegistry,
  type SupplierConfig,
} from '@service-ai/suppliers';
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
let mockProvider: MockSupplierProvider;
let otherMockProvider: MockSupplierProvider;

// Deterministic IDs so the test reads as a story.
const MANAGER_USER = 'qr-mgr-id-xxxxxxxxxxxxxxxxxxxx';
const CSR_USER = 'qr-csr-id-xxxxxxxxxxxxxxxxxxxx';
const CORP_USER = 'qr-corp-id-xxxxxxxxxxxxxxxxxxx';
const OTHER_MGR_USER = 'qr-ombr-id-xxxxxxxxxxxxxxxxxx';

const CORPORATE_ID = '00000000-0000-0000-0000-0000000c07c0';
const BRANCH_ID = '00000000-0000-0000-0000-0000000b07c0';
const OTHER_BRANCH_ID = '00000000-0000-0000-0000-0000000b07c1';
const CUSTOMER_ID = '00000000-0000-0000-0000-0000000a07c0';
const OTHER_CUSTOMER_ID = '00000000-0000-0000-0000-0000000a07c1';
const SUPPLIER_ID = '00000000-0000-0000-0000-0000000507c0';
const OTHER_SUPPLIER_ID = '00000000-0000-0000-0000-0000000507c1';
const COMP_PLAN_ID = '00000000-0000-0000-0000-0000007c07c0';

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await p.query('SELECT 1 FROM quotes LIMIT 0');
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
      if (userId === OTHER_MGR_USER) {
        return [{ scopeType: 'branch', role: 'manager', branchId: OTHER_BRANCH_ID }];
      }
      return [];
    },
  };
}

async function clean(): Promise<void> {
  // Order matters: children before parents.
  await pool.query(`DELETE FROM commission_ledger WHERE branch_id IN ($1, $2)`, [
    BRANCH_ID,
    OTHER_BRANCH_ID,
  ]);
  await pool.query(`DELETE FROM quote_status_log WHERE branch_id IN ($1, $2)`, [
    BRANCH_ID,
    OTHER_BRANCH_ID,
  ]);
  await pool.query(`DELETE FROM quote_line_items WHERE branch_id IN ($1, $2)`, [
    BRANCH_ID,
    OTHER_BRANCH_ID,
  ]);
  // QF: invoices reference jobs (RESTRICT) and jobs reference customers
  // (RESTRICT), so tear them down before quotes/customers.
  await pool.query(`DELETE FROM invoices WHERE branch_id IN ($1, $2)`, [
    BRANCH_ID,
    OTHER_BRANCH_ID,
  ]);
  await pool.query(`DELETE FROM jobs WHERE branch_id IN ($1, $2)`, [
    BRANCH_ID,
    OTHER_BRANCH_ID,
  ]);
  await pool.query(`DELETE FROM quotes WHERE branch_id IN ($1, $2)`, [
    BRANCH_ID,
    OTHER_BRANCH_ID,
  ]);
  await pool.query(`DELETE FROM margin_overrides WHERE item_category LIKE 'QR-%'`);
  await pool.query(`DELETE FROM audit_log WHERE target_branch_id IN ($1, $2)`, [
    BRANCH_ID,
    OTHER_BRANCH_ID,
  ]);
  await pool.query(`DELETE FROM user_comp_assignments WHERE user_id = $1`, [MANAGER_USER]);
  await pool.query(`DELETE FROM comp_plans WHERE id = $1`, [COMP_PLAN_ID]);
  await pool.query(`DELETE FROM branch_managers WHERE branch_id IN ($1, $2)`, [
    BRANCH_ID,
    OTHER_BRANCH_ID,
  ]);
  await pool.query(`DELETE FROM customers WHERE id IN ($1, $2)`, [
    CUSTOMER_ID,
    OTHER_CUSTOMER_ID,
  ]);
  await pool.query(`DELETE FROM suppliers WHERE id IN ($1, $2)`, [
    SUPPLIER_ID,
    OTHER_SUPPLIER_ID,
  ]);
  await pool.query(`DELETE FROM branches WHERE id IN ($1, $2)`, [
    BRANCH_ID,
    OTHER_BRANCH_ID,
  ]);
  await pool.query(`DELETE FROM corporate WHERE id = $1`, [CORPORATE_ID]);
  await pool.query(`DELETE FROM users WHERE id IN ($1, $2, $3, $4)`, [
    MANAGER_USER,
    CSR_USER,
    CORP_USER,
    OTHER_MGR_USER,
  ]);
}

async function seed(): Promise<void> {
  for (const [id, email, name] of [
    [MANAGER_USER, 'qr-mgr@test.local', 'QR Manager'],
    [CSR_USER, 'qr-csr@test.local', 'QR CSR'],
    [CORP_USER, 'qr-corp@test.local', 'QR Corp'],
    [OTHER_MGR_USER, 'qr-other@test.local', 'QR Other Manager'],
  ] as const) {
    await pool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
      id,
      email,
      name,
    ]);
  }
  // Corporate row with explicit margin policy so the math is
  // predictable. Default 50%, floor 10%, ceiling 200%. The handler
  // resolves "the corporate" by picking the singleton via `.limit(1)`,
  // so when other test files (e.g. seed) have already inserted the
  // Elevated Doors corporate, we upsert into it rather than insert a
  // duplicate that the handler would never pick.
  const existingCorp = await pool.query<{ id: string }>(
    `SELECT id FROM corporate ORDER BY created_at LIMIT 1`,
  );
  let corpId: string;
  if (existingCorp.rows.length === 0) {
    await pool.query(
      `INSERT INTO corporate (id, name, slug, default_margin_pct, min_margin_pct, max_margin_pct)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [CORPORATE_ID, 'QR Corp', 'qr-corp', '50.00', '10.00', '200.00'],
    );
    corpId = CORPORATE_ID;
  } else {
    corpId = existingCorp.rows[0]!.id;
    await pool.query(
      `UPDATE corporate
         SET default_margin_pct = '50.00',
             min_margin_pct = '10.00',
             max_margin_pct = '200.00'
       WHERE id = $1`,
      [corpId],
    );
  }
  await pool.query(
    `INSERT INTO branches (id, corporate_id, name, slug) VALUES ($1, $2, $3, $4)`,
    [BRANCH_ID, corpId, 'QR Branch', 'qr-branch'],
  );
  await pool.query(
    `INSERT INTO branches (id, corporate_id, name, slug) VALUES ($1, $2, $3, $4)`,
    [OTHER_BRANCH_ID, corpId, 'QR Other Branch', 'qr-other-branch'],
  );
  await pool.query(`INSERT INTO customers (id, branch_id, name) VALUES ($1, $2, $3)`, [
    CUSTOMER_ID,
    BRANCH_ID,
    'QR Customer',
  ]);
  await pool.query(`INSERT INTO customers (id, branch_id, name) VALUES ($1, $2, $3)`, [
    OTHER_CUSTOMER_ID,
    OTHER_BRANCH_ID,
    'QR Other Customer',
  ]);
  await pool.query(
    `INSERT INTO suppliers
       (id, name, provider_kind, endpoint_url, api_key_secret_ref, supplier_account_code)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [SUPPLIER_ID, 'QR Supplier', 'bc_ai_agent', 'https://mock.local', 'QR_API_KEY', 'ACC-001'],
  );
  await pool.query(
    `INSERT INTO suppliers
       (id, name, provider_kind, endpoint_url, api_key_secret_ref, supplier_account_code)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      OTHER_SUPPLIER_ID,
      'QR Other Supplier',
      'bc_ai_agent',
      'https://mock.local',
      'QR_API_KEY',
      'ACC-002',
    ],
  );
  // Comp plan + assignment so commit yields a commission ledger row.
  await pool.query(
    `INSERT INTO comp_plans
       (id, name, kind, base_salary_cents, pay_period, commission_rules, effective_from)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      COMP_PLAN_ID,
      'QR Plan',
      'base_plus_commission',
      500_000,
      'monthly',
      JSON.stringify([{ kind: 'flat_percent_of_quote_committed', percent: 2 }]),
      '2026-01-01',
    ],
  );
  await pool.query(
    `INSERT INTO user_comp_assignments (user_id, comp_plan_id, branch_id, effective_from)
     VALUES ($1, $2, $3, $4)`,
    [MANAGER_USER, COMP_PLAN_ID, BRANCH_ID, '2026-01-01'],
  );
  await pool.query(
    `INSERT INTO branch_managers (branch_id, user_id, started_at) VALUES ($1, $2, $3)`,
    [BRANCH_ID, MANAGER_USER, '2026-01-01T00:00:00Z'],
  );
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  db = drizzle(pool, { schema });
  await clean();
  await seed();

  // Stub auth so the request-scope plugin sees a non-null session.
  const stubAuth = {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const userId = headers.get('x-test-user');
        return userId ? { session: { id: `stub-${userId}` }, user: { id: userId } } : null;
      },
    },
  } as unknown as Auth;

  // Pre-seed a ProviderRegistry that maps both the production kind
  // ('bc_ai_agent') and the test-only 'mock' kind to the same mock
  // provider instance. The suppliers rows we seeded above carry
  // provider_kind='bc_ai_agent' (the only enum value), so the route's
  // bind() call routes through the bc_ai_agent factory.
  mockProvider = new MockSupplierProvider({
    supplierId: SUPPLIER_ID,
    catalog: [
      {
        sku: 'PART-A',
        name: 'Spring kit',
        category: 'QR-SPRINGS',
        unitPriceCents: 0, // engine recomputes
        unitCostCents: 10_000, // $100
      },
      {
        sku: 'PART-B',
        name: 'Rail',
        category: 'QR-RAILS',
        unitPriceCents: 0,
        unitCostCents: 20_000, // $200
      },
      {
        sku: 'PART-C',
        name: 'Hinge',
        category: 'QR-HINGES',
        unitPriceCents: 0,
        unitCostCents: 5_000, // $50
      },
    ],
    taxRatePct: 0, // route ignores tax_cents from provider; we compute totals locally
  });
  otherMockProvider = new MockSupplierProvider({
    supplierId: OTHER_SUPPLIER_ID,
    catalog: mockProvider['catalog']
      ? // re-seed identical catalog for the second supplier
        []
      : [],
    taxRatePct: 0,
  });
  otherMockProvider.seedCatalog([
    {
      sku: 'PART-A',
      name: 'Spring kit',
      category: 'QR-SPRINGS',
      unitPriceCents: 0,
      unitCostCents: 10_000,
    },
  ]);

  const registry = new ProviderRegistry();
  registry.registerFactory('bc_ai_agent', (config: SupplierConfig) => {
    if (config.supplierId === OTHER_SUPPLIER_ID) return otherMockProvider;
    return mockProvider;
  });

  app = await buildApp({
    auth: stubAuth,
    drizzle: db,
    membershipResolver: makeResolver(),
    providerRegistry: registry,
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
  // Reset per-test state on the quote tables so each test starts clean.
  await pool.query(`DELETE FROM commission_ledger WHERE branch_id IN ($1, $2)`, [
    BRANCH_ID,
    OTHER_BRANCH_ID,
  ]);
  await pool.query(`DELETE FROM quote_status_log WHERE branch_id IN ($1, $2)`, [
    BRANCH_ID,
    OTHER_BRANCH_ID,
  ]);
  await pool.query(`DELETE FROM quote_line_items WHERE branch_id IN ($1, $2)`, [
    BRANCH_ID,
    OTHER_BRANCH_ID,
  ]);
  // invoices reference jobs (RESTRICT) so delete them first; both link to
  // quotes via SET NULL. Keeps QF job/invoice assertions isolated — without
  // this, auto-created jobs accumulate across tests.
  await pool.query(`DELETE FROM invoices WHERE branch_id IN ($1, $2)`, [
    BRANCH_ID,
    OTHER_BRANCH_ID,
  ]);
  await pool.query(`DELETE FROM jobs WHERE branch_id IN ($1, $2)`, [
    BRANCH_ID,
    OTHER_BRANCH_ID,
  ]);
  await pool.query(`DELETE FROM quotes WHERE branch_id IN ($1, $2)`, [
    BRANCH_ID,
    OTHER_BRANCH_ID,
  ]);
  await pool.query(`DELETE FROM margin_overrides WHERE item_category LIKE 'QR-%'`);
  await pool.query(`DELETE FROM audit_log WHERE action = 'quote.margin_override'`);
  // Re-assert the corporate margin policy each test. Multiple corporate
  // rows exist across the full suite (this file, live-margin-routes, the
  // demo seed) and the price handler resolves "the corporate" with an
  // unordered LIMIT 1 — so it may pick a row another file left at 55%.
  // Update EVERY row (matching live-margin-routes' beforeEach) so PART-A
  // ($100 cost) deterministically prices at $150 regardless of which row
  // the handler picks or what order the files ran in.
  await pool.query(
    `UPDATE corporate
       SET default_margin_pct = '50.00',
           min_margin_pct = '10.00',
           max_margin_pct = '200.00',
           deposit_pct = '0.00',
           deposit_min_cents = 0,
           deposit_max_cents = NULL`,
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createDraftQuote(
  user: string,
  opts: { customerId?: string; supplierId?: string } = {},
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/quotes',
    headers: { 'x-test-user': user, 'content-type': 'application/json' },
    payload: {
      customerId: opts.customerId ?? CUSTOMER_ID,
      supplierId: opts.supplierId ?? SUPPLIER_ID,
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`createDraftQuote failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json() as { data: { id: string } };
  return body.data.id;
}

interface PriceLineInput {
  sku: string;
  description?: string;
  quantity: number;
  itemCategory?: string | null;
  marginOverridePct?: number | null;
  marginOverrideReason?: string | null;
}

async function priceQuote(
  user: string,
  quoteId: string,
  lineItems: PriceLineInput[],
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/quotes/${quoteId}/price`,
    headers: { 'x-test-user': user, 'content-type': 'application/json' },
    payload: { lineItems },
  });
}

// ---------------------------------------------------------------------------
// Auth matrix
// ---------------------------------------------------------------------------

describe('quote routes — auth matrix', () => {
  it('returns 401 when unauthenticated', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/quotes/${'00000000-0000-0000-0000-000000000000'}`,
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { ok: boolean; error?: { code: string } };
    expect(body.error?.code).toBe('UNAUTHENTICATED');
  });

  it("returns 404 on a different branch's quote (no cross-branch leakage)", async () => {
    if (!reachable) return;
    // Create a quote owned by OTHER_MGR_USER (OTHER_BRANCH_ID).
    const otherQuoteId = await createDraftQuote(OTHER_MGR_USER, {
      customerId: OTHER_CUSTOMER_ID,
      supplierId: OTHER_SUPPLIER_ID,
    });
    // MANAGER_USER (BRANCH_ID) cannot see it.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/quotes/${otherQuoteId}`,
      headers: { 'x-test-user': MANAGER_USER },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 for the owning manager (happy path)', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/quotes/${id}`,
      headers: { 'x-test-user': MANAGER_USER },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data?: { quote: { id: string } } };
    expect(body.ok).toBe(true);
    expect(body.data?.quote.id).toBe(id);
  });

  it('returns 200 for a corporate_admin reading any branch (happy path)', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/quotes/${id}`,
      headers: { 'x-test-user': CORP_USER },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data?: { quote: { id: string } } };
    expect(body.data?.quote.id).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// Margin engine integration
// ---------------------------------------------------------------------------

describe('quote routes — margin engine integration', () => {
  it('honours resolution order: line override > category override > default', async () => {
    if (!reachable) return;
    // Seed a category override for QR-SPRINGS at 30%; the corporate
    // default is 50%; PART-C uses the default (no category row).
    await pool.query(
      `INSERT INTO margin_overrides (item_category, margin_pct) VALUES ($1, $2)`,
      ['QR-SPRINGS', '30.00'],
    );

    const id = await createDraftQuote(MANAGER_USER);
    const res = await priceQuote(MANAGER_USER, id, [
      // PART-A (QR-SPRINGS): line override of 75% beats category 30%
      {
        sku: 'PART-A',
        quantity: 1,
        marginOverridePct: 75,
        marginOverrideReason: 'Loyal customer',
      },
      // PART-B (QR-RAILS): no category row -> default 50%
      { sku: 'PART-B', quantity: 1 },
      // PART-C (QR-HINGES): no override; itemCategory 'QR-SPRINGS' forces category 30% match
      { sku: 'PART-C', quantity: 1, itemCategory: 'QR-SPRINGS' },
    ]);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { lineItems: Array<{ position: number; appliedMarginSource: string }> };
    };
    const sourceByPos = new Map(
      body.data.lineItems.map((l) => [l.position, l.appliedMarginSource]),
    );
    expect(sourceByPos.get(0)).toBe('line_override');
    expect(sourceByPos.get(1)).toBe('corporate_default');
    expect(sourceByPos.get(2)).toBe('category_override');
  });

  it('rejects overrides below the corporate floor with MARGIN_OUT_OF_BOUNDS', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    const res = await priceQuote(MANAGER_USER, id, [
      {
        sku: 'PART-A',
        quantity: 1,
        marginOverridePct: 5, // < min 10
        marginOverrideReason: 'Loss leader',
      },
    ]);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('MARGIN_OUT_OF_BOUNDS');
  });

  it('rejects margin override without reason with OVERRIDE_REASON_REQUIRED', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    const res = await priceQuote(MANAGER_USER, id, [
      { sku: 'PART-A', quantity: 1, marginOverridePct: 50 },
    ]);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('OVERRIDE_REASON_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
// Role gating
// ---------------------------------------------------------------------------

describe('quote routes — role gating', () => {
  it('csr attempting marginOverridePct returns 403 OVERRIDE_NOT_PERMITTED', async () => {
    if (!reachable) return;
    // Draft + price must be done by csr; create draft first.
    const id = await createDraftQuote(CSR_USER);
    const res = await priceQuote(CSR_USER, id, [
      {
        sku: 'PART-A',
        quantity: 1,
        marginOverridePct: 50,
        marginOverrideReason: 'Trying it on',
      },
    ]);
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('OVERRIDE_NOT_PERMITTED');
  });
});

// ---------------------------------------------------------------------------
// Cost-forgery integration
// ---------------------------------------------------------------------------

describe('quote routes — cost forgery', () => {
  it('rejects a smuggled unitCostCents field with 400 (TD-SQB-A3 .strict())', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    // The line schema is .strict(): an unknown field is a hard 400, not
    // a silent strip. This is the load-bearing guard against a future
    // contributor accidentally re-opening client-supplied cost trust.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/price`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {
        lineItems: [
          {
            sku: 'PART-A',
            quantity: 1,
            unitCostCents: 99_999_999,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('cost comes from the supplier, never the client (clean path)', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/price`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: { lineItems: [{ sku: 'PART-A', quantity: 1 }] },
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query<{ supplier_unit_cost_cents: string }>(
      `SELECT supplier_unit_cost_cents FROM quote_line_items WHERE quote_id = $1`,
      [id],
    );
    expect(Number(rows[0]?.supplier_unit_cost_cents)).toBe(10_000); // mock catalog value
  });
});

// ---------------------------------------------------------------------------
// Frozen totals on category override edit
// ---------------------------------------------------------------------------

describe('quote routes — frozen totals on category override edit', () => {
  it('committed quote keeps totals when margin_overrides is edited afterward', async () => {
    if (!reachable) return;
    // Seed a category override at 30%.
    await pool.query(
      `INSERT INTO margin_overrides (item_category, margin_pct) VALUES ($1, $2)`,
      ['QR-SPRINGS', '30.00'],
    );

    // Price + commit a quote on QR-SPRINGS.
    const quoteAId = await createDraftQuote(MANAGER_USER);
    const priceRes = await priceQuote(MANAGER_USER, quoteAId, [
      { sku: 'PART-A', quantity: 1, itemCategory: 'QR-SPRINGS' },
    ]);
    expect(priceRes.statusCode).toBe(200);
    const aBody = priceRes.json() as {
      data: { quote: { totalCents: number } };
    };
    const aTotalAtPrice = aBody.data.quote.totalCents;
    // 10_000 * 1.30 = 13_000
    expect(aTotalAtPrice).toBe(13_000);

    const commitRes = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${quoteAId}/commit`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: { idempotencyKey: `commit-${quoteAId}` },
    });
    expect(commitRes.statusCode).toBe(200);

    // Edit the margin override row out from under the committed quote.
    await pool.query(
      `UPDATE margin_overrides SET margin_pct = $1 WHERE item_category = $2`,
      ['80.00', 'QR-SPRINGS'],
    );

    // Re-fetch the committed quote — totals must still be 13_000.
    const fetchRes = await app.inject({
      method: 'GET',
      url: `/api/v1/quotes/${quoteAId}`,
      headers: { 'x-test-user': MANAGER_USER },
    });
    expect(fetchRes.statusCode).toBe(200);
    const fetchBody = fetchRes.json() as {
      data: { quote: { totalCents: number } };
    };
    expect(fetchBody.data.quote.totalCents).toBe(13_000);

    // A NEW draft quote on the same item picks up the EDITED margin.
    const quoteBId = await createDraftQuote(MANAGER_USER);
    const priceBRes = await priceQuote(MANAGER_USER, quoteBId, [
      { sku: 'PART-A', quantity: 1, itemCategory: 'QR-SPRINGS' },
    ]);
    expect(priceBRes.statusCode).toBe(200);
    const bBody = priceBRes.json() as {
      data: { quote: { totalCents: number } };
    };
    // 10_000 * 1.80 = 18_000
    expect(bBody.data.quote.totalCents).toBe(18_000);
  });
});

// ---------------------------------------------------------------------------
// Status machine
// ---------------------------------------------------------------------------

describe('quote routes — status machine', () => {
  it('draft -> priced is legal', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    const res = await priceQuote(MANAGER_USER, id, [
      { sku: 'PART-A', quantity: 1 },
    ]);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { quote: { status: string } } };
    expect(body.data.quote.status).toBe('priced');
  });

  it('priced -> committed is legal', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    const pRes = await priceQuote(MANAGER_USER, id, [
      { sku: 'PART-A', quantity: 1 },
    ]);
    expect(pRes.statusCode).toBe(200);
    const cRes = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/commit`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    expect(cRes.statusCode).toBe(200);
    const body = cRes.json() as { data: { quote: { status: string } } };
    expect(body.data.quote.status).toBe('committed');
  });

  it('draft -> committed (without pricing) returns 409 INVALID_TRANSITION', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/commit`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_TRANSITION');
  });
});

// ---------------------------------------------------------------------------
// Commission integration
// ---------------------------------------------------------------------------

describe('quote routes — commission preview (TD-SQB-A5)', () => {
  it('/price returns commissionPreview computed off the closer’s active comp plan', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    // Default 50% margin: PART-A at $100 cost → $150 selling price.
    // MANAGER_USER's seeded plan has a 2% flat_percent_of_quote_committed
    // rule (same one /commit credits), so the preview should match.
    const res = await priceQuote(MANAGER_USER, id, [
      { sku: 'PART-A', quantity: 1 },
    ]);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: {
        quote: { totalCents: number };
        commissionPreview: { commissionCents: number; percentEffective: number } | null;
      };
    };
    expect(body.data.quote.totalCents).toBe(15_000);
    expect(body.data.commissionPreview).not.toBeNull();
    expect(body.data.commissionPreview?.commissionCents).toBe(300);
    expect(body.data.commissionPreview?.percentEffective).toBe(2);
  });

  it('/price returns commissionPreview=null when the user has no active comp plan', async () => {
    if (!reachable) return;
    // CSR_USER (csr role) is not assigned a comp plan in the test seed.
    const id = await createDraftQuote(CSR_USER);
    const res = await priceQuote(CSR_USER, id, [
      { sku: 'PART-A', quantity: 1 },
    ]);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { commissionPreview: unknown };
    };
    expect(body.data.commissionPreview).toBeNull();
  });
});

describe('quote routes — commission ledger', () => {
  it('writes a ledger row on commit for the closer (manager)', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    // Default 50% margin: PART-A at $100 cost -> $150 selling price.
    const pRes = await priceQuote(MANAGER_USER, id, [
      { sku: 'PART-A', quantity: 1 },
    ]);
    expect(pRes.statusCode).toBe(200);
    const cRes = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/commit`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    expect(cRes.statusCode).toBe(200);
    const { rows } = await pool.query<{ amount_cents: string; source_kind: string }>(
      `SELECT amount_cents, source_kind FROM commission_ledger
        WHERE user_id = $1 AND source_kind = 'quote_committed'`,
      [MANAGER_USER],
    );
    expect(rows.length).toBe(1);
    // total = 15_000 cents; 2% rule => 300 cents
    expect(Number(rows[0]!.amount_cents)).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Void reversal
// ---------------------------------------------------------------------------

describe('quote routes — void reversal', () => {
  it('writes a balancing -cents ledger row when a committed quote is voided', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    await priceQuote(MANAGER_USER, id, [{ sku: 'PART-A', quantity: 1 }]);
    await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/commit`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    const vRes = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/void`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: { reason: 'customer changed mind' },
    });
    expect(vRes.statusCode).toBe(200);
    const { rows } = await pool.query<{ amount_cents: string; source_kind: string }>(
      `SELECT amount_cents, source_kind FROM commission_ledger
        WHERE user_id = $1
        ORDER BY created_at`,
      [MANAGER_USER],
    );
    expect(rows.length).toBe(2);
    expect(rows[0]!.source_kind).toBe('quote_committed');
    expect(Number(rows[0]!.amount_cents)).toBe(300);
    expect(rows[1]!.source_kind).toBe('manual_adjustment');
    expect(Number(rows[1]!.amount_cents)).toBe(-300);
  });

  it('reverses commission when an ACCEPTED quote is voided (TD-SQB-A6)', async () => {
    if (!reachable) return;
    // The accepted→void branch became reachable once /accept landed
    // (SQB M2). Exercise it: commit (credits +300), accept (no ledger
    // change), then void (must write the balancing -300).
    const id = await createDraftQuote(MANAGER_USER);
    await priceQuote(MANAGER_USER, id, [{ sku: 'PART-A', quantity: 1 }]);
    await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/commit`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    const aRes = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/accept`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: { acknowledgmentChannel: 'verbal_phone' },
    });
    expect(aRes.statusCode).toBe(200);

    const vRes = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/void`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: { reason: 'refund after acceptance' },
    });
    expect(vRes.statusCode).toBe(200);

    const { rows } = await pool.query<{ amount_cents: string; source_kind: string }>(
      `SELECT amount_cents, source_kind FROM commission_ledger
        WHERE user_id = $1 AND source_id LIKE $2
        ORDER BY created_at`,
      [MANAGER_USER, `%${id}%`],
    );
    // One credit + one balancing reversal → nets to zero.
    const net = rows.reduce((s, r) => s + Number(r.amount_cents), 0);
    expect(net).toBe(0);
    expect(rows.some((r) => r.source_kind === 'manual_adjustment' && Number(r.amount_cents) === -300)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// QOC-06: accept + quote-to-order conversion
//
// Lives in this file (vs. a separate `live-quote-order-conversion.test.ts`)
// to reuse the heavyweight fixture setup above. The QOC gate names a
// new file; the auditor may push back. If split, hoist the fixtures
// into a shared helper module first to avoid a 250-line setup
// duplication.
// ---------------------------------------------------------------------------

async function commitQuoteHelper(user: string, id: string): Promise<void> {
  await priceQuote(user, id, [{ sku: 'PART-A', quantity: 1 }]);
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/quotes/${id}/commit`,
    headers: { 'x-test-user': user, 'content-type': 'application/json' },
    payload: {},
  });
  if (res.statusCode !== 200) {
    throw new Error(`commit failed: ${res.statusCode} ${res.body}`);
  }
}

describe('quote routes — share / customer accept link (CQA-02)', () => {
  async function shareQuote(user: string, id: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/share`,
      headers: { 'x-test-user': user, 'content-type': 'application/json' },
      payload: {},
    });
  }

  it('returns 401 when unauthenticated', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/quotes/00000000-0000-0000-0000-000000000001/share',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 on malformed UUID', async () => {
    if (!reachable) return;
    const res = await shareQuote(MANAGER_USER, 'not-a-uuid');
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 on a different branch's quote (no cross-branch leakage)", async () => {
    if (!reachable) return;
    const otherId = await createDraftQuote(OTHER_MGR_USER, {
      customerId: OTHER_CUSTOMER_ID,
      supplierId: OTHER_SUPPLIER_ID,
    });
    await commitQuoteHelper(OTHER_MGR_USER, otherId);
    const res = await shareQuote(MANAGER_USER, otherId);
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 INVALID_STATE when the quote is not committed (still draft)', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    const res = await shareQuote(MANAGER_USER, id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_STATE');
  });

  it('happy path mints a token + URL; deposit null when policy pct = 0', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id);
    const res = await shareQuote(MANAGER_USER, id);
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      token: string;
      url: string;
      expiresAt: string;
      depositAmountCents: number | null;
    };
    expect(data.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(data.url).toContain(`/quotes/${data.token}/accept`);
    expect(new Date(data.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(data.depositAmountCents).toBeNull();

    // Token persisted on the row.
    const { rows } = await pool.query<{ accept_token: string }>(
      `SELECT accept_token FROM quotes WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.accept_token).toBe(data.token);
  });

  it('freezes the deposit amount from the corporate policy (25% of total)', async () => {
    if (!reachable) return;
    await pool.query(`UPDATE corporate SET deposit_pct = '25.00', deposit_min_cents = 0, deposit_max_cents = NULL`);
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id); // PART-A → total 15_000 cents
    const res = await shareQuote(MANAGER_USER, id);
    expect(res.statusCode).toBe(200);
    // 25% of 15_000 = 3_750
    expect(res.json().data.depositAmountCents).toBe(3_750);
    const { rows } = await pool.query<{ deposit_amount_cents: number }>(
      `SELECT deposit_amount_cents FROM quotes WHERE id = $1`,
      [id],
    );
    expect(Number(rows[0]?.deposit_amount_cents)).toBe(3_750);
  });

  it('clamps the deposit to the policy floor', async () => {
    if (!reachable) return;
    // 25% of 15_000 = 3_750, but floor is 5_000 → clamps up.
    await pool.query(`UPDATE corporate SET deposit_pct = '25.00', deposit_min_cents = 5000, deposit_max_cents = NULL`);
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id);
    const res = await shareQuote(MANAGER_USER, id);
    expect(res.json().data.depositAmountCents).toBe(5_000);
  });

  it('is idempotent — re-sharing returns the same live token', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id);
    const first = await shareQuote(MANAGER_USER, id);
    const second = await shareQuote(MANAGER_USER, id);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.token).toBe(first.json().data.token);
  });
});

describe('public quote routes — customer accept link (CQA-03)', () => {
  async function shareAndGetToken(user: string, id: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/share`,
      headers: { 'x-test-user': user, 'content-type': 'application/json' },
      payload: {},
    });
    if (res.statusCode !== 200) throw new Error(`share failed: ${res.statusCode} ${res.body}`);
    return res.json().data.token as string;
  }

  async function committedSharedQuote(): Promise<{ id: string; token: string }> {
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id);
    const token = await shareAndGetToken(MANAGER_USER, id);
    return { id, token };
  }

  it('GET returns 400 on a bad token shape', async () => {
    if (!reachable) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/quotes/short' });
    expect(res.statusCode).toBe(400);
  });

  it('GET returns 404 on an unknown (well-formed) token', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/quotes/${'A'.repeat(43)}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET happy path returns the whitelisted summary', async () => {
    if (!reachable) return;
    const { token } = await committedSharedQuote();
    const res = await app.inject({ method: 'GET', url: `/api/v1/public/quotes/${token}` });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.status).toBe('committed');
    expect(data.supplierQuoteRef).toMatch(/^SQ-/);
    expect(data.totalCents).toBe(15_000);
    expect(data.customerName).toBeTruthy();
    expect(Array.isArray(data.lineItems)).toBe(true);
    expect(data.lineItems[0].unitPriceCents).toBe(15_000);
  });

  it('GET never leaks cost or margin fields (field-leak guard)', async () => {
    if (!reachable) return;
    const { token } = await committedSharedQuote();
    const res = await app.inject({ method: 'GET', url: `/api/v1/public/quotes/${token}` });
    const body = res.body; // raw JSON string
    expect(body).not.toMatch(/margin/i);
    expect(body).not.toMatch(/unitCost/i);
    expect(body).not.toMatch(/supplier_unit_cost/i);
    expect(body).not.toMatch(/appliedMargin/i);
  });

  it('POST accept rejects a non-JSON content-type with 403', async () => {
    if (!reachable) return;
    const { token } = await committedSharedQuote();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/quotes/${token}/accept`,
      headers: { 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST accept rejects a cross-origin request with 403 when WEB_ORIGIN is set', async () => {
    if (!reachable) return;
    const prev = process.env['WEB_ORIGIN'];
    process.env['WEB_ORIGIN'] = 'https://app.elevateddoors.test';
    try {
      const { token } = await committedSharedQuote();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/public/quotes/${token}/accept`,
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    } finally {
      if (prev === undefined) delete process.env['WEB_ORIGIN'];
      else process.env['WEB_ORIGIN'] = prev;
    }
  });

  it('POST accept happy path transitions to accepted + stamps the BC order ref', async () => {
    if (!reachable) return;
    const { id, token } = await committedSharedQuote();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/quotes/${token}/accept`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.accepted).toBe(true);
    expect(data.status).toBe('accepted');
    expect(data.supplierOrderRef).toMatch(/^SO-/);

    // Row persisted: accepted_channel customer_link + order ref.
    const { rows } = await pool.query<{ status: string; accepted_channel: string; supplier_order_ref: string }>(
      `SELECT status, accepted_channel, supplier_order_ref FROM quotes WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.status).toBe('accepted');
    expect(rows[0]?.accepted_channel).toBe('customer_link');
    expect(rows[0]?.supplier_order_ref).toMatch(/^SO-/);

    // audit_log: actor is null (customer is not a Service.AI user) but the
    // customer ref + channel are captured in metadata.
    const { rows: audit } = await pool.query<{ actor_user_id: string | null; customer_ref: string; channel: string }>(
      `SELECT actor_user_id, metadata->>'customerRef' AS customer_ref, metadata->>'acknowledgmentChannel' AS channel
         FROM audit_log WHERE action = 'quote.accept' AND metadata->>'quoteId' = $1`,
      [id],
    );
    expect(audit[0]?.actor_user_id).toBeNull();
    expect(audit[0]?.customer_ref).toMatch(/^customer:/);
    expect(audit[0]?.channel).toBe('customer_link');
  });

  it('POST accept on an already-accepted quote returns 409', async () => {
    if (!reachable) return;
    const { token } = await committedSharedQuote();
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/public/quotes/${token}/accept`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/public/quotes/${token}/accept`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(second.statusCode).toBe(409);
  });

  it('POST accept on an expired token returns 410 GONE', async () => {
    if (!reachable) return;
    const { id, token } = await committedSharedQuote();
    await pool.query(
      `UPDATE quotes SET accept_token_expires_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/quotes/${token}/accept`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(410);
  });
});

describe('quote PDF — operator + public (CQA-04)', () => {
  async function committedSharedQuote(): Promise<{ id: string; token: string }> {
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/share`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    return { id, token: res.json().data.token as string };
  }

  it('operator GET /quotes/:id/quote.pdf returns a PDF', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/quotes/${id}/quote.pdf`,
      headers: { 'x-test-user': MANAGER_USER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('operator quote.pdf is 401 unauthenticated', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/quotes/00000000-0000-0000-0000-000000000001/quote.pdf',
    });
    expect(res.statusCode).toBe(401);
  });

  it("operator quote.pdf is 404 on another branch's quote", async () => {
    if (!reachable) return;
    const otherId = await createDraftQuote(OTHER_MGR_USER, {
      customerId: OTHER_CUSTOMER_ID,
      supplierId: OTHER_SUPPLIER_ID,
    });
    await commitQuoteHelper(OTHER_MGR_USER, otherId);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/quotes/${otherId}/quote.pdf`,
      headers: { 'x-test-user': MANAGER_USER },
    });
    expect(res.statusCode).toBe(404);
  });

  it('public GET /public/quotes/:token/pdf returns a PDF', async () => {
    if (!reachable) return;
    const { token } = await committedSharedQuote();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/quotes/${token}/pdf`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.rawPayload.subarray(0, 4).toString('latin1')).toBe('%PDF');
  });

  it('public quote pdf is 404 on an unknown token', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/public/quotes/${'B'.repeat(43)}/pdf`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('quote deposit — Stripe intent + webhook (CQA-05)', () => {
  async function acceptedQuoteWithDeposit(pct = '25.00'): Promise<{ id: string; token: string }> {
    await pool.query(
      `UPDATE corporate SET deposit_pct = $1, deposit_min_cents = 0, deposit_max_cents = NULL`,
      [pct],
    );
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id);
    const share = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/share`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    const token = share.json().data.token as string;
    const accept = await app.inject({
      method: 'POST',
      url: `/api/v1/public/quotes/${token}/accept`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    if (accept.statusCode !== 200) throw new Error(`accept failed: ${accept.statusCode} ${accept.body}`);
    return { id, token };
  }

  function depositIntent(token: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/public/quotes/${token}/deposit-intent`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
  }

  it('deposit-intent before accept returns 409', async () => {
    if (!reachable) return;
    await pool.query(`UPDATE corporate SET deposit_pct = '25.00'`);
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id);
    const share = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/share`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    const token = share.json().data.token as string;
    const res = await depositIntent(token); // not accepted yet
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_STATE');
  });

  it('deposit-intent happy path returns a clientSecret + amount and stores the PI id', async () => {
    if (!reachable) return;
    const { id, token } = await acceptedQuoteWithDeposit();
    const res = await depositIntent(token);
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { clientSecret: string; amountCents: number };
    expect(data.clientSecret).toContain('_secret_stub');
    expect(data.amountCents).toBe(3_750); // 25% of 15_000

    const { rows } = await pool.query<{ deposit_payment_intent_id: string }>(
      `SELECT deposit_payment_intent_id FROM quotes WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.deposit_payment_intent_id).toMatch(/^pi_stub_/);
  });

  it('deposit-intent is idempotent — same clientSecret, no second PI', async () => {
    if (!reachable) return;
    const { id, token } = await acceptedQuoteWithDeposit();
    const first = await depositIntent(token);
    const { rows: afterFirst } = await pool.query<{ deposit_payment_intent_id: string }>(
      `SELECT deposit_payment_intent_id FROM quotes WHERE id = $1`,
      [id],
    );
    const second = await depositIntent(token);
    const { rows: afterSecond } = await pool.query<{ deposit_payment_intent_id: string }>(
      `SELECT deposit_payment_intent_id FROM quotes WHERE id = $1`,
      [id],
    );
    expect(second.json().data.clientSecret).toBe(first.json().data.clientSecret);
    expect(afterSecond[0]?.deposit_payment_intent_id).toBe(afterFirst[0]?.deposit_payment_intent_id);
  });

  it('deposit-intent returns 409 NO_DEPOSIT when the policy collects nothing', async () => {
    if (!reachable) return;
    // pct 0 → no deposit frozen at share → deposit_amount_cents null.
    const { token } = await acceptedQuoteWithDeposit('0.00');
    const res = await depositIntent(token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NO_DEPOSIT');
  });

  it('webhook payment_intent.succeeded stamps deposit_paid_at (idempotent on redelivery)', async () => {
    if (!reachable) return;
    const { id, token } = await acceptedQuoteWithDeposit();
    await depositIntent(token);
    const { rows } = await pool.query<{ deposit_payment_intent_id: string }>(
      `SELECT deposit_payment_intent_id FROM quotes WHERE id = $1`,
      [id],
    );
    const piId = rows[0]!.deposit_payment_intent_id;

    const event = {
      id: `evt_dep_${piId}`,
      type: 'payment_intent.succeeded',
      data: { object: { id: piId, amount: 3_750, currency: 'cad', status: 'succeeded' } },
    };
    const post = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/stripe',
        headers: { 'content-type': 'application/json', 'stripe-signature': 'sig-ignored-by-stub' },
        payload: JSON.stringify(event),
      });

    const first = await post();
    expect(first.statusCode).toBe(200);
    const { rows: paid1 } = await pool.query<{ deposit_paid_at: string | null }>(
      `SELECT deposit_paid_at FROM quotes WHERE id = $1`,
      [id],
    );
    expect(paid1[0]?.deposit_paid_at).not.toBeNull();

    // Redelivery of the SAME event id → replay short-circuit, still stamped once.
    const second = await post();
    expect(second.statusCode).toBe(200);
    expect(second.json().data.replay).toBe(true);
  });

  it('webhook with an unmatched PI is a no-op 200', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig-ignored-by-stub' },
      payload: JSON.stringify({
        id: 'evt_unmatched_pi_1',
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_does_not_exist', amount: 100, currency: 'cad', status: 'succeeded' } },
      }),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('accept → job fulfillment link (QF-02)', () => {
  async function committedShared(): Promise<{ id: string; token: string }> {
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id);
    const share = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/share`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    return { id, token: share.json().data.token as string };
  }

  it('operator accept with no job creates one unassigned job linked to the quote', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/accept`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: { acknowledgmentChannel: 'verbal_phone' },
    });
    expect(res.statusCode).toBe(200);

    const { rows } = await pool.query<{ id: string; status: string; quote_id: string }>(
      `SELECT id, status, quote_id FROM jobs WHERE quote_id = $1`,
      [id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('unassigned');

    const { rows: qrows } = await pool.query<{ job_id: string }>(
      `SELECT job_id FROM quotes WHERE id = $1`,
      [id],
    );
    expect(qrows[0]!.job_id).toBe(rows[0]!.id);
  });

  it('public accept with no job creates one unassigned job linked to the quote', async () => {
    if (!reachable) return;
    const { id, token } = await committedShared();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/public/quotes/${token}/accept`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query(`SELECT id FROM jobs WHERE quote_id = $1`, [id]);
    expect(rows.length).toBe(1);
  });

  it('accept links an existing job instead of creating a second one', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id);
    // Pre-create a job and link the quote to it.
    const jobIns = await pool.query<{ id: string }>(
      `INSERT INTO jobs (branch_id, customer_id, title, status)
       VALUES ($1, $2, 'Pre-existing job', 'unassigned') RETURNING id`,
      [BRANCH_ID, CUSTOMER_ID],
    );
    const existingJobId = jobIns.rows[0]!.id;
    await pool.query(`UPDATE quotes SET job_id = $1 WHERE id = $2`, [existingJobId, id]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/accept`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    // No second job; the existing one is now linked back to the quote.
    const { rows } = await pool.query<{ id: string; quote_id: string }>(
      `SELECT id, quote_id FROM jobs WHERE customer_id = $1`,
      [CUSTOMER_ID],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(existingJobId);
    expect(rows[0]!.quote_id).toBe(id);
  });
});

describe('completion → balance invoice (QF-03)', () => {
  async function shareCommitted(id: string): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/share`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    if (res.statusCode !== 200) throw new Error(`share failed: ${res.statusCode}`);
  }
  async function acceptOperator(id: string): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/accept`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: { acknowledgmentChannel: 'verbal_phone' },
    });
    if (res.statusCode !== 200) throw new Error(`accept failed: ${res.statusCode} ${res.body}`);
  }
  async function completeJob(jobId: string): Promise<void> {
    for (const to of ['scheduled', 'en_route', 'arrived', 'in_progress', 'completed']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${jobId}/transition`,
        headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
        payload: JSON.stringify({ toStatus: to }),
      });
      if (res.statusCode !== 200) throw new Error(`transition ${to} failed: ${res.statusCode} ${res.body}`);
    }
  }
  async function jobIdForQuote(quoteId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM jobs WHERE quote_id = $1`,
      [quoteId],
    );
    return rows[0]!.id;
  }

  it('completing a quote-linked job drafts a balance invoice crediting the paid deposit', async () => {
    if (!reachable) return;
    await pool.query(`UPDATE corporate SET deposit_pct = '25.00', deposit_min_cents = 0, deposit_max_cents = NULL`);
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id); // total 15_000 cents = $150
    await shareCommitted(id); // freezes deposit 3_750
    await acceptOperator(id); // creates the job
    await pool.query(`UPDATE quotes SET deposit_paid_at = now() WHERE id = $1`, [id]);

    const jobId = await jobIdForQuote(id);
    await completeJob(jobId);

    const { rows: inv } = await pool.query<{ id: string; status: string; total: string }>(
      `SELECT id, status, total FROM invoices WHERE quote_id = $1 AND deleted_at IS NULL`,
      [id],
    );
    expect(inv.length).toBe(1);
    expect(inv[0]!.status).toBe('draft');
    // balance = $150.00 − $37.50 deposit = $112.50
    expect(Number(inv[0]!.total)).toBe(112.5);

    const { rows: credit } = await pool.query<{ line_total: string }>(
      `SELECT line_total FROM invoice_line_items WHERE invoice_id = $1 AND sku = 'DEPOSIT'`,
      [inv[0]!.id],
    );
    expect(credit.length).toBe(1);
    expect(Number(credit[0]!.line_total)).toBe(-37.5);
  });

  it('no deposit → balance invoice total is the full quote total, no credit line', async () => {
    if (!reachable) return;
    // deposit_pct 0 (beforeEach default) → no deposit frozen.
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id);
    await acceptOperator(id);
    const jobId = await jobIdForQuote(id);
    await completeJob(jobId);

    const { rows: inv } = await pool.query<{ id: string; total: string }>(
      `SELECT id, total FROM invoices WHERE quote_id = $1 AND deleted_at IS NULL`,
      [id],
    );
    expect(inv.length).toBe(1);
    expect(Number(inv[0]!.total)).toBe(150.0);
    const { rows: credit } = await pool.query(
      `SELECT 1 FROM invoice_line_items WHERE invoice_id = $1 AND sku = 'DEPOSIT'`,
      [inv[0]!.id],
    );
    expect(credit.length).toBe(0);
  });

  it('completing a plain (no-quote) job does NOT auto-generate an invoice', async () => {
    if (!reachable) return;
    const jobIns = await pool.query<{ id: string }>(
      `INSERT INTO jobs (branch_id, customer_id, title, status)
       VALUES ($1, $2, 'Plain service call', 'unassigned') RETURNING id`,
      [BRANCH_ID, CUSTOMER_ID],
    );
    const jobId = jobIns.rows[0]!.id;
    await completeJob(jobId);
    const { rows } = await pool.query(`SELECT 1 FROM invoices WHERE job_id = $1`, [jobId]);
    expect(rows.length).toBe(0);
  });
});

describe('quote routes — accept + quote-to-order conversion (QOC)', () => {
  it('happy path: accept stamps SO-XXXXXX on the quote row via mock provider', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id);

    const aRes = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/accept`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: { acknowledgmentChannel: 'verbal_phone' },
    });
    expect(aRes.statusCode).toBe(200);
    const body = aRes.json() as {
      data: {
        quote: {
          status: string;
          supplierOrderRef: string | null;
          supplierOrderId: string | null;
          orderedAt: string | null;
        };
      };
    };
    expect(body.data.quote.status).toBe('accepted');
    expect(body.data.quote.supplierOrderRef).toMatch(/^SO-\d{6}$/);
    expect(body.data.quote.supplierOrderId).toBeTruthy();
    expect(body.data.quote.orderedAt).toBeTruthy();
    expect(mockProvider.isConverted(id)).toBe(true);

    // TD-QOC-A10: assert the columns actually persisted on the row, not
    // just that the response (built from loadQuoteDetail) carried them.
    const { rows: quoteRows } = await pool.query<{
      supplier_order_ref: string | null;
      supplier_order_id: string | null;
      ordered_at: string | null;
    }>(
      `SELECT supplier_order_ref, supplier_order_id, ordered_at FROM quotes WHERE id = $1`,
      [id],
    );
    expect(quoteRows[0]?.supplier_order_ref).toMatch(/^SO-\d{6}$/);
    expect(quoteRows[0]?.supplier_order_id).toBeTruthy();
    expect(quoteRows[0]?.ordered_at).toBeTruthy();

    // TD-QOC-A2: assert the quote.accept audit_log row landed with the
    // expected actor + quoteId metadata. A future refactor that drops
    // the audit insert would be caught here, not silently.
    const { rows: acceptAudit } = await pool.query<{
      actor_user_id: string;
    }>(
      `SELECT actor_user_id FROM audit_log
        WHERE action = 'quote.accept' AND metadata->>'quoteId' = $1`,
      [id],
    );
    expect(acceptAudit.length).toBe(1);
    expect(acceptAudit[0]?.actor_user_id).toBe(MANAGER_USER);

    // TD-QOC-A4: the conversion event is now an audit_log row, not a
    // status_log self-loop. Assert it landed and that NO accepted→accepted
    // status_log row was written.
    const { rows: convAudit } = await pool.query(
      `SELECT 1 FROM audit_log
        WHERE action = 'quote.order_converted' AND metadata->>'quoteId' = $1`,
      [id],
    );
    expect(convAudit.length).toBe(1);
    const { rows: selfLoop } = await pool.query(
      `SELECT 1 FROM quote_status_log
        WHERE quote_id = $1 AND from_status = 'accepted' AND to_status = 'accepted'`,
      [id],
    );
    expect(selfLoop.length).toBe(0);
  });

  it('returns 401 when unauthenticated', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/quotes/00000000-0000-0000-0000-000000000001/accept',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 on a different branch's quote (no cross-branch leakage)", async () => {
    if (!reachable) return;
    const otherId = await createDraftQuote(OTHER_MGR_USER, {
      customerId: OTHER_CUSTOMER_ID,
      supplierId: OTHER_SUPPLIER_ID,
    });
    await priceQuote(OTHER_MGR_USER, otherId, [{ sku: 'PART-A', quantity: 1 }]);
    await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${otherId}/commit`,
      headers: {
        'x-test-user': OTHER_MGR_USER,
        'content-type': 'application/json',
      },
      payload: {},
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${otherId}/accept`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 on malformed UUID', async () => {
    if (!reachable) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/quotes/not-a-uuid/accept',
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 INVALID_TRANSITION on draft → accept (not committed first)', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/accept`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_TRANSITION');
  });

  it('provider failure does NOT roll back the local accept state', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id);

    mockProvider.injectFailure('convertToOrder', {
      code: 'NETWORK_ERROR',
      message: 'simulated BC outage',
      retryable: true,
    });

    const aRes = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/accept`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    expect(aRes.statusCode).toBe(200);
    const body = aRes.json() as {
      data: {
        quote: {
          status: string;
          supplierOrderRef: string | null;
          orderedAt: string | null;
        };
      };
    };
    expect(body.data.quote.status).toBe('accepted');
    expect(body.data.quote.supplierOrderRef).toBeNull();
    expect(body.data.quote.orderedAt).toBeNull();
  });

  it('idempotent retry: a second /accept after a successful conversion does not re-convert', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    await commitQuoteHelper(MANAGER_USER, id);

    const a1 = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/accept`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    expect(a1.statusCode).toBe(200);
    const firstRef = (
      a1.json() as { data: { quote: { supplierOrderRef: string } } }
    ).data.quote.supplierOrderRef;

    // Reset the mock's failure injection so a second convert call would
    // mint a new SO ref if it ran. Then call /accept again — the route
    // sees status=accepted, returns 409 INVALID_TRANSITION (correct
    // behavior; accepted is terminal except for void). This proves the
    // /accept route does not blindly re-trigger conversion.
    const a2 = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/accept`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {},
    });
    expect(a2.statusCode).toBe(409);

    // The quote row still carries the original order ref.
    const { rows } = await pool.query<{ supplier_order_ref: string }>(
      `SELECT supplier_order_ref FROM quotes WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.supplier_order_ref).toBe(firstRef);
  });
});
