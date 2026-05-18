/**
 * Drizzle ORM schema for @service-ai/db.
 *
 * Organised in three layers:
 *   1. Infra (health_checks) — foundation phase
 *   2. Auth (users, sessions, accounts, verifications) — Better Auth tables
 *   3. Tenancy (corporate, branches, locations, memberships, audit_log)
 *
 * Tenant-scoped tables carry branch_id (and location_id where applicable)
 * plus created_at / updated_at. RLS is ENABLED on every tenant-scoped table by
 * migration 0016; the policy template is two roles per table
 * (`_corporate_admin` + `_scoped`) keyed off `app.role` and `app.branch_id`
 * GUCs set by `withScope`.
 */
import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  numeric,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Infra
// ---------------------------------------------------------------------------

export const healthChecks = pgTable('health_checks', {
  id: uuid('id').defaultRandom().primaryKey(),
  service: varchar('service', { length: 100 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Auth (Better Auth core tables)
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    name: text('name'),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    phone: text('phone'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    phoneUnique: uniqueIndex('users_phone_unique')
      .on(t.phone)
      .where(sql`${t.phone} IS NOT NULL`),
  }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId),
    expiresIdx: index('sessions_expires_idx').on(t.expiresAt),
  }),
);

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('accounts_user_idx').on(t.userId),
    providerAccountIdx: uniqueIndex('accounts_provider_account_idx').on(
      t.providerId,
      t.accountId,
    ),
  }),
);

export const verifications = pgTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    identifierIdx: index('verifications_identifier_idx').on(t.identifier),
    expiresIdx: index('verifications_expires_idx').on(t.expiresAt),
  }),
);

// ---------------------------------------------------------------------------
// Tenancy (corporate hub-and-spoke — migration 0016)
//
// The franchisor/franchisee model was replaced by a single corporate hub
// plus N branches. The pgEnum values below match the post-CHR-01 DB state:
// `platform_admin` and `location_manager` are legacy values that remain in
// the SQL enum (Postgres cannot drop enum values) and may appear in
// not-yet-re-seeded rows. The application never WRITES them; the
// MembershipResolver promotes any legacy row it reads to its corporate-hub
// equivalent (see apps/api/src/request-scope.ts#resolveScope).
// ---------------------------------------------------------------------------

export const scopeType = pgEnum('scope_type', [
  'platform',
  'corporate',
  'branch',
  'location',
]);

export const role = pgEnum('role', [
  'platform_admin',
  'corporate_admin',
  'manager',
  'location_manager',
  'dispatcher',
  'tech',
  'csr',
]);

// New corporate hub-and-spoke tables (migration 0016).
//
// `corporate` is a singleton: exactly one row identifies the platform
// operator (Elevated Doors HQ in production). Branches are children;
// every tenant-scoped business table carries branch_id directly.

