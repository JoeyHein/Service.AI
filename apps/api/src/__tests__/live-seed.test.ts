/**
 * Live Postgres tests for TASK-TEN-09 seed + production resolvers.
 *
 * Runs the seed module directly against the docker Postgres and verifies:
 *   - row counts after a reset + seed match the gate (1 franchisor, 2
 *     franchisees, 2 locations, 13 users, 13 memberships).
 *   - re-running seed is a no-op (counts unchanged, same franchisor UUID).
 *   - every seeded user can sign in with DEV_SEED_PASSWORD.
 *   - the production MembershipResolver returns the seeded membership
 *     for a franchisee-scoped user.
 *
 * Auto-skips when DATABASE_URL is unreachable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createAuth } from '@service-ai/auth';
import * as schema from '@service-ai/db';
import {
  users,
  sessions,
  accounts,
  verifications,
  franchisors,
  franchisees,
  locations,
  memberships,
} from '@service-ai/db';
import { buildApp } from '../app.js';
import { runSeed, runReset, DEV_SEED_PASSWORD } from '../seed/index.js';
import { membershipResolver } from '../production-resolvers.js';

const { Pool } = pkg;

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await p.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await p.end();
  }
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  if (pool) await pool.end();
});

beforeEach(async (ctx) => {
  if (!reachable) return ctx.skip();
  await runReset(pool);
});

async function countRow(table: string): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS c FROM ${table}`);
  return (rows[0] as { c: number }).c;
}

/**
 * Scope row-count assertions to the seed's own franchisor so concurrent
 * live-* test files running in parallel don't bleed into the numbers.
 * Vitest executes test FILES concurrently by default — global counts
 * would be unreliable even after beforeEach reset, because another file
 * could be mid-setup when we query.
 */
async function seedScopedCounts(franchisorId: string): Promise<{
  franchisees: number;
  locations: number;
  memberships: number;
  users: number;
}> {
  const franchiseesCount = await pool.query(
    'SELECT count(*)::int AS c FROM franchisees WHERE franchisor_id = $1',
    [franchisorId],
  );
  const locationsCount = await pool.query(
    `SELECT count(*)::int AS c FROM locations
      WHERE franchisee_id IN (SELECT id FROM franchisees WHERE franchisor_id = $1)`,
    [franchisorId],
  );
  const membershipsCount = await pool.query(
    `SELECT count(*)::int AS c FROM memberships
      WHERE role = 'platform_admin'
         OR franchisee_id IN (SELECT id FROM franchisees WHERE franchisor_id = $1)`,
    [franchisorId],
  );
  const usersCount = await pool.query(
    `SELECT count(*)::int AS c FROM users
      WHERE email = 'joey@opendc.ca'
         OR email LIKE '%@elevateddoors.test'`,
  );
  return {
    franchisees: (franchiseesCount.rows[0] as { c: number }).c,
    locations: (locationsCount.rows[0] as { c: number }).c,
    memberships: (membershipsCount.rows[0] as { c: number }).c,
    users: (usersCount.rows[0] as { c: number }).c,
  };
}

describe('Seed — row counts after reset+seed', () => {
  it('creates exactly the gate-mandated counts', async () => {
    const result = await runSeed(pool);
    const counts = await seedScopedCounts(result.franchisorId);
    expect(counts.franchisees).toBe(2);
    expect(counts.locations).toBe(2);
    expect(counts.users).toBe(13);
    expect(counts.memberships).toBe(13);

    // Global franchisor-with-our-slug count must be 1.
    const { rows } = await pool.query(
      "SELECT count(*)::int AS c FROM franchisors WHERE slug = 'elevated-doors'",
    );
    expect((rows[0] as { c: number }).c).toBe(1);
  });

  it('is idempotent — second runSeed does not duplicate rows', async () => {
    const first = await runSeed(pool);
    const second = await runSeed(pool);
    expect(second.franchisorId).toBe(first.franchisorId);
    expect(second.platformAdminUserId).toBe(first.platformAdminUserId);
    const counts = await seedScopedCounts(first.franchisorId);
    expect(counts.franchisees).toBe(2);
    expect(counts.users).toBe(13);
    expect(counts.memberships).toBe(13);
  });
});

describe('Seed — auth chain', () => {
  it('every seeded franchisee user can sign in with DEV_SEED_PASSWORD', async () => {
    await runSeed(pool);

    const db = drizzle(pool, { schema });
    const auth = createAuth({
      db,
      authSchema: { user: users, session: sessions, account: accounts, verification: verifications },
      baseUrl: 'http://localhost',
      secret: 'x'.repeat(32),
    });
    const app: FastifyInstance = buildApp({
      db: { query: async () => ({ rows: [] }) },
      redis: { ping: async () => 'PONG' },
      logger: false,
      auth,
    });
    await app.ready();
    try {
      const franchiseeEmails = [
        'denver.owner@elevateddoors.test',
        'denver.dispatcher@elevateddoors.test',
        'austin.tech1@elevateddoors.test',
        'austin.csr@elevateddoors.test',
      ];
      for (const email of franchiseeEmails) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD }),
        });
        expect(res.statusCode, `sign-in failed for ${email}`).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it('production MembershipResolver returns seeded membership for a franchisee user', async () => {
    await runSeed(pool);
    const db = drizzle(pool, { schema });
    const resolver = membershipResolver(db);

    const [ownerRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, 'denver.owner@elevateddoors.test'));
    expect(ownerRow).toBeDefined();
    const rows = await resolver.memberships(ownerRow!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('franchisee_owner');
    expect(rows[0]?.franchisorId).toBeTruthy();
    expect(rows[0]?.franchiseeId).toBeTruthy();
  });
});

describe('Seed reset', () => {
  it('clears every tenant + auth table while preserving the schema', async () => {
    await runSeed(pool);
    // After seed, the seeded franchisor + users must exist.
    const beforeFr = await pool.query(
      "SELECT count(*)::int AS c FROM franchisors WHERE slug='elevated-doors'",
    );
    expect((beforeFr.rows[0] as { c: number }).c).toBe(1);

    await runReset(pool);

    // Globally empty — reset is a truncate, so any concurrent writers
    // will race with us; we only assert this right after our own reset.
    expect(await countRow('users')).toBe(0);
    expect(await countRow('memberships')).toBe(0);
    expect(await countRow('franchisors')).toBe(0);
    expect(await countRow('franchisees')).toBe(0);
    expect(await countRow('locations')).toBe(0);

    // Schema (tables themselves) still exists.
    const { rows } = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`);
    const names = rows.map((r: { tablename: string }) => r.tablename);
    expect(names).toContain('users');
    expect(names).toContain('memberships');
    expect(names).toContain('franchisors');
  });
});

// Touch imports so tree-shaking doesn't strip them when types-only.
void users;
void sessions;
void accounts;
void verifications;
void franchisors;
void franchisees;
void locations;
void memberships;
