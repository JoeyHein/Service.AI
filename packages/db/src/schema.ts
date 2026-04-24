/**
 * Drizzle ORM schema for @service-ai/db.
 *
 * Organised in three layers:
 *   1. Infra (health_checks) — foundation phase
 *   2. Auth (users, sessions, accounts, verifications) — Better Auth tables
 *   3. Tenancy (franchisors, franchisees, locations, memberships, audit_log)
 *
 * Tenant-scoped tables carry franchisee_id (and location_id where applicable)
 * plus created_at / updated_at. RLS is ENABLED on every tenant-scoped table by
 * the corresponding migration; policies themselves are introduced in TASK-TEN-03
 * once RequestScope/GUC wiring is in place.
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
// Tenancy
// ---------------------------------------------------------------------------

export const scopeType = pgEnum('scope_type', [
  'platform',
  'franchisor',
  'franchisee',
  'location',
]);

export const role = pgEnum('role', [
  'platform_admin',
  'franchisor_admin',
  'franchisee_owner',
  'location_manager',
  'dispatcher',
  'tech',
  'csr',
]);

export const franchisors = pgTable('franchisors', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  brandConfig: jsonb('brand_config').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const franchisees = pgTable(
  'franchisees',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    franchisorId: uuid('franchisor_id')
      .notNull()
      .references(() => franchisors.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    legalEntityName: text('legal_entity_name'),
    // Stripe Connect fields (phase_invoicing_stripe, migration 0008).
    // stripeAccountId is the acct_* id; the three boolean columns
    // mirror the Stripe `Account` object's readiness flags and are
    // kept in sync by the account.updated webhook.
    stripeAccountId: text('stripe_account_id'),
    stripeChargesEnabled: boolean('stripe_charges_enabled').notNull().default(false),
    stripePayoutsEnabled: boolean('stripe_payouts_enabled').notNull().default(false),
    stripeDetailsSubmitted: boolean('stripe_details_submitted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    franchisorIdx: index('franchisees_franchisor_idx').on(t.franchisorId),
    slugUnique: uniqueIndex('franchisees_franchisor_slug_unique').on(
      t.franchisorId,
      t.slug,
    ),
    stripeAccountUnique: uniqueIndex('franchisees_stripe_account_unique')
      .on(t.stripeAccountId)
      .where(sql`${t.stripeAccountId} IS NOT NULL`),
  }),
);

export const locations = pgTable(
  'locations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    franchiseeId: uuid('franchisee_id')
      .notNull()
      .references(() => franchisees.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    timezone: text('timezone').notNull().default('America/Denver'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    franchiseeIdx: index('locations_franchisee_idx').on(t.franchiseeId),
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
    franchiseeId: uuid('franchisee_id').references(() => franchisees.id, {
      onDelete: 'cascade',
    }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userIdx: index('memberships_user_idx').on(t.userId),
    scopeIdx: index('memberships_scope_idx').on(t.scopeType, t.scopeId),
    franchiseeIdx: index('memberships_franchisee_idx').on(t.franchiseeId),
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
    targetFranchiseeId: uuid('target_franchisee_id').references(() => franchisees.id, {
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
    franchiseeIdx: index('audit_log_franchisee_idx').on(t.targetFranchiseeId),
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
 * membership will land (franchisor / franchisee / location). franchisorId
 * is always set for RLS-scoped visibility, even for franchisee-level
 * invites, so a franchisor_admin can list every outstanding invite across
 * their franchisees.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    email: text('email').notNull(),
    role: role('role').notNull(),
    scopeType: scopeType('scope_type').notNull(),
    franchisorId: uuid('franchisor_id')
      .notNull()
      .references(() => franchisors.id, { onDelete: 'cascade' }),
    franchiseeId: uuid('franchisee_id').references(() => franchisees.id, {
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
    franchisorIdx: index('invitations_franchisor_idx').on(t.franchisorId),
    franchiseeIdx: index('invitations_franchisee_idx').on(t.franchiseeId),
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
    franchiseeId: uuid('franchisee_id')
      .notNull()
      .references(() => franchisees.id, { onDelete: 'cascade' }),
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
    franchiseeIdx: index('customers_franchisee_idx').on(t.franchiseeId),
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
    franchiseeId: uuid('franchisee_id')
      .notNull()
      .references(() => franchisees.id, { onDelete: 'cascade' }),
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
    franchiseeIdx: index('jobs_franchisee_idx').on(t.franchiseeId),
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
    // Denormalised franchisee_id so RLS policies match with a single
    // column predicate (no join through jobs).
    franchiseeId: uuid('franchisee_id')
      .notNull()
      .references(() => franchisees.id, { onDelete: 'cascade' }),
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
    franchiseeIdx: index('job_status_log_franchisee_idx').on(t.franchiseeId),
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
    franchiseeId: uuid('franchisee_id')
      .notNull()
      .references(() => franchisees.id, { onDelete: 'cascade' }),
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
    franchiseeIdx: index('job_photos_franchisee_idx').on(t.franchiseeId),
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
 * Franchisor-authored service catalog. One currently-published template
 * per franchisor is the gate-level invariant — the publish handler
 * atomically archives the previous published template so franchisees
 * always see a single authoritative catalog.
 */
