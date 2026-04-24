# Phase Gate: phase_ai_csr_voice

**Written before build begins. Criteria here cannot be loosened mid-phase.**

Phase 9 of 13. AI answers the phone, books jobs end-to-end. A
caller dials the demo franchisee's Twilio number, the AI greets
them, collects name + address + symptom, checks tech
availability, books a job, and sends an SMS confirmation. The
job appears on the dispatch board before they hang up.

Every new primitive reuses the pattern set by phases 3–8 —
pluggable external-service adapters, stub defaults, real
implementations behind env vars. The AI router itself is its own
pluggable boundary so tests drive scripted conversations through
the full intent loop without hitting Anthropic.

**After this phase, Elevated Doors can point a production Twilio
number at the voice service and start booking from the field
without a human CSR picking up.**

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### Data model (migration 0010)

- [ ] `ai_conversations` table: `id`, `franchiseeId`, `capability`
  (enum: 'csr.voice', 'dispatcher', 'tech.photoQuote',
  'collections'), `subjectCustomerId?`, `subjectJobId?`,
  `startedAt`, `endedAt?`, timestamps. 3-policy RLS.
- [ ] `ai_messages` table: `conversationId`, `role`
  ('system' | 'user' | 'assistant' | 'tool'), `content` (jsonb),
  `toolName?`, `toolInput?`, `toolOutput?`, `confidence?`,
  `costUsd?`, `provider?`, `model?`, `createdAt`. 3-policy RLS.
- [ ] `call_sessions` table: `id`, `franchiseeId`,
  `conversationId` (FK → ai_conversations), `twilioCallSid`
  (unique), `fromE164`, `toE164`, `direction` ('inbound' |
  'outbound'), `status` ('ringing' | 'in_progress' | 'completed' |
  'transferred' | 'failed'), `startedAt`, `endedAt?`,
  `recordingKey?`, `outcome` ('booked' | 'transferred' |
  'abandoned' | 'none'). 3-policy RLS.
- [ ] `franchisees.twilio_phone_number` (text, unique partial),
  `franchisees.ai_guardrails` (jsonb, default
  `{"confidenceThreshold": 0.8, "undoWindowSeconds": 900,
  "transferOnLowConfidence": true}`).
- [ ] Reversible migration.

### AI router (`packages/ai`)

- [ ] New package with `AIClient` interface:
  `call({ capability, messages, tools, maxSteps })` returns
  `{ messages, toolCalls, lastAssistant, confidence, costUsd }`.
  Exports stub + real (Anthropic) impls.
- [ ] `stubAIClient({ script })` accepts a scripted array of
  assistant turns so tests can drive the loop deterministically.
- [ ] `anthropicAIClient(apiKey)` wraps the Anthropic SDK; tool
  calls are multi-turn (assistant emits tool_use → harness
  executes → feeds tool_result back → repeat until the
  assistant emits a non-tool turn).
- [ ] Router persists every assistant message + tool call to
  `ai_messages` with `confidence`, `costUsd`, `provider`,
  `model` so we can audit AI actions after the fact.
- [ ] Prompt library at `packages/ai/prompts/csr.ts` — NOT inline
  string concatenation in business code.

### CSR agent tools

- [ ] Six tool implementations live in `packages/ai/src/tools/`:
  - `lookupCustomer({ phone?, name? })` — returns customer id +
    name + address snippet.
  - `createCustomer({ name, phone?, address? })` — inserts a
    customer row; address goes through the phase-3 Places
    adapter when present.
  - `proposeTimeSlots({ windowStart, windowEnd, techCount? })`
    — returns 3 candidate slots (greedy first-available across
    today + tomorrow).
  - `bookJob({ customerId, title, scheduledStart, scheduledEnd,
    assignedTechUserId? })` — creates a job + schedules it +
    emits `job.scheduled` on the EventBus.
  - `transferToHuman({ reason, priority })` — records an
    audit row, flips the call_session to 'transferred'.
  - `logCallSummary({ summary, intent, outcome })` — writes a
    summary message + stamps `call_sessions.outcome`.
- [ ] Each tool enforces scope via `{ franchiseeId, userId }`
  context passed in by the call harness. Cross-franchisee
  lookups return "not found" from the tool's POV so the agent
  doesn't accidentally leak.
- [ ] ≥ 12 unit tests across tools (happy path + scope
  violation + malformed input).

### Telephony + ASR + TTS adapters

- [ ] `TelephonyClient` interface covers: `provisionNumber(
  { areaCode, franchiseeId })`, `verifyTwilioSignature(url,
  params, signature)`, `sendSms({ to, from, body })`,
  `initiateTransfer({ callSid, destination })`. Stub + real.
- [ ] `AsrClient` streams 20ms µ-law chunks → partial + final
  transcripts. Stub emits a deterministic scripted transcript
  based on `input.audioId` so tests are reproducible.
- [ ] `TtsClient` accepts text → streams µ-law audio back. Stub
  returns silent 8kHz µ-law frames of length
  `ceil(text.length * 60ms)` so the loop's timing is
  approximated without a real codec.
