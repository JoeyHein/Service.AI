# Phase Gate: phase_franchisor_console

**Written before build begins. Criteria here cannot be loosened mid-phase.**

Phase 13 of 13 — the final phase. HQ can run the network:
review every franchisee's performance, drill into one
franchisee's data (with the phase-2 impersonation banner
flagging the HQ context), audit any cross-tenant read, and
onboard a new franchisee end-to-end through a single wizard.

Most of the primitives exist already: impersonation +
audit-log writer from phase 2, pricebook template publisher
from phase 4, Stripe Connect from phase 7, franchise
agreement authoring from phase 8, Twilio provisioning from
phase 9. Phase 13 composes them behind a franchisor-facing
console.

**After this phase, Elevated Doors' HQ can onboard a new
territory in one sitting — legal name → Twilio number → Stripe
Connect → published pricebook → first staff invite — and watch
the first-day revenue roll up into the network dashboard.**

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### Network metrics + API

- [ ] `computeNetworkMetrics(tx, { scope, periodStart?, periodEnd? })`
  pure projector returning
  `{
     totals: { revenueCents, openArCents, aiCostUsd,
               royaltyCollectedCents, jobsCount,
               franchiseeCount },
     perFranchisee: [
       { franchiseeId, name, revenueCents, openArCents,
         jobsCount, aiCostUsd, royaltyCollectedCents }
     ]
   }`
  scoped to the caller (`platform_admin` → all;
  `franchisor_admin` → their franchisees).
- [ ] `GET /api/v1/franchisor/network-metrics?periodStart=&periodEnd=`
  admin-only (platform + franchisor). Scoped franchisee /
  tech / CSR → 403.
- [ ] Default period = trailing 30 days UTC when no query
  params.

### Audit log search + filters

- [ ] `GET /api/v1/audit-log` accepts `?q=`, `?userId=`,
  `?kind=` query params. `q` does a case-insensitive LIKE
  match across `action` and `target_type`. Results stay
  scoped per the phase-2 RLS + app-layer rules.
- [ ] `/franchisor/audit` UI gains a filter bar with text
  search + a kind dropdown (all / impersonation /
  invoice / payment / agreement).

### Network dashboard

- [ ] `/franchisor` (new top-level route) renders four
  metric tiles (revenue, open AR, AI spend, franchisee
  count) + a per-franchisee table with revenue / jobs /
  royalty collected / a "View as" quick-impersonate link.
- [ ] "View as" calls the existing `/impersonate/start`
  flow and redirects to `/dashboard`; the phase-2 HQ
  banner appears automatically.
- [ ] Non-admin scopes get `notFound()` on `/franchisor`.

### Onboarding wizard

- [ ] `POST /api/v1/franchisor/onboard` creates a franchisee
  row under the caller's franchisor (admin-only). Body
  carries `{ name, slug, legalEntityName?, locationName?,
  timezone? }`. Returns the new franchisee id.
- [ ] `/franchisor/onboard` multi-step client wizard:
  1. Legal name + slug + city/timezone → POST `/onboard`.
  2. Optional Twilio number provision (via existing
     `/api/v1/franchisees/:id/phone/provision`).
  3. Stripe Connect onboarding link (via existing
     `/connect/onboard`).
  4. Publish a pricebook template (via existing catalog
     endpoints) — the UI picks from the franchisor's
     already-authored templates.
  5. Invite the first staff member (via existing
     `/api/v1/invites`).
- [ ] Each step is skippable — the wizard always lets
  the admin "finish now" without completing optional
  steps. Progress persists across page reloads via a
  small localStorage resume helper.

### Security test suite

- [ ] ≥ 20 cases in `apps/api/src/__tests__/live-security-fc.test.ts`,
  < 30 s runtime.
- [ ] Anonymous 401 on `/franchisor/network-metrics` +
  `/franchisor/onboard`.
- [ ] Tech / CSR / franchisee_owner → 403 on both.
- [ ] Cross-franchisor: a franchisor admin for Franchisor A
  does not see Franchisor B's franchisees in metrics.
- [ ] Onboarding call that sends a `franchisorId` in the
  body (malicious / ignored) still creates the franchisee
  under the caller's franchisor, not the supplied one.
- [ ] Audit-log filter injection: `?q=` treated as a LIKE
  parameter, never concatenated into SQL.

### Unit + integration tests
- [ ] `pnpm turbo test --force` → 0 cached, 0 skipped.
- [ ] No regression in phases 1–12.

---

## Must Improve Over Previous Phase
- [ ] No regression in phase_ai_collections.
- [ ] No new `pnpm audit --audit-level=high` findings.
- [ ] `/franchisor` + `/franchisor/onboard` bundles each
  under 130 kB First Load JS.

---

## Security Baseline
- [ ] Every new endpoint has 401 + 403 + 400 tests.
- [ ] Onboarding payload ignores any client-supplied
  `franchisorId`; the server always uses the caller's
  scope.
- [ ] Audit-log filters use parameterised queries, not
  concatenation.

---

## Documentation
- [ ] `docs/ARCHITECTURE.md` section 6k "Franchisor console".
- [ ] `docs/api/franchisor-console.md`.

---

## Gate Decision

_(Filled in by reviewer after all BLOCKER criteria are verified)_

**Verdict:** _(pending)_
