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
  jsonb,
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
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    franchisorIdx: index('franchisees_franchisor_idx').on(t.franchisorId),
    slugUnique: uniqueIndex('franchisees_franchisor_slug_unique').on(
      t.franchisorId,
      t.slug,
    ),
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
