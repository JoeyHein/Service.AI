/**
 * Drizzle ORM schema definitions for @service-ai/db.
 *
 * Contains the `health_checks` table used to record periodic health-check
 * results for each service.  This is the first table in the foundation phase;
 * all business tables are added in later phases.
 *
 * Edge cases:
 * - `service` is capped at 100 chars by the DB constraint — Drizzle does not
 *   enforce this at the JS layer, but the Postgres driver will throw on insert.
 * - `checkedAt` has a DB-side DEFAULT NOW() so callers may omit it.
 */
import { pgTable, uuid, varchar, timestamp } from 'drizzle-orm/pg-core';

export const healthChecks = pgTable('health_checks', {
  id: uuid('id').defaultRandom().primaryKey(),
  service: varchar('service', { length: 100 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
});
