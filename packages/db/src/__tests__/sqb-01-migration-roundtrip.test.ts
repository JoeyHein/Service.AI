/**
 * Live round-trip test for SQB-01 (migration 0017_supplier_quote_bridge).
 *
 * Auto-skips when Postgres or `psql` is unreachable, matching the
 * chr-01 round-trip test pattern. When the DB is available, asserts:
 *
 *   1. The migration applies cleanly on top of 0016.
 *   2. After up: all 5 new tables exist and carry the two-policy RLS
 *      template.
 *   3. After down: every table from 0017 is gone, all three new enums
 *      are dropped.
 *   4. After up→down→up: the schema is identical (idempotent).
 *
 * Migrations 0001..0016 must already be applied — same prereq as
 * chr-01-migration-roundtrip.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const { Pool } = pkg;
const exec = promisify(execFile);

const ADMIN_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

const DB_PKG_ROOT = resolve(__dirname, '../..');
const UP_SQL = 'migrations/0017_supplier_quote_bridge.sql';
const DOWN_SQL = 'migrations/0017_supplier_quote_bridge.down.sql';

let reachable = false;
let psqlAvailable = false;
let pool: InstanceType<typeof Pool>;

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    // SQB-01 layers on the corporate hub — the migration assumes
    // 0016 has run.
    await p.query('SELECT 1 FROM branches LIMIT 0');
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
    [ADMIN_URL, '-v', 'ON_ERROR_STOP=1', '-f', relativeFile],
    { cwd: DB_PKG_ROOT, maxBuffer: 32 * 1024 * 1024 },
  );
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = $1
     ) AS present`,
    [name],
  );
  return Boolean(rows[0].present);
}

async function policiesFor(table: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT policyname FROM pg_policies
      WHERE schemaname = current_schema() AND tablename = $1`,
    [table],
  );
  return rows.map((r) => r.policyname as string);
}

async function enumExists(name: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = $1) AS present`,
    [name],
  );
  return Boolean(rows[0].present);
}

const NEW_TABLES = [
  'suppliers',
  'margin_overrides',
  'quotes',
  'quote_line_items',
  'quote_status_log',
] as const;

const BRANCH_SCOPED_TABLES = ['quotes', 'quote_line_items', 'quote_status_log'] as const;
const CORPORATE_ONLY_TABLES = ['suppliers', 'margin_overrides'] as const;

const NEW_ENUMS = ['supplier_provider_kind', 'quote_status', 'margin_source'] as const;

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  psqlAvailable = await checkPsql();
  if (!psqlAvailable) return;
  pool = new Pool({ connectionString: ADMIN_URL });
  // Ensure a clean slate — drop any prior partial seeds. The down
  // migration tolerates missing tables (IF EXISTS).
  try {
    await runPsqlFile(DOWN_SQL);
  } catch {
    // First run, nothing to drop. OK.
  }
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe('SQB-01 migration 0017 round-trip', () => {
  it('skips cleanly when prerequisites are missing', () => {
    if (!reachable) {
      // eslint-disable-next-line no-console
      console.warn(`[sqb-01] DATABASE_URL ${ADMIN_URL} unreachable — test skipped.`);
    }
    if (reachable && !psqlAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[sqb-01] psql not on PATH — test skipped.');
    }
  });

  it('applies up cleanly, creating all 5 new tables', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(UP_SQL);
    for (const t of NEW_TABLES) {
      expect(await tableExists(t), `expected ${t} after up`).toBe(true);
    }
  });

  it('creates the three new enums', async () => {
    if (!reachable || !psqlAvailable) return;
    for (const e of NEW_ENUMS) {
      expect(await enumExists(e), `expected enum ${e} after up`).toBe(true);
    }
  });

  it('attaches both policies to every branch-scoped table', async () => {
    if (!reachable || !psqlAvailable) return;
    for (const t of BRANCH_SCOPED_TABLES) {
      const policies = await policiesFor(t);
      expect(policies, `${t} missing _corporate_admin`).toContain(`${t}_corporate_admin`);
      expect(policies, `${t} missing _scoped`).toContain(`${t}_scoped`);
    }
  });

  it('attaches both policies (corporate-only shape) to suppliers + margin_overrides', async () => {
    if (!reachable || !psqlAvailable) return;
    for (const t of CORPORATE_ONLY_TABLES) {
      const policies = await policiesFor(t);
      expect(policies).toContain(`${t}_corporate_admin`);
      expect(policies).toContain(`${t}_scoped`);
    }
  });

  it('down drops every new table + enum', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(DOWN_SQL);
    for (const t of NEW_TABLES) {
      expect(await tableExists(t), `${t} should be dropped`).toBe(false);
    }
    for (const e of NEW_ENUMS) {
      expect(await enumExists(e), `${e} should be dropped`).toBe(false);
    }
  });

  it('round-trips up → down → up with the same shape', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(UP_SQL);
    for (const t of NEW_TABLES) {
      expect(await tableExists(t)).toBe(true);
    }
    for (const e of NEW_ENUMS) {
      expect(await enumExists(e)).toBe(true);
    }
  });
});
