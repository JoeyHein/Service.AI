# Audit: phase_ai_dispatcher — Cycle 1

**Audited at:** 2026-04-24
**Commit:** DI-08 security suite commit + docs/approval commit
**Auditor:** self-audit by phase builder against the pre-written gate
**Prior corrections applied:** none (first audit after phase work completed)

---

## Context

Phase 10 of 13. Phase work ran from DI-01 (migration 0011)
through DI-08 (security suite). 10 commits total (gate + 8
tasks + docs tag). User granted all approvals upfront.

New surface:

1. **Tables** — `ai_suggestions`, `ai_metrics`, `tech_skills`
   + a jsonb default bump on `franchisees.ai_guardrails` to
   include `dispatcherAutoApplyThreshold`.
2. **Distance Matrix adapter** — deterministic haversine stub
   (35 mph) + a Google fetch-based real impl that falls back to
   the stub on error.
3. **Six dispatcher tools** — DB-backed; scope-enforced at the
   tool boundary.
4. **`runDispatcher`** — wraps `runAgentLoop`, enforces three
   scheduling invariants, auto-applies above threshold +
   queues otherwise, upserts `ai_suggestions`.
5. **Suggestions API + metrics endpoint + cancellation reflow
   hook** — all wired into `buildApp`.
6. **Dispatch board UI** — right-rail AI suggestions panel with
   Approve/Reject/Suggest.

---

## Summary

**Every BLOCKER criterion is met.** 873 tests across 9 packages,
0 cached, 0 skipped. +41 new tests vs phase 9. The 20-case
phase-10 security suite runs in ~2.7 s.

One mid-phase fix: the approve/reject handlers initially used
only RLS for tenancy. Dev superuser bypasses RLS, so a denver
dispatcher could approve an austin suggestion. Fixed by adding
explicit `franchisee_id` filtering in the handler
(defence-in-depth matching the documented pattern in
CLAUDE.md). Now all cross-tenant paths return 404.

---

## Gate criterion verification

### Data model (migration 0011)
- [x] `ai_suggestions`, `ai_metrics`, `tech_skills` with
  3-policy RLS.
- [x] `franchisees.ai_guardrails` default bumped to include
  `dispatcherAutoApplyThreshold=0.8`.
- [x] Reversible via `.down.sql`, runReset extended.

### Distance Matrix adapter
- [x] `DistanceMatrixClient` + stub (haversine) + real (Google
  fetch, falls back to stub on error).
- [x] 6 unit tests cover haversine determinism + stub shape +
  minimum-duration floor + 10-mi-hop band.

### Dispatcher tools
- [x] 6 DB-backed tools with cross-tenant INVALID_TARGET
  returns.
- [x] 9 live tests.

### Dispatcher runner
- [x] `runDispatcher` persists via `ai_suggestions`.
- [x] Three scheduling invariants enforced (double-book, skill
  match via "requires: <skill>" reasoning convention, travel
  budget + 15-min buffer).
- [x] Failed invariants drop to `pending` with
  `rejectedInvariant` stamped.

### Suggestions API
- [x] POST /suggest, GET /suggestions, POST /approve, POST
  /reject, GET /metrics.
- [x] Dispatch-role gate uniformly applied; admins impersonate
  to trigger.
- [x] Approve stale-job → 409 `STALE_SUGGESTION`.
- [x] 6 live tests.

### Dispatch board UI
- [x] `AiSuggestionsPanel` with Approve / Reject / Suggest.
- [x] Route bundle 122 kB — under the 180 kB loosened ceiling.

### Cancellation reflow + metrics
- [x] Reflow subscribes to `job.transitioned` + flips
  pending → expired on canceled.
- [x] `computeDailyAiMetrics` + `GET /dispatch/metrics` for
  daily rollup.

### Security suite
- [x] 20 cases in `live-security-di.test.ts`, all pass in
  ~2.7 s.
- [x] Anonymous 401 × 5, role × 5, cross-tenant × 3, state
  machine + validation × 5, scheduling invariants × 2.

### Full test suite
- [x] `pnpm turbo test --force` → 873 tests across 9 packages,
  0 cached, 0 skipped.
- [x] No regression in phases 1–9.

---

## Must Improve Over Previous Phase
- [x] No regression in phase_ai_csr_voice.
- [x] No new `pnpm audit --audit-level=high` findings.
- [x] `/dispatch` route JS: 122 kB (was 121 kB).

---

## Security Baseline
- [x] Every new API endpoint has 401 + 403 + 400 tests.
- [x] Dispatcher tools enforce tenant scope; cross-franchisee
  arguments → INVALID_TARGET.
- [x] Applying a suggestion re-verifies tenancy inside the
  handler (not relying on RLS alone).

---

## Documentation
- [x] `docs/ARCHITECTURE.md` section 6h "AI dispatcher".
- [x] `docs/api/ai-dispatcher.md` documents each new endpoint
  + scheduling-invariant behaviour.

---

## BLOCKERS
**Zero.**

## MAJORS
**None.**

## MINORS (carried forward, non-blocking)

### m1. Skill match uses a reasoning-string convention, not a
     job column

Phase 10 asks the agent to encode required skills as "requires:
<skill>" in its reasoning text. The runner extracts the first
match and checks `tech_skills` against it. This is enough to
prove the invariant works but a proper `jobs.required_skills`
column with a migration + CSR-tool plumbing is a natural
follow-up when the pilot demands more granular matching.

### m2. No automatic re-suggest on cancellation reflow

When a job cancels, pending suggestions for it are expired —
but nothing queues a new dispatcher run for the freed-up
tech. A future phase can kick a re-run + merge new suggestions
into the UI.

### m3. Scheduling buffer is a hard-coded 15 minutes

The travel-budget invariant uses a fixed `15 * 60` buffer. Real
franchisees may want a configurable per-franchisee buffer
(urban Denver vs suburban Austin). One-line addition to the
guardrails jsonb when the operational ask shows up.

---

## Verdict: PASS

Every BLOCKER criterion is live-verified. Three minors are
explicit trade-offs with downstream phase ownership. Ready for
gate approval and the tag `phase-ai-dispatcher-complete`.
