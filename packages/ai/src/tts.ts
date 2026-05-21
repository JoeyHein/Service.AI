/**
 * TTS pluggable adapter (ElevenLabs-shaped).
 *
 * Accepts text, streams µ-law 8kHz audio frames back. The stub
 * emits silent frames sized roughly proportional to the text
 * length so the loop's timing is approximated in tests without
 * a real codec.
 */

export interface TtsStream {
  /** Async iterator of µ-law 8kHz buffers. Each buffer is <= 1 Twilio frame. */
  chunks: AsyncIterable<Buffer>;
  /** Resolves when the provider has finished sending. */
  done: Promise<void>;
}

export interface TtsClient {
  speak(opts: { text: string; voiceId?: string }): TtsStream;
}

// ---------------------------------------------------------------------------
// Stub
// ---------------------------------------------------------------------------

const TWILIO_FRAME_BYTES = 160; // 20ms at 8kHz µ-law

export function stubTtsClient(): TtsClient {
  return {
    speak({ text }) {
      // ~60ms per character as a stand-in for real phonetic duration.
      const totalMs = Math.max(120, text.length * 60);
      const totalFrames = Math.ceil(totalMs / 20);
      async function* gen(): AsyncGenerator<Buffer> {
        for (let i = 0; i < totalFrames; i++) {
          // Silent µ-law frame (0x7F is silence in µ-law).
          yield Buffer.alloc(TWILIO_FRAME_BYTES, 0x7f);
        }
      }
      const iter = gen();
      const doneResolver: { resolve: () => void; promise: Promise<void> } = (() => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        return { resolve, promise };
      })();
      const chunks: AsyncIterable<Buffer> = {
        [Symbol.asyncIterator]() {
          const inner = iter;
          return {
            async next() {
              const r = await inner.next();
              if (r.done) doneResolver.resolve();
              return r;
            },
          };
        },
      };
      return { chunks, done: doneResolver.promise };
    },
  };
}

// ---------------------------------------------------------------------------
// Real (ElevenLabs) — VP-02, ported from Donna's lib/voice/elevenlabs.ts
// ---------------------------------------------------------------------------

const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'; // "Sarah"
const FLASH_MODEL = 'eleven_flash_v2_5'; // lowest-latency model (~75ms TTFB)

/**
 * ElevenLabs streaming TTS → µ-law 8kHz, the format Twilio Media Streams want
 * (no transcoding). Config (flash_v2_5, latency 4, voice settings) is kept
 * from the proven Donna setup. Output is re-chunked to ≤160-byte frames
 * (one 20ms Twilio frame) to match the loop's expectation.
 */
export function elevenLabsTtsClient(apiKey: string): TtsClient {
  return {
    speak({ text, voiceId }) {
      const vid = voiceId ?? process.env['ELEVENLABS_VOICE_ID'] ?? DEFAULT_VOICE_ID;
      const doneResolver: { resolve: () => void; reject: (e: unknown) => void; promise: Promise<void> } =
        (() => {
          let resolve!: () => void;
          let reject!: (e: unknown) => void;
          const promise = new Promise<void>((res, rej) => {
            resolve = res;
            reject = rej;
          });
          return { resolve, reject, promise };
        })();

      async function* gen(): AsyncGenerator<Buffer> {
        const url =
          `https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream` +
          `?output_format=ulaw_8000&optimize_streaming_latency=4`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/basic',
          },
          body: JSON.stringify({
            text,
            model_id: FLASH_MODEL,
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.85,
              style: 0.0,
              use_speaker_boost: true,
            },
          }),
        });
        if (!res.ok || !res.body) {
          const body = await res.text().catch(() => '');
          throw new Error(`ElevenLabs TTS ${res.status}: ${body}`);
        }
        const reader = res.body.getReader();
        let leftover = Buffer.alloc(0);
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              let buf = Buffer.concat([leftover, Buffer.from(value)]);
              while (buf.byteLength >= TWILIO_FRAME_BYTES) {
                yield buf.subarray(0, TWILIO_FRAME_BYTES);
                buf = buf.subarray(TWILIO_FRAME_BYTES);
              }
              leftover = buf;
            }
          }
          if (leftover.byteLength > 0) yield leftover;
        } finally {
          reader.releaseLock();
        }
      }

      const iter = gen();
      const chunks: AsyncIterable<Buffer> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              try {
                const r = await iter.next();
                if (r.done) doneResolver.resolve();
                return r;
              } catch (e) {
                doneResolver.reject(e);
                throw e;
              }
            },
          };
        },
      };
      return { chunks, done: doneResolver.promise };
    },
  };
}

export async function resolveTtsClient(): Promise<TtsClient> {
  const key = process.env['ELEVENLABS_API_KEY'];
  // Boot-safe: stub until the key is configured.
  if (!key) return stubTtsClient();
  return elevenLabsTtsClient(key);
}
