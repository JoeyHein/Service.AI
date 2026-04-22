/**
 * Live RLS enforcement tests for TASK-TEN-02 and TASK-TEN-03.
 *
 * These tests require a reachable Postgres 16 instance with the 0001–0003
 * migrations applied. They create a NOSUPERUSER NOBYPASSRLS role
 * (rls_test_user) so RLS policies actually fire — the default `builder`
 * dev role is a superuser and bypasses RLS. Production DO-managed Postgres
 * connects as a non-superuser by default, so these tests mirror that
 * environment.
 *
 * All tests auto-skip when DATABASE_URL is unreachable, matching the
 * health-checks.test.ts pattern so the suite stays green on bare hosts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { withScope, type RequestScope } from '../scope.js';
import * as schema from '../schema.js';

const { Pool } = pkg;

const ADMIN_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

// Replace user:password in ADMIN_URL with rls_test_user:rls_test_user so the
// RLS tests connect as a non-superuser. Keeps the dev DATABASE_URL convention
// (single env var) and avoids adding a second variable.
const RLS_URL = ADMIN_URL.replace(
  /^postgresql:\/\/[^:]+:[^@]+@/,
  'postgresql://rls_test_user:rls_test_user@',
);

let reachable = false;

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

const FRANCHISOR_A = '11111111-1111-1111-1111-111111111111';
const FRANCHISOR_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FRANCHISEE_A1 = 'a1111111-1111-1111-1111-111111111111';
const FRANCHISEE_B1 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

let adminPool: InstanceType<typeof Pool>;
let rlsPool: InstanceType<typeof Pool>;

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;

  adminPool = new Pool({ connectionString: ADMIN_URL });

  // Provision the non-superuser test role. Idempotent — DO block checks first.
  await adminPool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rls_test_user') THEN
        CREATE ROLE rls_test_user NOSUPERUSER NOBYPASSRLS LOGIN PASSWORD 'rls_test_user';
      END IF;
    END
    $$;
  `);
  await adminPool.query('GRANT USAGE ON SCHEMA public TO rls_test_user');
  await adminPool.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO rls_test_user',
  );
  await adminPool.query(
    'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rls_test_user',
  );

  // Clean any prior seed state — adminPool bypasses RLS so this truncates
  // all tenant rows regardless of app.role GUC.
  await adminPool.query('TRUNCATE TABLE audit_log, memberships, locations, franchisees, franchisors CASCADE');

  // Seed two franchisors, two franchisees. Use explicit UUIDs so tests can
  // assert on specific ids.
  await adminPool.query(
    `INSERT INTO franchisors (id, name, slug)
     VALUES ($1, 'Franchisor A', 'franchisor-a'),
            ($2, 'Franchisor B', 'franchisor-b')`,
    [FRANCHISOR_A, FRANCHISOR_B],
  );
  await adminPool.query(
    `INSERT INTO franchisees (id, franchisor_id, name, slug)
     VALUES ($1, $3, 'Franchisee A1', 'a1'),
            ($2, $4, 'Franchisee B1', 'b1')`,
    [FRANCHISEE_A1, FRANCHISEE_B1, FRANCHISOR_A, FRANCHISOR_B],
  );
  await adminPool.query(
    `INSERT INTO locations (franchisee_id, name) VALUES ($1, 'A1 HQ'), ($2, 'B1 HQ')`,
    [FRANCHISEE_A1, FRANCHISEE_B1],
  );

  rlsPool = new Pool({ connectionString: RLS_URL });
});

afterAll(async () => {
  if (rlsPool) await rlsPool.end();
  if (adminPool) await adminPool.end();
});

describe('RLS policy enforcement (live Postgres)', () => {
  beforeEach((ctx) => {
    if (!reachable) ctx.skip();
  });

  it('returns zero tenant rows when no GUCs are set (fail-closed)', async () => {
    const { rows: franchisees } = await rlsPool.query('SELECT id FROM franchisees');
    expect(franchisees).toHaveLength(0);
    const { rows: locs } = await rlsPool.query('SELECT id FROM locations');
    expect(locs).toHaveLength(0);
  });

  it('platform_admin sees every tenant row', async () => {
    const client = await rlsPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.role', 'platform_admin', true)`);
      const { rows } = await client.query('SELECT id FROM franchisees ORDER BY slug');
      expect(rows.map((r) => r.id)).toEqual([FRANCHISEE_A1, FRANCHISEE_B1]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('franchisor_admin sees only their own franchisor\'s franchisees', async () => {
    const client = await rlsPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.role', 'franchisor_admin', true)`);
      await client.query(`SELECT set_config('app.franchisor_id', $1, true)`, [FRANCHISOR_A]);
      const { rows } = await client.query('SELECT id FROM franchisees');
      expect(rows.map((r) => r.id)).toEqual([FRANCHISEE_A1]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('franchisor_admin sees locations only at their franchisor\'s franchisees', async () => {
    const client = await rlsPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.role', 'franchisor_admin', true)`);
      await client.query(`SELECT set_config('app.franchisor_id', $1, true)`, [FRANCHISOR_B]);
      const { rows } = await client.query('SELECT franchisee_id FROM locations');
      expect(rows.map((r) => r.franchisee_id)).toEqual([FRANCHISEE_B1]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('franchisee-scoped role sees only its franchisee\'s rows', async () => {
    const client = await rlsPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.role', 'dispatcher', true)`);
      await client.query(`SELECT set_config('app.franchisee_id', $1, true)`, [FRANCHISEE_A1]);
      const { rows: franchisees } = await client.query('SELECT id FROM franchisees');
      expect(franchisees.map((r) => r.id)).toEqual([FRANCHISEE_A1]);

      const { rows: locs } = await client.query('SELECT franchisee_id FROM locations');
      expect(locs.map((r) => r.franchisee_id)).toEqual([FRANCHISEE_A1]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('GUCs auto-clear at transaction end (no cross-request leak)', async () => {
    const client = await rlsPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.role', 'platform_admin', true)`);
      const { rows: inside } = await client.query('SELECT id FROM franchisees');
      expect(inside.length).toBe(2);
      await client.query('COMMIT');

      // Fresh transaction on the same pooled connection; GUCs should be empty.
      const { rows: after } = await client.query('SELECT id FROM franchisees');
      expect(after).toHaveLength(0);
    } finally {
      client.release();
    }
  });
});

describe('withScope helper (live Postgres)', () => {
  beforeEach((ctx) => {
    if (!reachable) ctx.skip();
  });

  it('sets all three GUCs and returns the callback\'s result', async () => {
    const db = drizzle(rlsPool, { schema });
    const scope: RequestScope = {
      type: 'franchisee',
      userId: 'u-test',
      role: 'dispatcher',
      franchisorId: FRANCHISOR_A,
      franchiseeId: FRANCHISEE_A1,
    };
    const seenGucs = await withScope(db, scope, async (tx) => {
      const role = await tx.execute(sql`select current_setting('app.role', true) as role`);
      const franchisorId = await tx.execute(
        sql`select current_setting('app.franchisor_id', true) as franchisor_id`,
      );
      const franchiseeId = await tx.execute(
        sql`select current_setting('app.franchisee_id', true) as franchisee_id`,
      );
      return {
        role: (role.rows[0] as { role: string }).role,
        franchisorId: (franchisorId.rows[0] as { franchisor_id: string }).franchisor_id,
        franchiseeId: (franchiseeId.rows[0] as { franchisee_id: string }).franchisee_id,
      };
    });
    expect(seenGucs).toEqual({
      role: 'dispatcher',
      franchisorId: FRANCHISOR_A,
      franchiseeId: FRANCHISEE_A1,
    });
  });

  it('GUCs auto-clear after withScope returns', async () => {
    const db = drizzle(rlsPool, { schema });
    const scope: RequestScope = {
      type: 'platform',
      userId: 'u-test',
      role: 'platform_admin',
    };
    await withScope(db, scope, async () => {});

    // A fresh query outside withScope — GUCs should be empty strings.
    const { rows } = await rlsPool.query(
      `SELECT current_setting('app.role', true) as role`,
    );
    expect((rows[0] as { role: string | null }).role ?? '').toBe('');
  });
});