export const corporate = pgTable('corporate', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  legalEntityName: text('legal_entity_name'),
  timezone: text('timezone').notNull().default('America/Edmonton'),
  currencyCode: varchar('currency_code', { length: 3 }).notNull().default('CAD'),
  brandAssets: jsonb('brand_assets').notNull().default(sql`'{}'::jsonb`),
  brandVoice: jsonb('brand_voice').notNull().default(sql`'{}'::jsonb`),
  defaultMarginPct: numeric('default_margin_pct', { precision: 6, scale: 2 })
    .notNull()
    .default('60.00'),
  minMarginPct: numeric('min_margin_pct', { precision: 6, scale: 2 })
    .notNull()
    .default('20.00'),
  maxMarginPct: numeric('max_margin_pct', { precision: 6, scale: 2 })
    .notNull()
    .default('200.00'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const branches = pgTable(
  'branches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    corporateId: uuid('corporate_id')
      .notNull()
      .references(() => corporate.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    legalEntityName: text('legal_entity_name'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    region: text('region'),
    postalCode: text('postal_code'),
    countryCode: varchar('country_code', { length: 2 }),
    timezone: text('timezone').notNull().default('America/Edmonton'),
    phoneNumber: text('phone_number'),
    twilioPhoneNumber: text('twilio_phone_number'),
    twilioPhoneSid: text('twilio_phone_sid'),
    stripeAccountId: text('stripe_account_id'),
    brandVoice: jsonb('brand_voice').notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    corporateIdx: index('branches_corporate_idx').on(t.corporateId),
    slugUnique: uniqueIndex('branches_slug_unique').on(t.slug),
  }),
);

export const locations = pgTable(
  'locations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    timezone: text('timezone').notNull().default('America/Denver'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    branchIdx: index('locations_branch_idx').on(t.branchId),
  }),
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scopeType: scopeType('scope_type').notNull(),
    scopeId: uuid('scope_id'),
    role: role('role').notNull(),
    branchId: uuid('branch_id').references(() => branches.id, {
      onDelete: 'cascade',
    }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    /**
     * Optional dollar/hour rate for techs. Used by the owner
     * dashboard's profit projector. NULL = "not modeled" and the
     * projector treats labor cost as 0 for that tech.
     */
    hourlyRate: numeric('hourly_rate_cents', { precision: 12, scale: 2 }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('memberships_user_idx').on(t.userId),
    scopeIdx: index('memberships_scope_idx').on(t.scopeType, t.scopeId),
    branchIdx: index('memberships_branch_idx').on(t.branchId),
    locationIdx: index('memberships_location_idx').on(t.locationId),
    uniqueActive: uniqueIndex('memberships_unique_active')
      .on(t.userId, t.scopeType, t.scopeId)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    targetBranchId: uuid('target_branch_id').references(() => branches.id, {
      onDelete: 'set null',
    }),
    action: text('action').notNull(),
    scopeType: scopeType('scope_type'),
    scopeId: uuid('scope_id'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    actorIdx: index('audit_log_actor_idx').on(t.actorUserId),
    branchIdx: index('audit_log_branch_idx').on(t.targetBranchId),
    actionIdx: index('audit_log_action_idx').on(t.action),
    createdIdx: index('audit_log_created_idx').on(t.createdAt),
  }),
);

/**
 * Pending / redeemed / revoked user invitations.
 *
 * Only the SHA-256 hash of the token is stored. The raw token lives only in
 * the invite link emailed to the recipient; if the DB leaks, pending
 * invites still cannot be redeemed. scopeType + scopeId identify where the
 * membership will land (corporate / branch). Under the corporate hub
 * model the franchisor parent collapses to the single corporate row, so no
 * top-level scope id is stored on the invite.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    email: text('email').notNull(),
    role: role('role').notNull(),
    scopeType: scopeType('scope_type').notNull(),
    branchId: uuid('branch_id').references(() => branches.id, {
      onDelete: 'cascade',
    }),
    locationId: uuid('location_id').references(() => locations.id, {
      onDelete: 'set null',
    }),
    inviterUserId: text('inviter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    redeemedUserId: text('redeemed_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    emailIdx: index('invitations_email_idx').on(t.email),
    expiresIdx: index('invitations_expires_idx').on(t.expiresAt),
    branchIdx: index('invitations_branch_idx').on(t.branchId),
    locationIdx: index('invitations_location_idx').on(t.locationId),
    inviterIdx: index('invitations_inviter_idx').on(t.inviterUserId),
  }),
);

// ---------------------------------------------------------------------------
// Customer / job model (phase_customer_job)
// ---------------------------------------------------------------------------

/**
 * Job lifecycle states. Terminal states: completed, canceled. Valid
 * transitions are enforced at the API layer in
 * apps/api/src/jobs-routes.ts#canTransition — not a DB CHECK because
 * the matrix includes "unschedule" (scheduled → unassigned) which would
 * need procedural trigger logic the app already owns. The enum
 * constrains the column to a known set; the app constrains which
 * moves between them are legal.
 */
export const jobStatus = pgEnum('job_status', [
  'unassigned',
  'scheduled',
  'en_route',
  'arrived',
  'in_progress',
  'completed',
  'canceled',
]);

/**
 * Tenant customers. Soft-delete via deleted_at so we preserve job
 * history references. Address is denormalised from Google Places —
 * place_id lets us re-fetch the canonical record if needed.
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').references(() => locations.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    country: text('country'),
    placeId: text('place_id'),
    latitude: numeric('latitude', { precision: 10, scale: 7 }),
    longitude: numeric('longitude', { precision: 10, scale: 7 }),
    notes: text('notes'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    branchIdx: index('customers_branch_idx').on(t.branchId),
    locationIdx: index('customers_location_idx').on(t.locationId),
    emailIdx: index('customers_email_idx').on(t.email),
    phoneIdx: index('customers_phone_idx').on(t.phone),
    placeIdx: index('customers_place_idx').on(t.placeId),
  }),
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').references(() => locations.id, {
      onDelete: 'set null',
    }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    status: jobStatus('status').notNull().default('unassigned'),
    title: text('title').notNull(),
    description: text('description'),
    scheduledStart: timestamp('scheduled_start', { withTimezone: true }),
    scheduledEnd: timestamp('scheduled_end', { withTimezone: true }),
    actualStart: timestamp('actual_start', { withTimezone: true }),
    actualEnd: timestamp('actual_end', { withTimezone: true }),
    assignedTechUserId: text('assigned_tech_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    branchIdx: index('jobs_branch_idx').on(t.branchId),
    locationIdx: index('jobs_location_idx').on(t.locationId),
    customerIdx: index('jobs_customer_idx').on(t.customerId),
    statusIdx: index('jobs_status_idx').on(t.status),
    scheduledStartIdx: index('jobs_scheduled_start_idx').on(t.scheduledStart),
    assignedTechIdx: index('jobs_assigned_tech_idx').on(t.assignedTechUserId),
  }),
);

/**
 * Append-only log of job state changes. Every row represents one
 * validated transition. The job's current status is the to_status of
 * the newest row (denormalised on jobs.status for query convenience).
 */
export const jobStatusLog = pgTable(
  'job_status_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    // Denormalised branch_id so RLS policies match with a single
    // column predicate (no join through jobs).
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    fromStatus: jobStatus('from_status'),
    toStatus: jobStatus('to_status').notNull(),
    actorUserId: text('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    jobIdx: index('job_status_log_job_idx').on(t.jobId),
    branchIdx: index('job_status_log_branch_idx').on(t.branchId),
    createdIdx: index('job_status_log_created_idx').on(t.createdAt),
  }),
);

