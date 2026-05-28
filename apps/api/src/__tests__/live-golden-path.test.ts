/**
 * W5 — Golden-path end-to-end (the "it all works together" check).
 *
 * Walks one job through its entire money+ops lifecycle against the REAL
 * Fastify app and a REAL Postgres, exactly the way production routes run —
 * only the external adapters are stubbed (supplier = MockSupplierProvider,
 * Stripe/email/SMS = the env-gated stubs that ship when no keys are set). No
 * browser, no third-party credentials: this is the machine-verified backbone
 * the pilot go-live plan calls for (docs/PILOT_GO_LIVE_PLAN.md, W5).
 *
 *   book        POST /api/v1/jobs                         → job (unassigned)
 *   quote       POST /api/v1/quotes                       → draft
 *               POST /api/v1/quotes/:id/price             → priced
 *               POST /api/v1/quotes/:id/commit            → committed (BC ref)
 *   accept      POST /api/v1/quotes/:id/share             → customer link token
 *               POST /api/v1/public/quotes/:token/accept  → accepted, job linked
 *   complete    POST /api/v1/jobs/:id/transition × N      → completed
 *                 └─ auto-drafts the balance invoice (QF-03)
 *   invoice     POST /api/v1/invoices/:id/finalize        → finalized (+ PI)
 *   pay         POST /api/v1/webhooks/stripe              → paid
 *
 * Auto-skips when Postgres is unreachable on DATABASE_URL (same contract as
 * every other live-*.test.ts), so it is a no-op locally without a DB but runs
 * for real in CI's `pnpm -r test` job where Postgres is provisioned.
 *
 * Harness mirrors live-quote-routes.test.ts: stub auth keyed off the
 * `x-test-user` header + an injected MembershipResolver, deterministic IDs,
 * and a MockSupplierProvider registered under the `bc_ai_agent` kind.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

// The public accept route enforces a same-origin (or no-origin) JSON POST.
// Pin WEB_ORIGIN for the run and send a matching Origin header on accept.
const WEB_ORIGIN = 'http://localhost:3000';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let app: FastifyInstance;
let priorWebOrigin: string | undefined;

// Deterministic IDs — 'gp' (golden path) namespace, distinct from every other
// live test file so the suite can run them in one process without collisions.
const MANAGER_USER = 'gp-mgr-id-xxxxxxxxxxxxxxxxxxxx';
const CORPORATE_ID = '00000000-0000-0000-0000-00000000c69d';
const BRANCH_ID = '00000000-0000-0000-0000-0000000b69d0';
const CUSTOMER_ID = '00000000-0000-0000-0000-0000000a69d0';
const SUPPLIER_ID = '00000000-0000-0000-0000-00000005690d';

// Stub Stripe event id — deleted in teardown so reruns aren't deduped away.
const WEBHOOK_EVENT_ID = 'evt_gp_paid_1';

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
      return [];
    },
  };
}

async function clean(): Promise<void> {
  // Children before parents (RESTRICT FKs). Mirrors live-quote-routes teardown
  // plus the invoice + stripe-event rows this flow writes.
  await pool.query(`DELETE FROM stripe_events WHERE id = $1`, [WEBHOOK_EVENT_ID]);
  await pool.query(`DELETE FROM commission_ledger WHERE branch_id = $1`, [BRANCH_ID]);
  // Paying the invoice writes payment rows that FK to invoices — drop them
  // (and any scheduled retries) before the invoices themselves.
  await pool.query(
    `DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE branch_id = $1)`,
    [BRANCH_ID],
  );
  await pool.query(
    `DELETE FROM payment_retries WHERE invoice_id IN (SELECT id FROM invoices WHERE branch_id = $1)`,
    [BRANCH_ID],
  );
  await pool.query(`DELETE FROM invoice_line_items WHERE branch_id = $1`, [BRANCH_ID]);
  await pool.query(`DELETE FROM invoices WHERE branch_id = $1`, [BRANCH_ID]);
  await pool.query(`DELETE FROM quote_status_log WHERE branch_id = $1`, [BRANCH_ID]);
  await pool.query(`DELETE FROM quote_line_items WHERE branch_id = $1`, [BRANCH_ID]);
  await pool.query(`DELETE FROM job_status_log WHERE branch_id = $1`, [BRANCH_ID]);
  await pool.query(`DELETE FROM jobs WHERE branch_id = $1`, [BRANCH_ID]);
  await pool.query(`DELETE FROM quotes WHERE branch_id = $1`, [BRANCH_ID]);
  // Acceptance reserves inventory for the quote's lines (INV-02); tear those
  // child rows down before items/suppliers/branches.
  await pool.query(`DELETE FROM inventory_consumption_exceptions WHERE branch_id = $1`, [BRANCH_ID]);
  await pool.query(`DELETE FROM inventory_movements WHERE branch_id = $1`, [BRANCH_ID]);
  await pool.query(`DELETE FROM inventory_items WHERE branch_id = $1`, [BRANCH_ID]);
  await pool.query(`DELETE FROM customers WHERE branch_id = $1`, [BRANCH_ID]);
  await pool.query(`DELETE FROM suppliers WHERE id = $1`, [SUPPLIER_ID]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [BRANCH_ID]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [MANAGER_USER]);
}

async function seed(): Promise<void> {
  await pool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
    MANAGER_USER,
    'gp-mgr@test.local',
    'GP Manager',
  ]);

  // Resolve "the corporate" the same way the pricing handler does — it picks
  // the singleton via an unordered LIMIT 1, so other test files / the demo
  // seed may have inserted the row already. Reuse it when present; insert ours
  // only when the table is empty.
  const existingCorp = await pool.query<{ id: string }>(
    `SELECT id FROM corporate ORDER BY created_at LIMIT 1`,
  );
  let corpId: string;
  if (existingCorp.rows.length === 0) {
    await pool.query(
      `INSERT INTO corporate (id, name, slug, default_margin_pct, min_margin_pct, max_margin_pct)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [CORPORATE_ID, 'GP Corp', 'gp-corp', '50.00', '10.00', '200.00'],
    );
    corpId = CORPORATE_ID;
  } else {
    corpId = existingCorp.rows[0]!.id;
  }
  // Deterministic margin + zero deposit on EVERY corporate row (the handler's
  // LIMIT 1 may pick any of them), so pricing is predictable and acceptance
  // mints no deposit invoice — the balance invoice is the whole charge.
  await pool.query(
    `UPDATE corporate
       SET default_margin_pct = '50.00',
           min_margin_pct = '10.00',
           max_margin_pct = '200.00',
           deposit_pct = '0.00',
           deposit_min_cents = 0,
           deposit_max_cents = NULL`,
  );

  await pool.query(
    `INSERT INTO branches (id, corporate_id, name, slug) VALUES ($1, $2, $3, $4)`,
    [BRANCH_ID, corpId, 'GP Branch', 'gp-branch'],
  );
  await pool.query(`INSERT INTO customers (id, branch_id, name) VALUES ($1, $2, $3)`, [
    CUSTOMER_ID,
    BRANCH_ID,
    'GP Customer',
  ]);
  await pool.query(
    `INSERT INTO suppliers
       (id, name, provider_kind, endpoint_url, api_key_secret_ref, supplier_account_code)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [SUPPLIER_ID, 'GP Supplier', 'bc_ai_agent', 'https://mock.local', 'GP_API_KEY', 'ACC-GP'],
  );
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;

  priorWebOrigin = process.env['WEB_ORIGIN'];
  process.env['WEB_ORIGIN'] = WEB_ORIGIN;

  pool = new Pool({ connectionString: DATABASE_URL });
  db = drizzle(pool, { schema });
  await clean();
  await seed();

  // Stub auth: the request-scope plugin sees a session iff x-test-user is set.
  const stubAuth = {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const userId = headers.get('x-test-user');
        return userId ? { session: { id: `stub-${userId}` }, user: { id: userId } } : null;
      },
    },
  } as unknown as Auth;

  // MockSupplierProvider under the only enum kind ('bc_ai_agent'); the route's
  // bind() resolves to this in-memory provider so commit never hits a network.
  const mockProvider = new MockSupplierProvider({
    supplierId: SUPPLIER_ID,
    catalog: [
      { sku: 'PART-A', name: 'Spring kit', category: 'GP-SPRINGS', unitPriceCents: 0, unitCostCents: 10_000 },
      { sku: 'PART-B', name: 'Rail', category: 'GP-RAILS', unitPriceCents: 0, unitCostCents: 20_000 },
    ],
    taxRatePct: 0,
  });
  const registry = new ProviderRegistry();
  registry.registerFactory('bc_ai_agent', (_config: SupplierConfig) => mockProvider);

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
  if (priorWebOrigin === undefined) delete process.env['WEB_ORIGIN'];
  else process.env['WEB_ORIGIN'] = priorWebOrigin;
});

const asManager = { 'x-test-user': MANAGER_USER, 'content-type': 'application/json' };

describe('W5 — golden path: book → quote → accept → complete → invoice → pay', () => {
  it('walks one job through the full money + ops lifecycle', async () => {
    if (!reachable) return;

    // ---- BOOK --------------------------------------------------------------
    const booked = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: asManager,
      payload: { customerId: CUSTOMER_ID, title: 'Golden path — door install' },
    });
    expect(booked.statusCode, booked.body).toBe(201);
    const jobId = (booked.json() as { data: { id: string; status: string } }).data.id;
    expect((booked.json() as { data: { status: string } }).data.status).toBe('unassigned');

    // ---- QUOTE: create (linked to the booked job) --------------------------
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/quotes',
      headers: asManager,
      payload: { customerId: CUSTOMER_ID, supplierId: SUPPLIER_ID, jobId },
    });
    expect(created.statusCode, created.body).toBe(201);
    const quoteId = (created.json() as { data: { id: string } }).data.id;

    // ---- QUOTE: price ------------------------------------------------------
    const priced = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${quoteId}/price`,
      headers: asManager,
      payload: {
        lineItems: [
          { sku: 'PART-A', quantity: 2 },
          { sku: 'PART-B', quantity: 1 },
        ],
      },
    });
    expect(priced.statusCode, priced.body).toBe(200);
    const pricedQuote = (priced.json() as { data: { quote: { status: string; totalCents: number } } })
      .data.quote;
    expect(pricedQuote.status).toBe('priced');
    expect(pricedQuote.totalCents).toBeGreaterThan(0);
    const quoteTotalCents = pricedQuote.totalCents;

    // ---- QUOTE: commit (→ supplier, mints BC ref) --------------------------
    const committed = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${quoteId}/commit`,
      headers: asManager,
      payload: {},
    });
    expect(committed.statusCode, committed.body).toBe(200);
    expect((committed.json() as { data: { quote: { status: string } } }).data.quote.status).toBe(
      'committed',
    );

    // ---- ACCEPT: mint a customer link, then accept it publicly -------------
    const shared = await app.inject({
      method: 'POST',
      url: `/api/v1/quotes/${quoteId}/share`,
      headers: asManager,
      payload: {},
    });
    expect(shared.statusCode, shared.body).toBe(200);
    const token = (shared.json() as { data: { token: string } }).data.token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/);

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/public/quotes/${token}/accept`,
      // Origin must match WEB_ORIGIN and content-type must be JSON.
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
      payload: {},
    });
    expect(accepted.statusCode, accepted.body).toBe(200);

    // Quote is accepted and stayed bound to the job we booked (not a new one).
    const quoteRow = await pool.query<{ status: string; job_id: string }>(
      `SELECT status, job_id FROM quotes WHERE id = $1`,
      [quoteId],
    );
    expect(quoteRow.rows[0]!.status).toBe('accepted');
    expect(quoteRow.rows[0]!.job_id).toBe(jobId);

    // ---- COMPLETE: walk the job status machine to done ---------------------
    for (const toStatus of ['scheduled', 'en_route', 'arrived', 'in_progress', 'completed']) {
      const t = await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${jobId}/transition`,
        headers: asManager,
        payload: { toStatus },
      });
      expect(t.statusCode, `transition → ${toStatus}: ${t.body}`).toBe(200);
    }

    // ---- INVOICE: completion auto-drafted the balance invoice (QF-03) ------
    const invRows = await pool.query<{ id: string; status: string; total: string }>(
      `SELECT id, status, total FROM invoices
        WHERE quote_id = $1 AND deleted_at IS NULL`,
      [quoteId],
    );
    expect(invRows.rows).toHaveLength(1);
    const invoice = invRows.rows[0]!;
    expect(invoice.status).toBe('draft');
    // No deposit was taken, so the balance due equals the full quote total.
    expect(invoice.total).toBe((quoteTotalCents / 100).toFixed(2));
    const invoiceId = invoice.id;

    // ---- INVOICE: finalize (creates the Stripe PaymentIntent) --------------
    const finalized = await app.inject({
      method: 'POST',
      url: `/api/v1/invoices/${invoiceId}/finalize`,
      headers: asManager,
      payload: {},
    });
    expect(finalized.statusCode, finalized.body).toBe(200);
    const finalizedData = (
      finalized.json() as { data: { status: string; stripePaymentIntentId: string | null } }
    ).data;
    expect(finalizedData.status).toBe('finalized');
    expect(finalizedData.stripePaymentIntentId).toBeTruthy();
    const paymentIntentId = finalizedData.stripePaymentIntentId!;

    // ---- PAY: Stripe confirms payment via webhook → invoice paid -----------
    const webhook = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/stripe',
      // Stub Stripe skips signature verification but the header is required.
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig-stub' },
      payload: JSON.stringify({
        id: WEBHOOK_EVENT_ID,
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: paymentIntentId,
            amount: quoteTotalCents,
            currency: 'usd',
            status: 'succeeded',
            latest_charge: 'ch_gp_1',
          },
        },
      }),
    });
    expect(webhook.statusCode, webhook.body).toBe(200);

    const paidRow = await pool.query<{ status: string; paid_at: string | null }>(
      `SELECT status, paid_at FROM invoices WHERE id = $1`,
      [invoiceId],
    );
    expect(paidRow.rows[0]!.status).toBe('paid');
    expect(paidRow.rows[0]!.paid_at).toBeTruthy();
  });
});
