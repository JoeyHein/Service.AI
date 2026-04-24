/**
 * Fastify application factory for Service.AI API.
 *
 * Registers all required plugins (sensible, helmet, cors, rate-limit, compress)
 * and mounts the /healthz endpoint. Accepts optional dependency overrides so
 * integration tests can inject mock DB/Redis clients without network connections.
 *
 * @module app
 */

import { setupFastify as setupSentryFastify } from './sentry.js';
import { logger } from './logger.js';
import { mountAuth } from './auth-mount.js';
import { registerInviteRoutes } from './invites.js';
import { registerFranchiseeRoutes } from './franchisees-routes.js';
import { registerAuditLogRoutes } from './audit-log-routes.js';
import { registerCustomerRoutes } from './customers-routes.js';
import { registerJobRoutes } from './jobs-routes.js';
import { registerPlacesRoutes, stubPlacesClient, type PlacesClient } from './places.js';
import { registerJobPhotoRoutes } from './job-photos-routes.js';
import { stubObjectStore, type ObjectStore } from './object-store.js';
import { registerCatalogRoutes } from './catalog-routes.js';
import { registerPricebookRoutes } from './pricebook-routes.js';
import { registerInvoiceRoutes } from './invoice-routes.js';
import { registerInvoicePaymentRoutes } from './invoice-payment-routes.js';
import { registerPublicInvoiceRoutes } from './public-invoice-routes.js';
import { registerConnectRoutes } from './connect-routes.js';
import { registerAgreementRoutes } from './agreement-routes.js';
import { registerStatementRoutes } from './statement-routes.js';
import {
  registerPhoneRoutes,
  stubPhoneProvisioner,
  type PhoneProvisioner,
} from './phone-routes.js';
import { registerStripeWebhook } from './stripe-webhook.js';
import { resolveStripeClient, type StripeClient } from './stripe.js';
import {
  resolveEmailSender,
  resolveSmsSender,
  type EmailSender,
  type SmsSender,
} from './notify.js';
import { registerPushRoutes } from './push-routes.js';
import { resolvePushSender, type PushSender } from './push.js';
import { registerAssignmentRoutes } from './assignment-routes.js';
import { registerSseRoutes } from './sse-routes.js';
import { registerTechRoutes } from './techs-routes.js';
import { inProcessEventBus, type EventBus } from './event-bus.js';
import {
  requestScopePlugin,
  type MembershipResolver,
  type FranchiseeLookup,
  type AuditLogWriter,
} from './request-scope.js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as dbSchema from '@service-ai/db';
import type { MagicLinkSender } from '@service-ai/auth';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Server, IncomingMessage, ServerResponse } from 'http';
import sensible from '@fastify/sensible';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import pg from 'pg';
import { Redis } from 'ioredis';
import { z } from 'zod';
import type { Auth } from '@service-ai/auth';

const { Pool } = pg;

/**
 * Minimal interface that any DB client must satisfy for healthz checks.
 * Accepts the native pg.Pool or a test stub.
 */
interface DbClient {
  query: (sql: string) => Promise<unknown>;
}

/**
 * Minimal interface that any Redis client must satisfy for healthz checks.
 * Accepts the native ioredis instance or a test stub.
 */
interface RedisClient {
  ping: () => Promise<string>;
}

/**
 * Options accepted by buildApp.
 *
 * @property db     - Optional DB client override (defaults to a real pg.Pool).
 * @property redis  - Optional Redis client override (defaults to a real ioredis instance).
 * @property logger - Fastify logger option; false disables logging in tests.
 */
