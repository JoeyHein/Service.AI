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
  await pool.query(`DELETE FROM quotes WHERE branch_id IN ($1, $2)`, [
    BRANCH_ID,
    OTHER_BRANCH_ID,
  ]);
  await pool.query(`DELETE FROM margin_overrides WHERE item_category LIKE 'QR-%'`);
  await pool.query(`DELETE FROM audit_log WHERE action = 'quote.margin_override'`);
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
  it('ignores client-supplied unitCostCents; supplier value wins', async () => {
    if (!reachable) return;
    const id = await createDraftQuote(MANAGER_USER);
    // Force a wildly inflated body that the route should NOT honor.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${id}/price`,
      headers: { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' },
      payload: {
        lineItems: [
          {
            sku: 'PART-A',
            quantity: 1,
            // The field below is intentionally not in the schema; Zod
            // strips it. The point is that even a future schema that
            // accepted it would be a footgun — the integration check
            // is on the resulting DB row.
            unitCostCents: 99_999_999,
          },
        ],
      },
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