/**
 * Photos attached to a job. The actual bytes live in DO Spaces; this
 * row records the storage key + metadata. Deleting the row does NOT
 * delete the object — storage cleanup is a v2 concern per TECH_DEBT.
 */
export const jobPhotos = pgTable(
  'job_photos',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    // Denormalised for RLS (same reason as job_status_log).
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes'),
    label: varchar('label', { length: 50 }),
    uploadedByUserId: text('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    jobIdx: index('job_photos_job_idx').on(t.jobId),
    branchIdx: index('job_photos_branch_idx').on(t.branchId),
    storageKeyIdx: uniqueIndex('job_photos_storage_key_unique').on(t.storageKey),
  }),
);

// ---------------------------------------------------------------------------
// Pricebook model (phase_pricebook)
// ---------------------------------------------------------------------------

export const catalogStatus = pgEnum('catalog_status', [
  'draft',
  'published',
  'archived',
]);

/**
 * Corporate-authored service catalog. One currently-published template
 * for the corporate hub is the gate-level invariant — the publish handler
 * atomically archives the previous published template so branches
 * always see a single authoritative catalog.
 */
export const serviceCatalogTemplates = pgTable(
  'service_catalog_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    status: catalogStatus('status').notNull().default('draft'),
    notes: text('notes'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    statusIdx: index('service_catalog_templates_status_idx').on(t.status),
    slugUnique: uniqueIndex('service_catalog_templates_slug_unique').on(t.slug),
  }),
);

export const serviceItems = pgTable(
  'service_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => serviceCatalogTemplates.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    category: text('category').notNull(),
    unit: text('unit').notNull(),
    basePrice: numeric('base_price', { precision: 12, scale: 2 }).notNull(),
    floorPrice: numeric('floor_price', { precision: 12, scale: 2 }),
    /**
     * Cost of goods sold per unit. Optional — NULL means
     * "unknown / not modeled" and the profit projector treats
     * line-items selling this SKU as zero materials cost.
     */
    cogsPrice: numeric('cogs_price', { precision: 12, scale: 2 }),
    ceilingPrice: numeric('ceiling_price', { precision: 12, scale: 2 }),
    sortOrder: integer('sort_order').notNull().default(0),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    templateIdx: index('service_items_template_idx').on(t.templateId),
    categoryIdx: index('service_items_category_idx').on(t.category),
    skuUnique: uniqueIndex('service_items_template_sku_unique').on(t.templateId, t.sku),
  }),
);

// ---------------------------------------------------------------------------
// Invoices (phase_tech_mobile_pwa draft scope; finalize/pay in phase 7)
// ---------------------------------------------------------------------------