export interface AppOptions {
  db?: DbClient;
  redis?: RedisClient;
  logger?: boolean | object;
  /**
   * Optional Better Auth instance. When present, /api/auth/* and /api/v1/me
   * are mounted. Tests that don't need auth omit this; it defaults to null
   * so the app boots and serves /healthz without an auth backend configured.
   */
  auth?: Auth | null;
  /**
   * Resolves the active memberships for a given user id. Used by the
   * requestScopePlugin to populate request.scope. Required when `auth` is
   * provided. Tests inject a stub; production wires a real DB-backed impl.
   */
  membershipResolver?: MembershipResolver;
  /**
   * Validates the target of an X-Impersonate-Franchisee header. Omit to
   * disable impersonation (any header becomes IMPERSONATION_DISABLED 403).
   */
  franchiseeLookup?: FranchiseeLookup;
  /**
   * Writes impersonation audit rows. Required when franchiseeLookup is
   * provided; the plugin invokes it once per valid impersonated request.
   */
  auditWriter?: AuditLogWriter;
  /**
   * Drizzle database handle for tenant-scoped routes (invitations, later:
   * customers, jobs, …). When supplied together with magicLinkSender,
   * /api/v1/invites is mounted.
   */
  drizzle?: NodePgDatabase<typeof dbSchema>;
  /** Email sender for invite links. Required to mount invite routes. */
  magicLinkSender?: MagicLinkSender;
  /** Origin used to build invite accept URLs. Defaults to http://localhost:3000. */
  acceptUrlBase?: string;
  /**
   * Google Places adapter. Defaults to the deterministic `stubPlacesClient`
   * so dev + tests never hit the network. Production wires the real
   * client via `googlePlacesClient(GOOGLE_MAPS_API_KEY)`.
   */
  placesClient?: PlacesClient;
  /**
   * Photo storage adapter. Defaults to `stubObjectStore()` so dev
   * tests run without any bucket configured. Production wires
   * `s3ObjectStore({ endpoint, region, bucket, accessKeyId, secretAccessKey })`
   * pointed at the DO Space.
   */
  objectStore?: ObjectStore;
  /**
   * Dispatch EventBus (phase_dispatch_board). Defaults to the
   * in-process impl suitable for single-process API deployments.
   * Multi-host deployments swap in a Redis-backed impl.
   */
  eventBus?: EventBus;
  /**
   * Web push sender (phase_tech_mobile_pwa). Defaults to
   * `resolvePushSender()` which returns the stub unless all
   * VAPID_* env vars are present.
   */
  pushSender?: PushSender;
  /**
   * Stripe adapter (phase_invoicing_stripe). Defaults to
   * `resolveStripeClient()` — stub unless STRIPE_SECRET_KEY +
   * STRIPE_WEBHOOK_SECRET are both set.
   */
  stripe?: StripeClient;
  /**
   * Origin used when building Stripe account-link return URLs and
   * public payment page URLs. Defaults to http://localhost:3000.
   */
  publicBaseUrl?: string;
  /** Email sender used for invoice delivery (phase 7). */
  emailSender?: EmailSender;
  /** SMS sender used for invoice delivery (phase 7). */
  smsSender?: SmsSender;
  /**
   * Phone provisioner (phase_ai_csr_voice). Default is
   * `stubPhoneProvisioner()` so dev + tests never hit Twilio.
   */
  phoneProvisioner?: PhoneProvisioner;
}

/**
 * Builds and returns a configured Fastify instance without starting the server.
 *
 * Side effects:
 * - Creates a pg.Pool connected to DATABASE_URL when no db override is supplied.
 * - Creates an ioredis client connected to REDIS_URL when no redis override is supplied.
 *
 * Both real clients are created lazily during plugin registration; the
 * connections are not validated until the first query/ping.
 *
 * @param opts - Optional overrides for db, redis, and logger.
 * @returns    A Fastify instance ready to be awaited with .ready() or .listen().
 */
