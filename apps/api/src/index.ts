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
 *   GOOGLE_MAPS_API_KEY  — enables real Google Places lookups. When
 *                          absent, the app uses the deterministic
 *                          `stubPlacesClient` (suitable for dev + CI).
 *   DO_SPACES_ENDPOINT   — DigitalOcean Spaces endpoint URL.
 *   DO_SPACES_REGION     — region (e.g. nyc3).
 *   DO_SPACES_BUCKET     — bucket name.
 *   DO_SPACES_KEY        — Spaces access key.
 *   DO_SPACES_SECRET     — Spaces secret key.
 *                          When all five DO_SPACES_* vars are set, job
 *                          photo uploads use s3ObjectStore. When any is
 *                          missing, stubObjectStore is used (in-memory,
 *                          dev only) and the API logs a warning.
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
import {
  googlePlacesClient,
  stubPlacesClient,
  type PlacesClient,
} from './places.js';
import {
  s3ObjectStore,
  stubObjectStore,
  type ObjectStore,
} from './object-store.js';

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

const placesApiKey = process.env['GOOGLE_MAPS_API_KEY'];
const placesClient: PlacesClient = placesApiKey
  ? await googlePlacesClient(placesApiKey)
  : stubPlacesClient;
if (!placesApiKey) {
  console.warn(
    '[warn] GOOGLE_MAPS_API_KEY is unset — using stubPlacesClient. Set a real key for production Places lookups.',
  );
}

const doSpacesConfigured = !!(
  process.env['DO_SPACES_ENDPOINT'] &&
  process.env['DO_SPACES_REGION'] &&
  process.env['DO_SPACES_BUCKET'] &&
  process.env['DO_SPACES_KEY'] &&
  process.env['DO_SPACES_SECRET']
);
const objectStore: ObjectStore = doSpacesConfigured
  ? await s3ObjectStore({
      endpoint: process.env['DO_SPACES_ENDPOINT']!,
      region: process.env['DO_SPACES_REGION']!,
      bucket: process.env['DO_SPACES_BUCKET']!,
      accessKeyId: process.env['DO_SPACES_KEY']!,
      secretAccessKey: process.env['DO_SPACES_SECRET']!,
    })
  : stubObjectStore();
if (!doSpacesConfigured) {
  console.warn(
    '[warn] DO_SPACES_* env vars incomplete — using stubObjectStore. Photo uploads will not persist.',
  );
}

const app = buildApp({
  auth,
  drizzle: db,
  membershipResolver: membershipResolver(db),
  franchiseeLookup: franchiseeLookup(db),
  auditWriter: auditLogWriter(db),
  magicLinkSender: loggingSender,
  acceptUrlBase: process.env['WEB_ORIGIN'] ?? 'http://localhost:3000',
  placesClient,
  objectStore,
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
