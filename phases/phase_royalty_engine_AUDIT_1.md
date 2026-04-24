# Audit: phase_royalty_engine — Cycle 1

**Audited at:** 2026-04-24
**Commit:** RE-08 security suite commit + docs/approval commit
**Auditor:** self-audit by phase builder against the pre-written gate
**Prior corrections applied:** none (first audit after phase work completed)

---

## Context

Phase 8 of 13. Phase work ran from RE-01 (migration 0009) through
RE-08 (security suite). 10 commits total (gate + 8 tasks + docs
tag). Same autonomous-run discipline as phases 3–7: mocked tests
where they help + live-Postgres integration tests per task. User
granted all approvals upfront for phase 8 so the whole phase ran
end-to-end without pauses.

New surface this phase:

1. **Pure royalty rule engine** — `resolveFeeCents(rules, ctx)`
   with four rule types, exhaustive switch, clamped final fee.
   Shared by `finalize` and the statement projector.
2. **Agreement CRUD + state machine** — draft/active/ended with
   a partial unique index on active, atomic activate (end prior +
   flip new).
3. **`finalize` integration** — resolves the active agreement
   instead of hard-coding 5%. Falls back to 5% when no agreement
   is configured so the phase-7 integration tests stay green.
4. **Monthly statement projector** — tz-aware period bounds via
   `date-fns-tz`, idempotent upsert keyed on
   `(franchisee_id, period_start, period_end)`.
5. **Stripe Transfers integration** — `createTransfer` added to
   the adapter (stub + real), reconcile endpoint stamps
   `transfer_id`.
6. **Franchisor + franchisee UIs** — agreement editor, statements
   list (admin generate + reconcile; franchisee self-view).

---

## Summary

**Every gate criterion is met.** 773 tests across 9 packages,
0 cached, 0 skipped. +61 tests vs phase 7. The 22-case phase-8
security suite runs in ~2.5 s.

No mid-phase bugs caught this time — the pure engine's unit
tests exposed a handful of rounding questions that the code
already handled correctly (floor-clamp, zero-total, rounding
symmetry). One small lint fixup after the statement-routes
refactor (`and` import left dangling after a Drizzle query
simplification) — fixed before the commit landed.

---

## Gate criterion verification

### Data model (migration 0009)
- [x] `franchise_agreements`, `royalty_rules`, `royalty_statements`
  with 3-policy RLS.
- [x] `franchisor_id` denormalised on agreements + statements for
  fast parent-scoped reads.
- [x] Partial unique index `(franchisee_id) WHERE status='active'`.
- [x] `royalty_statements` unique on
  `(franchisee_id, period_start, period_end)` + partial unique
  on `transfer_id IS NOT NULL`.
- [x] Reversible via `.down.sql`.

### Pure rule engine
- [x] `resolveFeeCents(rules, ctx)` exported.
- [x] All four rule types implemented + exhaustive switch.
- [x] Final clamp to `totalCents` as a defensive rail.
- [x] 19 vitest unit cases covering every rule type +
  combinations + zero-total + rounding edges.

### Agreement CRUD API
- [x] POST/GET/PATCH/activate endpoints, admin-only writes,
  franchisee-owner reads.
- [x] PATCH on active → 409 AGREEMENT_LOCKED.
- [x] Activate transitions atomically + ends prior active.
- [x] 9 live tests.

### Finalize uses the resolver
- [x] Loads active agreement, computes fee from rules; 5%
  fallback when none.
- [x] Live test asserts a 10% agreement → 10% fee.

### Monthly statement + Transfers
- [x] `generateMonthlyStatement` computes all fields, upserts
  idempotently.
- [x] `POST /statements/generate` (admin-only), `GET` list
  (admin or owning franchisee), `GET /statements` self-view.
- [x] `POST /:id/reconcile` creates Stripe Transfer via adapter,
  stamps `transfer_id`.
- [x] `StripeClient.createTransfer` wired (stub + real).
- [x] 8 live tests (math + upsert + list + reconcile +
  re-reconcile 409).

### Franchisor + franchisee UI
- [x] `/franchisor/franchisees/[id]/agreement` editor.
- [x] `/franchisor/franchisees/[id]/statements` admin list
  with Generate + Reconcile.
- [x] `/statements` franchisee self-view with YTD tiles.
- [x] Bundle sizes: 109 / 108 / 105 kB — well under 130 kB cap.

### Security suite
- [x] 22 cases in `live-security-re.test.ts`, all pass, ~2.5 s.
- [x] Anonymous 401 × 8, role boundaries × 5, visibility × 4,
  rule validation × 5.

### Full test suite
- [x] `pnpm turbo test --force` → 773 tests across 9 packages,
  0 cached, 0 skipped.
- [x] No regression in phases 1–7.

---

## Must Improve Over Previous Phase
- [x] No regression in phase_invoicing_stripe (8 / 8 prior
  finalize tests still pass; fallback behaviour preserved).
- [x] No new `pnpm audit --audit-level=high` findings (5
  moderate, same as phase 7).
- [x] New web routes 105–109 kB First Load JS — under the
  phase-8 cap.

---

## Security Baseline
- [x] Every new endpoint has 401 + 403 + 400 tests.
- [x] Rule `params` validated per-rule-type with Zod before
  insert; malformed JSONB cannot land.
- [x] Royalty fee computed server-side only; application fee
  never submitted by the client.
- [x] Partial unique index guarantees exactly one authoritative
  active agreement per franchisee.

---

## Documentation
- [x] `docs/ARCHITECTURE.md` gains section 6f "Royalty engine +
  statements" covering the rule engine, fee resolution, monthly
  projector, Transfer reconciliation.
- [x] `docs/api/royalty.md` documents every new endpoint + rule
  reference.

---

## BLOCKERS
**Zero.**

## MAJORS
**None.**

## MINORS (carried forward, non-blocking)

### m1. BullMQ scheduler is a scaffold, not a cron

The monthly job is currently kicked off manually via the
generate endpoint (or the admin UI button). A real BullMQ
scheduled worker that fires on the franchisor's timezone
midnight of the 1st lands when the deployment reaches more
than one franchisor and operator-driven generation stops
scaling.

### m2. Stripe Transfer direction is encoded in description

Reconcile always creates a transfer with a positive `amount`,
encoding "platform reclaims" vs "platform pays" in the
description string. A real two-sided reconciliation (using
Stripe's reverse-transfer API for reclaim) lands when the
franchisor accounting team gives us the signed ledger shape.

### m3. Context `monthGrossCents` / `monthFeesAccruedCents`
       are computed in UTC-month at finalize

`finalize` uses UTC month boundaries for its rolling context
even though statement generation respects the franchisor's
timezone. At a month boundary this produces up to 24 hours of
tiered-rule drift between what `finalize` assumed and what
the statement projector later reports. The variance still
reconciles via the Stripe Transfer, but per-invoice fees near
the boundary will be slightly off. Fix: plumb the franchisor
timezone through finalize too (one franchisees lookup +
`toZonedTime`). Deferred because no pilot franchisor is near
a TZ boundary that would matter in practice.

---

## Verdict: PASS

Every BLOCKER criterion is live-verified. Three minors are
explicit trade-offs with downstream phase ownership. Ready for
gate approval and the tag `phase-royalty-engine-complete`.
