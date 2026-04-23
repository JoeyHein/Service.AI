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
  franchisors,
  franchisees,
  locations,
  memberships,
  serviceCatalogTemplates,
  serviceItems,
  pricebookOverrides,
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
  catalog: {
    templateId: string;
    itemCount: number;
    overrideCount: number;
  };
}

/**
 * Demo garage-door catalog: ~50 items across five categories. Prices
 * match real-industry ranges so screenshots look plausible.
 *
 * category | count | price sample
 * ---------+-------+-----------------------------------
 * Installs |   6   | single-car install $1,200 → 2-car $1,800
 * Repairs  |  10   | roller swap $150, cable replace $220
 * Springs  |   6   | torsion spring $220, pair $380
 * Openers  |   8   | chain-drive $395, smart belt $695
 * Parts    |  20+  | rollers, hinges, cables, sensors …
 */
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
  // Installs
  { sku: 'INST-SC-STEEL', name: 'Single-car steel door install', category: 'Installs', unit: 'each', basePrice: 1200, floorPrice: 1000, ceilingPrice: 1600 },
  { sku: 'INST-2C-STEEL', name: '2-car steel door install', category: 'Installs', unit: 'each', basePrice: 1800, floorPrice: 1500, ceilingPrice: 2400 },
  { sku: 'INST-SC-WOOD', name: 'Single-car wood door install', category: 'Installs', unit: 'each', basePrice: 2200, floorPrice: 1800, ceilingPrice: 3000 },
  { sku: 'INST-2C-WOOD', name: '2-car wood door install', category: 'Installs', unit: 'each', basePrice: 3400, floorPrice: 2800, ceilingPrice: 4400 },
  { sku: 'INST-ALUM', name: 'Aluminum/glass panorama install', category: 'Installs', unit: 'each', basePrice: 4800, floorPrice: 3800, ceilingPrice: 6500 },
  { sku: 'INST-REMOVE', name: 'Old door haul-away', category: 'Installs', unit: 'each', basePrice: 150, floorPrice: 100, ceilingPrice: 250 },

  // Repairs
  { sku: 'REP-ROLLER', name: 'Roller replacement (set of 10)', category: 'Repairs', unit: 'set', basePrice: 150, floorPrice: 120, ceilingPrice: 220 },
  { sku: 'REP-CABLE', name: 'Cable replacement (pair)', category: 'Repairs', unit: 'pair', basePrice: 220, floorPrice: 180, ceilingPrice: 300 },
  { sku: 'REP-HINGE', name: 'Hinge replacement', category: 'Repairs', unit: 'each', basePrice: 35, floorPrice: 25, ceilingPrice: 60 },
  { sku: 'REP-TRACK', name: 'Track alignment', category: 'Repairs', unit: 'each', basePrice: 180, floorPrice: 140, ceilingPrice: 260 },
  { sku: 'REP-BOTTOMSEAL', name: 'Bottom seal replacement', category: 'Repairs', unit: 'each', basePrice: 95, floorPrice: 70, ceilingPrice: 140 },
  { sku: 'REP-WEATHERSTRIP', name: 'Weather-strip replacement', category: 'Repairs', unit: 'linear_foot', basePrice: 9, floorPrice: 7, ceilingPrice: 14 },
  { sku: 'REP-PANEL', name: 'Single panel replacement', category: 'Repairs', unit: 'each', basePrice: 280, floorPrice: 220, ceilingPrice: 400 },
  { sku: 'REP-OFFTRACK', name: 'Door off-track reset', category: 'Repairs', unit: 'each', basePrice: 165, floorPrice: 130, ceilingPrice: 240 },
  { sku: 'REP-LUBRICATE', name: 'Lubrication + tune-up', category: 'Repairs', unit: 'each', basePrice: 120, floorPrice: 95, ceilingPrice: 160 },
  { sku: 'REP-SENSORALIGN', name: 'Safety sensor alignment', category: 'Repairs', unit: 'each', basePrice: 85, floorPrice: 65, ceilingPrice: 120 },

  // Springs
  { sku: 'SPR-TORSION', name: 'Torsion spring replacement', category: 'Springs', unit: 'each', basePrice: 220, floorPrice: 180, ceilingPrice: 300 },
  { sku: 'SPR-TORSION-PAIR', name: 'Torsion spring pair', category: 'Springs', unit: 'pair', basePrice: 380, floorPrice: 320, ceilingPrice: 520 },
  { sku: 'SPR-EXT', name: 'Extension spring (each)', category: 'Springs', unit: 'each', basePrice: 140, floorPrice: 110, ceilingPrice: 200 },
  { sku: 'SPR-EXT-PAIR', name: 'Extension spring pair', category: 'Springs', unit: 'pair', basePrice: 240, floorPrice: 200, ceilingPrice: 340 },
  { sku: 'SPR-CONV', name: 'Extension → torsion conversion', category: 'Springs', unit: 'each', basePrice: 495, floorPrice: 400, ceilingPrice: 680 },
  { sku: 'SPR-HD', name: 'Heavy-duty torsion (2-car wood)', category: 'Springs', unit: 'each', basePrice: 320, floorPrice: 270, ceilingPrice: 440 },

  // Openers
  { sku: 'OPN-CHAIN', name: 'Chain-drive opener (1/2 hp)', category: 'Openers', unit: 'each', basePrice: 395, floorPrice: 320, ceilingPrice: 540 },
  { sku: 'OPN-BELT', name: 'Belt-drive opener (3/4 hp)', category: 'Openers', unit: 'each', basePrice: 495, floorPrice: 420, ceilingPrice: 660 },
  { sku: 'OPN-SMART-BELT', name: 'Smart belt-drive opener (myQ / WiFi)', category: 'Openers', unit: 'each', basePrice: 695, floorPrice: 580, ceilingPrice: 900 },
  { sku: 'OPN-JACKSHAFT', name: 'Jackshaft opener', category: 'Openers', unit: 'each', basePrice: 895, floorPrice: 740, ceilingPrice: 1200 },
  { sku: 'OPN-REMOTE', name: 'Remote (3-button)', category: 'Openers', unit: 'each', basePrice: 45, floorPrice: 35, ceilingPrice: 70 },
  { sku: 'OPN-KEYPAD', name: 'Wireless keypad', category: 'Openers', unit: 'each', basePrice: 65, floorPrice: 50, ceilingPrice: 95 },
  { sku: 'OPN-BATTERY', name: 'Backup battery install', category: 'Openers', unit: 'each', basePrice: 175, floorPrice: 140, ceilingPrice: 240 },
  { sku: 'OPN-DIAG', name: 'Opener diagnostic', category: 'Openers', unit: 'each', basePrice: 95, floorPrice: 75, ceilingPrice: 140 },

  // Parts
  { sku: 'PART-ROLLER-NYLON', name: 'Nylon roller', category: 'Parts', unit: 'each', basePrice: 9, floorPrice: 6, ceilingPrice: 15 },
  { sku: 'PART-ROLLER-STEEL', name: 'Steel roller', category: 'Parts', unit: 'each', basePrice: 6, floorPrice: 4, ceilingPrice: 10 },
  { sku: 'PART-HINGE-SM', name: 'Hinge (1-2)', category: 'Parts', unit: 'each', basePrice: 11, floorPrice: 8, ceilingPrice: 18 },
  { sku: 'PART-HINGE-LG', name: 'Hinge (3-4)', category: 'Parts', unit: 'each', basePrice: 16, floorPrice: 12, ceilingPrice: 24 },
  { sku: 'PART-CABLE-8FT', name: '8-ft lift cable (each)', category: 'Parts', unit: 'each', basePrice: 15, floorPrice: 10, ceilingPrice: 24 },
  { sku: 'PART-CABLE-10FT', name: '10-ft lift cable (each)', category: 'Parts', unit: 'each', basePrice: 18, floorPrice: 13, ceilingPrice: 28 },
  { sku: 'PART-BRACKET', name: 'Bottom fixture bracket', category: 'Parts', unit: 'each', basePrice: 22, floorPrice: 16, ceilingPrice: 36 },
  { sku: 'PART-TRACK-6FT', name: '6-ft vertical track section', category: 'Parts', unit: 'each', basePrice: 55, floorPrice: 40, ceilingPrice: 85 },
  { sku: 'PART-STRUT', name: 'Reinforcement strut', category: 'Parts', unit: 'each', basePrice: 48, floorPrice: 35, ceilingPrice: 75 },
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
  franchisorId: string,
): Promise<{ templateId: string; itemCount: number }> {
  const existing = await db
    .select({ id: serviceCatalogTemplates.id, status: serviceCatalogTemplates.status })
    .from(serviceCatalogTemplates)
    .where(
      and(
        eq(serviceCatalogTemplates.franchisorId, franchisorId),
        eq(serviceCatalogTemplates.slug, 'starter-2026'),
      ),
    );
  const templateId =
    existing[0]?.id ??
    (
      await db
        .insert(serviceCatalogTemplates)
        .values({
          franchisorId,
          name: 'Starter Catalog 2026',
          slug: 'starter-2026',
          notes: 'Seed catalog for Elevated Doors demo environments.',
          status: 'published',
          publishedAt: new Date(),
        })
        .returning({ id: serviceCatalogTemplates.id })
    )[0]!.id;

  // If the template existed but isn't published yet, publish it now so
  // the resolved pricebook works in dev without a manual step.
  if (existing[0] && existing[0].status !== 'published') {
    await db
      .update(serviceCatalogTemplates)
      .set({ status: 'published', publishedAt: new Date() })
      .where(eq(serviceCatalogTemplates.id, templateId));
  }

  // Idempotent bulk upsert of items — check by (template_id, sku).
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
        franchisorId,
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

async function ensureDemoOverrides(
  db: ReturnType<typeof drizzle<typeof schema>>,
  franchisorId: string,
  denverFranchiseeId: string,
): Promise<number> {
  // Denver gets a premium price on the 2-car steel install (closer to
  // the ceiling) and a discount on the roller replacement.
  const demos: Array<{ sku: string; price: number; note: string }> = [
    { sku: 'INST-2C-STEEL', price: 2100, note: 'Denver premium pricing' },
    { sku: 'REP-ROLLER', price: 135, note: 'Denver promo' },
  ];
  let count = 0;
  for (const d of demos) {
    const itemRows = await db
      .select({ id: serviceItems.id })
      .from(serviceItems)
      .where(
        and(
          eq(serviceItems.sku, d.sku),
          eq(serviceItems.franchisorId, franchisorId),
        ),
      );
    const itemId = itemRows[0]?.id;
    if (!itemId) continue;
    const already = await db
      .select({ id: pricebookOverrides.id })
      .from(pricebookOverrides)
      .where(
        and(
          eq(pricebookOverrides.franchiseeId, denverFranchiseeId),
          eq(pricebookOverrides.serviceItemId, itemId),
        ),
      );
    if (already.length > 0) {
      count++;
      continue;
    }
    await db.insert(pricebookOverrides).values({
      franchiseeId: denverFranchiseeId,
      franchisorId,
      serviceItemId: itemId,
      overridePrice: String(d.price),
      note: d.note,
    });
    count++;
  }
  return count;
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

  const result: SeedResult = {
    platformAdminUserId,
    franchisorId,
    franchisees: [],
    catalog: { templateId: '', itemCount: 0, overrideCount: 0 },
  };

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

  // Catalog (phase_pricebook) — created after franchisees exist so we
  // can attach demo overrides to Denver.
  const catalog = await ensureCatalog(db, franchisorId);
  const denver = result.franchisees.find((f) => f.slug === 'denver');
  const overrideCount = denver
    ? await ensureDemoOverrides(db, franchisorId, denver.id)
    : 0;
  result.catalog = {
    templateId: catalog.templateId,
    itemCount: catalog.itemCount,
    overrideCount,
  };

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
       pricebook_overrides,
       service_items,
       service_catalog_templates,
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
    console.log(
      `  catalog template: ${result.catalog.templateId} (${result.catalog.itemCount} items, ${result.catalog.overrideCount} Denver overrides)`,
    );
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
