/**
 * Live round-trip test for CHR-01 (migration 0016_corporate_hub_redesign).
 *
 * Runs the migration up, then down, then up again against a Postgres
 * instance already migrated through 0015. Asserts:
 *
 *   1. The migration files parse and execute without error.
 *   2. After up, the dropped tables are gone and the new tables exist.
 *   3. After up, every table carrying branch_id has both the
 *      <table>_corporate_admin and <table>_scoped RLS policies attached.
 *   4. After up, the pricebook overrides CSV snapshot file exists.
 *   5. After up→down→up, business-table row counts are unchanged from the
 *      first-up baseline (no row-count delta on round-trip).
 *
 * The test auto-skips when Postgres is unreachable, matching the existing
 * live-rls.test.ts skip pattern. It also requires `psql` on PATH because
 * the migration uses \copy (a psql client meta-command) that cannot run
 * via the pg client library.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const { Pool } = pkg;
const exec = promisify(execFile);

const ADMIN_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

const REPO_ROOT = resolve(__dirname, '../../../..');
const DB_PKG_ROOT = resolve(__dirname, '../..');
const SNAPSHOT_CSV = resolve(REPO_ROOT, 'docs/migrations/0016_pricebook_overrides_snapshot.csv');

const UP_SQL = 'migrations/0016_corporate_hub_redesign.sql';
const DOWN_SQL = 'migrations/0016_corporate_hub_redesign.down.sql';

let reachable = false;
let psqlAvailable = false;
let pool: InstanceType<typeof Pool>;

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await p.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await p.end();
  }
}

async function checkPsql(): Promise<boolean> {
  try {
    await exec('psql', ['--version']);
    return true;
  } catch {
    return false;
  }
}

async function runPsqlFile(relativeFile: string): Promise<void> {
  await exec(
    'psql',
    [
      ADMIN_URL,
      '-v', 'ON_ERROR_STOP=1',
      '-f', relativeFile,
    ],
    { cwd: DB_PKG_ROOT, maxBuffer: 64 * 1024 * 1024 },
  );
}

type RowCounts = Map<string, number>;

async function snapshotRowCounts(tables: string[]): Promise<RowCounts> {
  const counts: RowCounts = new Map();
  for (const t of tables) {
    const exists = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = $1
       ) AS present`,
      [t],
    );
    if (!exists.rows[0].present) {
      counts.set(t, -1);
      continue;
    }
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
    counts.set(t, rows[0].n);
  }
  return counts;
}

// Business tables that survive CHR-01 (renamed columns, preserved rows).
// These are the tables the gate's "no row-count delta" assertion covers.
const SURVIVING_BUSINESS_TABLES = [
  'locations', 'memberships', 'audit_log', 'invitations',
  'customers', 'jobs', 'job_status_log', 'job_photos',
  'service_catalog_templates', 'service_items',
  'invoices', 'invoice_line_items', 'payments', 'refunds', 'stripe_events',
  'collections_drafts', 'payment_retries',
  'kb_docs', 'ai_feedback', 'ai_suggestions', 'ai_metrics',
  'tech_skills', 'ai_conversations', 'ai_messages', 'call_sessions',
  'push_subscriptions', 'notifications_log',
];

// Tables that have a branch_id column after up and must carry both new
// policies (the _scoped policy plus the _corporate_admin policy).
const BRANCH_SCOPED_TABLES = [
  'locations', 'memberships', 'invitations',
  'customers', 'jobs', 'job_status_log', 'job_photos',
  'invoices', 'invoice_line_items', 'payments', 'refunds',
  'collections_drafts', 'payment_retries',
  'ai_feedback', 'ai_suggestions', 'ai_metrics',
  'tech_skills', 'ai_conversations', 'ai_messages', 'call_sessions',
  'push_subscriptions', 'notifications_log',
];

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  psqlAvailable = await checkPsql();
  if (!psqlAvailable) return;

  pool = new Pool({ connectionString: ADMIN_URL });

  // Make sure the snapshot directory exists so \copy doesn't fail. The
  // CSV inside is a transient artifact; clean it before each run.
  mkdirSync(resolve(REPO_ROOT, 'docs/migrations'), { recursive: true });
  if (existsSync(SNAPSHOT_CSV)) rmSync(SNAPSHOT_CSV);
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe('CHR-01 migration 0016 round-trip', () => {
  it('skips cleanly when prerequisites are missing', () => {
    if (!reachable) {
      // eslint-disable-next-line no-console
      console.warn(`[chr-01] DATABASE_URL ${ADMIN_URL} unreachable — test skipped.`);
    }
    if (reachable && !psqlAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[chr-01] psql not on PATH — test skipped.');
    }
  });

  it('applies up cleanly, creating new tables and dropping old ones', async () => {
    if (!reachable || !psqlAvailable) return;

    await runPsqlFile(UP_SQL);

    // New tables exist.
    for (const t of [
      'corporate', 'branches', 'branch_managers',
      'comp_plans', 'user_comp_assignments', 'commission_ledger',
      'pricebook_suggestions',
    ]) {
      const { rows } = await pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = $1
         ) AS present`,
        [t],
      );
      expect(rows[0].present, `expected ${t} to exist after up`).toBe(true);
    }

    // Old tables dropped.
    for (const t of [
      'franchisors', 'franchisees',
      'franchise_agreements', 'royalty_rules', 'royalty_statements',
      'pricebook_overrides',
    ]) {
      const { rows } = await pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = $1
         ) AS present`,
        [t],
      );
      expect(rows[0].present, `expected ${t} to be dropped after up`).toBe(false);
    }

    // CSV snapshot was written (file exists, even if empty header-only).
    expect(existsSync(SNAPSHOT_CSV), 'expected snapshot CSV to be written').toBe(true);
  });

  it('renames franchisee_id columns to branch_id on every business table', async () => {
    if (!reachable || !psqlAvailable) return;

    for (const t of BRANCH_SCOPED_TABLES) {
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1`,
        [t],
      );
      const cols = rows.map((r) => r.column_name);
      expect(cols, `${t} should have branch_id`).toContain('branch_id');
      expect(cols, `${t} should NOT have franchisee_id`).not.toContain('franchisee_id');
    }

    const { rows: auditCols } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'audit_log'`,
    );
    const auditColNames = auditCols.map((r) => r.column_name);
    expect(auditColNames).toContain('target_branch_id');
    expect(auditColNames).not.toContain('target_franchisee_id');
  });

  it('attaches both two-policy template policies to every branch-scoped table', async () => {
    if (!reachable || !psqlAvailable) return;

    for (const t of BRANCH_SCOPED_TABLES) {
      const { rows } = await pool.query(
        `SELECT policyname FROM pg_policies
          WHERE schemaname = current_schema() AND tablename = $1`,
        [t],
      );
      const policyNames = rows.map((r) => r.policyname);
      expect(policyNames, `${t} missing _corporate_admin policy`).toContain(`${t}_corporate_admin`);
      expect(policyNames, `${t} missing _scoped policy`).toContain(`${t}_scoped`);
    }
  });

  it('round-trips up → down → up with no row-count delta on business tables', async () => {
    if (!reachable || !psqlAvailable) return;

    // We are post-up from the previous test. Capture baseline counts.
    const baseline = await snapshotRowCounts(SURVIVING_BUSINESS_TABLES);

    // Down brings us back to franchisee-shaped schema.
    await runPsqlFile(DOWN_SQL);

    // The franchisee tables are back.
    const { rows: fRows } = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = 'franchisees'
       ) AS present`,
    );
    expect(fRows[0].present).toBe(true);

    // Up again.
    await runPsqlFile(UP_SQL);

    const after = await snapshotRowCounts(SURVIVING_BUSINESS_TABLES);

    for (const t of SURVIVING_BUSINESS_TABLES) {
      expect(after.get(t), `row count delta on ${t}`).toBe(baseline.get(t));
    }
  });
});
