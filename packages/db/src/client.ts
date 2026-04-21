/**
 * Drizzle ORM client for @service-ai/db.
 *
 * Creates a `pg.Pool` from the DATABASE_URL environment variable and wraps it
 * in a Drizzle instance typed against the full schema.  Both the pool (for raw
 * queries and migrations) and the Drizzle db handle are exported.
 *
 * Side effects: opens a Postgres connection pool when this module is first
 * imported.  Callers are responsible for calling `pool.end()` on shutdown.
 *
 * Edge cases:
 * - If DATABASE_URL is undefined the Pool constructor defers the error to the
 *   first query, not at module load time.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import pkg from 'pg';
const { Pool } = pkg;
import * as schema from './schema.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
export { pool };
