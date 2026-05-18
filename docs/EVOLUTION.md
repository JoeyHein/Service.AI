# Service.AI — Evolution Policy

The evolver runs after every gate passes. Its job is to make the next phase better than this one by learning from what just happened.

---

## CHR — Corporate hub redesign (2026-05)

The most material architectural change in the project's history. Replaced the franchise tenancy model (platform → franchisor → franchisee → location) with a **corporate hub-and-spoke** model (single corporate parent → many branches → users) across 11 shipped CHR tasks.

### What changed

- **Tenancy collapsed** from a 4-level tree to a 2-variant `RequestScope` discriminated union (`corporate | branch`). `app.role` + `app.branch_id` + `app.user_id` are the only GUCs; `app.franchisor_id` / `app.franchisee_id` are gone.
- **Roles** shrunk from 7 (`platform_admin`, `franchisor_admin`, `franchisee_owner`, `location_manager`, `dispatcher`, `tech`, `csr`) to 5 (`corporate_admin`, `manager`, `dispatcher`, `tech`, `csr`).
- **RLS template** simplified from three policies (`_platform_admin` / `_franchisor_admin` / `_scoped`) to two (`_corporate_admin` / `_scoped`).
- **Compensation model** introduced: W2 local managers on base + commission via `comp_plans`, `user_comp_assignments`, and `commission_ledger`. Commission engine lives at `apps/api/src/commission-engine.ts`; Stripe webhook fires `onInvoicePaid` / `reverseInvoicePaid` / `onQuoteCommitted`.
- **Stripe** simplified: single corporate account, no Stripe Connect onboarding, no `application_fee_amount`, no per-branch payouts.
- **Royalty engine deleted**: `franchise_agreements`, `royalty_rules`, `royalty_statements` tables dropped; `/api/v1/royalty/*` routes removed.
- **Pricebook overrides replaced** with `pricebook_suggestions` (manager proposes → corporate approves).
- **Impersonation removed entirely**: no `X-Impersonate-Franchisee` header, no `serviceai.impersonate` cookie, no HQ banner — corporate sees every branch natively.
- **New web routes**: `/corporate/*` (branches CRUD wizard, managers, comp-plans, pricebook-suggestions) and `/branch` (manager dashboard with projected commission). All `/franchisor/*` routes deleted.

### Why

GTM model changed from franchising to corporate-operated branches. Elevated Doors is now a corporate-operated brand, not a franchisee. The franchise scaffolding — independent legal entities, royalty agreements, Stripe Connect, per-franchisee Twilio provisioning gated on contract signing — was overhead the product would never need.

### Scope

- 11 CHR tasks shipped (CHR-01 through CHR-11; CHR-12 adversarial audit follows).
- Migration `0016_corporate_hub_redesign.sql` is the load-bearing piece — every table rename, every RLS swap, every data migration step is in one transaction.
- CHR-08 alone deleted **~3963 LOC net** (royalty engine + Stripe Connect onboarding + `/franchisor/*` routes).
- ~110 files touched across the monorepo.

### Risk + acceptance

- **Reversibility**: migration 0016 has a `.down.sql` that restores `franchisors`, `franchisees`, `franchise_agreements`, `royalty_rules`, `royalty_statements`, and `pricebook_overrides` tables; the franchisor/franchisee row data is preserved because `branches.id` reuses `franchisees.id` (no UUID rewrite). **Royalty data is lost on rollback by design** — the up migration drops the rows, the down restores only the schema. A `up → down → up` CI gate verifies row counts on every business table.
- **Static AI guardrails fallback**: the `franchisees.ai_guardrails` JSONB column went away with the table. Per-branch guardrails are deferred; the AI runtime currently uses static defaults. This is the largest known regression and is parked in `docs/TECH_DEBT.md`.

### Cross-references

- Gate: `phases/phase_corporate_hub_redesign_GATE.md` — written before the build began; criteria locked.
- Tasks: `docs/TASKS.md` under CHR-01..CHR-11.
- Source of truth: `packages/db/migrations/0016_corporate_hub_redesign.sql`, `packages/db/src/scope.ts`, `apps/api/src/request-scope.ts`, `apps/api/src/commission-engine.ts`, `apps/api/src/corporate-routes.ts`, `apps/api/src/branch-routes.ts`.

---

## 1. What the evolver IS allowed to change

| File | Allowed changes | Constraints |
|---|---|---|
| `CLAUDE.md` | Add/refine required patterns, forbidden patterns, file/folder layout rules | Never loosen rigor. Evolver may only tighten. Reversal of a rule requires human approval. |
| `docs/LESSONS.md` | Append cumulative learning, keyed by symptom → rule | Free-form; this is the evolver's journal. |
| `docs/ARCHITECTURE.md` | Document emergent decisions that arose during builds | Never revise Section 12 (Key Decisions) without human approval — that's the tombstone table. |
| `docs/TECH_DEBT.md` | Curate and prioritize accumulated debt | New entries only from corrector's deferred-minor list. |
| `.claude/agents/*.md` | Refine agent prompts when a specific agent keeps underperforming | One change per observed pattern. Not a dozen. |
| `docs/TASKS.md` — future-phase stubs only | Expand anchor tasks for phases 2+ ahead if lessons warrant earlier mitigation | Never retroactively edit completed phase task lists. |
| `scripts/` | Minor quality-of-life edits to build loop (logging, notifications) | Never alter the phase-gate discipline (no skipping audits, no raising cycle caps, etc.). |

