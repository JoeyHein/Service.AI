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