export function buildApp(opts: AppOptions = {}) {
  // Fastify 5 only accepts a boolean or config object in the `logger` option —
  // passing a pre-built pino instance directly causes a runtime error; use
  // `loggerInstance` for that case. When `loggerInstance` is used, Fastify
  // infers a different Logger generic incompatible with `FastifyBaseLogger`, so
  // we cast the result to the standard HTTP FastifyInstance type so callers and
  // tests see a uniform return type. Tests pass `opts.logger = false` to
  // suppress output; production uses the shared pino instance from logger.ts.
  type App = FastifyInstance<Server, IncomingMessage, ServerResponse>;

  const commonOpts = {
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id' as const,
    requestIdLogLabel: 'reqId' as const,
  };

  const app = (opts.logger !== undefined
    // Test path: caller controls logging (typically false to suppress output).
    ? Fastify({ ...commonOpts, logger: opts.logger as boolean })
    // Production path: use the shared pino instance that fans out to Axiom.
    : Fastify({ ...commonOpts, loggerInstance: logger })) as App;

  // Use injected clients or create real ones. Real clients are not yet
  // connected at construction time — connection happens on first use.
  const db: DbClient = opts.db ?? new Pool({ connectionString: process.env['DATABASE_URL'] });
  const redis: RedisClient = opts.redis ?? new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
    // Suppress ioredis reconnection attempts in test environments where no
    // real Redis is available but we still need the app to boot cleanly.
    lazyConnect: true,
  });

  // Echo the internal request ID back to the caller as a response header.
  // Fastify reads x-request-id from the incoming request (when provided) or
  // generates one via genReqId, but does not automatically send it back.
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // Uniform error envelope. Plugins throw errors decorated with a .code
  // and .statusCode (see request-scope.ts); Fastify's default serialiser
  // would expose `code` at the top level, which breaks client contracts
  // that expect `{ ok: false, error: { code, message } }`. This handler
  // reshapes any error that carries a string `code` into the canonical
  // envelope. Errors without a code fall through to Fastify defaults.
  interface CodedError {
    statusCode?: number;
    code?: string;
    message?: string;
  }
  app.setErrorHandler((err: CodedError, _req, reply) => {
    const code = typeof err.code === 'string' ? err.code : null;
    const statusCode =
      typeof err.statusCode === 'number' && err.statusCode >= 400
        ? err.statusCode
        : 500;
    if (code) {
      return reply.code(statusCode).send({
        ok: false,
        error: { code, message: err.message ?? code },
      });
    }
    return reply.code(statusCode).send({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: err.message ?? 'Unexpected error' },
    });
  });

  // Register plugins in dependency order. sensible first so its decorators
  // are available to all subsequent plugins and routes.
  app.register(sensible);
  app.register(helmet);
  app.register(cors);
  app.register(rateLimit, { max: 60, timeWindow: '1 minute' });
  app.register(compress);

  // Wire Sentry's Fastify error handler so unhandled route errors are
  // captured with request context. No-op when SENTRY_DSN is unset.
  setupSentryFastify(app);

  // Mount Better Auth + RequestScope when an auth instance is provided.
  // Skipped in tests that only exercise /healthz or /echo.
  if (opts.auth) {
    const resolver: MembershipResolver = opts.membershipResolver ?? {
      // Default resolver returns no memberships — suitable as a safe no-op
      // for tests that wire auth but don't care about scope. Production
      // wires a real DB-backed resolver in index.ts.
      memberships: async () => [],
    };
    app.register(requestScopePlugin, {
      auth: opts.auth,
      membershipResolver: resolver,
      franchiseeLookup: opts.franchiseeLookup,
      auditWriter: opts.auditWriter,
    });
    mountAuth(app, opts.auth);
  }

  // Mount invite routes when a Drizzle handle + sender are wired.
  if (opts.drizzle && opts.magicLinkSender) {
    registerInviteRoutes(app, {
      drizzle: opts.drizzle,
      magicLinkSender: opts.magicLinkSender,
      acceptUrlBase: opts.acceptUrlBase ?? 'http://localhost:3000',
    });
  }

  // Mount franchisee list + audit log when a Drizzle handle is wired.
  // Needs the scope plugin already registered — buildApp orders that above.
  if (opts.drizzle) {
    registerFranchiseeRoutes(app, opts.drizzle);
    registerAuditLogRoutes(app, opts.drizzle);
    registerCustomerRoutes(app, opts.drizzle);
    registerJobRoutes(app, opts.drizzle);
    registerJobPhotoRoutes(
      app,
      opts.drizzle,
      opts.objectStore ?? stubObjectStore(),
    );
    registerCatalogRoutes(app, opts.drizzle);
    registerPricebookRoutes(app, opts.drizzle);
    registerInvoiceRoutes(app, opts.drizzle);
    const stripe = opts.stripe ?? resolveStripeClient();
    const publicBaseUrl = opts.publicBaseUrl ?? 'http://localhost:3000';
    const emailSender = opts.emailSender ?? resolveEmailSender();
    const smsSender = opts.smsSender ?? resolveSmsSender();
    registerConnectRoutes(app, opts.drizzle, { stripe, publicBaseUrl });
    registerInvoicePaymentRoutes(app, opts.drizzle, {
      stripe,
      emailSender,
      smsSender,
      publicBaseUrl,
    });
    registerStripeWebhook(app, opts.drizzle, stripe);
    registerAgreementRoutes(app, opts.drizzle);
    registerStatementRoutes(app, opts.drizzle, { stripe });
    registerPhoneRoutes(
      app,
      opts.drizzle,
      opts.phoneProvisioner ?? stubPhoneProvisioner(),
    );
    registerPublicInvoiceRoutes(app, opts.drizzle);
    registerPushRoutes(app, opts.drizzle);
    // Resolve the push sender now so a missing-VAPID warning lands
    // at boot time rather than at first send. Stashed on the app
    // instance for later phases that actually call it.
    const pushSender = opts.pushSender ?? resolvePushSender();
    app.decorate('pushSender', pushSender);
    const bus = opts.eventBus ?? inProcessEventBus();
    registerAssignmentRoutes(app, opts.drizzle, bus);
    registerSseRoutes(app, opts.drizzle, bus);
    registerTechRoutes(app, opts.drizzle);
  }

  // Places endpoints don't need the DB but do require the scope plugin —
  // guard on opts.auth so they only register when the rest of the auth
  // stack is present.
  if (opts.auth) {
    registerPlacesRoutes(app, opts.placesClient ?? stubPlacesClient);
  }

  /**
   * GET /healthz
   *
   * Checks liveness of the API and its critical dependencies (Postgres, Redis).
   * Returns 200 when all dependencies are healthy, 503 when any are degraded.
   * Never throws — all errors are caught and reflected in the response body.
   *
   * Response: { ok: boolean, db: 'up' | 'down', redis: 'up' | 'down' }
   */
  app.get('/healthz', async (_request, reply) => {
    let dbStatus: 'up' | 'down' = 'up';
    let redisStatus: 'up' | 'down' = 'up';

    try {
      await db.query('SELECT 1');
    } catch {
      dbStatus = 'down';
    }

    try {
      await redis.ping();
    } catch {
      redisStatus = 'down';
    }

    const ok = dbStatus === 'up' && redisStatus === 'up';

    return reply
      .code(ok ? 200 : 503)
      .send({ ok, db: dbStatus, redis: redisStatus });
  });

  /**
   * POST /api/v1/echo
   *
   * Validates the request body against EchoInputSchema and returns the
   * submitted message wrapped in the standard { ok: true, data: { echo } }
   * envelope. Returns 400 with a structured error envelope on invalid input.
   *
   * This endpoint validates the ts-rest contract layer end-to-end during
   * the foundation phase. It does not touch DB or Redis.
   *
   * Response 200: { ok: true, data: { echo: string } }
   * Response 400: { ok: false, error: { code: string, message: string } }
   */
  const EchoInputSchema = z.object({
    message: z.string().min(1),
  });

  app.post('/api/v1/echo', async (request, reply) => {
    const result = EchoInputSchema.safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: result.error.message,
        },
      });
    }
    return reply.code(200).send({
      ok: true,
      data: { echo: result.data.message },
    });
  });

  return app;
}
