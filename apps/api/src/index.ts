/**
 * Entry point for the Service.AI Fastify API server.
 *
 * Builds the Drizzle handle from DATABASE_URL, constructs a Better Auth
 * instance with the schema mapping, wires the three production resolvers
 * (MembershipResolver, FranchiseeLookup, AuditLogWriter) into
 * requestScopePlugin, and registers graceful-shutdown handlers for
 * SIGTERM and SIGINT so in-flight requests drain before exit.
 *
 * Environment:
 *   DATABASE_URL         — required. Postgres connection string.
 *   REDIS_URL            — optional, defaults to redis://localhost:6379.
 *   BETTER_AUTH_SECRET   — required in production (>=32 chars). Dev falls
 *                          back to a fixed placeholder with a WARN log.
 *   BETTER_AUTH_URL      — base URL Better Auth serves routes under.
 *                          Defaults to http://<host>:<port>.
 *   WEB_ORIGIN           — origin used for invite accept URLs. Defaults
 *                          to http://localhost:3000.
 *   HOST / PORT          — listen host/port. Defaults 0.0.0.0 / 3001.
 */
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createAuth, loggingSender } from '@service-ai/auth';
import * as schema from '@service-ai/db';
import { users, sessions, accounts, verifications } from '@service-ai/db';
import { buildApp } from './app.js';
import {
  membershipResolver,
  franchiseeLookup,
  auditLogWriter,
} from './production-resolvers.js';

const { Pool } = pkg;

const host = process.env['HOST'] ?? '0.0.0.0';
const port = parseInt(process.env['PORT'] ?? '3001', 10);
const databaseUrl = process.env['DATABASE_URL'];
const isProd = process.env['NODE_ENV'] === 'production';

if (!databaseUrl) {
  console.error('FATAL: DATABASE_URL is not set');
  process.exit(2);
}

const secret = process.env['BETTER_AUTH_SECRET'];
if (!secret && isProd) {
  console.error('FATAL: BETTER_AUTH_SECRET is required in production');
  process.exit(2);
}
const effectiveSecret = secret ?? 'dev-only-placeholder-secret-do-not-use-xxxxxxx';
if (!secret) {
  console.warn(
    '[warn] BETTER_AUTH_SECRET is unset — using a dev-only placeholder. Set a real value before deploying.',
  );
}

const pool = new Pool({ connectionString: databaseUrl });
const db = drizzle(pool, { schema });

const auth = createAuth({
  db,
  authSchema: {
    user: users,
    session: sessions,
    account: accounts,
    verification: verifications,
  },
  baseUrl: process.env['BETTER_AUTH_URL'] ?? `http://${host}:${port}`,
  secret: effectiveSecret,
  production: isProd,
});

const app = buildApp({
  auth,
  drizzle: db,
  membershipResolver: membershipResolver(db),
  franchiseeLookup: franchiseeLookup(db),
  auditWriter: auditLogWriter(db),
  magicLinkSender: loggingSender,
  acceptUrlBase: process.env['WEB_ORIGIN'] ?? 'http://localhost:3000',
});

const signals = ['SIGTERM', 'SIGINT'] as const;
for (const signal of signals) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}

try {
  await app.listen({ host, port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
