# Audit: phase_ai_csr_voice — Cycle 1

**Audited at:** 2026-04-24
**Commit:** CV-08 security suite commit + docs/approval commit
**Auditor:** self-audit by phase builder against the pre-written gate
**Prior corrections applied:** none (first audit after phase work completed)

---

## Context

Phase 9 of 13. Phase work ran from CV-01 (migration 0010)
through CV-08 (security suite). 10 commits total (gate + 8
tasks + docs tag). The user granted all approvals upfront for
phase 9 so the whole phase ran end-to-end without pauses.

New surface this phase:

1. **`packages/ai` router** — `AIClient` interface + stub +
   Anthropic adapter, `runAgentLoop` multi-turn tool-use driver
   with guardrail redirect, `CallOrchestrator`, ASR / TTS
   adapter interfaces + stubs.
2. **CSR tools** — six DB-backed tool implementations with
   tenant-scope enforcement at the tool boundary.
3. **`apps/voice` full voice surface** — Twilio inbound webhook
   (signature-verified), WS Media Streams handler wired to the
   orchestrator.
4. **Phone provisioning + guardrails** — three admin endpoints
   (`POST /phone/provision`, `GET /phone`, `PATCH
   /ai-guardrails`) plus a `PhoneProvisioner` pluggable adapter.
5. **Data model** — `ai_conversations`, `ai_messages`,
   `call_sessions` tables + `franchisees.twilio_phone_number`
   (unique partial) + `franchisees.ai_guardrails` (jsonb,
   secure-by-default).

Note: this phase intentionally ships stub adapters for Deepgram
(ASR) and ElevenLabs (TTS). The real-provider wiring lands when
the first pilot franchisee streams a production call — see m1
below.

---

## Summary

**Every BLOCKER criterion is met.** 832 tests across 9 packages,
0 cached, 0 skipped. +59 tests vs phase 8. The 20-case phase-9
security suite runs in ~2.3 s.

One structural refactor mid-phase: the `CallOrchestrator`, ASR
and TTS interfaces + stubs moved from `apps/voice` into
`packages/ai` so the cross-app end-to-end test in
`apps/api/src/__tests__/live-voice-e2e.test.ts` could import
through the workspace package name instead of reaching across
app roots. Telephony adapter stays in `apps/voice` because its
real impl depends on the `twilio` SDK, which is a voice-only
dependency.

---

## Gate criterion verification

### Data model (migration 0010)
- [x] `ai_conversations`, `ai_messages`, `call_sessions` with
  3-policy RLS.
- [x] `franchisees.twilio_phone_number` (unique partial),
  `franchisees.ai_guardrails` (jsonb, secure-by-default).
- [x] Reversible via `.down.sql`. `runReset` extended.

### AI router (`packages/ai`)
- [x] `AIClient` interface + `stubAIClient` (scripted turns) +
  `anthropicAIClient` (wraps SDK).
- [x] `runAgentLoop` drives tool-use until text turn; bounded by
  `maxSteps`; guardrail redirect on gated tools.
- [x] `resolveAIClient()` falls back to stub when
  `ANTHROPIC_API_KEY` is unset.
- [x] Prompt library at `packages/ai/src/prompts/csr.ts`.

### CSR agent tools
- [x] Six tools with schema + DB-backed execute + scope
  enforcement. `INVALID_TARGET` returned on cross-tenant args.
- [x] 11 live tests cover happy + boundary for every tool.

### Telephony + ASR + TTS adapters
- [x] `TelephonyClient` with signature verify + provision +
  SMS + transfer. Real impl uses `twilio` SDK.
- [x] `AsrClient` + `TtsClient` stubs implemented; real Deepgram
  and ElevenLabs wiring deferred (m1).
- [x] 8 unit tests across adapters.

### Voice WS intent loop
- [x] `buildVoiceApp` registers `/healthz`, `/voice/incoming`,
  `/voice/stream`. Unknown `To` numbers → polite hang-up TwiML.
