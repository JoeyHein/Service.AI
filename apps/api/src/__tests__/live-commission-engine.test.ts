/**
 * Live integration test for the commission engine (CHR-05).
 *
 * Skips silently when Postgres is unreachable on `DATABASE_URL`. When the
 * DB IS reachable, the test exercises the full path:
 *
 *   1. Seed corporate + branch + user + comp_plan +
 *      user_comp_assignment + branch_manager + customer + job + invoice.
 *   2. Call `onInvoicePaid` inside `withScope`.
 *   3. Assert a `commission_ledger` row landed with the expected amount.
 *   4. Replay `onInvoicePaid` and assert no duplicate (idempotency).
 *   5. Call `reverseInvoicePaid` and assert a balancing -row appears.
 *   6. Call `computeCommission` and assert subtotals are correct.
 *
 * The seed uses raw INSERTs as a superuser (RLS bypassed) so the test
 * does not depend on the API layer. Engine calls run inside `withScope`
 * with role=corporate_admin, which satisfies the _corporate_admin RLS
 * policy on every CHR-managed table.
 *
 * Prereq: migrations 0001..0016 must be applied.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '@service-ai/db';
import { withScope, type RequestScope } from '@service-ai/db';
import {
  onInvoicePaid,
  reverseInvoicePaid,
  computeCommission,
  periodLabelFor,
} from '../commission-engine.js';

const { Pool } = pkg;

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let db: ReturnType<typeof drizzle<typeof schema>>;

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await p.query('SELECT 1');
    // Also verify CHR-01 ran — the `branches` table is the cheapest signal.
    await p.query('SELECT 1 FROM branches LIMIT 0');
    return true;
  } catch {
    return false;
  } finally {
    await p.end();
  }
}

// Deterministic UUIDs so the test reads as a story.
const CORPORATE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const BRANCH_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = 'commtest_user_id_xxxxxxxxxxxxxxxx';
const CUSTOMER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const JOB_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const INVOICE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const COMP_PLAN_ID = '11111111-2222-3333-4444-555555555555';

const PAID_AT = new Date('2026-05-20T15:00:00Z');
const PERIOD = periodLabelFor(PAID_AT); // '2026-05'

const SCOPE: RequestScope = {
  type: 'corporate',
  userId: USER_ID,
  role: 'corporate_admin',
};

async function clean(): Promise<void> {
  // CASCADE so any prior partial seeds are wiped before this run.
  await pool.query(`DELETE FROM commission_ledger WHERE user_id = $1`, [USER_ID]);
  await pool.query(`DELETE FROM user_comp_assignments WHERE user_id = $1`, [USER_ID]);
  await pool.query(`DELETE FROM comp_plans WHERE id = $1`, [COMP_PLAN_ID]);
  await pool.query(`DELETE FROM branch_managers WHERE user_id = $1`, [USER_ID]);
  await pool.query(`DELETE FROM invoices WHERE id = $1`, [INVOICE_ID]);
  await pool.query(`DELETE FROM jobs WHERE id = $1`, [JOB_ID]);
  await pool.query(`DELETE FROM customers WHERE id = $1`, [CUSTOMER_ID]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [BRANCH_ID]);
  await pool.query(`DELETE FROM corporate WHERE id = $1`, [CORPORATE_ID]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
}

async function seed(): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`,
    [USER_ID, 'manager-comm@test.local', 'Comm Engine Manager'],
  );
  await pool.query(
    `INSERT INTO corporate (id, name, slug) VALUES ($1, $2, $3)`,
    [CORPORATE_ID, 'Comm Engine Corp', 'comm-engine-corp'],
  );
  await pool.query(
    `INSERT INTO branches (id, corporate_id, name, slug)
     VALUES ($1, $2, $3, $4)`,
    [BRANCH_ID, CORPORATE_ID, 'Comm Engine Branch', 'comm-engine-branch'],
  );
  await pool.query(
    `INSERT INTO branch_managers (branch_id, user_id, started_at)
     VALUES ($1, $2, $3)`,
    [BRANCH_ID, USER_ID, '2026-01-01T00:00:00Z'],
  );
  await pool.query(
    `INSERT INTO comp_plans (id, name, kind, base_salary_cents, pay_period, commission_rules, effective_from)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      COMP_PLAN_ID,
      'Test Plan: 4% flat',
      'base_plus_commission',
      500_000,
      'monthly',
      JSON.stringify([{ kind: 'flat_percent_of_invoice_paid', percent: 4 }]),
      '2026-01-01',
    ],
  );
  await pool.query(
    `INSERT INTO user_comp_assignments (user_id, comp_plan_id, branch_id, effective_from)
     VALUES ($1, $2, $3, $4)`,
    [USER_ID, COMP_PLAN_ID, BRANCH_ID, '2026-01-01'],
  );
  await pool.query(
    `INSERT INTO customers (id, branch_id, name) VALUES ($1, $2, $3)`,
    [CUSTOMER_ID, BRANCH_ID, 'Test Customer'],
  );
  await pool.query(
    `INSERT INTO jobs (id, branch_id, customer_id, title, status, scheduled_start)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [JOB_ID, BRANCH_ID, CUSTOMER_ID, 'Commission test job', 'completed', PAID_AT.toISOString()],
  );
  await pool.query(
    `INSERT INTO invoices (id, branch_id, job_id, customer_id, status, total, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      INVOICE_ID,
      BRANCH_ID,
      JOB_ID,
      CUSTOMER_ID,
      'paid',
      '1000.00', // $1000.00 invoice -> 100000 cents -> 4000 cents commission
      PAID_AT.toISOString(),
    ],
  );
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  db = drizzle(pool, { schema });
  await clean();
  await seed();
});

afterAll(async () => {
  if (!reachable) return;
  await clean();
  await pool.end();
});

describe('commission engine — live invoice lifecycle', () => {
  it('writes a ledger row on first onInvoicePaid', async () => {
    if (!reachable) return;
    const written = await withScope(db, SCOPE, (tx) =>
      onInvoicePaid(tx, INVOICE_ID),
    );
    expect(written.length).toBe(1);
    expect(written[0]!.amountCents).toBe(4_000);
    expect(written[0]!.periodLabel).toBe(PERIOD);
    expect(written[0]!.sourceKind).toBe('invoice_paid');
  });

  it('does NOT duplicate on replay (idempotent)', async () => {
    if (!reachable) return;
    const written = await withScope(db, SCOPE, (tx) =>
      onInvoicePaid(tx, INVOICE_ID),
    );
    expect(written.length).toBe(0);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM commission_ledger
        WHERE user_id = $1 AND source_kind = 'invoice_paid' AND source_id = $2`,
      [USER_ID, INVOICE_ID],
    );
    expect(rows[0].n).toBe(1);
  });

  it('computeCommission sums base + commission for the period', async () => {
    if (!reachable) return;
    const result = await withScope(db, SCOPE, (tx) =>
      computeCommission(tx, USER_ID, PERIOD),
    );
    expect(result.period).toBe(PERIOD);
    expect(result.baseSalaryCents).toBe(500_000);
    expect(result.commissionCents).toBe(4_000);
    expect(result.totalCents).toBe(504_000);
    expect(result.lineItems.length).toBe(1);
  });

  it('reverseInvoicePaid writes a balancing -row', async () => {
    if (!reachable) return;
    const reversals = await withScope(db, SCOPE, (tx) =>
      reverseInvoicePaid(tx, INVOICE_ID, 'invoice_refunded'),
    );
    expect(reversals.length).toBe(1);
    expect(reversals[0]!.amountCents).toBe(-4_000);
    expect(reversals[0]!.sourceKind).toBe('manual_adjustment');

    // Net commission for the user across all periods should now be zero
    // (the original is in PAID_AT's period; the reversal lands in
    // current-month period, so we sum across both).
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0)::int AS net FROM commission_ledger WHERE user_id = $1`,
      [USER_ID],
    );
    expect(rows[0].net).toBe(0);
  });

  it('replay of reverseInvoicePaid is idempotent', async () => {
    if (!reachable) return;
    const reversals = await withScope(db, SCOPE, (tx) =>
      reverseInvoicePaid(tx, INVOICE_ID, 'invoice_refunded'),
    );
    expect(reversals.length).toBe(0);
  });
});

describe('commission engine — empty period', () => {
  it('returns zero baseSalary + zero commission when user has no plan', async () => {
    if (!reachable) return;
    const result = await withScope(db, SCOPE, (tx) =>
      computeCommission(tx, 'unknown_user_no_plan', '2026-05'),
    );
    expect(result.baseSalaryCents).toBe(0);
    expect(result.commissionCents).toBe(0);
    expect(result.totalCents).toBe(0);
    expect(result.lineItems).toEqual([]);
  });

  it('returns base salary even when no events fired in the period', async () => {
    if (!reachable) return;
    // Pick a period the manager's plan covers but contains no invoice.
    const result = await withScope(db, SCOPE, (tx) =>
      computeCommission(tx, USER_ID, '2026-03'),
    );
    expect(result.baseSalaryCents).toBe(500_000);
    expect(result.commissionCents).toBe(0);
    expect(result.totalCents).toBe(500_000);
  });
});

// Silence the "no test in this file" complaint when reachable is false —
// the describe blocks above still RUN, they just no-op inside.
describe('commission engine — DB reachable status', () => {
  it(`is ${reachable ? 'reachable' : 'unreachable — tests above silently skip'}`, () => {
    expect(typeof reachable).toBe('boolean');
  });
});

// Reference the sql helper so eslint does not complain about unused
// imports — the next phase that uses raw sql() queries will pick it up.
void sql;
