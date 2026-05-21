import { describe, it, expect, vi, afterEach } from 'vitest';
import { elevenLabsTtsClient, stubTtsClient } from './tts.js';

function streamOf(bytes: Uint8Array, chunkSize = 100): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('elevenLabsTtsClient', () => {
  it('re-chunks the stream to ≤160-byte Twilio frames and preserves bytes', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({
      ok: true,
      body: streamOf(new Uint8Array(350)), // 350 → 160 + 160 + 30
      text: async () => '',
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { chunks, done } = elevenLabsTtsClient('xi_key').speak({ text: 'hello' });
    const sizes: number[] = [];
    let total = 0;
    for await (const c of chunks) {
      sizes.push(c.byteLength);
      total += c.byteLength;
    }
    await done;

    expect(Math.max(...sizes)).toBeLessThanOrEqual(160);
    expect(total).toBe(350);
    // Hits the µ-law streaming endpoint with the api key.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/stream?output_format=ulaw_8000');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['xi-api-key']).toBe('xi_key');
  });

  it('honors a voiceId override in the URL', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({ ok: true, body: streamOf(new Uint8Array(10)), text: async () => '' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { chunks, done } = elevenLabsTtsClient('k').speak({ text: 'hi', voiceId: 'VOICE123' });
    for await (const _ of chunks) void _;
    await done;
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/VOICE123/stream');
  });

  it('throws on a non-OK response', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401, body: null, text: async () => 'bad key' })) as unknown as typeof fetch;
    const { chunks } = elevenLabsTtsClient('k').speak({ text: 'hi' });
    await expect(async () => {
      for await (const _ of chunks) void _;
    }).rejects.toThrow(/401/);
  });
});

describe('stubTtsClient (unchanged fallback)', () => {
  it('emits silent frames and resolves done', async () => {
    const { chunks, done } = stubTtsClient().speak({ text: 'hi' });
    let frames = 0;
    for await (const c of chunks) {
      expect(c.byteLength).toBe(160);
      frames += 1;
    }
    await done;
    expect(frames).toBeGreaterThan(0);
  });
});