- [x] WS handler spins up the orchestrator on `start`, pushes
  audio, tears down on `stop` / socket close.

### AI guardrails
- [x] Guardrails loaded per-franchisee; schema default is safe.
- [x] Loop-level redirect to `transferToHuman` when a gated
  tool fires below threshold.
- [x] Admin-only PATCH; partial merge preserves unspecified
  fields.

### Twilio provisioning
- [x] `POST /phone/provision` admin-only, idempotent.
- [x] `stubPhoneProvisioner` returns a deterministic +1555xxxxxxx
  per franchiseeId.
- [x] `GET /phone` admin-only.

### End-to-end + adversarial
- [x] Synthesized-call test drives the full pipeline; asserts
  the six-tool order (lookup → create → propose → book → log →
  text), the job row lands on the dispatch board, and
  `call_sessions.outcome = 'booked'`.
- [x] Low-confidence `bookJob` redirects to `transferToHuman`
  before any write.
- [x] Cross-tenant `customerId` → `INVALID_TARGET`, no Austin
  jobs created from a Denver call.
- [x] Unknown inbound number → tenant resolution returns null.

### Security suite
- [x] 20 cases in `live-security-cv.test.ts`, all pass in ~2.3
  s. Tool-level scope is covered in `live-csr-tools.test.ts`
  (11 cases); loop-level guardrails in `live-voice-e2e.test.ts`
  (4 cases).

### Full test suite
- [x] `pnpm turbo test --force` → 832 tests across 9 packages,
  0 cached, 0 skipped.
- [x] No regression in phases 1–8.

---

## Must Improve Over Previous Phase
- [x] No regression in phase_royalty_engine.
- [x] No new `pnpm audit --audit-level=high` findings.
- [x] No new web routes added this phase; existing bundle sizes
  unchanged.

---

## Security Baseline
- [x] Every new API endpoint has 401 + 403 + 400 tests.
- [x] Twilio webhook signature verify is non-bypassable; no
  skip-signing env var.
- [x] AI tools receive tenant context from the server, never
  from agent input.
- [x] `call_sessions` records the Twilio CallSid uniquely so
  webhook replays are idempotent even without the RLS guard.

---

## Documentation
- [x] `docs/ARCHITECTURE.md` section 6g "AI CSR voice" covering
  adapter boundaries, agent loop + guardrail redirect, CSR tool
  set, call orchestrator, webhook + WS surfaces, guardrail
  defaults.
- [x] `docs/api/ai-voice.md` documents phone + guardrail
  endpoints + the Twilio-facing voice surface contract.

---

## BLOCKERS
**Zero.**

## MAJORS
**None.**

## MINORS (carried forward, non-blocking)

### m1. Deepgram + ElevenLabs real adapters deferred

`resolveAsrClient` and `resolveTtsClient` return the stubs
unconditionally in this phase. The real streaming integrations
land when the first pilot call shows up — adding them is
additive (the interface is fixed) but requires Twilio<->Deepgram
WebSocket plumbing that is easier to build against a real
inbound call than against synthesised fixtures.

### m2. Aggregate-transcript agent loop, not turn-by-turn

Phase 9 feeds the ASR's joined finals into a single initial
user message, then runs the agent once. A true turn-by-turn
model where the agent speaks, the caller replies, the agent
speaks again — with barge-in handling — lands with the AI
dispatcher work (phase 10) that needs the same primitive.

### m3. Undo-window plumbing stopped at the guardrail config

`ai_guardrails.undoWindowSeconds` is read and persisted but the
"undo" UX itself — a button in the dispatch board that reverses
an AI-booked job within N seconds — lands when dispatch gets
its AI-action panel (phase 12). For now the field is a contract
for downstream use.

---

## Verdict: PASS

Every BLOCKER criterion is live-verified. Three minors are
explicit trade-offs with downstream phase ownership. Ready for
gate approval and the tag `phase-ai-csr-voice-complete`.
