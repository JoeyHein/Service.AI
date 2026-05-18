# Phase Gate: phase_corporate_hub_redesign

**Written before build begins. Criteria here cannot be loosened mid-phase.**

Phase 14 — replaces the franchisor → franchisee tenancy
model (phases 2–13) with a **corporate hub-and-spoke** model.
One corporate parent (the hub). Many **branches** (the
spokes). Each branch is run by a **local manager** who is a
W2 employee on **base salary + commission**. No independent
franchisees, no royalty rules, no Stripe Connect transfers
between legal entities, no franchise agreements.

This phase is a *destructive simplification*: it removes
load-bearing concepts (franchisor / franchisee / royalty /
Stripe Connect Standard) and replaces them with branch /
manager / commission. Every prior phase touched the
franchise tables, so every prior phase has migration work
here.

**Goal (what success looks like):** corporate ops logs in
and sees one network. They create a new branch and assign a
local manager in under 2 minutes. The local manager logs in,
sees their branch dashboard with revenue, commissionable
revenue, jobs in flight, and their projected monthly
commission. Techs and CSRs assigned to the branch keep
working exactly as they did before — same dispatch board,
same tech mobile flow, same AI voice — but everything they
do flows up through the branch to corporate, not through a
franchisor → franchisee chain. Commission is computed live
from completed jobs and shown to the manager every time they
load their dashboard.

---

## Architectural shape

**Before (phases 2–13):**
```
platform_admin → franchisor → franchisee → location → user
                                  │
                                  ├── pricebook overrides
                                  ├── royalty agreement
                                  ├── Stripe Connect account
                                  └── audit-log scope
```

**After (this phase):**
```
corporate (single row) → branch → user
                            │
                            ├── pricebook (corporate-owned, no overrides v1)
                            ├── manager assignment + comp plan
                            ├── commission ledger
                            └── audit-log scope
```

Tenancy collapses from two levels to one: `branch_id` is
the only scope key on every business table. Postgres RLS
policies simplify accordingly. Corporate role replaces
platform_admin + franchisor_admin (two roles → one). Tech
and CSR roles are unchanged.

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### Schema migration (load-bearing)

- [ ] New tables in migration `0016_corporate_hub_redesign.sql`:
  - `corporate` — single row, holds the legal entity name,
    timezone, currency, brand assets, and
    `default_margin_pct` (the corporate-wide markup applied
    on top of supplier platinum cost when SQB resolves
    selling prices — default 60%, editable in
    `/corporate/settings/margins`). Application bootstrap
    inserts this row.
  - `branches` — `id`, `corporate_id` (always 1), `name`,
    `slug`, `address`, `timezone`, `phone_number`,
    `stripe_account_id?` (single corporate Stripe account
    used by every branch; the column is here for future
    per-branch payout), `status` enum
    (`active` / `paused` / `closed`), timestamps.
  - `branch_managers` — `id`, `branch_id`, `user_id`,
    `started_at`, `ended_at?`. At most one active manager
    per branch enforced by a partial unique index where
    `ended_at IS NULL`. History preserved.
  - `comp_plans` — `id`, `name`, `kind` enum
    (`base_plus_commission` / `commission_only`),
    `base_salary_cents`, `pay_period` enum
    (`monthly` / `biweekly`), `commission_rules jsonb`
    (initial rule schema below), `effective_from`,
    `effective_to?`. Editable by corporate only.
  - `user_comp_assignments` — `id`, `user_id`,
    `comp_plan_id`, `branch_id`, `effective_from`,
    `effective_to?`. Tracks who is on which plan when.
  - `commission_ledger` — `id`, `user_id`, `branch_id`,
    `source_kind` enum (`invoice_paid` / `quote_committed`
    / `manual_adjustment`), `source_id`, `amount_cents`,
    `rule_snapshot jsonb` (the comp_plan rule that fired
    at calc time — frozen for audit), `period_label`
    (e.g. "2026-05"), `created_at`.
- [ ] All tables have `RLS ENABLED + FORCE RLS` and two
  named policies per table (`_corporate_admin` and
  `_scoped`). Three-policy pattern from phase 2 collapses
  to two (no franchisor_admin layer).

### Data migration

