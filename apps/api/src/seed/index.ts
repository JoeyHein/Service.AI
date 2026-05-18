/**
 * Idempotent seed for the corporate hub model.
 *
 * Creates the demo tenant tree for Elevated Doors:
 *   - 1 corporate admin   (joey@opendc.ca)
 *   - 1 corporate hub     (Elevated Doors)
 *   - 2 branches          (Denver, Austin)
 *   - 2 locations         (one per branch)
 *   - 12 branch users     (manager + dispatcher + 2 techs + csr, ×2 — manager
 *                          is the only branch-level admin under the corporate
 *                          hub model; the legacy "owner" tier was collapsed)
 *
 * All users share a single DEV-ONLY password.
 *
 * Idempotency: every insert is guarded by a SELECT-before-INSERT lookup
 * on the natural unique key. Re-running the seed is a no-op.
 *
 * Reset: when invoked with `--reset` the script truncates every tenant-
 * scoped table plus Better Auth tables, leaving migrations and
 * health_checks intact.
 *
 * Runs with the admin DATABASE_URL — RLS is bypassed by superuser.
 */
import { and, eq } from 'drizzle-orm';
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
  corporate,
  branches,
  locations,
  memberships,
  serviceCatalogTemplates,
  serviceItems,
} from '@service-ai/db';

const { Pool } = pkg;

export const DEV_SEED_PASSWORD = 'changeme123!A';

const ELEVATED_DOORS_SLUG = 'elevated-doors';

interface BranchSpec {
  slug: string;
  name: string;
  location: string;
  userPrefix: string;
  timezone: string;
}

const BRANCHES: readonly BranchSpec[] = [
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

type BranchRole = 'manager' | 'dispatcher' | 'tech' | 'csr';

interface UserSpec {
  email: string;
  name: string;
  role: BranchRole;
}

function usersFor(fr: BranchSpec): UserSpec[] {
  const p = fr.userPrefix;
  return [
    { email: `${p}.owner@elevateddoors.test`, name: `${fr.slug} Manager`, role: 'manager' },
    { email: `${p}.manager@elevateddoors.test`, name: `${fr.slug} Manager 2`, role: 'manager' },
    { email: `${p}.dispatcher@elevateddoors.test`, name: `${fr.slug} Dispatcher`, role: 'dispatcher' },
    { email: `${p}.tech1@elevateddoors.test`, name: `${fr.slug} Tech 1`, role: 'tech' },
    { email: `${p}.tech2@elevateddoors.test`, name: `${fr.slug} Tech 2`, role: 'tech' },
    { email: `${p}.csr@elevateddoors.test`, name: `${fr.slug} CSR`, role: 'csr' },
  ];
}

const CORPORATE_ADMIN = {
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

async function ensureCorporate(
  db: Drizzle,
  spec: { name: string; slug: string },
): Promise<string> {
  const existing = await db
    .select({ id: corporate.id })
    .from(corporate)
    .where(eq(corporate.slug, spec.slug));
  if (existing[0]) return existing[0].id;
  const inserted = await db
    .insert(corporate)
    .values({ name: spec.name, slug: spec.slug })
    .returning({ id: corporate.id });
  return inserted[0]!.id;
}

async function ensureBranch(
  db: Drizzle,
  corporateId: string,
  spec: BranchSpec,
): Promise<string> {
  const existing = await db
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.slug, spec.slug));
  if (existing[0]) return existing[0].id;
  const inserted = await db
    .insert(branches)
    .values({
      corporateId,
      name: spec.name,
      slug: spec.slug,
      legalEntityName: `${spec.name} LLC`,
      timezone: spec.timezone,
    })
    .returning({ id: branches.id });
  return inserted[0]!.id;
}

async function ensureLocation(
  db: Drizzle,
  branchId: string,
  name: string,
  timezone: string,
): Promise<string> {
  const existing = await db
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.branchId, branchId));
  if (existing[0]) return existing[0].id;
  const inserted = await db
    .insert(locations)
    .values({ branchId, name, timezone })
    .returning({ id: locations.id });
  return inserted[0]!.id;
}

