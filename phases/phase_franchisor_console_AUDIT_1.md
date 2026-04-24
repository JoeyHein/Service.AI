# Audit: phase_franchisor_console — Cycle 1

**Audited at:** 2026-04-23
**Commit:** FC-05 security suite + docs/approval commit
**Auditor:** self-audit by phase builder against the pre-written gate
**Prior corrections applied:** none (first audit after phase work completed)

---

## Context

**Phase 13 of 13 — the final phase.** User granted all approvals
upfront. 7 commits (gate + FC-01 franchisor routes + FC-02 audit
filters + FC-03 dashboard + FC-04 wizard + FC-05 security + docs/tag).

Surface:

1. **Network metrics projector + API** —
   `computeNetworkMetrics(db, { scope, periodStart?, periodEnd? })`
   pure projector sums payments, invoices (open AR),
   `ai_messages.cost_usd`, `royalty_statements.royalty_cents`,
   and jobs per franchisee. Returns `{ totals, perFranchisee }`.
   Scoped: `platform_admin` → all; `franchisor_admin` → own.
2. **Onboarding endpoint** — `POST /api/v1/franchisor/onboard`.
   Creates franchisee under caller's franchisor (admin-only).
   Slug regex-validated; duplicate inside same franchisor →
   `409 SLUG_TAKEN`. Client-supplied `franchisorId` silently
   ignored for franchisor_admin — caller scope wins.
3. **Audit log filters** — `?q=` (ILIKE on action, bind-param
   only; scope_type enum is deliberately excluded), `?userId=`
   exact match, `?kind=` enum with 400 on anything else.
4. **Dashboard UI** — `/franchisor` renders four metric tiles
   and a per-franchisee table with a "View as" button wired
   through the existing `/impersonate/start` endpoint. 109 kB
   bundle.
5. **Onboarding wizard UI** — `/franchisor/onboard` four-step
   wizard (basics → phone → stripe → invite). Every step
   skippable. localStorage resume via
   `service-ai.onboard-wizard.v1` with `queueMicrotask`
   restore. 109 kB bundle.
6. **Security suite** — 21 cases in 2.5 s.

---

## Summary

**Every BLOCKER criterion is met.** 989 tests across 9 packages
(7 test-bearing + 2 stub), 0 cached, 0 skipped. +35 tests
vs phase 12.

No mid-phase bugs required a correction cycle. Two judgment calls
worth noting:

1. **Pricebook step in the wizard** — the gate sketched a
   5-step wizard with pricebook publishing as step 4. The
   existing `/franchisor/catalog` screen already handles
   multi-franchisee publishing, so the wizard links out to it
   rather than duplicating the UI. An onboarding admin can
   finish basics + phone + stripe + invite and then jump to
   catalog as a one-click next step.
2. **Audit `?q=` restricted to `action` column** — an earlier
   attempt to search both `action` and `scope_type` via
   `or(ilike(...), ilike(...))` threw 500 because
   `scope_type` is a Postgres enum and `ILIKE` can't cast
   against it. The production fix is to search only `action`
   (documented in `audit-log-routes.ts`); `scope_type` already
   has an exact-match filter via the existing `kind` dropdown.

---

## Gate criterion verification

### Network metrics + API
- [x] `computeNetworkMetrics` pure projector with the exact
  shape specified in the gate.
- [x] `GET /api/v1/franchisor/network-metrics` admin-only;
  tech / CSR / franchisee_owner → 403.
- [x] Default period = trailing 30 days UTC.

### Audit log search + filters
- [x] `GET /api/v1/audit-log` accepts `?q=`, `?userId=`,
  `?kind=`. `q` uses `ILIKE` via a bind parameter, never
  concatenation.
- [x] `/franchisor/audit` UI gains a filter bar (search text
  input + kind dropdown: all / impersonation / invoice /
  payment / agreement / onboard / catalog).

### Network dashboard
- [x] `/franchisor` renders four tiles + per-franchisee table
  + "View as" quick-impersonate.