- [ ] `0016_corporate_hub_redesign.sql` includes a
  data migration step that:
  - Inserts the single `corporate` row from existing
    `franchisors` data (uses the Elevated Doors row that
    seeds had created — see `apps/api/src/seed/index.ts`).
  - Copies every `franchisees` row into `branches`,
    preserving the id where possible (or writing a mapping
    table `_legacy_franchisee_to_branch` for audit).
  - Inserts a `branch_managers` row for whichever user held
    the `franchisee_admin` membership on each branch.
  - Renames `franchisee_id` columns on every business table
    to `branch_id` (uses `ALTER TABLE … RENAME COLUMN`
    inside one transaction).
- [ ] Down migration is reversible: restores
  `franchisees`, restores `franchisee_id`, replays the
  `_legacy_franchisee_to_branch` mapping in reverse.
- [ ] CI gate runs the full sequence
  `migrate up → migrate down → migrate up` against a
  populated dev database; assert row counts unchanged on
  every business table.

### Application code (top-down sweep)

- [ ] `RequestScope` discriminated union collapses from
  `platform` / `franchisor` / `franchisee` to
  `corporate` / `branch`. Pattern matches in every consumer
  updated.
- [ ] `requestScopePlugin` resolves the scope from Better
  Auth session + `memberships` against the new role set:
  `corporate_admin`, `manager`, `csr`, `tech`. The
  `franchisor_admin` impersonation flow is removed
  (corporate sees everything natively; no cross-tenant
  pretence needed).
- [ ] `withScope(db, scope, fn)` continues to exist but the
  `set_config` keys change: `app.role`, `app.branch_id`.
  `app.franchisor_id` / `app.franchisee_id` are removed.
- [ ] Every API route updated:
  - Body fields like `{ franchiseeId }` renamed to
    `{ branchId }`.
  - `request.requireScope().franchiseeId` becomes
    `request.requireScope().branchId`.
  - Cross-tenant probe behaviour preserved: a `branch_id`
    that doesn't belong to the caller returns 404 (not 403),
    same rule as before.
- [ ] Every web route updated:
  - `/franchisor/*` and `/franchisor/onboard` are deleted.
  - New `/corporate` route hierarchy mirrors what
    `/franchisor` used to render, minus impersonation:
    `/corporate/branches`, `/corporate/branches/new`,
    `/corporate/branches/:id`, `/corporate/managers`,
    `/corporate/comp-plans`.
  - Manager dashboard at `/branch` shows revenue, AR,
    jobs in flight, and **projected commission** for the
    current pay period.
- [ ] Better Auth schema updated: `franchisor_admin` role
  removed from the enum; existing assignments migrated to
  `corporate_admin`.

### Branch CRUD UI

- [ ] `/corporate/branches` lists branches with status,
  manager, monthly revenue, monthly commission paid out.
- [ ] `/corporate/branches/new` (corporate-only): legal
  name → address (Google Places) → timezone → Twilio number
  provision (reuses the existing flow) → assign manager
  (search existing users or create one with `manager` role).
  Three steps, one continuous wizard, no franchise
  agreement / no Stripe Connect / no pricebook template
  publish (pricebook is corporate-owned now and inherited).
- [ ] `/corporate/branches/:id` detail page: manager
  history, comp plan assignment, branch status toggle
  (active → paused requires confirm), an audit log filtered
  to this branch.
- [ ] Non-corporate roles get `notFound()` on
  `/corporate/*`.

### Comp plan + commission engine

- [ ] `/corporate/comp-plans` UI: list, create, edit. Form
  enforces:
  - `base_salary_cents` ≥ 0
  - `commission_rules jsonb` validates against a Zod schema
    with three rule kinds for v1:
    - `flat_percent_of_invoice_paid` — `{ percent: 0..100 }`
    - `tiered_percent_of_invoice_paid` — `{ tiers: [{ floorCents, percent }] }` sorted ascending; first matching tier wins
    - `flat_percent_of_quote_committed` — `{ percent: 0..100 }` — fires when a quote is committed (used for closers paid before invoice cycle)
- [ ] `computeCommission(tx, userId, periodLabel)` pure
  projector returning:
  ```ts
  {
    period: '2026-05',
    base_salary_cents: number,
    commission_cents: number,
    total_cents: number,
    line_items: [{ source_kind, source_id, amount_cents, rule_snapshot }]
  }
  ```
