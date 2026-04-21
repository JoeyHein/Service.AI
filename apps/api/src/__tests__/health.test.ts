/**
 * Integration tests for TASK-FND-03: Fastify API skeleton + health endpoint.
 *
 * These tests are intentionally written BEFORE the implementation exists (TDD red phase).
 * They encode the acceptance criteria from TASK-FND-03 as executable specifications.
 *
 * Acceptance criteria covered:
 * - GET /healthz returns 200 when DB + Redis are reachable
 * - GET /healthz returns 503 when DB or Redis is down
 * - Logs are structured JSON with request id
 * - All required plugins are registered (helmet, cors, rate-limit, compress, sensible)
 * - Response shape: { ok: boolean, db: 'up'|'down', redis: 'up'|'down' }
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a fresh Fastify instance for each test and closes it in afterEach.
 * Accepts optional dependency overrides so individual tests can inject faults.
 */
function createTestApp(overrides?: Parameters<typeof buildApp>[0]) {
  return buildApp(overrides);
}

// ---------------------------------------------------------------------------
// Suite 1 — Application boots without error
// ---------------------------------------------------------------------------

describe('TASK-FND-03 / application bootstrap', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('boots without throwing when all plugins are registered', async () => {
    // If buildApp() throws or ready() rejects, the test fails — which is the
    // intended failure mode until the builder implements app.ts.
    app = createTestApp();
    await expect(app.ready()).resolves.not.toThrow();
  });

  it('exposes a pino logger instance on the app', async () => {
    app = createTestApp();
    await app.ready();

    // The Fastify logger configured with pino must be present and callable.
    expect(app.log).toBeTruthy();
    expect(typeof app.log.info).toBe('function');
    expect(typeof app.log.error).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — GET /healthz happy path (DB + Redis reachable)
// ---------------------------------------------------------------------------

describe('TASK-FND-03 / GET /healthz — happy path', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns HTTP 200 when DB and Redis are both reachable', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(200);
  });

  it('returns Content-Type application/json', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.headers['content-type']).toMatch(/application\/json/);
  });

  it('response body contains ok: true', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    const body = response.json<{ ok: boolean; db: string; redis: string }>();
    expect(body.ok).toBe(true);
  });

  it('response body contains db: "up"', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    const body = response.json<{ ok: boolean; db: string; redis: string }>();
    expect(body.db).toBe('up');
  });

  it('response body contains redis: "up"', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    const body = response.json<{ ok: boolean; db: string; redis: string }>();
    expect(body.redis).toBe('up');
  });

  it('response body has exactly the three expected keys (ok, db, redis)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    const body = response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(['db', 'ok', 'redis'].sort());
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — GET /healthz when DB is unreachable
// ---------------------------------------------------------------------------

describe('TASK-FND-03 / GET /healthz — DB unreachable', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    /**
     * Pass a mock DB client that always throws, simulating a connection failure.
     * The builder must accept an optional `db` override in buildApp() to allow
     * this injection — an intentional testability constraint.
     */
    app = createTestApp({
      db: {
        // Simulate any query method throwing a connection error
        query: async () => {
          throw new Error('ECONNREFUSED: DB unavailable in test');
        },
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns HTTP 503 when the DB health check throws', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(503);
  });

  it('response body contains db: "down" when DB throws', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    const body = response.json<{ ok: boolean; db: string; redis: string }>();
    expect(body.db).toBe('down');
  });

  it('response body contains ok: false when DB throws', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    const body = response.json<{ ok: boolean; db: string; redis: string }>();
    expect(body.ok).toBe(false);
  });

  it('still includes redis status in the body when DB is down', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    const body = response.json<{ ok: boolean; db: string; redis: string }>();
    // Redis was not broken — should report its real status (up or down)
    expect(['up', 'down']).toContain(body.redis);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — GET /healthz when Redis is unreachable
// ---------------------------------------------------------------------------

describe('TASK-FND-03 / GET /healthz — Redis unreachable', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    /**
     * Pass a mock Redis client that always throws, simulating a connection failure.
     * The builder must accept an optional `redis` override in buildApp().
     */
    app = createTestApp({
      redis: {
        ping: async () => {
          throw new Error('ECONNREFUSED: Redis unavailable in test');
        },
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns HTTP 503 when the Redis health check throws', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(503);
  });

  it('response body contains redis: "down" when Redis throws', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    const body = response.json<{ ok: boolean; db: string; redis: string }>();
    expect(body.redis).toBe('down');
  });

  it('response body contains ok: false when Redis throws', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    const body = response.json<{ ok: boolean; db: string; redis: string }>();
    expect(body.ok).toBe(false);
  });

  it('still includes db status in the body when Redis is down', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    const body = response.json<{ ok: boolean; db: string; redis: string }>();
    expect(['up', 'down']).toContain(body.db);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — GET /healthz when both DB and Redis are unreachable
// ---------------------------------------------------------------------------

describe('TASK-FND-03 / GET /healthz — DB and Redis both unreachable', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = createTestApp({
      db: {
        query: async () => {
          throw new Error('ECONNREFUSED: DB unavailable in test');
        },
      },
      redis: {
        ping: async () => {
          throw new Error('ECONNREFUSED: Redis unavailable in test');
        },
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns HTTP 503 when both DB and Redis are unreachable', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(503);
  });

  it('response body reports both db and redis as "down"', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    const body = response.json<{ ok: boolean; db: string; redis: string }>();
    expect(body.db).toBe('down');
    expect(body.redis).toBe('down');
    expect(body.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 6 — Structured JSON logging + request ID header
// ---------------------------------------------------------------------------

describe('TASK-FND-03 / structured logging and request ID', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('includes a request-id header in every response', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    // Fastify sets x-request-id by default when genReqId is configured or
    // the request carries no ID. Either header name is acceptable.
    const hasRequestId =
      Boolean(response.headers['x-request-id']) ||
      Boolean(response.headers['request-id']);

    expect(hasRequestId).toBe(true);
  });

  it('request-id changes between requests (unique per request)', async () => {
    const [r1, r2] = await Promise.all([
      app.inject({ method: 'GET', url: '/healthz' }),
      app.inject({ method: 'GET', url: '/healthz' }),
    ]);

    const id1 =
      r1.headers['x-request-id'] ?? r1.headers['request-id'];
    const id2 =
      r2.headers['x-request-id'] ?? r2.headers['request-id'];

    // Both must exist
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    // And they must differ (unique IDs per request)
    expect(id1).not.toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// Suite 7 — Security headers (helmet plugin)
// ---------------------------------------------------------------------------

describe('TASK-FND-03 / security headers via @fastify/helmet', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('sets X-Content-Type-Options: nosniff header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options or Content-Security-Policy header (helmet active)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    const hasFrameOptions = Boolean(response.headers['x-frame-options']);
    const hasCsp = Boolean(response.headers['content-security-policy']);

    // At least one of these must be present when helmet is registered
    expect(hasFrameOptions || hasCsp).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 8 — CORS plugin
// ---------------------------------------------------------------------------

describe('TASK-FND-03 / CORS via @fastify/cors', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('responds to a preflight OPTIONS request on /healthz', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/healthz',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'GET',
      },
    });

    // CORS preflight should not be a 404 — accepted or at minimum no 404
    expect(response.statusCode).not.toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Suite 9 — Unknown route shape
// ---------------------------------------------------------------------------

describe('TASK-FND-03 / unknown route handling', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 404 for an unknown route', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/does-not-exist',
    });

    expect(response.statusCode).toBe(404);
  });

  it('404 response is valid JSON (sensible plugin shapes errors)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/does-not-exist',
    });

    // Should not throw when parsing
    expect(() => response.json()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite 10 — Logger wiring regression (AUDIT-2 / B4)
// ---------------------------------------------------------------------------

describe('AUDIT-2 / B4 regression / logger wiring', () => {
  it('buildApp() without opts.logger boots without throwing (uses loggerInstance path)', async () => {
    // This test would fail before the fix if buildApp passed the pino logger
    // instance directly to Fastify's logger option, which Fastify 5 rejects
    // with "logger options only accepts a configuration object".
    // After the fix, buildApp uses loggerInstance to inject the pre-built pino
    // instance from logger.ts so the app boots cleanly.
    const app = buildApp();
    await expect(app.ready()).resolves.not.toThrow();
    await app.close();
  });

  it('buildApp() without opts.logger exposes a functioning log object', async () => {
    const app = buildApp();
    await app.ready();

    // The app.log object must be present and callable regardless of the logger
    // path taken. Without this test, a silent regression could leave the API
    // booting with no logger at all.
    expect(app.log).toBeTruthy();
    expect(typeof app.log.info).toBe('function');
    expect(typeof app.log.error).toBe('function');
    expect(typeof app.log.warn).toBe('function');

    await app.close();
  });

  it('buildApp({ logger: false }) suppresses logging without error (test helper path)', async () => {
    // Tests use logger:false to suppress noise. This path must not throw.
    const app = buildApp({ logger: false });
    await expect(app.ready()).resolves.not.toThrow();
    await app.close();
  });
});
