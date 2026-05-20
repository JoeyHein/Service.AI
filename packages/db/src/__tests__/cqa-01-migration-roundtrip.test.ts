/**
 * Live round-trip test for CQA-01 (migration 0019_customer_quote_acceptance).
 *
 * Auto-skips when Postgres or `psql` is unreachable, matching the qoc-01
 * round-trip pattern. When the DB is available, asserts:
 *
 *   1. The migration applies cleanly on top of 0018.
 *   2. After up: `quotes` carries the six new acceptance/deposit columns +
 *      the accept-token unique index + the deposit-PI lookup index, and
 *      `corporate` carries the three deposit-policy columns.
 *   3. After down: every new column + index is gone.
 *   4. After up→down→up: the schema is identical (idempotent).
 *
 * Migrations 0001..0018 must already be applied — same prereq as qoc-01.
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
const UP_SQL = 'migrations/0019_customer_quote_acceptance.sql';
const DOWN_SQL = 'migrations/0019_customer_quote_acceptance.down.sql';

let reachable = false;
let psqlAvailable = false;
let pool: InstanceType<typeof Pool>;

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    // CQA-01 layers on QOC — assumes `quotes` already has the order columns.
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

const QUOTE_COLUMNS = [
  'accept_token',
  'accept_token_expires_at',
  'accepted_channel',
  'deposit_amount_cents',
  'deposit_payment_intent_id',
  'deposit_paid_at',
] as const;
const CORPORATE_COLUMNS = [
  'deposit_pct',
  'deposit_min_cents',
  'deposit_max_cents',
] as const;
const NEW_INDEXES = [
  'quotes_accept_token_unique',
  'quotes_deposit_payment_intent_idx',
] as const;

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

describe('CQA-01 migration 0019 round-trip', () => {
  it('skips cleanly when prerequisites are missing', () => {
    if (!reachable) {
      // eslint-disable-next-line no-console
      console.warn(`[cqa-01] DATABASE_URL ${ADMIN_URL} unreachable — test skipped.`);
    }
    if (reachable && !psqlAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[cqa-01] psql not on PATH — test skipped.');
    }
  });

  it('applies up cleanly, adding the quote + corporate columns', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(UP_SQL);
    for (const c of QUOTE_COLUMNS) {
      expect(await columnExists('quotes', c), `expected quotes.${c} after up`).toBe(true);
    }
    for (const c of CORPORATE_COLUMNS) {
      expect(await columnExists('corporate', c), `expected corporate.${c} after up`).toBe(true);
    }
  });

  it('creates the accept-token + deposit-PI indexes', async () => {
    if (!reachable || !psqlAvailable) return;
    for (const idx of NEW_INDEXES) {
      expect(await indexExists(idx), `expected ${idx} after up`).toBe(true);
    }
  });

  it('down removes every new column + index', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(DOWN_SQL);
    for (const c of QUOTE_COLUMNS) {
      expect(await columnExists('quotes', c), `quotes.${c} should be dropped`).toBe(false);
    }
    for (const c of CORPORATE_COLUMNS) {
      expect(await columnExists('corporate', c), `corporate.${c} should be dropped`).toBe(false);
    }
    for (const idx of NEW_INDEXES) {
      expect(await indexExists(idx), `${idx} should be dropped`).toBe(false);
    }
  });

  it('round-trips up → down → up with the same shape', async () => {
    if (!reachable || !psqlAvailable) return;
    await runPsqlFile(UP_SQL);
    for (const c of QUOTE_COLUMNS) {
      expect(await columnExists('quotes', c)).toBe(true);
    }
    for (const c of CORPORATE_COLUMNS) {
      expect(await columnExists('corporate', c)).toBe(true);
    }
    for (const idx of NEW_INDEXES) {
      expect(await indexExists(idx)).toBe(true);
    }
  });
});
