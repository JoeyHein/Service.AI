/**
 * Live round-trip test for CRM-01 (migration 0022_crm_customer_notes).
 *
 * Auto-skips when Postgres or `psql` is unreachable (qf-01 pattern). When the
 * DB is available, asserts the migration creates `customer_notes` + its
 * indexes + RLS policies on top of 0021, drops cleanly, and round-trips.
 *
 * Migrations 0001..0021 must already be applied.
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
const UP_SQL = 'migrations/0022_crm_customer_notes.sql';
const DOWN_SQL = 'migrations/0022_crm_customer_notes.down.sql';

let reachable = false;
let psqlAvailable = false;
let pool: InstanceType<typeof Pool>;

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await p.query('SELECT 1 FROM customers LIMIT 0');
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

async function tableExists(table: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = $1
     ) AS present`,
    [table],
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

async function policyCount(table: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM pg_policies
      WHERE schemaname = current_schema() AND tablename = $1`,
    [table],
  );
  return rows[0].n as number;
}

const NEW_INDEXES = [
  'customer_notes_customer_idx',
  'customer_notes_branch_idx',
  'customer_notes_branch_occurred_idx',
  'customer_notes_match_key_idx',
  'customer_notes_source_ref_unique',
] as const;

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

describe('CRM-01 migration 0022 round-trip', () => {
  it('skips cleanly when prerequisites are missing', () => {
    if (!reachable) {
      // eslint-disable-next-line no-console
      console.warn(`[crm-01] DATABASE_URL ${ADMIN_URL} unreachable — test skipped.`);
    }
    if (reachable && !psqlAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[crm-01] psql not on PATH — test skipped.');
    }
  });

  it('applies up: customer_notes + indexes + RLS policies', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(UP_SQL);
    expect(await tableExists('customer_notes')).toBe(true);
    for (const idx of NEW_INDEXES) {
      expect(await indexExists(idx), `expected ${idx} after up`).toBe(true);
    }
    expect(await policyCount('customer_notes')).toBe(2);
  });

  it('down removes the table + indexes', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(DOWN_SQL);
    expect(await tableExists('customer_notes')).toBe(false);
    for (const idx of NEW_INDEXES) {
      expect(await indexExists(idx), `${idx} should be dropped`).toBe(false);
    }
  });

  it('round-trips up → down → up with the same shape', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(UP_SQL);
    expect(await tableExists('customer_notes')).toBe(true);
    for (const idx of NEW_INDEXES) {
      expect(await indexExists(idx)).toBe(true);
    }
    expect(await policyCount('customer_notes')).toBe(2);
  });
});
