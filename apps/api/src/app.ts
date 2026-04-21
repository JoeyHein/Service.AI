/**
 * Fastify application factory for Service.AI API.
 *
 * Registers all required plugins (sensible, helmet, cors, rate-limit, compress)
 * and mounts the /healthz endpoint. Accepts optional dependency overrides so
 * integration tests can inject mock DB/Redis clients without network connections.
 *
 * @module app
 */

import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import pg from 'pg';
import { Redis } from 'ioredis';

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
  const app = Fastify({
    logger: opts.logger !== undefined ? opts.logger : {
      level: 'info',
    },
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'reqId',
  });

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

  // Register plugins in dependency order. sensible first so its decorators
  // are available to all subsequent plugins and routes.
  app.register(sensible);
  app.register(helmet);
  app.register(cors);
  app.register(rateLimit, { max: 60, timeWindow: '1 minute' });
  app.register(compress);

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

  return app;
}
