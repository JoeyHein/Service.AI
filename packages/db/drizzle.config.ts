/**
 * Drizzle Kit configuration for @service-ai/db.
 *
 * Points drizzle-kit at the TypeScript schema and the migrations output
 * directory.  The database URL is required at migration time and is read from
 * the DATABASE_URL environment variable.
 */
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
} satisfies Config;
