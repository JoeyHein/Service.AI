/**
 * Integration tests for TASK-FND-06: ts-rest contracts + echo endpoint.
 *
 * These tests are written BEFORE the implementation exists (TDD red phase).
 * They encode the acceptance criteria for the API side:
 *   - POST /api/v1/echo happy path returns 200 with { ok: true, data: { echo: <input> } }
 *   - The echoed value matches the submitted message exactly (roundtrip)
 *   - Missing message field returns 400
 *   - Wrong type for message returns 400
 *   - Every response carries an `ok` field (the standard envelope)
 *   - Unauthenticated request shape (no special auth in v1 echo, but endpoint exists)
 *
 * Uses app.inject() so no real network is required. DB and Redis are stubbed
 * via the same override mechanism used by health.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Shared stub dependencies — echo does not touch DB or Redis, but buildApp
// requires them. Stubs prevent connection attempts in unit-style runs.
// ---------------------------------------------------------------------------

const stubDb = {
  query: async (_sql: string) => ({ rows: [] }),
};

const stubRedis = {
  ping: async () => 'PONG',
};

function createTestApp() {
  return buildApp({ db: stubDb, redis: stubRedis, logger: false });
}

// ---------------------------------------------------------------------------
// Suite 1 — POST /api/v1/echo happy path
// ---------------------------------------------------------------------------

describe('TASK-FND-06 / POST /api/v1/echo — happy path', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns HTTP 200 for a valid request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });

    expect(response.statusCode).toBe(200);
  });

  it('response body has ok: true', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });

    const body = response.json<{ ok: boolean; data: { echo: string } }>();
    expect(body.ok).toBe(true);
  });

  it('response body has data.echo equal to the submitted message', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });

    const body = response.json<{ ok: boolean; data: { echo: string } }>();
    expect(body.data.echo).toBe('hello');
  });

  it('returns Content-Type application/json', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });

    expect(response.headers['content-type']).toMatch(/application\/json/);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Roundtrip fidelity: the echoed value must match exactly
// ---------------------------------------------------------------------------

describe('TASK-FND-06 / POST /api/v1/echo — roundtrip fidelity', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('echoes the string "world" without modification', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'world' }),
    });

    const body = response.json<{ ok: boolean; data: { echo: string } }>();
    expect(body.data.echo).toBe('world');
  });

  it('echoes a realistic field service message verbatim', async () => {
    const message =
      'Garage door opener repair at 4820 W Colfax Ave, Denver CO — tech Carmichael requested';

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    const body = response.json<{ ok: boolean; data: { echo: string } }>();
    expect(body.data.echo).toBe(message);
  });

  it('echoes unicode characters without corruption', async () => {
    const message = 'Café — résumé — naïve — Ångström';

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    const body = response.json<{ ok: boolean; data: { echo: string } }>();
    expect(body.data.echo).toBe(message);
  });

  it('two sequential requests with different messages return different echo values', async () => {
    const [r1, r2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/echo',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'first-request' }),
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/echo',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'second-request' }),
      }),
    ]);

    const b1 = r1.json<{ ok: boolean; data: { echo: string } }>();
    const b2 = r2.json<{ ok: boolean; data: { echo: string } }>();
    expect(b1.data.echo).toBe('first-request');
    expect(b2.data.echo).toBe('second-request');
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — 400 on invalid input
// ---------------------------------------------------------------------------

describe('TASK-FND-06 / POST /api/v1/echo — invalid input', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 400 when message field is absent', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when message is a number instead of a string', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 123 }),
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when message is null', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: null }),
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when message is an empty string', async () => {
    // Empty strings have no utility for an echo endpoint; the schema uses min(1).
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when the body is not JSON (malformed)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: 'this is not json {{{',
    });

    // Fastify returns 400 on JSON parse failure
    expect(response.statusCode).toBe(400);
  });

  it('400 response body contains ok: false', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    const body = response.json<{ ok: boolean }>();
    expect(body.ok).toBe(false);
  });

  it('400 response body contains a structured error with code and message fields', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 123 }),
    });

    const body = response.json<{
      ok: boolean;
      error: { code: string; message: string };
    }>();
    // The error envelope must carry at minimum code and message per API conventions.
    expect(body.error).toBeDefined();
    expect(typeof body.error.code).toBe('string');
    expect(typeof body.error.message).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Response envelope consistency
// ---------------------------------------------------------------------------

describe('TASK-FND-06 / POST /api/v1/echo — response envelope', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('every successful response has an ok field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'envelope-check' }),
    });

    const body = response.json<Record<string, unknown>>();
    expect(body).toHaveProperty('ok');
  });

  it('every error response has an ok field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    const body = response.json<Record<string, unknown>>();
    expect(body).toHaveProperty('ok');
  });

  it('successful response data object contains only the echo key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'shape-check' }),
    });

    const body = response.json<{ ok: boolean; data: Record<string, unknown> }>();
    expect(Object.keys(body.data)).toEqual(['echo']);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — Edge cases
// ---------------------------------------------------------------------------

describe('TASK-FND-06 / POST /api/v1/echo — edge cases', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('handles a 255-character message without error', async () => {
    const message = 'A'.repeat(255);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ ok: boolean; data: { echo: string } }>();
    expect(body.data.echo).toBe(message);
  });

  it('does not crash or hang on an extra unknown field in the body', async () => {
    // Extra fields should be stripped or ignored — the response still succeeds.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'valid', unexpectedField: true }),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ ok: boolean; data: { echo: string } }>();
    expect(body.ok).toBe(true);
    expect(body.data.echo).toBe('valid');
  });
});
