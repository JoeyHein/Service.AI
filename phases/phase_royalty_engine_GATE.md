# Phase Gate: phase_royalty_engine

**Written before build begins. Criteria here cannot be loosened mid-phase.**

Phase 8 of 13. Royalty is automatic and reconcilable. Application
fee on every PaymentIntent reflects the active franchise
agreement, not a hard-coded 5%. End-of-month statements are
generated per franchisee in their timezone and reconciled via
Stripe Transfers.

Every layer reuses the patterns from phases 1–7 — `RequestScope`,
`withScope`, app-layer WHERE + RLS, pluggable external-service
adapters. New primitives: a pure rule engine (so tests are
trivial and portable), a BullMQ scheduler scaffold for the
monthly job, and the Stripe Transfers API wired through the
existing `StripeClient` interface.

**After this phase, Elevated Doors can configure
"8% of gross revenue, minimum $500/month" once and every invoice
across every territory charges the correct platform fee
automatically.**

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### Data model (migration 0009)

- [ ] Migration 0009 adds `franchise_agreements`, `royalty_rules`,
  `royalty_statements` tables with the standard 3-policy RLS
  pattern and indexed FKs.
- [ ] `franchise_agreements` has: `franchisee_id`, `franchisor_id`
  (denormalised for RLS + fast parent scoping), `status` enum
  ('draft', 'active', 'ended'), `starts_on`, `ends_on` nullable,
  `currency` default 'usd', timestamps.
- [ ] At most one active agreement per franchisee at a time —
  enforced via a partial unique index
  `(franchisee_id) WHERE status = 'active'`.
- [ ] `royalty_rules` has: `agreement_id`, `rule_type` enum
  ('percentage', 'flat_per_job', 'tiered', 'minimum_floor'),
  `params JSONB` (shape depends on type), `sort_order`,
  timestamps. Rules are ordered; the engine applies them in
  `sort_order` then aggregates per the rule type.
- [ ] `royalty_statements` has: `franchisee_id`, `franchisor_id`,
  `period_start`, `period_end` (UTC instants marking the tz-
  aware month boundary), `gross_revenue`, `refund_total`,
  `net_revenue`, `royalty_owed`, `royalty_collected`
  (= sum of PaymentIntent application fees), `variance`
  (= owed - collected), `transfer_id` (nullable Stripe transfer
  used to reconcile), `status` ('open', 'reconciled',
  'disputed'), `created_at`.
- [ ] Migration is reversible.

### Pure rule engine

- [ ] `apps/api/src/royalty-engine.ts` exports
  `resolveFeeCents(rules, ctx): number` — ctx carries
  `{ totalCents, customerJobCountThisMonth, monthGrossCents,
  monthFeesAccruedCents }`.
- [ ] Four rule types implemented:
  - `percentage` — `params = { basisPoints }`; fee += `round(totalCents * bps / 10000)`.
  - `flat_per_job` — `params = { amountCents }`; fee += `amountCents`.
  - `tiered` — `params = { tiers: [{upToCents, basisPoints}] }`;
    applies to `monthGrossCents + totalCents` incrementally.
  - `minimum_floor` — `params = { perMonthCents }`; if
    `monthFeesAccruedCents + fee < perMonthCents`, bump fee to
    cover the floor (clamped to `totalCents`).
- [ ] Rules are composable: a percentage + minimum_floor combo
  works out of the box.
- [ ] ≥ 15 vitest unit cases covering every rule type +
  combinations + edge cases (zero total, rounding symmetry,
  floor below gross).

### Agreement CRUD API

- [ ] `POST /api/v1/franchisees/:id/agreement` creates a draft
  agreement with an initial rules array. Franchisor admin +
  platform admin only.
- [ ] `POST /api/v1/franchisees/:id/agreement/activate` ends any
  prior active agreement and sets this one to `active`. Atomic
  in one transaction. Reused when updating rules — you edit a
  draft then activate it, which avoids mutating rules on an
  active agreement.
- [ ] `GET /api/v1/franchisees/:id/agreement` returns the active
  agreement + its rules (fall back to the most recent if none
  active).
- [ ] `PATCH` on a draft replaces the rules array atomically;
  rejects PATCH on an active agreement with 409
  `AGREEMENT_LOCKED`.

### Finalize uses the royalty resolver