- [ ] `commission_ledger` rows written by a single
  transition function per source kind:
  - `onInvoicePaid(invoiceId, tx)` — finds the assigned
    manager + tech (split rules in v1.5; v1 awards 100% to
    the manager of the branch where the job ran) and
    writes ledger rows.
  - `onQuoteCommitted(quoteId, tx)` — same shape for
    closer-paid plans.
  - Idempotent: writes are upserted on
    `(user_id, source_kind, source_id)` unique index.
- [ ] BullMQ monthly job rolls up the ledger into a
  `commission_statements` table (out of scope to send
  payroll — just the read model for managers and
  corporate).

### Manager dashboard

- [ ] `/branch` (manager-only) renders:
  - Tile row: branch revenue MTD, AR open, jobs in flight,
    **projected commission this period**.
  - "Pipeline" card: committed quotes that have not been
    invoiced yet (these will earn commission once they
    convert — for plans tied to `invoice_paid`).
  - Recent jobs + a "go to dispatch board" CTA.
  - Manager sees only their branch. Cannot see another
    branch's revenue or commission.

### Pricebook simplification

- [ ] Existing `pricebook_overrides` table is dropped.
  Pricebook is corporate-owned, single resolved view. The
  manager UI no longer offers price overrides (they can
  request changes via a new "Suggest price change" form
  that drops a row in a new `pricebook_suggestions` table
  for corporate review — keeps the door open for v1.5
  without holding up this phase).
- [ ] Migration removes the `pricebook_overrides` table
  after copying any meaningful override to a one-time CSV
  in `docs/migrations/0016_pricebook_overrides_snapshot.csv`
  for the record.

### Royalty engine removal

- [ ] `franchise_agreements`, `royalty_rules`, and
  `royalty_statements` tables are dropped in this migration.
- [ ] Routes `/api/v1/royalty/*` are deleted.
- [ ] Stripe Connect onboarding flow is deleted.
  PaymentIntent creation switches to a single corporate
  Stripe account; `application_fee_amount` is removed.
- [ ] The `royalty_engine` phase's docs in `docs/PHASES.md`
  are struck through with a note pointing here.

### Tests

- [ ] All prior-phase tests pass after the rename. Where a
  test asserted franchisor / franchisee behaviour that no
  longer exists (e.g., impersonation, royalty rule
  combinations), the test is **deleted with a referenced
  commit** — not skipped.
- [ ] New live security suite at
  `apps/api/src/__tests__/live-security-corporate.test.ts`
  covers:
  - manager-A cannot read branch-B's branch metrics (404)
  - manager-A cannot edit branch-B's comp plan (404)
  - csr cannot read commission_ledger of any user (403)
  - tech cannot read commission_ledger of any user (403)
  - corporate_admin can read across all branches
- [ ] Commission engine has property-based tests for each
  rule kind covering boundary cases (empty period, single
  invoice, ten invoices, refunded invoice negates the
  commission row, manual adjustment, plan change mid-period).

### AI surfaces updated

- [ ] AI CSR voice tools that took `franchiseeId` updated
  to `branchId`. Prompt strings in `packages/ai/prompts/`
  updated. Existing recorded test fixtures regenerated.
- [ ] AI dispatcher tools updated for the new role set.
- [ ] AI collections drafts continue to use the franchisee
  brand voice config — that config moves under the
  `branches.brand_voice jsonb` column. Migration copies
  prior franchisee brand_voice into the corresponding
  branch row.

---

## Must Improve Over Previous Phase

- [ ] **Schema simplification metric**: total business
  table count drops by at least 5 (royalty 3 + pricebook
  overrides 1 + franchise agreements 1 = 5 minimum).
  - **Verification:** schema diff in `docs/ARCHITECTURE.md`.
- [ ] **Code simplification metric**: net LOC change is
  negative or within +500 LOC despite the new commission
  engine. Branch / commission code should be smaller than
  the franchisor / royalty code it replaces.
  - **Verification:** `git diff --shortstat origin/main`.
- [ ] No regression in test pass rate. The total test count
  after this phase is allowed to drop (royalty / franchisor
  tests deleted), but every remaining test passes.
  - **Verification:** `pnpm -r test` exits 0.