export const invoiceStatus = pgEnum('invoice_status', [
  'draft',
  'finalized',
  'sent',
  'paid',
  'void',
]);

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    status: invoiceStatus('status').notNull().default('draft'),
    subtotal: numeric('subtotal', { precision: 12, scale: 2 }).notNull().default('0'),
    taxRate: numeric('tax_rate', { precision: 6, scale: 4 }).notNull().default('0'),
    taxAmount: numeric('tax_amount', { precision: 12, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 12, scale: 2 }).notNull().default('0'),
    // Legacy: populated by the Stripe Connect / royalty engine pre-CHR-08.
    // The corporate-hub model never writes this column; it stays zero.
    // Kept in schema because the DB column still exists (CHR-08 was a
    // code-only deletion; the migration is deferred).
    applicationFeeAmount: numeric('application_fee_amount', {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default('0'),
    notes: text('notes'),
    // Payment wiring (phase_invoicing_stripe). Both fields are
    // populated at finalize; before that they are NULL.
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    paymentLinkToken: text('payment_link_token'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    dueDate: timestamp('due_date', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    branchIdx: index('invoices_branch_idx').on(t.branchId),
    jobIdx: index('invoices_job_idx').on(t.jobId),
    customerIdx: index('invoices_customer_idx').on(t.customerId),
    statusIdx: index('invoices_status_idx').on(t.status),
    paymentIntentUnique: uniqueIndex('invoices_stripe_payment_intent_unique')
      .on(t.stripePaymentIntentId)
      .where(sql`${t.stripePaymentIntentId} IS NOT NULL`),
    paymentLinkTokenUnique: uniqueIndex('invoices_payment_link_token_unique')
      .on(t.paymentLinkToken)
      .where(sql`${t.paymentLinkToken} IS NOT NULL`),
  }),
);

export const invoiceLineItems = pgTable(
  'invoice_line_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    serviceItemId: uuid('service_item_id').references(() => serviceItems.id, {
      onDelete: 'set null',
    }),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
    lineTotal: numeric('line_total', { precision: 12, scale: 2 }).notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    invoiceIdx: index('invoice_line_items_invoice_idx').on(t.invoiceId),
    branchIdx: index('invoice_line_items_branch_idx').on(t.branchId),
  }),
);

// ---------------------------------------------------------------------------
// Payments + refunds + Stripe webhook idempotency (phase_invoicing_stripe)
// ---------------------------------------------------------------------------

/**
 * A payment row is created by the Stripe webhook handler when
 * payment_intent.succeeded fires. `stripeChargeId` is unique so
 * webhook replays are idempotent — the row either exists already
 * or is inserted; never both.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    stripePaymentIntentId: text('stripe_payment_intent_id').notNull(),
    stripeChargeId: text('stripe_charge_id').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    // Legacy: populated by the Stripe Connect / royalty engine pre-CHR-08.
    // The single-account corporate-hub webhook never writes this column;
    // it stays zero. Column kept because the underlying DB column still
    // exists (CHR-08 was code-only; the migration is deferred).
    applicationFeeAmount: numeric('application_fee_amount', {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default('0'),
    currency: text('currency').notNull().default('usd'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    branchIdx: index('payments_branch_idx').on(t.branchId),
    invoiceIdx: index('payments_invoice_idx').on(t.invoiceId),
    chargeUnique: uniqueIndex('payments_charge_unique').on(t.stripeChargeId),
  }),
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    paymentId: uuid('payment_id').references(() => payments.id, {
      onDelete: 'set null',
    }),
    stripeRefundId: text('stripe_refund_id').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    reason: text('reason'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    branchIdx: index('refunds_branch_idx').on(t.branchId),
    invoiceIdx: index('refunds_invoice_idx').on(t.invoiceId),
    refundUnique: uniqueIndex('refunds_stripe_refund_unique').on(t.stripeRefundId),
  }),
);

/**
 * Webhook idempotency. The handler inserts the Stripe `event.id`
 * before processing; a duplicate insert (unique violation) short-
 * circuits the handler to a 200 without re-running the side
 * effects. Deliberately NOT tenant-scoped — the webhook callback
 * runs before any branch has been resolved from the event.
 */
export const stripeEvents = pgTable(
  'stripe_events',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    typeIdx: index('stripe_events_type_idx').on(t.type),
  }),
);

// ---------------------------------------------------------------------------
// AI collections (phase_ai_collections)
// ---------------------------------------------------------------------------

