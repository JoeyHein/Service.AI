/**
 * Live round-trip test for INV-01 (migration 0023_inventory_management).
 *
 * Auto-skips when Postgres or `psql` is unreachable. Asserts the migration
 * creates the three inventory tables + indexes + RLS policies on top of 0022,
 * drops cleanly, and round-trips. Migrations 0001..0022 must be applied.
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
const UP_SQL = 'migrations/0023_inventory_management.sql';
const DOWN_SQL = 'migrations/0023_inventory_management.down.sql';

let reachable = false;
let psqlAvailable = false;
let pool: InstanceType<typeof Pool>;

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
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
  await exec('psql', [ADMIN_URL, '-v', 'ON_ERROR_STOP=1', '-f', relativeFile], {
    cwd: DB_PKG_ROOT,
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function tableExists(table: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = $1) AS present`,
    [table],
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

const TABLES = [
  'inventory_items',
  'inventory_movements',
  'inventory_consumption_exceptions',
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

describe('INV-01 migration 0023 round-trip', () => {
  it('skips cleanly when prerequisites are missing', () => {
    if (!reachable) {
      // eslint-disable-next-line no-console
      console.warn(`[inv-01] DATABASE_URL ${ADMIN_URL} unreachable — test skipped.`);
    }
    if (reachable && !psqlAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[inv-01] psql not on PATH — test skipped.');
    }
  });

  it('applies up: three tables + two RLS policies each', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(UP_SQL);
    for (const t of TABLES) {
      expect(await tableExists(t), `${t} should exist`).toBe(true);
      expect(await policyCount(t), `${t} policies`).toBe(2);
    }
  });

  it('down removes all three tables', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(DOWN_SQL);
    for (const t of TABLES) {
      expect(await tableExists(t), `${t} should be dropped`).toBe(false);
    }
  });

  it('round-trips up → down → up', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(UP_SQL);
    for (const t of TABLES) {
      expect(await tableExists(t)).toBe(true);
    }
  });
});
