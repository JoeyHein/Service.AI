# AI CSR voice endpoints — phase_ai_csr_voice

Four public / admin endpoints land this phase. The voice WS
stream itself is a Twilio-facing contract, not a normal API
endpoint — see ARCHITECTURE §6g for its shape.

Conventions:
- `{ ok: true, data }` / `{ ok: false, error }`.
- Cross-tenant access → `404 NOT_FOUND` (no existence leak).
- Admin-only surfaces → `403 FORBIDDEN` for tech / dispatcher /
  CSR / franchisee owner.

---

## Phone provisioning

### POST /api/v1/franchisees/:id/phone/provision

Admin-only. Provisions a Twilio number through the pluggable
`PhoneProvisioner` (stub default returns a deterministic
`+1555xxxxxxx` per franchiseeId). Idempotent — second call
returns the existing number with `alreadyProvisioned: true`.

**Body (optional):**
```json
{ "areaCode": "720", "friendlyName": "Elevated Denver" }
```

**201 / 200 response:**
```json
{
  "ok": true,
  "data": {
    "phoneNumberE164": "+17205550123",
    "twilioSid": "PN...",
    "alreadyProvisioned": false
  }
}
```

### GET /api/v1/franchisees/:id/phone

Returns the current provisioned number (or null). Admin-only.

---

## Guardrails

### PATCH /api/v1/franchisees/:id/ai-guardrails

Partial-merge update of the franchisee's jsonb guardrail config.
Admin-only.

**Body (all optional):**
```json
{
  "confidenceThreshold": 0.85,
  "undoWindowSeconds": 1800,
  "transferOnLowConfidence": true
}
```

Field bounds:
- `confidenceThreshold` ∈ [0, 1].
- `undoWindowSeconds` ∈ [0, 86400] (1 day).

---

## Voice inbound webhook (Twilio-facing)

### POST /voice/incoming

`apps/voice` surface. Twilio POSTs `x-www-form-urlencoded` with
`X-Twilio-Signature`. Signature verified via the
`TelephonyClient`; missing or wrong → `400 BAD_SIGNATURE`.

**Success (known `To` number):** TwiML that opens
`<Connect><Stream>` to the WS endpoint with the franchisee id
carried as a custom parameter.

**Unknown `To` number:** TwiML `<Say>…<Hangup/>` (HTTP 200 so
Twilio records a successful webhook but the caller hears a
polite disconnect). No DB writes happen.

---

## Voice Media Streams (Twilio-facing)

### WS /voice/stream

Receives Twilio Media Streams JSON frames (`start`, `media`,
`stop`). On `start`:
1. Resolve tenant from the `customParameters.toE164`.
2. Spin up a `CallOrchestrator` with ASR + TTS adapters, the
   `CSR` tool set, and the tenant's guardrails.
3. Push inbound audio frames into the ASR session.
4. When the agent emits a text turn, stream TTS frames back via
   `event: 'media'` JSON frames.

Unknown tenant on `start` → the socket closes immediately; no
`ai_conversations` / `call_sessions` row is written.

---

## Error code reference (phase 9 additions)

| Code | HTTP | Meaning |
|---|---|---|
| `FORBIDDEN`         | 403 | Caller is not an admin of this franchisor. |
| `BAD_SIGNATURE`     | 400 | Twilio signature missing or invalid. |
| `VALIDATION_ERROR`  | 400 | Non-UUID id, bad area code, out-of-range guardrails, etc. |
| `NOT_FOUND`         | 404 | Franchisee id unknown. |
| `INVALID_TARGET`    | 400 | Tool argument references a row in another tenant. |
| `INVALID_INPUT`     | 400 | Required tool fields missing. |

---

## Guardrail defaults

```json
{
  "confidenceThreshold": 0.8,
  "undoWindowSeconds": 900,
  "transferOnLowConfidence": true
}
```

Every newly-inserted `franchisees` row inherits these via the
schema default, so voice boots safely without requiring an
explicit admin step post-onboarding.

## Real ASR / TTS / Grok (phase_voice_port, VP — 2026-05-20)

The voice plumbing (Twilio media streams + `CallOrchestrator` + the CSR
tool-loop) shipped earlier with **stub** ASR/TTS. VP wired the real adapters,
ported from Donna (`email-ai-tool`):

- **ASR** — `deepgramAsrClient` in `packages/ai/asr.ts` (Deepgram
  nova-2-phonecall, µ-law 8kHz, interim + speech_final endpointing).
  `resolveAsrClient()` returns it when `DEEPGRAM_API_KEY` is set, else the stub.
- **TTS** — `elevenLabsTtsClient` in `packages/ai/tts.ts` (ElevenLabs
  flash_v2_5, `ulaw_8000`, re-chunked to 160-byte Twilio frames).
  `resolveTtsClient()` gated on `ELEVENLABS_API_KEY`; `ELEVENLABS_VOICE_ID`
  overrides the default voice.
- **Grok** — `grokAIClient` in `packages/ai/client.ts` (xAI OpenAI-compatible
  API via the `openai` SDK at `api.x.ai/v1`). `resolveAIClient()` selects by
  `AI_PROVIDER` (`claude` default | `grok`); Grok gated on `XAI_API_KEY`.

All three are boot-safe (fall back to stub when keys are unset). Verified by
mocked unit tests (Deepgram live-conn mock, ElevenLabs fetch/stream mock, Grok
completions mock). **Live phone-call quality is not yet validated** — that
needs a real pilot call with the keys configured (same as the go-live
one-real-transaction step).

Env (set in DO per the go-live runbook): `DEEPGRAM_API_KEY`,
`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `XAI_API_KEY`, `AI_PROVIDER`.