export const collectionsTone = pgEnum('collections_tone', [
  'friendly',
  'firm',
  'final',
]);

export const collectionsDraftStatus = pgEnum('collections_draft_status', [
  'pending',
  'approved',
  'edited',
  'rejected',
  'sent',
  'failed',
]);

export const paymentRetryStatus = pgEnum('payment_retry_status', [
  'scheduled',
  'succeeded',
  'failed',
  'canceled',
]);

export const collectionsDrafts = pgTable(
  'collections_drafts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id'),
    tone: collectionsTone('tone').notNull(),
    smsBody: text('sms_body').notNull(),
    emailSubject: text('email_subject').notNull(),
    emailBody: text('email_body').notNull(),
    status: collectionsDraftStatus('status').notNull().default('pending'),
    deliveryChannels: jsonb('delivery_channels')
      .notNull()
      .default(sql`'{"email": true, "sms": true}'::jsonb`),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByUserId: text('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    branchIdx: index('collections_drafts_branch_idx').on(t.branchId),
    invoiceIdx: index('collections_drafts_invoice_idx').on(t.invoiceId),
    statusIdx: index('collections_drafts_status_idx').on(t.status),
    pendingUnique: uniqueIndex('collections_drafts_pending_unique')
      .on(t.invoiceId, t.tone)
      .where(sql`${t.status} = 'pending'`),
  }),
);

export const paymentRetries = pgTable(
  'payment_retries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id').references(() => payments.id, {
      onDelete: 'set null',
    }),
    failureCode: text('failure_code').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    status: paymentRetryStatus('status').notNull().default('scheduled'),
    attemptIndex: integer('attempt_index').notNull().default(1),
    resultRef: jsonb('result_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    branchIdx: index('payment_retries_branch_idx').on(t.branchId),
    invoiceIdx: index('payment_retries_invoice_idx').on(t.invoiceId),
    statusIdx: index('payment_retries_status_idx').on(t.status),
  }),
);

// ---------------------------------------------------------------------------
// AI tech assistant (phase_ai_tech_assistant)
// ---------------------------------------------------------------------------

export const aiFeedbackKind = pgEnum('ai_feedback_kind', ['accept', 'override']);
export const aiFeedbackSubjectKind = pgEnum('ai_feedback_subject_kind', [
  'photo_quote_item',
  'notes_invoice_draft',
  'dispatcher_assignment',
]);

/**
 * kb_docs is corporate-scoped (the franchisor_id column was dropped in
 * migration 0016). Embeddings are jsonb arrays — phase 11 computes
 * cosine similarity in JS at the ≤200-doc scale; a pgvector migration
 * is deferred until the corpus grows past the in-memory threshold.
 */
export const kbDocs = pgTable(
  'kb_docs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    source: text('source').notNull(),
    embedding: jsonb('embedding').notNull(),
    tags: jsonb('tags').notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    sourceUnique: uniqueIndex('kb_docs_source_unique').on(t.source),
  }),
);

export const aiFeedback = pgTable(
  'ai_feedback',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id'),
    kind: aiFeedbackKind('kind').notNull(),
    subjectKind: aiFeedbackSubjectKind('subject_kind').notNull(),
    subjectRef: jsonb('subject_ref').notNull(),
    actorUserId: text('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    branchIdx: index('ai_feedback_branch_idx').on(t.branchId),
    kindIdx: index('ai_feedback_kind_idx').on(t.kind),
    subjectIdx: index('ai_feedback_subject_kind_idx').on(t.subjectKind),
  }),
);

// ---------------------------------------------------------------------------
// AI dispatcher (phase_ai_dispatcher)
// ---------------------------------------------------------------------------

export const aiSuggestionKind = pgEnum('ai_suggestion_kind', ['assignment']);
export const aiSuggestionStatus = pgEnum('ai_suggestion_status', [
  'pending',
  'approved',
  'rejected',
  'applied',
  'expired',
]);