## 2. What the evolver is NOT allowed to change

- **Completed `phases/*_GATE.md` files.** History is immutable. If a gate was wrong, note it in `docs/LESSONS.md`; future gates get better.
- **Tests in the codebase.** Adjusting a failing test to make it pass is cheating. The corrector owns tests.
- **Production code** unless the change is a refactor explicitly justified by a tech-debt item that was accepted into this phase's scope.
- **The phase list in `docs/PHASES.md`.** v1 scope is locked. New phases require a human planning session.
- **Stack choices** in `docs/ARCHITECTURE.md` Section 1. A decision to swap Fastify for Hono, for example, is a human call — too much downstream impact to mutate autonomously.
- **Gate thresholds** in `phases/PHASE_TEMPLATE.md` (coverage %, latency budgets, etc.). Raising is fine after human review; lowering is never fine.

## 3. What the evolver should watch for

### Repeat-offender patterns
- Auditor keeps finding the same class of issue (e.g., "N+1 query in list endpoints")
  → Evolver updates `CLAUDE.md` forbidden patterns; updates `.claude/agents/builder.md` with a preflight check; appends `docs/LESSONS.md` entry.

### Stuck tasks
- Corrector took >2 cycles for the same task type (e.g., "Stripe webhook idempotency")
  → Evolver writes a recipe in `docs/LESSONS.md` with the known-good approach; updates builder prompt to check for that recipe.

### Architectural drift
- Builder is inventing patterns that deviate from `docs/ARCHITECTURE.md`
  → Evolver tightens the relevant section with concrete examples; updates builder to cite the architecture doc.

### Successful patterns
- Something worked unusually well (clean abstraction, fast delivery, low audit findings)
  → Evolver records the pattern in `docs/LESSONS.md` under a "what to keep doing" header; updates agent prompts to reinforce.

### AI behavior drift
- Subagent prompts are producing worse output over time (e.g., auditor getting milder)
  → Evolver resets the prompt section causing drift; adds explicit anti-drift language.

## 4. Output format

Per `.claude/agents/evolver.md`: evolver writes `phases/<phase>_EVOLUTION.md` and commits on a separate commit with message `chore(evolution): after <phase>` so humans can selectively revert.

Any deep change (e.g., modifying an agent prompt) is committed in **two** commits:
1. `chore(evolution): after <phase> — lessons learned`
2. `chore(evolution): after <phase> — agent prompt refinement`

This lets a human revert the prompt change without losing the lessons.

## 5. Regression safety

After every evolution pass, the evolver:
1. Runs the prior phase's test suite.
2. If anything regresses, reverts the evolution commit and flags the regression in `docs/LESSONS.md` as "attempted change X caused regression Y".

## 6. Evolver humility

If the evolver is unsure whether a change is an improvement, it does not apply the change. It writes a proposal into `docs/LESSONS.md` under "Hypotheses for human review" and moves on.

## 7. Human override

At any time a human can:
- Revert an evolution commit without explanation.
- Add a line to `docs/LESSONS.md` under "Overrides" naming a change that must not be repeated.
- Run `scripts/evolver-disable.sh` (not yet built; script stub for if we ever need it) to skip evolution passes for N phases.

## 8. Anti-patterns the evolver must never perform

- **Scope creep into v1** — adding features, endpoints, tables that weren't in the approved phase plan.
- **Rewriting instead of refining** — evolver edits, not rewrites.
- **Silent rule changes** — every prompt/CLAUDE.md change is in a commit with a clear message citing the observed pattern.
- **Teaching subagents to be softer** — the auditor must remain adversarial; the corrector must not be told to downgrade severities; the planner must not be told "estimates are just suggestions".

## 9. Accumulated-knowledge lifecycle

- `docs/LESSONS.md` is read by every agent at the start of every phase.
- When it grows beyond ~300 lines, evolver consolidates: duplicate entries merged, stale entries archived to `docs/LESSONS_ARCHIVE.md`.
- Consolidation is a separate commit with message `chore(evolution): consolidate lessons`.

## 10. Phase-specific evolution expectations

Early phases (1-3) will generate the most lessons because patterns are being established. Expect ~3-5 lessons per early phase. Late phases (9-13) should generate fewer (1-2) because the machinery has stabilized. If late phases are still generating 5+ lessons, something is wrong with the build machinery itself — human review warranted.
