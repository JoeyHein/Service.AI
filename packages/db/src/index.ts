/**
 * Public API for @service-ai/db.
 *
 * Re-exports the Drizzle schema (table definitions) and the database client so
 * consumers can import both from the same package entry point.
 */
export * from './schema.js';
export * from './client.js';
export * from './scope.js';