export const aiSuggestions = pgTable(
  'ai_suggestions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id'),
    kind: aiSuggestionKind('kind').notNull(),
    subjectJobId: uuid('subject_job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    proposedTechUserId: text('proposed_tech_user_id').references(
      () => users.id,
      { onDelete: 'set null' },
    ),
    proposedScheduledStart: timestamp('proposed_scheduled_start', {
      withTimezone: true,
    }),
    proposedScheduledEnd: timestamp('proposed_scheduled_end', {
      withTimezone: true,
    }),
    reasoning: text('reasoning').notNull(),
    confidence: numeric('confidence', { precision: 5, scale: 4 }).notNull(),
    status: aiSuggestionStatus('status').notNull().default('pending'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByUserId: text('decided_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    branchIdx: index('ai_suggestions_branch_idx').on(t.branchId),
    jobIdx: index('ai_suggestions_job_idx').on(t.subjectJobId),
    statusIdx: index('ai_suggestions_status_idx').on(t.status),
  }),
);

export const aiMetrics = pgTable(
  'ai_metrics',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    date: timestamp('date', { withTimezone: true }).notNull(),
    suggestionsTotal: integer('suggestions_total').notNull().default(0),
    autoApplied: integer('auto_applied').notNull().default(0),
    queued: integer('queued').notNull().default(0),
    approved: integer('approved').notNull().default(0),
    rejected: integer('rejected').notNull().default(0),
    overrideRate: numeric('override_rate', { precision: 5, scale: 4 })
      .notNull()
      .default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniqDay: uniqueIndex('ai_metrics_franchisee_date_unique').on(
      t.branchId,
      t.date,
    ),
  }),
);

export const techSkills = pgTable(
  'tech_skills',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    skill: text('skill').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: uniqueIndex('tech_skills_pk').on(t.userId, t.branchId, t.skill),
    branchIdx: index('tech_skills_branch_idx').on(t.branchId),
  }),
);

// ---------------------------------------------------------------------------
// AI CSR voice (phase_ai_csr_voice)
// ---------------------------------------------------------------------------

export const aiCapability = pgEnum('ai_capability', [
  'csr.voice',
  'dispatcher',
  'tech.photoQuote',
  'collections',
]);

export const aiMessageRole = pgEnum('ai_message_role', [
  'system',
  'user',
  'assistant',
  'tool',
]);

export const callDirection = pgEnum('call_direction', ['inbound', 'outbound']);
export const callStatus = pgEnum('call_status', [
  'ringing',
  'in_progress',
  'completed',
  'transferred',
  'failed',
]);
export const callOutcome = pgEnum('call_outcome', [
  'booked',
  'transferred',
  'abandoned',
  'none',
]);

export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    capability: aiCapability('capability').notNull(),
    subjectCustomerId: uuid('subject_customer_id').references(
      () => customers.id,
      { onDelete: 'set null' },
    ),
    subjectJobId: uuid('subject_job_id').references(() => jobs.id, {
      onDelete: 'set null',
    }),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    branchIdx: index('ai_conversations_branch_idx').on(t.branchId),
    capabilityIdx: index('ai_conversations_capability_idx').on(t.capability),
  }),
);

export const aiMessages = pgTable(
  'ai_messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    role: aiMessageRole('role').notNull(),
    content: jsonb('content').notNull(),
    toolName: text('tool_name'),
    toolInput: jsonb('tool_input'),
    toolOutput: jsonb('tool_output'),
    confidence: numeric('confidence', { precision: 5, scale: 4 }),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    provider: text('provider'),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    conversationIdx: index('ai_messages_conversation_idx').on(t.conversationId),
    branchIdx: index('ai_messages_branch_idx').on(t.branchId),
  }),
);

export const callSessions = pgTable(
  'call_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => aiConversations.id, {
      onDelete: 'set null',
    }),
    twilioCallSid: text('twilio_call_sid').notNull(),
    fromE164: text('from_e164').notNull(),
    toE164: text('to_e164').notNull(),
    direction: callDirection('direction').notNull().default('inbound'),
    status: callStatus('status').notNull().default('ringing'),
    outcome: callOutcome('outcome').notNull().default('none'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    recordingKey: text('recording_key'),
    transferReason: text('transfer_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    branchIdx: index('call_sessions_branch_idx').on(t.branchId),
    twilioUnique: uniqueIndex('call_sessions_twilio_sid_unique').on(t.twilioCallSid),
    statusIdx: index('call_sessions_status_idx').on(t.status),
  }),
);

