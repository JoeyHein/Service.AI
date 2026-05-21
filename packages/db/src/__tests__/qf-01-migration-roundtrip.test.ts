/**
 * Live round-trip test for QF-01 (migration 0020_quote_fulfillment).
 *
 * Auto-skips when Postgres or `psql` is unreachable (qoc-01/cqa-01 pattern).
 * When the DB is available, asserts the migration applies on top of 0019,
 * adds `jobs.quote_id` + `invoices.quote_id` and their indexes, drops them
 * cleanly, and round-trips up→down→up.
 *
 * Migrations 0001..0019 must already be applied.
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
const UP_SQL = 'migrations/0020_quote_fulfillment.sql';
const DOWN_SQL = 'migrations/0020_quote_fulfillment.down.sql';

let reachable = false;
let psqlAvailable = false;
let pool: InstanceType<typeof Pool>;

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
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
  await exec('psql', [ADMIN_URL, '-v', 'ON_ERROR_STOP=1', '-f', relativeFile], {
    cwd: DB_PKG_ROOT,
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2
     ) AS present`,
    [table, column],
  );
  return Boolean(rows[0].present);
}

async function indexExists(name: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1
     ) AS present`,
    [name],
  );
  return Boolean(rows[0].present);
}

const NEW_INDEXES = ['jobs_quote_idx', 'invoices_quote_id_unique'] as const;

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  psqlAvailable = await checkPsql();
  if (!psqlAvailable) return;
  pool = new Pool({ connectionString: ADMIN_URL });
  try {
    await runPsqlFile(DOWN_SQL);
  } catch {
    // First run, nothing to drop.
  }
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe('QF-01 migration 0020 round-trip', () => {
  it('skips cleanly when prerequisites are missing', () => {
    if (!reachable) {
      // eslint-disable-next-line no-console
      console.warn(`[qf-01] DATABASE_URL ${ADMIN_URL} unreachable — test skipped.`);
    }
    if (reachable && !psqlAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[qf-01] psql not on PATH — test skipped.');
    }
  });

  it('applies up: jobs.quote_id + invoices.quote_id + indexes', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(UP_SQL);
    expect(await columnExists('jobs', 'quote_id')).toBe(true);
    expect(await columnExists('invoices', 'quote_id')).toBe(true);
    for (const idx of NEW_INDEXES) {
      expect(await indexExists(idx), `expected ${idx} after up`).toBe(true);
    }
  });

  it('down removes the columns + indexes', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(DOWN_SQL);
    expect(await columnExists('jobs', 'quote_id')).toBe(false);
    expect(await columnExists('invoices', 'quote_id')).toBe(false);
    for (const idx of NEW_INDEXES) {
      expect(await indexExists(idx), `${idx} should be dropped`).toBe(false);
    }
  });

  it('round-trips up → down → up with the same shape', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(UP_SQL);
    expect(await columnExists('jobs', 'quote_id')).toBe(true);
    expect(await columnExists('invoices', 'quote_id')).toBe(true);
    for (const idx of NEW_INDEXES) {
      expect(await indexExists(idx)).toBe(true);
    }
  });
});
