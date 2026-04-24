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

export async function resolveTtsClient(): Promise<TtsClient> {
  const key = process.env['ELEVENLABS_API_KEY'];
  if (!key) return stubTtsClient();
  // Real ElevenLabs streaming wires in later — see phase audit
  // minor m1.
  return stubTtsClient();
}
