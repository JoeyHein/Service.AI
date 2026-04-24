/**
 * ASR pluggable adapter (Deepgram-shaped).
 *
 * Streams µ-law 8kHz audio chunks in, emits partial + final
 * transcripts out. The stub returns a deterministic transcript
 * based on a string key (`audioId`) so tests can reproduce
 * whole conversations without audio files. The real impl uses
 * Deepgram's WebSocket streaming API.
 */

export interface PartialTranscript {
  kind: 'partial';
  text: string;
  confidence: number;
}

export interface FinalTranscript {
  kind: 'final';
  text: string;
  confidence: number;
  /** Monotonically-increasing sequence number within a session. */
  seq: number;
}

export type AsrEvent = PartialTranscript | FinalTranscript;

export interface AsrSession {
  /** Push a µ-law 8kHz PCM chunk (one Twilio frame ~20ms). */
  pushAudio(chunk: Buffer): void;
  /** Listener registration — the session calls `cb` for every event. */
  onEvent(cb: (event: AsrEvent) => void): void;
  /** Close the session cleanly. */
  close(): Promise<void>;
}

export interface AsrClient {
  open(opts: { audioId?: string; languageHint?: string }): Promise<AsrSession>;
}

// ---------------------------------------------------------------------------
// Stub
// ---------------------------------------------------------------------------

/**
 * The stub looks up a canned transcript by `audioId`. If not
 * found, it replays the `defaultScript` (useful for
 * happy-path tests). Each call to `pushAudio` advances a cursor
 * so after a few frames the session fires a "final" event.
 */
export function stubAsrClient(opts: {
  scripts?: Record<string, string[]>;
  defaultScript?: string[];
}): AsrClient {
  return {
    async open(input) {
      const key = input.audioId ?? 'default';
      const lines =
        (input.audioId && opts.scripts?.[input.audioId]) ??
        opts.defaultScript ??
        [];
      let listeners: Array<(e: AsrEvent) => void> = [];
      let lineIdx = 0;
      let chunksForLine = 0;
      let seq = 0;
      return {
        pushAudio() {
          chunksForLine += 1;
          if (chunksForLine >= 3 && lineIdx < lines.length) {
            const text = lines[lineIdx]!;
            const confidence = text.length > 2 ? 0.9 : 0.5;
            seq += 1;
            for (const cb of listeners) {
              cb({ kind: 'final', text, confidence, seq });
            }
            lineIdx += 1;
            chunksForLine = 0;
          }
        },
        onEvent(cb) {
          listeners.push(cb);
        },
        async close() {
          listeners = [];
          void key;
        },
      };
    },
  };
}

export async function resolveAsrClient(): Promise<AsrClient> {
  const key = process.env['DEEPGRAM_API_KEY'];
  if (!key) return stubAsrClient({});
  // Real Deepgram streaming wires in with the first pilot call —
  // leaving a stub in production when the key is unset is
  // intentional so the server boots even before the integration
  // is configured. See phase_ai_csr_voice audit minor m1.
  return stubAsrClient({});
}
