/**
 * Corporate RLS enforcement on a NON-SUPERUSER connection (TD-CQA-01).
 *
 * The dev/test docker Postgres connects as a superuser (`builder`), which
 * BYPASSES row-level security — so route/scope tests never actually exercise
 * the `<table>_corporate_admin` / `<table>_scoped` policies. Production connects
 * as a non-superuser where RLS is the real backstop. This test creates a
 * dedicated non-superuser role, sets the `app.role` / `app.branch_id` GUCs the
 * way `withScope` does, and asserts the policies fire on raw SELECTs:
 *   - a branch-scoped role sees only its own branch's rows;
 *   - a corporate_admin sees every branch's rows.
 *
 * Auto-skips when Postgres is unreachable or the non-superuser role can't
 * connect (e.g. pg_hba doesn't allow password auth for new roles).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pkg from 'pg';

const { Pool } = pkg;

const ADMIN_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

const PROBE_ROLE = 'rls_probe';
const PROBE_PW = 'rls_probe_pw';

const CORP_ID = '00000000-0000-0000-0000-00000000c0c0';
const BRANCH_A = '00000000-0000-0000-0000-0000000a0a0a';
const BRANCH_B = '00000000-0000-0000-0000-0000000b0b0b';
const CUST_A = '00000000-0000-0000-0000-0000000aaaaa';
const CUST_B = '00000000-0000-0000-0000-0000000bbbbb';

let reachable = false;
let probeConnectable = false;
let admin: InstanceType<typeof Pool>;
let probe: InstanceType<typeof Pool>;

function probeUrl(): string {
  const u = new URL(ADMIN_URL);
  u.username = PROBE_ROLE;
  u.password = PROBE_PW;
  return u.toString();
}

async function clean(): Promise<void> {
  await admin.query(`DELETE FROM customers WHERE id IN ($1, $2)`, [CUST_A, CUST_B]);
  await admin.query(`DELETE FROM branches WHERE id IN ($1, $2)`, [BRANCH_A, BRANCH_B]);
  await admin.query(`DELETE FROM corporate WHERE id = $1`, [CORP_ID]);
}

beforeAll(async () => {
  const probePool = new Pool({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await probePool.query('SELECT 1 FROM customers LIMIT 0');
    reachable = true;
  } catch {
    reachable = false;
  } finally {
    await probePool.end();
  }
  if (!reachable) return;

  admin = new Pool({ connectionString: ADMIN_URL });

  // Non-superuser, non-bypassrls role with SELECT on the tables under test.
  await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`).catch(() => {});
  await admin.query(`CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD '${PROBE_PW}' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
  await admin.query(`GRANT SELECT ON customers, branches, corporate TO ${PROBE_ROLE}`);

  await clean();
  await admin.query(
    `INSERT INTO corporate (id, name, slug, default_margin_pct, min_margin_pct, max_margin_pct)
     VALUES ($1, 'RLS Probe Corp', 'rls-probe-corp', '50.00', '10.00', '90.00')`,
    [CORP_ID],
  );
  await admin.query(`INSERT INTO branches (id, corporate_id, name, slug) VALUES ($1,$2,'A','rls-a'),($3,$2,'B','rls-b')`, [
    BRANCH_A,
    CORP_ID,
    BRANCH_B,
  ]);
  await admin.query(`INSERT INTO customers (id, branch_id, name) VALUES ($1,$2,'Cust A'),($3,$4,'Cust B')`, [
    CUST_A,
    BRANCH_A,
    CUST_B,
    BRANCH_B,
  ]);

  probe = new Pool({ connectionString: probeUrl(), connectionTimeoutMillis: 3000 });
  try {
    await probe.query('SELECT 1');
    probeConnectable = true;
  } catch {
    probeConnectable = false;
  }
});

afterAll(async () => {
  if (probe) await probe.end().catch(() => {});
  if (reachable && admin) {
    await clean().catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`).catch(() => {});
    await admin.end();
  }
});

/** Run a SELECT under txn-local GUCs, mirroring withScope. */
async function selectAsScope(
  role: string,
  branchId: string,
): Promise<string[]> {
  const client = await probe.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.role', $1, true)`, [role]);
    await client.query(`SELECT set_config('app.branch_id', $1, true)`, [branchId]);
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM customers WHERE id IN ($1, $2) ORDER BY name`,
      [CUST_A, CUST_B],
    );
    await client.query('ROLLBACK');
    return rows.map((r) => r.id);
  } finally {
    client.release();
  }
}

describe('TD-CQA-01 / corporate RLS on a non-superuser connection', () => {
  it('skips cleanly when prerequisites are missing', () => {
    if (!reachable) {
      // eslint-disable-next-line no-console
      console.warn(`[live-rls-corporate] DATABASE_URL ${ADMIN_URL} unreachable — skipped.`);
    } else if (!probeConnectable) {
      // eslint-disable-next-line no-console
      console.warn('[live-rls-corporate] non-superuser role could not connect (pg_hba) — skipped.');
    }
  });

  it('a branch-scoped role sees ONLY its own branch customers', async () => {
    if (!reachable || !probeConnectable) return;
    const seenA = await selectAsScope('manager', BRANCH_A);
    expect(seenA).toEqual([CUST_A]);
    const seenB = await selectAsScope('manager', BRANCH_B);
    expect(seenB).toEqual([CUST_B]);
  });

  it('a corporate_admin sees every branch customer', async () => {
    if (!reachable || !probeConnectable) return;
    const seen = await selectAsScope('corporate_admin', '');
    expect(new Set(seen)).toEqual(new Set([CUST_A, CUST_B]));
  });

  it('an unset role (no GUCs) sees nothing (fails closed)', async () => {
    if (!reachable || !probeConnectable) return;
    const client = await probe.connect();
    try {
      // No set_config — both policies evaluate against NULL app.role.
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM customers WHERE id IN ($1, $2)`,
        [CUST_A, CUST_B],
      );
      expect(rows).toEqual([]);
    } finally {
      client.release();
    }
  });
});