- [ ] Build time does not grow.
  - **Verification:** CI timing comparison.

## Security Baseline

- [ ] No new `pnpm audit --audit-level=high` findings.
- [ ] RLS policy review: after migration, run an automated
  check that asserts every table with a `branch_id`
  column has the two new policies attached. CI fails if
  any are missing.
- [ ] Commission ledger rows are immutable after the
  monthly statement is finalized. Database CHECK +
  trigger enforces this; integration test verifies.
- [ ] Manager cannot self-edit their own comp plan or
  ledger. Corporate-only writes on those tables.

## Documentation

- [ ] `docs/ARCHITECTURE.md` rewritten for the corporate
  hub model. Old franchise diagram preserved in an
  appendix titled "Pre-2026-05 franchise model" with a
  link to this gate.
- [ ] `CLAUDE.md` rewritten:
  - "Project identity" section drops "franchise platform"
    language; replaces with "corporate hub-and-spoke
    field service platform, run by W2 local managers on
    base + commission".
  - Tenancy rule simplified: `branch_id` is the only
    scope key. RLS policy template updated to the new
    two-policy form.
  - AI guardrail defaults table re-keyed to
    corporate / manager / csr / tech.
- [ ] `docs/EVOLUTION.md` gets a top entry summarizing
  what was removed and why (the user changed the GTM
  model from franchise to corporate-operated; this is the
  most material architectural change in the project's
  history and future readers need the rationale).
- [ ] `docs/LESSONS.md` reserved entry — evolver fills it
  after the audit.
- [ ] `docs/TECH_DEBT.md`: park the deferred items
  (per-branch payouts via separate Stripe accounts;
  manager + tech commission split rules; multi-branch
  manager; territory geography).

---

## Out of scope (explicitly deferred)

- Multi-branch managers (a manager running 2+ branches).
  Schema allows it via multiple `branch_managers` rows,
  UI defaults to one.
- Tech commission splits (some plans pay a small % to the
  tech who completed the job). Schema is ready
  (`source_kind` enum extensible); rule kind for splits
  is a v1.5 follow-up.
- Per-branch Stripe payouts. v1 uses one corporate Stripe
  account.
- Branch-level pricebook overrides. v1 is one corporate
  pricebook; `pricebook_suggestions` table exists for the
  request flow but the apply path is manual.
- Territory geography / market analysis. Branch just has
  an address.

---

## Tasks (build order)

1. **CHR-01** — migration 0016: new tables, RLS, data
   migration copying franchisees → branches +
   franchisor_admin → corporate_admin. Up/down/up CI gate.
2. **CHR-02** — `RequestScope` + `requestScopePlugin`
   rewritten for the new role set. All consumer call sites
   updated.
3. **CHR-03** — API rename sweep: every body field +
   internal symbol franchisee → branch. ts-rest contracts
   regenerated. Live security test rewritten.
4. **CHR-04** — comp plan schema + Zod validators + the
   three rule kinds + property tests for each rule.
5. **CHR-05** — commission engine: `computeCommission` +
   `onInvoicePaid` + `onQuoteCommitted` + idempotent
   ledger writes. Property tests + integration test
   against the live demo seed.
6. **CHR-06** — `/corporate` web routes: branches list,
   branch CRUD wizard, comp plan CRUD. Replaces
   `/franchisor/*` routes (deletions in this commit).
7. **CHR-07** — `/branch` manager dashboard with tiles,
   pipeline, projected commission, recent jobs.
8. **CHR-08** — royalty engine removal: drop tables,
   delete routes, remove Stripe Connect onboarding,
   collapse to single corporate Stripe account.
9. **CHR-09** — pricebook override removal: snapshot
   CSV, drop table, replace UI with
   `pricebook_suggestions` form.
10. **CHR-10** — AI prompt / tool updates for the new
    role set; regenerate fixtures; rerun voice test set.
11. **CHR-11** — docs sweep: ARCHITECTURE, CLAUDE.md,
    EVOLUTION, PHASES (strike through royalty +
    franchisor_console phases with redirect notes).
12. **CHR-12** — adversarial audit pass against the
    new schema + the new role matrix; deletes any
    franchise-era assumption still leaking through.

---

## Gate Decision

<filled in by reviewer>
APPROVED | REJECTED