// ---------------------------------------------------------------------------
// Web push subscriptions (phase_tech_mobile_pwa)
// ---------------------------------------------------------------------------

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Denormalised so corporate-scoped push sends can target a
    // branch without joining memberships.
    branchId: uuid('branch_id').references(() => branches.id, {
      onDelete: 'cascade',
    }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('push_subscriptions_user_idx').on(t.userId),
    endpointUnique: uniqueIndex('push_subscriptions_endpoint_unique')
      .on(t.endpoint)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

// ---------------------------------------------------------------------------
// Notifications log (phase 14 pass 2 — owner dashboard)
// ---------------------------------------------------------------------------

export const notificationChannel = pgEnum('notification_channel', [
  'email',
  'sms',
]);

export const notificationDirection = pgEnum('notification_direction', [
  'outbound',
  'inbound',
]);

/**
 * One row per outbound (and eventually inbound) email / SMS. The
 * senders in apps/api persist a row on every send so the owner
 * dashboard can show volume tiles and drill into a customer's
 * communication history without scanning provider APIs.
 */
export const notificationsLog = pgTable(
  'notifications_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    channel: notificationChannel('channel').notNull(),
    direction: notificationDirection('direction').notNull().default('outbound'),
    toAddress: text('to_address').notNull(),
    fromAddress: text('from_address'),
    subject: text('subject'),
    bodyPreview: text('body_preview'),
    providerRef: text('provider_ref'),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    invoiceId: uuid('invoice_id').references(() => invoices.id, {
      onDelete: 'set null',
    }),
    customerId: uuid('customer_id').references(() => customers.id, {
      onDelete: 'set null',
    }),
    relatedKind: text('related_kind'),
    status: text('status').notNull().default('sent'),
    errorMessage: text('error_message'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    branchIdx: index('notifications_log_branch_idx').on(t.branchId),
    channelIdx: index('notifications_log_channel_idx').on(
      t.branchId,
      t.channel,
    ),
    sentIdx: index('notifications_log_sent_idx').on(t.branchId, t.sentAt),
  }),
);

// ---------------------------------------------------------------------------
// Corporate hub-and-spoke supplementary tables (migration 0016).
//
// branch_managers, comp_plans, user_comp_assignments, commission_ledger,
// and pricebook_suggestions support the W2 commission model that replaced
// the franchise royalty engine.
// ---------------------------------------------------------------------------

export const branchManagers = pgTable(
  'branch_managers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    branchIdx: index('branch_managers_branch_idx').on(t.branchId),
    userIdx: index('branch_managers_user_idx').on(t.userId),
  }),
);

export const compPlans = pgTable(
  'comp_plans',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    baseSalaryCents: integer('base_salary_cents').notNull().default(0),
    payPeriod: text('pay_period').notNull().default('monthly'),
    commissionRules: jsonb('commission_rules').notNull(),
    effectiveFrom: timestamp('effective_from', { mode: 'date' }).notNull(),
    effectiveTo: timestamp('effective_to', { mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    effectiveIdx: index('comp_plans_effective_idx').on(t.effectiveFrom, t.effectiveTo),
  }),
);

export const userCompAssignments = pgTable(
  'user_comp_assignments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    compPlanId: uuid('comp_plan_id')
      .notNull()
      .references(() => compPlans.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    effectiveFrom: timestamp('effective_from', { mode: 'date' }).notNull(),
    effectiveTo: timestamp('effective_to', { mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('user_comp_user_idx').on(t.userId),
    planIdx: index('user_comp_plan_idx').on(t.compPlanId),
    branchIdx: index('user_comp_branch_idx').on(t.branchId),
  }),
);

export const commissionLedger = pgTable(
  'commission_ledger',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    sourceKind: text('source_kind').notNull(),
    sourceId: text('source_id').notNull(),
    amountCents: integer('amount_cents').notNull(),
    ruleSnapshot: jsonb('rule_snapshot').notNull(),
    periodLabel: text('period_label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('commission_ledger_user_idx').on(t.userId),
    branchIdx: index('commission_ledger_branch_idx').on(t.branchId),
    periodIdx: index('commission_ledger_period_idx').on(t.periodLabel),
    sourceUnique: uniqueIndex('commission_ledger_source_unique').on(
      t.userId,
      t.sourceKind,
      t.sourceId,
    ),
  }),
);

export const pricebookSuggestions = pgTable(
  'pricebook_suggestions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    serviceItemId: uuid('service_item_id')
      .notNull()
      .references(() => serviceItems.id, { onDelete: 'cascade' }),
    suggestedPriceCents: integer('suggested_price_cents').notNull(),
    reason: text('reason'),
    suggestedByUserId: text('suggested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('pending'),
    resolvedByUserId: text('resolved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionNote: text('resolution_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    branchIdx: index('pricebook_suggestions_branch_idx').on(t.branchId),
    statusIdx: index('pricebook_suggestions_status_idx').on(t.status),
  }),
);

