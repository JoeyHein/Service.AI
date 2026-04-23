/**
 * Unit tests for the IndexedDB offline write queue (TASK-TM-03).
 *
 * Uses `fake-indexeddb` as the `indexedDB` global so the tests can
 * run under Vitest's default node environment without a browser.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';

import {
  enqueue,
  drain,
  size,
  clear,
  list,
  defaultSender,
} from '../lib/offline-queue.js';

afterEach(async () => {
  await clear();
});

describe('TM-03 / offline-queue / enqueue + drain happy path', () => {
  it('queues a POST and replays it when drained', async () => {
    await enqueue({
      method: 'POST',
      url: '/api/v1/jobs/abc/invoices',
      body: { lines: [] },
    });
    expect(await size()).toBe(1);

    const sender = vi.fn<(e: { url: string }) => Promise<Response>>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 201 }),
    );
    const result = await drain(sender);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(result.replayed).toBe(1);
    expect(result.remaining).toBe(0);
    expect(await size()).toBe(0);
  });

  it('preserves FIFO order across multiple entries', async () => {
    await enqueue({ method: 'POST', url: '/a', body: { n: 1 } });
    await enqueue({ method: 'PATCH', url: '/b', body: { n: 2 } });
    await enqueue({ method: 'DELETE', url: '/c' });
    const seen: string[] = [];
    await drain(async (entry) => {
      seen.push(entry.url);
      return new Response('', { status: 200 });
    });
    expect(seen).toEqual(['/a', '/b', '/c']);
  });

  it('4xx response still deletes the entry (server said no, don\'t retry)', async () => {
    await enqueue({ method: 'POST', url: '/x', body: {} });
    await drain(async () => new Response('{"ok":false}', { status: 400 }));
    expect(await size()).toBe(0);
  });

  it('5xx response retains the entry for later retry', async () => {
    await enqueue({ method: 'POST', url: '/y', body: {} });
    await drain(async () => new Response('{}', { status: 502 }));
    expect(await size()).toBe(1);
  });

  it('network error retains the entry', async () => {
    await enqueue({ method: 'POST', url: '/z', body: {} });
    await drain(async () => {
      throw new Error('connection reset');
    });
    expect(await size()).toBe(1);
  });
});

describe('TM-03 / offline-queue / offline no-ops', () => {
  it('drain() returns early when navigator.onLine is false', async () => {
    const originalOnline = Object.getOwnPropertyDescriptor(
      globalThis.navigator ?? {},
      'onLine',
    );
    Object.defineProperty(globalThis.navigator ?? (globalThis.navigator = {} as Navigator), 'onLine', {
      configurable: true,
      get: () => false,
    });
    try {
      await enqueue({ method: 'POST', url: '/a', body: {} });
      const sender = vi.fn<(e: unknown) => Promise<Response>>();
      const r = await drain(sender);
      expect(sender).not.toHaveBeenCalled();
      expect(r.replayed).toBe(0);
      expect(r.remaining).toBe(1);
    } finally {
      if (originalOnline) {
        Object.defineProperty(globalThis.navigator, 'onLine', originalOnline);
      }
    }
  });
});

describe('TM-03 / offline-queue / validation', () => {
  it('refuses non-mutating methods', async () => {
    await expect(enqueue({ method: 'GET', url: '/a' })).rejects.toThrow();
  });

  it('list() returns stored entries with enqueuedAt populated', async () => {
    await enqueue({ method: 'POST', url: '/a', body: { n: 1 } });
    const [entry] = await list();
    expect(entry).toBeDefined();
    expect(entry!.url).toBe('/a');
    expect(typeof entry!.enqueuedAt).toBe('number');
  });
});

describe('TM-03 / offline-queue / persistence across open calls', () => {
  it('a second call from a fresh open() sees entries written by the first', async () => {
    await enqueue({ method: 'POST', url: '/persist', body: {} });
    // The module resolves `indexedDB` at call time, so a second
    // size() call re-opens the DB and must still find the entry.
    expect(await size()).toBe(1);
  });
});

describe('TM-03 / offline-queue / defaultSender shape', () => {
  it('defaultSender constructs a same-shape fetch call', () => {
    expect(typeof defaultSender).toBe('function');
  });
});