- [ ] Adapters resolved from env: `TWILIO_ACCOUNT_SID +
  TWILIO_AUTH_TOKEN + TWILIO_WEBHOOK_SIGNING_KEY`,
  `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`. Missing → stub with
  WARN.

### Voice WS intent loop (`apps/voice`)

- [ ] `apps/voice` exposes an HTTP + WS Fastify server. Health:
  `GET /healthz`.
- [ ] `POST /voice/incoming` (HTTP) — Twilio webhook entry.
  Signature verified; responds with TwiML that opens a
  `<Stream>` to the WS endpoint. Unknown
  `To` numbers (no matching `franchisees.twilio_phone_number`)
  → `404 NOT_FOUND` with a polite hang-up message.
- [ ] `WS /voice/stream` — accepts Twilio Media Streams frames,
  pipes them through `AsrClient`, runs the intent loop when a
  final transcript arrives, streams TTS back. Emits `mark`
  frames on each TTS chunk for latency tracing.
- [ ] Loop persists a `call_sessions` row on start, updates on
  every state transition, and writes `ai_messages` rows via
  the AI router.

### AI guardrails

- [ ] Guardrail config is loaded per franchisee on call start
  (from `franchisees.ai_guardrails`). Defaults baked in so a
  newly onboarded franchisee is safe by default.
- [ ] When `confidence < confidenceThreshold` on a
  booking-related tool call, the loop invokes
  `transferToHuman` instead of proceeding.
- [ ] `undoWindowSeconds` is stamped on the `jobs.metadata`
  (new column or jsonb on existing) so a human can undo the AI
  booking within N seconds.
- [ ] Guardrail defaults are loaded at `GET /api/v1/me` for the
  web UI so the franchisor admin page can render/edit them
  (edit UI is out of scope for phase 9; field exposure is
  enough).

### Twilio phone provisioning

- [ ] `POST /api/v1/franchisees/:id/phone/provision` (admin-only)
  — calls `TelephonyClient.provisionNumber({ areaCode,
  franchiseeId })`, stamps `franchisees.twilio_phone_number`.
  Stub returns a deterministic `+1555*******` number based on
  franchiseeId so tests are reproducible.
- [ ] Franchisor UI page `/franchisor/franchisees/[id]/phone`
  surfaces the button + current number.
- [ ] Re-provisioning is a no-op when the franchisee already
  has a number (idempotent).

### Call persistence + end-to-end test

- [ ] Integration test drives a synthesized call through the
  loop with a scripted AI client:
  - Asserts the 6 tools fire in the expected order:
    `lookupCustomer` → `createCustomer` → `proposeTimeSlots`
    → `bookJob` → `logCallSummary`.
  - The job appears in `GET /api/v1/jobs` scoped to the
    franchisee within 2 seconds of the loop ending.
  - `call_sessions.outcome = 'booked'`.
- [ ] Adversarial-input tests:
  - Cross-tenant phone number → call rejected at `/voice/incoming`.
  - Low-confidence assistant turn → `transferToHuman` fires +
    `call_sessions.outcome = 'transferred'`.
  - Agent tries to call `bookJob` with another franchisee's
    `customerId` → tool returns `INVALID_TARGET`, loop
    continues.

### Security test suite

- [ ] ≥ 20 cases in `apps/api/src/__tests__/live-security-cv.test.ts`
  (+ voice-specific cases in `apps/voice`). Runtime < 30 s.
- [ ] Twilio webhook signature required → 400 on missing / wrong.
- [ ] Phone provisioning admin-only → 403.
- [ ] Anonymous webhook still validates signature (no bypass).
- [ ] Cross-tenant inbound call → 404 without tenant leak.

### Unit + integration test suite

- [ ] `pnpm turbo test --force` → 0 cached, 0 skipped.
- [ ] No regression in phases 1–8.

---

## Must Improve Over Previous Phase

- [ ] No regression in phase_royalty_engine.
- [ ] No new `pnpm audit --audit-level=high` findings.
- [ ] New web routes stay under 130 kB First Load JS.

---

## Security Baseline

- [ ] Every new API endpoint has 401 + 403 + 400 tests.
- [ ] Twilio webhooks verify X-Twilio-Signature; signature secret
  is never logged.
- [ ] AI tool calls cannot read/write across tenants — context
  is resolved server-side from the inbound number, never from
  agent input.
- [ ] Recording storage keys are tenant-scoped
  (`{franchiseeId}/calls/{callSid}`).

---

## Documentation

- [ ] `docs/ARCHITECTURE.md` section 6g "AI CSR voice" covering
  the call lifecycle, adapter boundaries, prompt library
  location, guardrail composition, and undo window semantics.
- [ ] `docs/api/ai-voice.md` documents the voice webhook, phone
  provisioning, and guardrail reads.

---

## Gate Decision

**Audited in:** `phase_ai_csr_voice_AUDIT_1.md` (cycle 1)
**Verdict:** PASS — approved 2026-04-24

All BLOCKER criteria verified. Three minors tracked in AUDIT_1
(m1: real Deepgram + ElevenLabs adapters deferred; m2:
aggregate-transcript agent loop becomes turn-by-turn in phase
10; m3: undo UX lives in dispatch phase 12). Tagged
`phase-ai-csr-voice-complete`.
