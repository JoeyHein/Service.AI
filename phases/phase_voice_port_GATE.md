# Phase Gate: phase_voice_port

**STATUS: SHIPPED 2026-05-20. VP-01..04 landed. Ref: `docs/api/ai-voice.md`.**

Phase 21 — first "harvest existing assets" phase. Ported Donna's proven
Deepgram STT + ElevenLabs TTS into Service.AI (whose ASR/TTS were stubs), and
added a Grok provider to the AI router. Local-only.

## Shipped
- **VP-01** — `@deepgram/sdk` + `deepgramAsrClient` (port of Donna's
  `lib/voice/deepgram.ts`) in `packages/ai/asr.ts`; `resolveAsrClient` returns
  it on `DEEPGRAM_API_KEY`. 5 mocked tests.
- **VP-02** — `elevenLabsTtsClient` (port of `streamTtsMulaw`) in
  `packages/ai/tts.ts`, re-chunked to 160-byte Twilio frames; `resolveTtsClient`
  on `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`. 4 mocked tests.
- **VP-03** — `grokAIClient` (xAI OpenAI-compatible via `openai` SDK) +
  `resolveAIClient` provider selection (`AI_PROVIDER`, default claude; Grok on
  `XAI_API_KEY`). 3 mocked tests.
- **VP-04** — `.do/app.yaml` env (XAI_API_KEY, AI_PROVIDER, ELEVENLABS_VOICE_ID),
  `docs/api/ai-voice.md` updated.

All boot-safe (stub fallback when keys unset). ai suite 19 tests green.

## Verification ceiling
Mocked unit tests + typecheck only. **Live phone-call quality (real Twilio →
Deepgram → loop → ElevenLabs) is unvalidated** — needs a pilot call with keys,
same as the go-live one-real-transaction.

## Gate Decision
**APPROVED + SHIPPED** (2026-05-20, Joey). Local-only.