// ---------------------------------------------------------------------------
// Supplier quote bridge (phase_supplier_quote_bridge / migration 0017).
//
// Provider abstraction + quote tables. `suppliers` is corporate-scoped
// (v1 has one row: BC AI Agent for the Elevated Doors BC customer).
// `margin_overrides` keys per BC `itemCategoryCode`; the SQB-07 margin
// engine resolves line override → category override →
// corporate.default_margin_pct.
// ---------------------------------------------------------------------------

export const supplierProviderKind = pgEnum('supplier_provider_kind', ['bc_ai_agent']);

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    providerKind: supplierProviderKind('provider_kind').notNull(),
    endpointUrl: text('endpoint_url').notNull(),
    apiKeySecretRef: text('api_key_secret_ref').notNull(),
    supplierAccountCode: text('supplier_account_code').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    providerIdx: index('suppliers_provider_idx').on(t.providerKind),
  }),
);

export const marginOverrides = pgTable(
  'margin_overrides',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    itemCategory: text('item_category').notNull(),
    marginPct: numeric('margin_pct', { precision: 6, scale: 2 }).notNull(),
    notes: text('notes'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    itemCategoryUnique: uniqueIndex('margin_overrides_item_category_unique').on(
      t.itemCategory,
    ),
  }),
);

export const quoteStatus = pgEnum('quote_status', [
  'draft',
  'priced',
  'committed',
  'accepted',
  'void',
]);

export const marginSource = pgEnum('margin_source', [
  'line_override',
  'category_override',
  'corporate_default',
]);

export const quotes = pgTable(
  'quotes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    status: quoteStatus('status').notNull().default('draft'),
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('CAD'),
    /** SQ-XXXXXX assigned by BC at commit. NULL until status >= committed. */
    supplierQuoteRef: text('supplier_quote_ref'),
    supplierQuoteId: text('supplier_quote_id'),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Whichever user clicked "Send to supplier" — drives commission credit. */
    closerUserId: text('closer_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    branchIdx: index('quotes_branch_idx').on(t.branchId),
    customerIdx: index('quotes_customer_idx').on(t.customerId),
    jobIdx: index('quotes_job_idx').on(t.jobId),
    statusIdx: index('quotes_status_idx').on(t.status),
    supplierIdx: index('quotes_supplier_idx').on(t.supplierId),
    supplierQuoteRefUnique: uniqueIndex('quotes_supplier_quote_ref_unique')
      .on(t.supplierQuoteRef)
      .where(sql`${t.supplierQuoteRef} IS NOT NULL`),
  }),
);

export const quoteLineItems = pgTable(
  'quote_line_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    quoteId: uuid('quote_id')
      .notNull()
      .references(() => quotes.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    supplierSku: text('supplier_sku').notNull(),
    description: text('description').notNull(),
    itemCategory: text('item_category'),
    quantity: numeric('quantity', { precision: 12, scale: 3 }).notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    lineTotalCents: integer('line_total_cents').notNull(),
    supplierUnitCostCents: integer('supplier_unit_cost_cents'),
    appliedMarginPct: numeric('applied_margin_pct', { precision: 6, scale: 2 }).notNull(),
    appliedMarginSource: marginSource('applied_margin_source').notNull(),
    /** Manager+ per-line discretion; null when default/category resolution wins. */
    marginOverridePct: numeric('margin_override_pct', { precision: 6, scale: 2 }),
    marginOverrideReason: text('margin_override_reason'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    quoteIdx: index('quote_line_items_quote_idx').on(t.quoteId),
    branchIdx: index('quote_line_items_branch_idx').on(t.branchId),
    positionUnique: uniqueIndex('quote_line_items_position_unique').on(
      t.quoteId,
      t.position,
    ),
  }),
);

export const quoteStatusLog = pgTable(
  'quote_status_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    quoteId: uuid('quote_id')
      .notNull()
      .references(() => quotes.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    fromStatus: quoteStatus('from_status'),
    toStatus: quoteStatus('to_status').notNull(),
    actorUserId: text('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reason: text('reason'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    quoteIdx: index('quote_status_log_quote_idx').on(t.quoteId),
    branchIdx: index('quote_status_log_branch_idx').on(t.branchId),
  }),
);