export const serviceCatalogTemplates = pgTable(
  'service_catalog_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    franchisorId: uuid('franchisor_id')
      .notNull()
      .references(() => franchisors.id, { onDelete: 'cascade' }),
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
    franchisorIdx: index('service_catalog_templates_franchisor_idx').on(t.franchisorId),
    statusIdx: index('service_catalog_templates_status_idx').on(t.status),
    slugUnique: uniqueIndex('service_catalog_templates_slug_unique').on(
      t.franchisorId,
      t.slug,
    ),
  }),
);

export const serviceItems = pgTable(
  'service_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => serviceCatalogTemplates.id, { onDelete: 'cascade' }),
    // Denormalised for RLS — franchisees resolve their pricebook via a
    // policy that matches on franchisor_id without joining templates.
    franchisorId: uuid('franchisor_id')
      .notNull()
      .references(() => franchisors.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    category: text('category').notNull(),
    unit: text('unit').notNull(),
    basePrice: numeric('base_price', { precision: 12, scale: 2 }).notNull(),
    floorPrice: numeric('floor_price', { precision: 12, scale: 2 }),
    ceilingPrice: numeric('ceiling_price', { precision: 12, scale: 2 }),
    sortOrder: integer('sort_order').notNull().default(0),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    templateIdx: index('service_items_template_idx').on(t.templateId),
    franchisorIdx: index('service_items_franchisor_idx').on(t.franchisorId),
    categoryIdx: index('service_items_category_idx').on(t.category),
    skuUnique: uniqueIndex('service_items_template_sku_unique').on(t.templateId, t.sku),
  }),
);

/**
 * Franchisee overrides on specific service items. One active override
 * per (franchisee, item). Overrides are soft-deleted so the history is
 * preserved for audit and for reverting.
 */
export const pricebookOverrides = pgTable(
  'pricebook_overrides',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    franchiseeId: uuid('franchisee_id')
      .notNull()
      .references(() => franchisees.id, { onDelete: 'cascade' }),
    // Denormalised for RLS read checks — we always know which franchisor
    // the override belongs to without joining through service_items.
    franchisorId: uuid('franchisor_id')
      .notNull()
      .references(() => franchisors.id, { onDelete: 'cascade' }),
    serviceItemId: uuid('service_item_id')
      .notNull()
      .references(() => serviceItems.id, { onDelete: 'cascade' }),
    overridePrice: numeric('override_price', { precision: 12, scale: 2 }).notNull(),
    note: text('note'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    franchiseeIdx: index('pricebook_overrides_franchisee_idx').on(t.franchiseeId),
    franchisorIdx: index('pricebook_overrides_franchisor_idx').on(t.franchisorId),
    itemIdx: index('pricebook_overrides_item_idx').on(t.serviceItemId),
    uniqueActive: uniqueIndex('pricebook_overrides_unique_active')
      .on(t.franchiseeId, t.serviceItemId)
      .where(sql`${t.deletedAt} IS NULL`),
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
    franchiseeId: uuid('franchisee_id')
      .notNull()
      .references(() => franchisees.id, { onDelete: 'cascade' }),
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
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    franchiseeIdx: index('invoices_franchisee_idx').on(t.franchiseeId),
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
    franchiseeId: uuid('franchisee_id')
      .notNull()
      .references(() => franchisees.id, { onDelete: 'cascade' }),
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
    franchiseeIdx: index('invoice_line_items_franchisee_idx').on(t.franchiseeId),
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
    franchiseeId: uuid('franchisee_id')
      .notNull()
      .references(() => franchisees.id, { onDelete: 'cascade' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    stripePaymentIntentId: text('stripe_payment_intent_id').notNull(),
    stripeChargeId: text('stripe_charge_id').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
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
    franchiseeIdx: index('payments_franchisee_idx').on(t.franchiseeId),
    invoiceIdx: index('payments_invoice_idx').on(t.invoiceId),
    chargeUnique: uniqueIndex('payments_charge_unique').on(t.stripeChargeId),
  }),
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    franchiseeId: uuid('franchisee_id')
      .notNull()
      .references(() => franchisees.id, { onDelete: 'cascade' }),
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
    franchiseeIdx: index('refunds_franchisee_idx').on(t.franchiseeId),
    invoiceIdx: index('refunds_invoice_idx').on(t.invoiceId),
    refundUnique: uniqueIndex('refunds_stripe_refund_unique').on(t.stripeRefundId),
  }),
);

