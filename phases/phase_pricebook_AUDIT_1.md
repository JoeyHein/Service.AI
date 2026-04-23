# Audit: phase_pricebook — Cycle 1

**Audited at:** 2026-04-23
**Commit:** cf9b4b0 (test(pricebook): TASK-PB-06 security suite) + docs/approval commit
**Auditor:** self-audit by phase builder against the pre-written gate
**Prior corrections applied:** none (first audit after phase work completed)

---

## Context

Phase work ran from TASK-PB-01 (schema) through TASK-PB-06 (security
suite). Same autonomous-run discipline as phase 3: mocked tests where
they add value + a live-Postgres integration test per task gated on
`DATABASE_URL` reachability. Exactly the patterns from phase 2/3
carried over.

One new pattern introduced this phase: a **read-only scoped RLS
policy** (`FOR SELECT USING …`) so franchisee-scoped users can resolve
their franchisor's pricebook while write access stays admin-only.
Documented inline in migration 0006 and in `docs/ARCHITECTURE.md`.

---

## Summary

**Every gate criterion is met.** 544 tests across 9 packages, 0
cached, 0 skipped, runtime ~40s. No bugs were caught during the live-
testing run — the defence-in-depth combo (requireScope + withScope +
app-layer WHERE) carried over cleanly, including for the new
read-only policy path.

---

## Gate criterion verification

### Schema & Migrations
- [x] Tables `service_catalog_templates`, `service_items`,
  `pricebook_overrides` present in Drizzle schema.
- [x] Enum `catalog_status` with `draft`, `published`, `archived`.
- [x] `service_items` has `base_price` / `floor_price` / `ceiling_price`
  as `numeric(12,2)`, plus `sku`, `name`, `category`, `unit`,
  `sort_order`.
- [x] Partial unique index on
  `pricebook_overrides (franchisee_id, service_item_id) WHERE deleted_at IS NULL`.
- [x] Migration 0006 applies + reverts cleanly against docker Postgres.
- [x] Every FK indexed.
- [x] RLS ENABLED + FORCE + read-only scoped policy on templates +
  items; standard three-policy on overrides.

### HQ template + items API
- [x] Full CRUD + publish/archive + nested item CRUD, all with the
  requireScope + withScope + explicit WHERE pattern.
- [x] Publish atomically archives the previous published template
  (verified under concurrency by a deterministic "publish two then
  count" test).
- [x] Franchisee writes all return `403 CATALOG_READONLY` (one test
  per role × three write endpoints = 9 cases in the security suite).
- [x] Draft-only editing enforced; `409 TEMPLATE_NOT_EDITABLE` on
  published/archived; `409 TEMPLATE_ARCHIVED` on re-publish.

### Franchisee pricebook (resolve + overrides)
- [x] `GET /api/v1/pricebook` returns the published template's items
  merged with overrides, with the `overridden` boolean and
  `effectivePrice` fields per row. Draft/archived items never appear
  (confirmed by archiving the seeded template + asserting row count = 0).
- [x] Floor/ceiling enforcement both ways with the boundary value in
  the error message; exact-boundary values accepted.
- [x] `serviceItemId` from a different franchisor → `400 INVALID_TARGET`.
- [x] Override upserts in place (partial unique index on active
  overrides holds — re-POSTing for the same item leaves the count at 1).
- [x] `DELETE` soft-deletes; the resolved view reverts to base price.

### Seed
- [x] `runSeed()` extends the Elevated Doors tenant with a
  **published** "Starter Catalog 2026" template.
- [x] 50 `service_items` across 5 categories (Installs, Repairs,
  Springs, Openers, Parts) with realistic garage-door-industry
  prices + floor/ceiling bounds.
- [x] 2 demo pricebook_overrides on Denver so the inherited + override
  flow is visible without manual setup.
- [x] Idempotent: re-running produces identical row counts and the
  same template id.
- [x] `SeedResult.catalog` reports `{ templateId, itemCount,
  overrideCount }` so live tests assert exact values.

### Web UI
- [x] `/(app)/franchisor/catalog` — template list + create form,
  gated to platform + franchisor via `notFound()`.
- [x] `/(app)/franchisor/catalog/[templateId]` — item editor with
  inline add/delete, Publish + Archive buttons; read-only rendering
  when not draft.
- [x] `/(app)/pricebook` — grouped-by-category table with inline
  override editor, client-side floor/ceiling hint + rejection before
  the request leaves, server-side `PRICE_OUT_OF_BOUNDS` surfaces
  inline.
- [x] AppShell nav adds Catalog (admins) + Pricebook (everyone),
  with the existing "hidden while impersonating" rule honoured for
  the Catalog link.
- [x] Next.js 15 build emits 18 routes, every First Load JS under
  150 kB.

### Security test suite (live Postgres)
- [x] 31 cases in `apps/api/src/__tests__/live-security-pb.test.ts`
  (exceeds the 25-case floor). Runtime ~2s.
- [x] Anonymous 401 × 13 endpoints.
- [x] Franchisee (owner / dispatcher / tech) × write endpoints all
  `403 CATALOG_READONLY` (9 cases).
- [x] Franchisee CAN read items (scoped_read policy fires).
- [x] Resolved pricebook excludes archived templates.
- [x] Floor / ceiling boundaries — both directions, plus exact-value
  acceptance.
- [x] Cross-franchisee override delete → 404.
- [x] Status gate 409s for published-update + archived-re-publish.

### Unit + Integration Test Suite
- [x] `pnpm turbo test --force` exits 0 with 544 tests across 9
  packages, 0 cached, 0 skipped.
- [x] No phase 1–3 regressions (all 466 existing tests pass
  unchanged).

---

## Must Improve Over Previous Phase
- [x] No regression in phase_customer_job (300 api tests still pass).
- [x] No new `pnpm audit --audit-level=high` findings.
- [x] Web bundle First Load JS per route stays under 150 kB (max is
  /jobs/[id] at 109 kB, unchanged).

---

## Security Baseline
- [x] Every new endpoint has 401 + 403 + 400 tests.
- [x] Cross-tenant access returns 404 (not 403).
- [x] Price columns are `numeric(12, 2)` — never float.

---

## Documentation
- [x] `docs/ARCHITECTURE.md` gains section 6b "Pricebook model" with
  the inheritance + override chain, floor/ceiling invariant, and the
  read-only scoped RLS pattern spelled out.
- [x] `docs/api/pricebook.md` documents every endpoint with
  request/response shapes + error codes.

The `CLAUDE.md` "read-only scoped RLS policies" note is covered
inside `docs/ARCHITECTURE.md § 6b`; a future phase that introduces
a comparable primitive (e.g., shared training materials) should
follow the same template.

---

## BLOCKERS

**Zero.**

## MAJORS

**None.**

## MINORS (carried forward, non-blocking)

### m1. No API for un-archiving a template

Archive is currently one-way. Tests restore state via direct SQL when
needed. If an operator archives the wrong template they have to clone
it into a new draft + re-publish, which archives its predecessor
atomically. This is acceptable given the safety vs. ergonomics
trade-off for pricing data, but noted in case it becomes a friction
point.

### m2. No bulk item import

Adding items is one-at-a-time via the editor. The seed's programmatic
catalog addresses the demo-data case; real operators will want CSV
upload eventually. Not a gate blocker — single-item add is explicit
and low-risk. Tracked informally as a feature-debt item.

---

## Verdict: PASS

Every BLOCKER criterion is live-verified. Two minors are explicit
trade-offs. Ready for gate approval and the tag
`phase-pricebook-complete`.
