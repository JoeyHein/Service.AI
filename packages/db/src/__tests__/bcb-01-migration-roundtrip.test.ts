/**
 * Live round-trip test for BCB (migration 0025_po_bc_ref).
 *
 * Auto-skips when Postgres or `psql` is unreachable. Asserts the migration
 * adds the BC-ref columns to purchase_orders on top of 0024 and round-trips.
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
const UP_SQL = 'migrations/0025_po_bc_ref.sql';
const DOWN_SQL = 'migrations/0025_po_bc_ref.down.sql';

let reachable = false;
let psqlAvailable = false;
let pool: InstanceType<typeof Pool>;

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await p.query('SELECT 1 FROM purchase_orders LIMIT 0');
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
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2) AS present`,
    [table, column],
  );
  return Boolean(rows[0].present);
}

const COLS = ['supplier_po_ref', 'supplier_po_id', 'bc_synced_at'] as const;

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  psqlAvailable = await checkPsql();
  if (!psqlAvailable) return;
  pool = new Pool({ connectionString: ADMIN_URL });
  try {
    await runPsqlFile(DOWN_SQL);
  } catch {
    // first run
  }
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe('BCB migration 0025 round-trip', () => {
  it('skips cleanly when prerequisites are missing', () => {
    if (!reachable || !psqlAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[bcb-01] DB/psql unavailable — test skipped.');
    }
  });

  it('applies up: adds the three BC-ref columns', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(UP_SQL);
    for (const c of COLS) expect(await columnExists('purchase_orders', c), c).toBe(true);
  });

  it('down removes them', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(DOWN_SQL);
    for (const c of COLS) expect(await columnExists('purchase_orders', c), c).toBe(false);
  });

  it('round-trips up → down → up', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(UP_SQL);
    for (const c of COLS) expect(await columnExists('purchase_orders', c)).toBe(true);
  });
});