/**
 * Webhook idempotency. The handler inserts the Stripe `event.id`
 * before processing; a duplicate insert (unique violation) short-
 * circuits the handler to a 200 without re-running the side
 * effects. Deliberately NOT tenant-scoped — the webhook callback
 * runs before any franchisee has been resolved from the event.
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
// Royalty engine (phase_royalty_engine)
// ---------------------------------------------------------------------------

export const agreementStatus = pgEnum('agreement_status', [
  'draft',
  'active',
  'ended',
]);

export const royaltyRuleType = pgEnum('royalty_rule_type', [
  'percentage',
  'flat_per_job',
  'tiered',
  'minimum_floor',
]);

export const royaltyStatementStatus = pgEnum('royalty_statement_status', [
  'open',
  'reconciled',
  'disputed',
]);

/**
 * A franchise agreement is the authoritative source of the
 * platform fee for every invoice under a franchisee. At most one
 * `status = 'active'` row per franchisee is enforced by a partial
 * unique index.
 */
export const franchiseAgreements = pgTable(
  'franchise_agreements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    franchiseeId: uuid('franchisee_id')
      .notNull()
      .references(() => franchisees.id, { onDelete: 'cascade' }),
    // Denormalised for fast franchisor-scoped reads + cleaner RLS.
    franchisorId: uuid('franchisor_id')
      .notNull()
      .references(() => franchisors.id, { onDelete: 'cascade' }),
    status: agreementStatus('status').notNull().default('draft'),
    name: text('name').notNull(),
    notes: text('notes'),
    startsOn: timestamp('starts_on', { withTimezone: true }),
    endsOn: timestamp('ends_on', { withTimezone: true }),
    currency: text('currency').notNull().default('usd'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    franchiseeIdx: index('franchise_agreements_franchisee_idx').on(t.franchiseeId),
    franchisorIdx: index('franchise_agreements_franchisor_idx').on(t.franchisorId),
    oneActivePerFranchisee: uniqueIndex('franchise_agreements_one_active')
      .on(t.franchiseeId)
      .where(sql`${t.status} = 'active'`),
  }),
);

export const royaltyRules = pgTable(
  'royalty_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agreementId: uuid('agreement_id')
      .notNull()
      .references(() => franchiseAgreements.id, { onDelete: 'cascade' }),
    franchiseeId: uuid('franchisee_id')
      .notNull()
      .references(() => franchisees.id, { onDelete: 'cascade' }),
    ruleType: royaltyRuleType('rule_type').notNull(),
    // JSONB blob whose shape depends on ruleType; validated by Zod
    // at the API boundary. Stored as-is so evolving rule shapes
    // don't require migrations.
    params: jsonb('params').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    agreementIdx: index('royalty_rules_agreement_idx').on(t.agreementId),
    franchiseeIdx: index('royalty_rules_franchisee_idx').on(t.franchiseeId),
  }),
);

export const royaltyStatements = pgTable(
  'royalty_statements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    franchiseeId: uuid('franchisee_id')
      .notNull()
      .references(() => franchisees.id, { onDelete: 'cascade' }),
    franchisorId: uuid('franchisor_id')
      .notNull()
      .references(() => franchisors.id, { onDelete: 'cascade' }),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    grossRevenue: numeric('gross_revenue', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    refundTotal: numeric('refund_total', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    netRevenue: numeric('net_revenue', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    royaltyOwed: numeric('royalty_owed', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    royaltyCollected: numeric('royalty_collected', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    variance: numeric('variance', { precision: 14, scale: 2 })
      .notNull()
      .default('0'),
    transferId: text('transfer_id'),
    status: royaltyStatementStatus('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    franchiseeIdx: index('royalty_statements_franchisee_idx').on(t.franchiseeId),
    franchisorIdx: index('royalty_statements_franchisor_idx').on(t.franchisorId),
    periodUnique: uniqueIndex('royalty_statements_period_unique').on(
      t.franchiseeId,
      t.periodStart,
      t.periodEnd,
    ),
    transferIdUnique: uniqueIndex('royalty_statements_transfer_unique')
      .on(t.transferId)
      .where(sql`${t.transferId} IS NOT NULL`),
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
    // Denormalised so franchisor-scoped push sends can target a
    // franchisee without joining memberships.
    franchiseeId: uuid('franchisee_id').references(() => franchisees.id, {
      onDelete: 'set null',
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