- [ ] `invoice-payment-routes.ts#finalize` resolves the active
  agreement's rules and computes `applicationFeeAmount` via the
  engine, instead of `total * 5%`.
- [ ] No active agreement → defaults to 5% (phase-7 behaviour
  preserved for existing integration tests).
- [ ] Live test asserts that a franchisee with a 10% rule gets
  a 10% fee on the PaymentIntent.

### Monthly statement job + Stripe Transfers

- [ ] `apps/api/src/royalty-statement.ts` exports
  `generateMonthlyStatement(tx, { franchiseeId, period: {
  start, end } }): Promise<Statement>`. Pulls payments +
  refunds in range, computes gross/refund/net/owed/collected,
  inserts a `royalty_statements` row, returns it.
- [ ] `POST /api/v1/franchisees/:id/statements/generate` (body:
  `{ month: 'YYYY-MM', timezone?: string }`) — platform /
  franchisor admin only. Uses `date-fns-tz` (or an in-tree tz
  helper) so the period bounds respect the franchisor's
  timezone.
- [ ] `GET /api/v1/franchisees/:id/statements` lists statements;
  franchisee-scoped users see their own, franchisor admins see
  their franchisees', platform admins see all.
- [ ] `POST /api/v1/statements/:id/reconcile` creates a Stripe
  Transfer (via the `StripeClient` adapter) for the
  `variance` amount, stamps `transfer_id`, flips status to
  `reconciled`.
- [ ] `StripeClient.createTransfer` added to the interface +
  stub + real implementation. Stub returns `tr_stub_*` ids.
- [ ] BullMQ scaffold for the monthly job is wired behind
  `opts.scheduleStatementJob`; default is a no-op so tests
  don't need a real Redis queue.

### Franchisor UI

- [ ] `/franchisor/franchisees/[id]/agreement` page — author /
  edit an agreement with a rules editor (one row per rule,
  type + params inputs). Active agreement is read-only; an
  "Edit as draft" action forks a new draft.
- [ ] `/franchisor/franchisees/[id]/statements` — list of
  statements with period, gross, owed, collected, variance,
  status.

### Franchisee UI

- [ ] `/statements` — franchisee-scoped list of their own
  royalty statements plus an at-a-glance "total collected
  year-to-date" summary.

### Security test suite

- [ ] ≥ 20 cases in `apps/api/src/__tests__/live-security-re.test.ts`,
  all pass, < 30 s runtime.
- [ ] Anonymous 401 on every new endpoint.
- [ ] Tech / franchisee owner cannot touch agreement CRUD → 403.
- [ ] Cross-franchisor agreement writes → 404.
- [ ] PATCH active agreement → 409 `AGREEMENT_LOCKED`.
- [ ] Statement generation blocked on non-admin roles.
- [ ] Franchisee can see own statements but not another
  franchisee's → 404.

### Unit + integration test suite

- [ ] `pnpm turbo test --force` → 0 cached, 0 skipped.
- [ ] No regression in phases 1–7.

---

## Must Improve Over Previous Phase

- [ ] No regression in phase_invoicing_stripe.
- [ ] No new `pnpm audit --audit-level=high` findings.
- [ ] Franchisor / franchisee new pages each under 130 kB First
  Load JS.

---

## Security Baseline

- [ ] Every new endpoint has 401 + 403 + 400 tests.
- [ ] Rules params are validated with Zod per-rule-type before
  insert — malformed rules cannot land in the DB.
- [ ] Royalty computation is server-side only; the client never
  submits a fee amount.
- [ ] Partial unique index on active agreements guarantees there
  is exactly one authoritative fee source per franchisee.

---

## Documentation

- [ ] `docs/ARCHITECTURE.md` gains section 6f "Royalty engine +
  statements" covering the rule engine composition model, fee
  resolution at finalize, monthly statement generation, and the
  Stripe Transfer reconciliation path.
- [ ] `docs/api/royalty.md` documents every new endpoint: agreement
  CRUD, activate, generate, reconcile, list.

---

## Gate Decision

**Audited in:** `phase_royalty_engine_AUDIT_1.md` (cycle 1)
**Verdict:** PASS — approved 2026-04-24

All BLOCKER criteria verified. Three minors tracked in AUDIT_1
(m1: BullMQ scheduler is a scaffold; m2: Transfer direction
encoded in description; m3: finalize context uses UTC boundaries
while statements use franchisor tz). Tagged
`phase-royalty-engine-complete`.
