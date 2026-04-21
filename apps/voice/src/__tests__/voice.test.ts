/**
 * Integration tests for TASK-FND-05: Voice WS stub.
 *
 * These tests are intentionally written BEFORE the implementation exists (TDD red phase).
 * They encode the acceptance criteria from TASK-FND-05 as executable specifications.
 *
 * Acceptance criteria covered:
 * - GET /healthz returns 200 with { ok: true }
 * - WebSocket handshake at /call succeeds
 * - Echo: client sends "ping", receives "pong"
 * - Echo round-trip latency is under 200ms (generous bound for test environments)
 * - Multiple sequential messages are each echoed correctly
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { buildVoiceApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Starts the Fastify app on an ephemeral port (port 0) and returns both the
 * app instance and the resolved port number.
 *
 * Using port 0 lets the OS pick any available port, which prevents conflicts
 * when multiple test suites run in parallel.
 */
async function startApp(): Promise<{ app: FastifyInstance; port: number }> {
  const app = buildVoiceApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 8080;
  return { app, port };
}

/**
 * Opens a WebSocket connection to the given URL and waits until the socket
 * reaches the OPEN ready state. Rejects if the connection fails to open
 * within the configured timeout.
 *
 * @param url - Full ws:// URL to connect to.
 * @returns   The open WebSocket instance.
 */
function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/**
 * Sends a message over an open WebSocket and returns a promise that resolves
 * with the first message received after the send. Also records the elapsed
 * milliseconds so latency assertions can be made.
 *
 * @param ws      - Open WebSocket instance.
 * @param message - Text message to send.
 * @returns       Object with the received `message` string and `elapsedMs`.
 */
function sendAndReceive(
  ws: WebSocket,
  message: string,
): Promise<{ message: string; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    ws.once('message', (data) => {
      resolve({ message: data.toString(), elapsedMs: Date.now() - start });
    });
    ws.once('error', reject);
    ws.send(message);
  });
}

/**
 * Collects exactly `count` messages from an open WebSocket and returns them
 * in order of arrival. Useful for multi-message echo assertions.
 *
 * @param ws    - Open WebSocket instance.
 * @param count - Number of messages to wait for.
 * @returns     Array of received message strings.
 */
function collectMessages(ws: WebSocket, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const collected: string[] = [];
    ws.on('message', (data) => {
      collected.push(data.toString());
      if (collected.length === count) {
        resolve(collected);
      }
    });
    ws.once('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Suite 1 — GET /healthz
// ---------------------------------------------------------------------------

describe('TASK-FND-05 / GET /healthz', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildVoiceApp();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('returns HTTP 200', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(200);
  });

  it('returns exactly { ok: true } in the response body', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    const body = response.json<Record<string, unknown>>();
    // The voice healthz endpoint is intentionally minimal — no DB/Redis deps.
    expect(body).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — WebSocket /call echo: happy path
// ---------------------------------------------------------------------------

describe('TASK-FND-05 / WebSocket /call — ping → pong echo', () => {
  let app: FastifyInstance;
  let port: number;
  let ws: WebSocket;

  beforeEach(async () => {
    ({ app, port } = await startApp());
    ws = await openWebSocket(`ws://127.0.0.1:${port}/call`);
  });

  afterEach(async () => {
    // Close the WebSocket before stopping the server so the server can drain.
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    await app.close();
  });

  it('WebSocket handshake at /call succeeds (readyState === OPEN)', () => {
    // If openWebSocket() in beforeEach rejected, this test would never reach
    // here. Reaching this assertion means the handshake succeeded.
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('receives "pong" after sending "ping"', async () => {
    const { message } = await sendAndReceive(ws, 'ping');
    expect(message).toBe('pong');
  });

  it('response is the string "pong" (not a Buffer or object wrapping pong)', async () => {
    const { message } = await sendAndReceive(ws, 'ping');
    // Strict type + value assertion: must be the plain string.
    expect(typeof message).toBe('string');
    expect(message).toBe('pong');
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Latency
// ---------------------------------------------------------------------------

describe('TASK-FND-05 / WebSocket /call — echo latency', () => {
  let app: FastifyInstance;
  let port: number;
  let ws: WebSocket;

  beforeEach(async () => {
    ({ app, port } = await startApp());
    ws = await openWebSocket(`ws://127.0.0.1:${port}/call`);
  });

  afterEach(async () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    await app.close();
  });

  it('echo round-trip completes in under 200ms (generous bound for CI environments)', async () => {
    const { elapsedMs } = await sendAndReceive(ws, 'ping');
    // The acceptance criterion says 50ms in production; we allow 200ms in test
    // environments to absorb scheduling jitter on CI runners.
    expect(elapsedMs).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Multiple messages
// ---------------------------------------------------------------------------

describe('TASK-FND-05 / WebSocket /call — multiple sequential messages', () => {
  let app: FastifyInstance;
  let port: number;
  let ws: WebSocket;

  beforeEach(async () => {
    ({ app, port } = await startApp());
    ws = await openWebSocket(`ws://127.0.0.1:${port}/call`);
  });

  afterEach(async () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    await app.close();
  });

  it('echoes "pong" for each of two sequential "ping" messages', async () => {
    // Register the listener before sending either message so no messages
    // are dropped between the two sends.
    const collectPromise = collectMessages(ws, 2);
    ws.send('ping');
    ws.send('ping');
    const messages = await collectPromise;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe('pong');
    expect(messages[1]).toBe('pong');
  });

  it('handles three consecutive ping messages without dropping any', async () => {
    const collectPromise = collectMessages(ws, 3);
    ws.send('ping');
    ws.send('ping');
    ws.send('ping');
    const messages = await collectPromise;
    expect(messages).toHaveLength(3);
    expect(messages.every((m) => m === 'pong')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — Edge cases
// ---------------------------------------------------------------------------

describe('TASK-FND-05 / WebSocket /call — edge cases', () => {
  let app: FastifyInstance;
  let port: number;
  let ws: WebSocket;

  beforeEach(async () => {
    ({ app, port } = await startApp());
    ws = await openWebSocket(`ws://127.0.0.1:${port}/call`);
  });

  afterEach(async () => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
    await app.close();
  });

  it('sending an empty string does not crash the server (connection stays open)', async () => {
    // The acceptance criterion only specifies the ping→pong contract. Sending
    // an empty string should not terminate the connection or throw an unhandled
    // error — the server must remain stable.
    ws.send('');
    // Give the server 100ms to process and optionally respond; then verify the
    // connection is still OPEN (or CLOSING, not CLOSED/ERROR).
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ws.readyState).not.toBe(WebSocket.CLOSED);
  });

  it('a second WebSocket client can independently connect to /call', async () => {
    const ws2 = await openWebSocket(`ws://127.0.0.1:${port}/call`);
    try {
      expect(ws2.readyState).toBe(WebSocket.OPEN);
      const { message } = await sendAndReceive(ws2, 'ping');
      expect(message).toBe('pong');
    } finally {
      ws2.close();
    }
  });

  it('GET /healthz continues to respond after a WebSocket session is active', async () => {
    // Proves the HTTP server is not blocked by the WS connection.
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
  });
});
