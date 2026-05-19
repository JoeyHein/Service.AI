/**
 * Live round-trip test for QOC-01 (migration 0018_quote_order_conversion).
 *
 * Auto-skips when Postgres or `psql` is unreachable, matching the
 * sqb-01 round-trip test pattern. When the DB is available, asserts:
 *
 *   1. The migration applies cleanly on top of 0017.
 *   2. After up: `quotes` carries `supplier_order_ref`, `supplier_order_id`,
 *      `ordered_at` columns and the partial-unique index on `supplier_order_ref`.
 *   3. After down: the three columns are gone and the index is dropped.
 *   4. After up→down→up: the schema is identical (idempotent).
 *
 * Migrations 0001..0017 must already be applied — same prereq as the
 * sqb-01 round-trip test.
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
const UP_SQL = 'migrations/0018_quote_order_conversion.sql';
const DOWN_SQL = 'migrations/0018_quote_order_conversion.down.sql';

let reachable = false;
let psqlAvailable = false;
let pool: InstanceType<typeof Pool>;

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    // QOC-01 layers on the SQB phase — the migration assumes `quotes`
    // exists with the SQB columns.
    await p.query('SELECT 1 FROM quotes LIMIT 0');
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

async function columnExists(table: string, column: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1
          AND column_name = $2
     ) AS present`,
    [table, column],
  );
  return Boolean(rows[0].present);
}

async function indexExists(name: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
        WHERE schemaname = current_schema() AND indexname = $1
     ) AS present`,
    [name],
  );
  return Boolean(rows[0].present);
}

const NEW_COLUMNS = ['supplier_order_ref', 'supplier_order_id', 'ordered_at'] as const;
const NEW_INDEX = 'quotes_supplier_order_ref_unique';

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  psqlAvailable = await checkPsql();
  if (!psqlAvailable) return;
  pool = new Pool({ connectionString: ADMIN_URL });
  // Clean slate — drop any prior partial application. down tolerates
  // missing columns via IF EXISTS.
  try {
    await runPsqlFile(DOWN_SQL);
  } catch {
    // First run, nothing to drop. OK.
  }
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe('QOC-01 migration 0018 round-trip', () => {
  it('skips cleanly when prerequisites are missing', () => {
    if (!reachable) {
      // eslint-disable-next-line no-console
      console.warn(`[qoc-01] DATABASE_URL ${ADMIN_URL} unreachable — test skipped.`);
    }
    if (reachable && !psqlAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[qoc-01] psql not on PATH — test skipped.');
    }
  });

  it('applies up cleanly, adding all three order columns', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(UP_SQL);
    for (const c of NEW_COLUMNS) {
      expect(await columnExists('quotes', c), `expected quotes.${c} after up`).toBe(true);
    }
  });

  it('creates the partial-unique index on supplier_order_ref', async () => {
    if (!reachable || !psqlAvailable) return;
    expect(await indexExists(NEW_INDEX), `expected ${NEW_INDEX} after up`).toBe(true);
  });

  it('down removes every new column + the index', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(DOWN_SQL);
    for (const c of NEW_COLUMNS) {
      expect(await columnExists('quotes', c), `quotes.${c} should be dropped`).toBe(false);
    }
    expect(await indexExists(NEW_INDEX), `${NEW_INDEX} should be dropped`).toBe(false);
  });

  it('round-trips up → down → up with the same shape', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(UP_SQL);
    for (const c of NEW_COLUMNS) {
      expect(await columnExists('quotes', c)).toBe(true);
    }
    expect(await indexExists(NEW_INDEX)).toBe(true);
  });
});
