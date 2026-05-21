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

// ---------------------------------------------------------------------------
// Real (Deepgram) — VP-01, ported from Donna's lib/voice/deepgram.ts
// ---------------------------------------------------------------------------

/**
 * Deepgram streaming STT for Twilio Media Streams. Twilio sends base64 µ-law
 * 8kHz frames; Deepgram accepts them directly with encoding=mulaw. Config
 * (nova-2-phonecall, interim results, speech_final endpointing) is tuned for
 * phone-call turn-taking — kept verbatim from the proven Donna setup.
 */
export function deepgramAsrClient(apiKey: string): AsrClient {
  return {
    async open(input) {
      // Dynamic import so the SDK only loads when a real key is configured
      // (the stub path stays dependency-free for the common boot case).
      const { createClient, LiveTranscriptionEvents } = await import('@deepgram/sdk');
      const dg = createClient(apiKey);
      const conn = dg.listen.live({
        model: 'nova-2-phonecall',
        encoding: 'mulaw',
        sample_rate: 8000,
        channels: 1,
        interim_results: true,
        smart_format: true,
        endpointing: 150,
        utterance_end_ms: 1000,
        vad_events: true,
        ...(input.languageHint ? { language: input.languageHint } : {}),
      });

      let listeners: Array<(e: AsrEvent) => void> = [];
      let seq = 0;

      conn.on(LiveTranscriptionEvents.Transcript, (data: unknown) => {
        const d = data as {
          channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
          is_final?: boolean;
        };
        const alt = d?.channel?.alternatives?.[0];
        if (!alt?.transcript) return;
        const confidence = alt.confidence ?? 0.9;
        if (d.is_final) {
          seq += 1;
          const evt: AsrEvent = { kind: 'final', text: alt.transcript, confidence, seq };
          for (const cb of listeners) cb(evt);
        } else {
          const evt: AsrEvent = { kind: 'partial', text: alt.transcript, confidence };
          for (const cb of listeners) cb(evt);
        }
      });

      return {
        pushAudio(chunk: Buffer) {
          if (conn.getReadyState() === 1) {
            const ab = chunk.buffer.slice(
              chunk.byteOffset,
              chunk.byteOffset + chunk.byteLength,
            ) as ArrayBuffer;
            conn.send(ab);
          }
        },
        onEvent(cb) {
          listeners.push(cb);
        },
        async close() {
          try {
            conn.requestClose();
          } catch {
            /* already closed */
          }
          listeners = [];
        },
      };
    },
  };
}

export async function resolveAsrClient(): Promise<AsrClient> {
  const key = process.env['DEEPGRAM_API_KEY'];
  // Boot-safe: fall back to the stub when the key is unset so the server
  // still starts before voice is configured.
  if (!key) return stubAsrClient({});
  return deepgramAsrClient(key);
}