async function ensureMembership(
  db: Drizzle,
  args: {
    userId: string;
    scopeType: 'corporate' | 'branch';
    scopeId: string | null;
    role:
      | 'corporate_admin'
      | 'manager'
      | 'dispatcher'
      | 'tech'
      | 'csr';
    branchId: string | null;
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
    branchId: args.branchId,
    locationId: args.locationId,
  });
}

export interface SeedResult {
  corporateAdminUserId: string;
  corporateId: string;
  branches: { slug: string; id: string; locationId: string; userIds: string[] }[];
  catalog: {
    templateId: string;
    itemCount: number;
  };
  platformAdminUserId: string; // @deprecated alias for corporateAdminUserId; removed in CHR-06
  franchisorId: string; // @deprecated alias for corporateId; removed in CHR-06
  franchisees: { slug: string; id: string; locationId: string; userIds: string[] }[]; // @deprecated alias for branches; removed in CHR-06
}

interface SeedItem {
  sku: string;
  name: string;
  description?: string;
  category: 'Installs' | 'Repairs' | 'Springs' | 'Openers' | 'Parts';
  unit: string;
  basePrice: number;
  floorPrice?: number;
  ceilingPrice?: number;
  sortOrder?: number;
}

const SEED_ITEMS: readonly SeedItem[] = [
  { sku: 'INST-SC-STEEL', name: 'Single-car steel door install', category: 'Installs', unit: 'each', basePrice: 1200, floorPrice: 1000, ceilingPrice: 1600 },
  { sku: 'INST-2C-STEEL', name: '2-car steel door install', category: 'Installs', unit: 'each', basePrice: 1800, floorPrice: 1500, ceilingPrice: 2400 },
  { sku: 'INST-SC-WOOD', name: 'Single-car wood door install', category: 'Installs', unit: 'each', basePrice: 2200, floorPrice: 1800, ceilingPrice: 3000 },
  { sku: 'INST-2C-WOOD', name: '2-car wood door install', category: 'Installs', unit: 'each', basePrice: 3400, floorPrice: 2800, ceilingPrice: 4400 },
  { sku: 'INST-ALUM', name: 'Aluminum/glass panorama install', category: 'Installs', unit: 'each', basePrice: 4800, floorPrice: 3800, ceilingPrice: 6500 },
  { sku: 'INST-REMOVE', name: 'Old door haul-away', category: 'Installs', unit: 'each', basePrice: 150, floorPrice: 100, ceilingPrice: 250 },

  { sku: 'REP-ROLLER', name: 'Roller replacement (set of 10)', category: 'Repairs', unit: 'set', basePrice: 150, floorPrice: 120, ceilingPrice: 220 },
  { sku: 'REP-CABLE', name: 'Cable replacement (pair)', category: 'Repairs', unit: 'pair', basePrice: 220, floorPrice: 180, ceilingPrice: 300 },
  { sku: 'REP-HINGE', name: 'Hinge replacement', category: 'Repairs', unit: 'each', basePrice: 35, floorPrice: 25, ceilingPrice: 60 },
  { sku: 'REP-TRACK', name: 'Track alignment', category: 'Repairs', unit: 'each', basePrice: 180, floorPrice: 140, ceilingPrice: 260 },
  { sku: 'REP-BOTTOMSEAL', name: 'Bottom seal replacement', category: 'Repairs', unit: 'each', basePrice: 95, floorPrice: 70, ceilingPrice: 140 },
  { sku: 'REP-WEATHERSTRIP', name: 'Weather-strip replacement', category: 'Repairs', unit: 'linear_foot', basePrice: 9, floorPrice: 7, ceilingPrice: 14 },
  { sku: 'REP-PANEL', name: 'Single panel replacement', category: 'Repairs', unit: 'each', basePrice: 280, floorPrice: 220, ceilingPrice: 400 },
  { sku: 'REP-OFFTRACK', name: 'Door off-track reset', category: 'Repairs', unit: 'each', basePrice: 165, floorPrice: 130, ceilingPrice: 240 },
  { sku: 'REP-LUBRICATE', name: 'Lubrication + tune-up', category: 'Repairs', unit: 'each', basePrice: 120, floorPrice: 95, ceilingPrice: 160 },
  { sku: 'REP-PHOTOEYE', name: 'Photo-eye sensor replacement', category: 'Repairs', unit: 'each', basePrice: 95, floorPrice: 70, ceilingPrice: 140 },

  { sku: 'SPRING-TORSION', name: 'Torsion spring replacement (single)', category: 'Springs', unit: 'each', basePrice: 220, floorPrice: 180, ceilingPrice: 300 },
  { sku: 'SPRING-TORSION-PAIR', name: 'Torsion spring replacement (pair)', category: 'Springs', unit: 'pair', basePrice: 380, floorPrice: 320, ceilingPrice: 520 },
  { sku: 'SPRING-EXT', name: 'Extension spring replacement', category: 'Springs', unit: 'each', basePrice: 180, floorPrice: 140, ceilingPrice: 260 },
  { sku: 'SPRING-CONVERT', name: 'Extension → torsion conversion', category: 'Springs', unit: 'each', basePrice: 450, floorPrice: 380, ceilingPrice: 620 },
  { sku: 'SPRING-LIFT-CABLE', name: 'Lift cable + spring set', category: 'Springs', unit: 'set', basePrice: 320, floorPrice: 260, ceilingPrice: 440 },
  { sku: 'SPRING-HEAVY', name: 'Heavy-duty (oversize) spring', category: 'Springs', unit: 'each', basePrice: 320, floorPrice: 260, ceilingPrice: 460 },

  { sku: 'OPENER-CHAIN', name: 'Chain-drive opener', category: 'Openers', unit: 'each', basePrice: 395, floorPrice: 320, ceilingPrice: 550 },
  { sku: 'OPENER-BELT', name: 'Belt-drive opener', category: 'Openers', unit: 'each', basePrice: 495, floorPrice: 400, ceilingPrice: 680 },
  { sku: 'OPENER-SMART', name: 'Smart Wi-Fi belt-drive opener', category: 'Openers', unit: 'each', basePrice: 695, floorPrice: 560, ceilingPrice: 950 },
  { sku: 'OPENER-JACKSHAFT', name: 'Jack-shaft opener (wall-mount)', category: 'Openers', unit: 'each', basePrice: 895, floorPrice: 720, ceilingPrice: 1200 },
  { sku: 'OPENER-LOGIC-BOARD', name: 'Logic board replacement', category: 'Openers', unit: 'each', basePrice: 220, floorPrice: 170, ceilingPrice: 320 },
  { sku: 'OPENER-REMOTE', name: 'Remote (single)', category: 'Openers', unit: 'each', basePrice: 35, floorPrice: 28, ceilingPrice: 60 },
  { sku: 'OPENER-REMOTE-3PK', name: 'Remote 3-pack', category: 'Openers', unit: 'pack', basePrice: 95, floorPrice: 75, ceilingPrice: 145 },
  { sku: 'OPENER-KEYPAD', name: 'Wireless keypad', category: 'Openers', unit: 'each', basePrice: 65, floorPrice: 50, ceilingPrice: 95 },

  { sku: 'PART-ROLLER', name: 'Nylon roller', category: 'Parts', unit: 'each', basePrice: 6, floorPrice: 4, ceilingPrice: 10 },
  { sku: 'PART-HINGE', name: 'Steel hinge', category: 'Parts', unit: 'each', basePrice: 8, floorPrice: 5, ceilingPrice: 12 },
  { sku: 'PART-CABLE', name: 'Lift cable', category: 'Parts', unit: 'each', basePrice: 22, floorPrice: 16, ceilingPrice: 38 },
  { sku: 'PART-DRUM', name: 'Cable drum', category: 'Parts', unit: 'each', basePrice: 18, floorPrice: 14, ceilingPrice: 30 },
  { sku: 'PART-BRACKET', name: 'Bottom bracket', category: 'Parts', unit: 'each', basePrice: 16, floorPrice: 12, ceilingPrice: 28 },
  { sku: 'PART-TRACK-12', name: 'Track section 12-ft', category: 'Parts', unit: 'each', basePrice: 35, floorPrice: 28, ceilingPrice: 55 },
  { sku: 'PART-SEAL-BOTTOM', name: 'Bottom seal retainer', category: 'Parts', unit: 'each', basePrice: 28, floorPrice: 20, ceilingPrice: 44 },
  { sku: 'PART-WEATHERSTRIP-ROLL', name: 'Weather-strip roll (20 ft)', category: 'Parts', unit: 'roll', basePrice: 45, floorPrice: 32, ceilingPrice: 70 },
  { sku: 'PART-SENSOR', name: 'Safety sensor pair', category: 'Parts', unit: 'pair', basePrice: 55, floorPrice: 40, ceilingPrice: 85 },
  { sku: 'PART-KEYPAD', name: 'Keypad receiver', category: 'Parts', unit: 'each', basePrice: 38, floorPrice: 28, ceilingPrice: 60 },
  { sku: 'PART-EMERG-RELEASE', name: 'Emergency release kit', category: 'Parts', unit: 'each', basePrice: 24, floorPrice: 18, ceilingPrice: 38 },
  { sku: 'PART-CENTER-BEARING', name: 'Center bearing plate', category: 'Parts', unit: 'each', basePrice: 12, floorPrice: 8, ceilingPrice: 20 },
  { sku: 'PART-END-BEARING', name: 'End bearing plate', category: 'Parts', unit: 'each', basePrice: 14, floorPrice: 10, ceilingPrice: 22 },
  { sku: 'PART-BOLTS', name: 'Hardware pack (bolts/nuts)', category: 'Parts', unit: 'pack', basePrice: 18, floorPrice: 12, ceilingPrice: 28 },
  { sku: 'PART-LUBE', name: 'Garage-door lubricant (spray)', category: 'Parts', unit: 'can', basePrice: 12, floorPrice: 8, ceilingPrice: 20 },
  { sku: 'PART-WALL-BUTTON', name: 'Wall-mounted door control', category: 'Parts', unit: 'each', basePrice: 42, floorPrice: 30, ceilingPrice: 65 },
  { sku: 'PART-WIRE', name: 'Low-voltage wire (per foot)', category: 'Parts', unit: 'linear_foot', basePrice: 2, floorPrice: 1, ceilingPrice: 4 },
];