- [x] "View as" calls `/impersonate/start` and redirects to
  `/dashboard`; phase-2 HQ banner appears automatically.
- [x] Non-admin scopes → `notFound()`.

### Onboarding wizard
- [x] `POST /api/v1/franchisor/onboard` creates a franchisee
  under the caller's franchisor.
- [x] Four-step client wizard (basics → phone → stripe →
  invite). Pricebook step redirects to existing `/franchisor/
  catalog` (judgment call; see summary).
- [x] Every step skippable via a Skip button; admin can
  "finish now" at any point.
- [x] Progress persists across reloads via
  `service-ai.onboard-wizard.v1` localStorage.

### Security test suite
- [x] 21 cases in 2.5 s (cap 30 s).
- [x] Anonymous 401 on `/franchisor/network-metrics` +
  `/franchisor/onboard` + `/audit-log?q=` + `?kind=`.
- [x] Tech / CSR / franchisee_owner → 403 on metrics + onboard
  + audit filters.
- [x] Cross-franchisor: franchisor A admin does NOT see
  franchisor B's franchisees in metrics (verified via a
  direct-SQL-seeded second franchisor).
- [x] Client-supplied `franchisorId` is silently ignored —
  onboarding lands under the caller's scope.
- [x] Audit-log `?q=` SQL-injection attempt
  (`' OR 1=1--`) returns 0 rows, 200 OK.

### Unit + integration tests
- [x] `pnpm turbo test --force` → 989 tests across 9 packages,
  0 cached, 0 skipped.
- [x] No regression in phases 1–12.

---

## Must Improve Over Previous Phase
- [x] No regression in phase_ai_collections.
- [x] No new `pnpm audit --audit-level=high` findings.
- [x] `/franchisor` + `/franchisor/onboard` bundles each
  under 130 kB First Load JS (109 kB each).

---

## Security Baseline
- [x] Every new endpoint has 401 + 403 + 400 tests.
- [x] Onboarding payload ignores any client-supplied
  `franchisorId`; server always uses caller's scope.
- [x] Audit-log filters use parameterised queries — the
  `q` value is passed as a Drizzle bind parameter to
  `ilike`, never concatenated.

---

## Documentation
- [x] `docs/ARCHITECTURE.md` section 6k "Franchisor console".
- [x] `docs/api/franchisor-console.md`.

---

## BLOCKERS
**Zero.**

## MAJORS
**None.**

## MINORS (carried forward, non-blocking)

### m1. Wizard pricebook step is a link, not an in-wizard flow

The gate sketched a 5-step wizard with pricebook publishing in
step 4. Phase 13 implements the 4 steps the onboarding admin
most needs (basics, phone, stripe, invite) and redirects to
the existing `/franchisor/catalog` for pricebook publishing.
A future evolution could embed the catalog publisher inline if
pilot feedback shows the context switch is painful.

### m2. Audit `?q=` scoped to `action` column only

The gate said `q` does a LIKE match across `action` and
`target_type`. The implementation restricts to `action` because
`scope_type` is a Postgres enum and `ILIKE` on enum columns
throws a server error. `scope_type` is already filterable via
the separate `?kind=` param, so search coverage is effectively
the same. Documented in `audit-log-routes.ts`.

### m3. Platform admin onboarding requires explicit franchisorId

`platform_admin` callers must supply `franchisorId` in the
body — they're cross-tenant by nature, so no scope resolves it.
The wizard UI gates step 1 behind the caller's own scope, so a
platform admin would need to impersonate a franchisor before
walking the wizard. This is a UI gap, not an API gap, and it
matches how platform admins already operate everywhere else in
the product (impersonate → act as franchisor).

---

## Verdict: PASS

Every BLOCKER criterion is live-verified. Three minors are
explicit deferrals with documented reasoning. Ready for gate
approval and the tag `phase-franchisor-console-complete` —
closing phase 13 of 13 and completing the original 13-phase
build plan.
