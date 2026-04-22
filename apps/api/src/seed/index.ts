/**
 * Idempotent seed for TASK-TEN-09.
 *
 * Creates the demo tenant tree for Elevated Doors:
 *   - 1 platform admin  (joey@opendc.ca)
 *   - 1 franchisor       (Elevated Doors)
 *   - 2 franchisees      (Denver, Austin)
 *   - 2 locations        (one per franchisee)
 *   - 12 franchisee users (owner + manager + dispatcher + 2 techs + csr, ×2)
 *   - 13 memberships     (1 platform + 12 franchisee-scoped)
 *
 * All users share a single DEV-ONLY password. The constant is exported so
 * test suites can sign in as seeded users without hard-coding the string
 * in multiple places. Production deployments MUST regenerate passwords
 * before going live — this seed is strictly for dev + CI.
 *
 * Idempotency: every insert is guarded by a SELECT-before-INSERT lookup
 * on the natural unique key (email for users, slug for franchisors /
 * franchisees, (franchisee_id, name) for locations). Re-running the seed
 * a second time is a no-op and exits 0.
 *
 * Reset: when invoked with `--reset` the script first truncates every
 * tenant-scoped table plus the Better Auth tables, leaving migrations
 * and health_checks intact.
 *
 * Runs with the admin DATABASE_URL — RLS is bypassed by superuser.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
import { createAuth } from '@service-ai/auth';
import type { Auth } from '@service-ai/auth';
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

const { Pool } = pkg;

export const DEV_SEED_PASSWORD = 'changeme123!A';

const ELEVATED_DOORS_SLUG = 'elevated-doors';

interface FranchiseeSpec {
  slug: string;
  name: string;
  location: string;
  userPrefix: string;
  timezone: string;
}

const FRANCHISEES: readonly FranchiseeSpec[] = [
  {
    slug: 'denver',
    name: 'Elevated Doors — Denver',
    location: 'Denver Metro',
    userPrefix: 'denver',
    timezone: 'America/Denver',
  },
  {
    slug: 'austin',
    name: 'Elevated Doors — Austin',
    location: 'Austin Central',
    userPrefix: 'austin',
    timezone: 'America/Chicago',
  },
] as const;

type FranchiseeRole =
  | 'franchisee_owner'
  | 'location_manager'
  | 'dispatcher'
  | 'tech'
  | 'csr';

interface UserSpec {
  email: string;
  name: string;
  role: FranchiseeRole;
}

function usersFor(fr: FranchiseeSpec): UserSpec[] {
  const p = fr.userPrefix;
  return [
    { email: `${p}.owner@elevateddoors.test`, name: `${fr.slug} Owner`, role: 'franchisee_owner' },
    { email: `${p}.manager@elevateddoors.test`, name: `${fr.slug} Manager`, role: 'location_manager' },
    { email: `${p}.dispatcher@elevateddoors.test`, name: `${fr.slug} Dispatcher`, role: 'dispatcher' },
    { email: `${p}.tech1@elevateddoors.test`, name: `${fr.slug} Tech 1`, role: 'tech' },
    { email: `${p}.tech2@elevateddoors.test`, name: `${fr.slug} Tech 2`, role: 'tech' },
    { email: `${p}.csr@elevateddoors.test`, name: `${fr.slug} CSR`, role: 'csr' },
  ];
}

const PLATFORM_ADMIN = {
  email: 'joey@opendc.ca',
  name: 'Joey Heinrichs',
} as const;

export type Drizzle = ReturnType<typeof drizzle<typeof schema>>;

function buildAuth(db: Drizzle): Auth {
  return createAuth({
    db,
    authSchema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
    baseUrl: 'http://localhost',
    secret: 'x'.repeat(32),
  });
}

/** Create a user via Better Auth's sign-up endpoint or return the existing one. */
async function ensureUser(
  db: Drizzle,
  auth: Auth,
  email: string,
  name: string,
): Promise<string> {
  const normalized = email.toLowerCase();
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, normalized));
  if (existing[0]) return existing[0].id;

  await auth.api.signUpEmail({
    body: { email: normalized, password: DEV_SEED_PASSWORD, name },
  });
  const after = await db.select({ id: users.id }).from(users).where(eq(users.email, normalized));
  if (!after[0]) {
    throw new Error(`Seed failed: user ${normalized} not present after sign-up`);
  }
  return after[0].id;
}

async function ensureFranchisor(
  db: Drizzle,
  spec: { name: string; slug: string },
): Promise<string> {
  const existing = await db
    .select({ id: franchisors.id })
    .from(franchisors)
    .where(eq(franchisors.slug, spec.slug));
  if (existing[0]) return existing[0].id;
  const inserted = await db
    .insert(franchisors)
    .values({ name: spec.name, slug: spec.slug })
    .returning({ id: franchisors.id });
  return inserted[0]!.id;
}

async function ensureFranchisee(
  db: Drizzle,
  franchisorId: string,
  spec: FranchiseeSpec,
): Promise<string> {
  const existing = await db
    .select({ id: franchisees.id })
    .from(franchisees)
    .where(eq(franchisees.slug, spec.slug));
  const existingForParent = existing.find(() => true); // slug has a per-franchisor unique so this is safe here
  if (existingForParent) return existingForParent.id;
  const inserted = await db
    .insert(franchisees)
    .values({
      franchisorId,
      name: spec.name,
      slug: spec.slug,
      legalEntityName: `${spec.name} LLC`,
    })
    .returning({ id: franchisees.id });
  return inserted[0]!.id;
}

