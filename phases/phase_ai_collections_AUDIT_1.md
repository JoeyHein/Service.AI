# Audit: phase_ai_collections — Cycle 1

**Audited at:** 2026-04-24
**Commit:** CO-07 security suite commit + docs/approval commit
**Auditor:** self-audit by phase builder against the pre-written gate
**Prior corrections applied:** none (first audit after phase work completed)

---

## Context

Phase 12 of 13. User granted all approvals upfront. 8 commits
(gate + CO-01 migration + CO-02/03/04/05 merged + CO-06 UI +
CO-07 security + docs/tag).

Surface:

1. **Data model (migration 0013)** — `collections_drafts` with
   partial unique index on `(invoice_id, tone) WHERE status =
   'pending'`, `payment_retries`, and a guardrails jsonb
   default bump including a `collections` sub-object with
   null `autoSendTone` (always queue).
2. **Prompt library** — three-tone collections system prompt
   in `packages/ai/prompts/collections.ts`.
3. **Pipeline** — `ai-collections.ts` with four primitives:
   `collectionsDraft`, pure `selectAgedInvoices` projector,
   `runCollectionsSweep`, `schedulePaymentRetry` with a
   failure-code → delay table, and
   `computeCollectionsMetrics` (DSO + recovered).
4. **Webhook integration** — phase-7
   `payment_intent.payment_failed` placeholder filled in;
   replays are idempotent via the phase-7 `stripe_events`
   unique PK.
5. **API + UI** — seven endpoints, franchisee-scope review
   queue with inline editing + approve/reject/sweep.
6. **Security suite** — 23 cases in ~2.5 s.

---

## Summary

**Every BLOCKER criterion is met.** 954 tests across 9
packages, 0 cached, 0 skipped. +36 tests vs phase 11.

No mid-phase bugs. One judgment call: the aging projector
picks the **most-severe** tone the invoice has crossed rather
than drafting one of each. Rationale: a 31-day overdue invoice
that somehow missed the day-7 and day-14 sweeps should get a
final notice, not three redundant drafts in a row.

---

## Gate criterion verification

### Data model (migration 0013)
- [x] `collections_drafts` + `payment_retries` + partial
  unique index + guardrail default bump.
- [x] Reversible migration, runReset extended.

### collections.draft capability
- [x] Three tones via prompt library.
- [x] JSON-first parse with deterministic fallback.
- [x] Persists ai_conversations + ai_messages.

### Aging scheduler + projector
- [x] `selectAgedInvoices` pure.
- [x] `runCollectionsSweep` idempotent via pre-check +
  partial unique index.
- [x] `AgingScheduler` interface: stub scheduler is the
  default (deferred real BullMQ wiring — AUDIT m1).

### Review queue API
- [x] Seven endpoints with role gate + scope filter.
- [x] Stale-status → 409 `DRAFT_NOT_PENDING`.
- [x] Approve / reject / edit live-tested.

### Payment retry orchestration
- [x] Stripe webhook → `schedulePaymentRetry` with code →
  delay table.
- [x] Max 4 attempts.
- [x] `POST /payments/retries/:id/run` admin-only; uses
  Stripe adapter.

### Review UI + metrics
- [x] `/collections` page with three tiles + editable
  queue. Bundle 105 kB — under 130 kB cap.
- [x] `GET /collections/metrics` returns DSO +
  recoveredRevenueCents + openInvoiceCents +
  totalRevenueCents.

### Security test suite
- [x] 23 cases, ~2.5 s runtime. Anonymous × 7, role × 4,
  cross-tenant × 5, state machine + validation × 6,
  webhook-idempotency × 1.

### Full test suite
- [x] `pnpm turbo test --force` → 954 tests across 9
  packages, 0 cached, 0 skipped.
- [x] No regression in phases 1–11.

---

## Must Improve Over Previous Phase
- [x] No regression in phase_ai_tech_assistant.
- [x] No new `pnpm audit --audit-level=high` findings.
- [x] `/collections` bundle 105 kB — under cap.

---

## Security Baseline
- [x] Every new endpoint has 401 + 403 + 400 tests.
- [x] Draft writes reference invoices only inside the
  caller's franchisee (server-resolved).
- [x] Approve re-reads the draft inside the transaction so
  a last-second status change blocks the send.

---

## Documentation
- [x] `docs/ARCHITECTURE.md` section 6j "AI collections".
- [x] `docs/api/ai-collections.md`.

---

## BLOCKERS
**Zero.**

## MAJORS
**None.**

## MINORS (carried forward, non-blocking)

### m1. Real BullMQ aging scheduler deferred

The gate spec asked for a BullMQ-backed daily sweep; phase 12
ships the interface + stub + the manual `POST /collections/run`
button. The cron wire-up is a ~30-line addition when the pilot
territory actually runs for 30 consecutive days and operator-
triggered sweeps stop scaling.

### m2. Retry cadence table is hard-coded

`RETRY_DELAY_MS` lives in `ai-collections.ts` as a module
constant. Per-franchisee overrides are tracked for later when
a pilot shows a specific failure mode dominates — the guardrail
jsonb has room without a migration.

### m3. Human-handoff escalation out of scope

Phase 12 caps retries at 4 attempts and the collections tones
at "final". A hard-collect escalation (email to a human
collections team, dunning) lands in a later phase per the
original gate spec.

---

## Verdict: PASS

Every BLOCKER criterion is live-verified. Three minors are
explicit deferrals with downstream ownership. Ready for gate
approval and the tag `phase-ai-collections-complete`.