async function ensureCatalog(
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<{ templateId: string; itemCount: number }> {
  const existing = await db
    .select({ id: serviceCatalogTemplates.id, status: serviceCatalogTemplates.status })
    .from(serviceCatalogTemplates)
    .where(eq(serviceCatalogTemplates.slug, 'starter-2026'));
  const templateId =
    existing[0]?.id ??
    (
      await db
        .insert(serviceCatalogTemplates)
        .values({
          name: 'Starter Catalog 2026',
          slug: 'starter-2026',
          notes: 'Seed catalog for Elevated Doors demo environments.',
          status: 'published',
          publishedAt: new Date(),
        })
        .returning({ id: serviceCatalogTemplates.id })
    )[0]!.id;

  if (existing[0] && existing[0].status !== 'published') {
    await db
      .update(serviceCatalogTemplates)
      .set({ status: 'published', publishedAt: new Date() })
      .where(eq(serviceCatalogTemplates.id, templateId));
  }

  let itemCount = 0;
  for (let idx = 0; idx < SEED_ITEMS.length; idx++) {
    const spec = SEED_ITEMS[idx]!;
    const already = await db
      .select({ id: serviceItems.id })
      .from(serviceItems)
      .where(
        and(
          eq(serviceItems.templateId, templateId),
          eq(serviceItems.sku, spec.sku),
        ),
      );
    if (already.length === 0) {
      await db.insert(serviceItems).values({
        templateId,
        sku: spec.sku,
        name: spec.name,
        description: spec.description ?? null,
        category: spec.category,
        unit: spec.unit,
        basePrice: String(spec.basePrice),
        floorPrice: spec.floorPrice == null ? null : String(spec.floorPrice),
        ceilingPrice: spec.ceilingPrice == null ? null : String(spec.ceilingPrice),
        sortOrder: spec.sortOrder ?? idx,
      });
    }
    itemCount++;
  }
  return { templateId, itemCount };
}

export async function runSeed(pool: InstanceType<typeof Pool>): Promise<SeedResult> {
  const db = drizzle(pool, { schema });
  const auth = buildAuth(db);

  const corporateAdminUserId = await ensureUser(
    db,
    auth,
    CORPORATE_ADMIN.email,
    CORPORATE_ADMIN.name,
  );

  const corporateId = await ensureCorporate(db, {
    name: 'Elevated Doors',
    slug: ELEVATED_DOORS_SLUG,
  });

  await ensureMembership(db, {
    userId: corporateAdminUserId,
    scopeType: 'corporate',
    scopeId: corporateId,
    role: 'corporate_admin',
    branchId: null,
    locationId: null,
  });

  const branchSummaries: SeedResult['branches'] = [];
  for (const spec of BRANCHES) {
    const branchId = await ensureBranch(db, corporateId, spec);
    const locationId = await ensureLocation(db, branchId, spec.location, spec.timezone);
    const userIds: string[] = [];
    for (const u of usersFor(spec)) {
      const userId = await ensureUser(db, auth, u.email, u.name);
      userIds.push(userId);
      await ensureMembership(db, {
        userId,
        scopeType: 'branch',
        scopeId: branchId,
        role: u.role,
        branchId,
        locationId: null,
      });
    }
    branchSummaries.push({ slug: spec.slug, id: branchId, locationId, userIds });
  }

  const catalog = await ensureCatalog(db);
  const result: SeedResult = {
    corporateAdminUserId,
    corporateId,
    branches: branchSummaries,
    catalog: {
      templateId: catalog.templateId,
      itemCount: catalog.itemCount,
    },
    platformAdminUserId: corporateAdminUserId, // @deprecated CHR-06
    franchisorId: corporateId, // @deprecated CHR-06
    franchisees: branchSummaries, // @deprecated CHR-06
  };

  const { runKbSeed } = await import('./kb-docs.js');
  await runKbSeed(pool);

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
       notifications_log,
       payment_retries,
       collections_drafts,
       ai_feedback,
       kb_docs,
       ai_metrics,
       ai_suggestions,
       tech_skills,
       call_sessions,
       ai_messages,
       ai_conversations,
       stripe_events,
       refunds,
       payments,
       commission_ledger,
       user_comp_assignments,
       comp_plans,
       pricebook_suggestions,
       service_items,
       service_catalog_templates,
       invitations,
       audit_log,
       memberships,
       branch_managers,
       locations,
       branches,
       corporate,
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
    console.log('  corporate admin:', CORPORATE_ADMIN.email);
    console.log('  corporate:', ELEVATED_DOORS_SLUG, result.corporateId);
    for (const b of result.branches) {
      console.log(`  branch ${b.slug}: ${b.id} (${b.userIds.length} users)`);
    }
    console.log(
      `  catalog template: ${result.catalog.templateId} (${result.catalog.itemCount} items)`,
    );
    console.log(`\nAll seeded users can sign in with: ${DEV_SEED_PASSWORD}`);
    console.log('(DEV ONLY — never use this in production)');
  } finally {
    await pool.end();
  }
}

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