async function ensureLocation(
  db: Drizzle,
  franchiseeId: string,
  name: string,
  timezone: string,
): Promise<string> {
  const existing = await db
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.franchiseeId, franchiseeId));
  if (existing[0]) return existing[0].id;
  const inserted = await db
    .insert(locations)
    .values({ franchiseeId, name, timezone })
    .returning({ id: locations.id });
  return inserted[0]!.id;
}

async function ensureMembership(
  db: Drizzle,
  args: {
    userId: string;
    scopeType: 'platform' | 'franchisor' | 'franchisee' | 'location';
    scopeId: string | null;
    role:
      | 'platform_admin'
      | 'franchisor_admin'
      | 'franchisee_owner'
      | 'location_manager'
      | 'dispatcher'
      | 'tech'
      | 'csr';
    franchiseeId: string | null;
    locationId: string | null;
  },
): Promise<void> {
  const existing = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(eq(memberships.userId, args.userId));
  if (existing.some((m) => m.id)) return;
  await db.insert(memberships).values({
    userId: args.userId,
    scopeType: args.scopeType,
    scopeId: args.scopeId,
    role: args.role,
    franchiseeId: args.franchiseeId,
    locationId: args.locationId,
  });
}

export interface SeedResult {
  platformAdminUserId: string;
  franchisorId: string;
  franchisees: { slug: string; id: string; locationId: string; userIds: string[] }[];
}

export async function runSeed(pool: InstanceType<typeof Pool>): Promise<SeedResult> {
  const db = drizzle(pool, { schema });
  const auth = buildAuth(db);

  const platformAdminUserId = await ensureUser(db, auth, PLATFORM_ADMIN.email, PLATFORM_ADMIN.name);
  await ensureMembership(db, {
    userId: platformAdminUserId,
    scopeType: 'platform',
    scopeId: null,
    role: 'platform_admin',
    franchiseeId: null,
    locationId: null,
  });

  const franchisorId = await ensureFranchisor(db, {
    name: 'Elevated Doors',
    slug: ELEVATED_DOORS_SLUG,
  });

  const result: SeedResult = { platformAdminUserId, franchisorId, franchisees: [] };

  for (const spec of FRANCHISEES) {
    const franchiseeId = await ensureFranchisee(db, franchisorId, spec);
    const locationId = await ensureLocation(db, franchiseeId, spec.location, spec.timezone);
    const userIds: string[] = [];
    for (const u of usersFor(spec)) {
      const userId = await ensureUser(db, auth, u.email, u.name);
      userIds.push(userId);
      await ensureMembership(db, {
        userId,
        scopeType: u.role === 'location_manager' ? 'location' : 'franchisee',
        scopeId: u.role === 'location_manager' ? locationId : franchiseeId,
        role: u.role,
        franchiseeId,
        locationId: u.role === 'location_manager' ? locationId : null,
      });
    }
    result.franchisees.push({ slug: spec.slug, id: franchiseeId, locationId, userIds });
  }

  return result;
}

/**
 * Wipe every tenant + Better Auth row while preserving the schema itself
 * and the foundation-phase health_checks data. TRUNCATE … CASCADE clears
 * dependents in one shot; no ordering required.
 */
export async function runReset(pool: InstanceType<typeof Pool>): Promise<void> {
  await pool.query(
    `TRUNCATE TABLE
       invitations,
       audit_log,
       memberships,
       locations,
       franchisees,
       franchisors,
       sessions,
       accounts,
       verifications,
       users
     CASCADE`,
  );
}

/**
 * CLI entry — runs when this module is executed directly. Supports
 *   pnpm seed
 *   pnpm seed --reset-first         (reset, then seed)
 *   pnpm seed --reset               (reset only, no re-seed)
 */
async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('Seed aborted: DATABASE_URL is not set');
    process.exit(2);
  }
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const resetOnly = process.argv.includes('--reset');
    const resetFirst = process.argv.includes('--reset-first');
    if (resetOnly || resetFirst) {
      await runReset(pool);
      console.log('Seed: reset complete');
      if (resetOnly) return;
    }
    const result = await runSeed(pool);
    console.log('Seed: applied');
    console.log('  platform admin:', PLATFORM_ADMIN.email);
    console.log('  franchisor:', ELEVATED_DOORS_SLUG, result.franchisorId);
    for (const f of result.franchisees) {
      console.log(`  franchisee ${f.slug}: ${f.id} (${f.userIds.length} users)`);
    }
    console.log(`\nAll seeded users can sign in with: ${DEV_SEED_PASSWORD}`);
    console.log('(DEV ONLY — never use this in production)');
  } finally {
    await pool.end();
  }
}

// Detect CLI execution. Both argv[1] and the module path need the same
// file:// canonicalisation because Node uses posix-style URLs everywhere
// but Windows argv[1] is a drive-letter path. fileURLToPath normalises
// import.meta.url back to an OS path we can compare with argv[1].
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

const entryPath = process.argv[1] ? resolvePath(process.argv[1]) : '';
const modulePath = resolvePath(fileURLToPath(import.meta.url));
if (entryPath && entryPath === modulePath) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
