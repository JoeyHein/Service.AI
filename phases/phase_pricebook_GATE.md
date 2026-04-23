# Phase Gate: phase_pricebook

**Written before build begins. Criteria here cannot be loosened mid-phase.**

Phase 4 of 13. Introduces the franchisor-authored service catalog plus
per-franchisee price overrides with floor/ceiling safety rails. Every
later phase (quotes, invoices, royalty engine) reads from this model,
so the shape must be right the first time.

Reuses phase 2/3 primitives without modification: `RequestScope`,
`withScope`, three-policy RLS per table, app-layer WHERE as defence
in depth, pluggable external-service adapters when we need them.

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### Schema & Migrations

- [ ] Tables: `service_catalog_templates`, `service_items`,
  `pricebook_overrides` present in Drizzle schema
- [ ] Enum `catalog_status` with values `draft`, `published`, `archived`
- [ ] `service_items` has `base_price`, `floor_price` (nullable),
  `ceiling_price` (nullable), `sku`, `name`, `category`, `unit`,
  `sort_order`
- [ ] `pricebook_overrides` is franchisee-scoped; unique per
  `(franchisee_id, service_item_id)` where `deleted_at IS NULL`
- [ ] Migration 0006 applies + reverts cleanly against Postgres 16
- [ ] Every FK indexed; every tenant-scoped table carries
  `franchisee_id` or `franchisor_id` as appropriate plus `created_at`
  / `updated_at`
- [ ] RLS ENABLED + FORCE on every new table
- [ ] Templates + items tables have a READ-ONLY scoped policy so
  franchisee-scoped users can resolve their pricebook (write is
  franchisor_admin / platform_admin only)
- [ ] `pricebook_overrides` follows the standard three-policy pattern

### HQ template + items API

- [ ] `POST /api/v1/catalog/templates` — creates a draft template
  scoped to the caller's franchisor (platform admin must specify
  `franchisorId`); returns the row
- [ ] `GET /api/v1/catalog/templates` — lists templates visible to
  the caller
- [ ] `GET /api/v1/catalog/templates/:id` — 404 when not in scope
- [ ] `PATCH /api/v1/catalog/templates/:id` — partial update while
  status is `draft`
- [ ] `POST /api/v1/catalog/templates/:id/publish` — flips status
  draft → published; enforces: only one `published` template per
  franchisor at a time (archives the previous one atomically)
- [ ] `POST /api/v1/catalog/templates/:id/archive` — flips any
  status → archived
- [ ] `POST /api/v1/catalog/templates/:id/items` + `GET` + `PATCH`
  `/items/:itemId` + `DELETE` — full CRUD for items nested under
  a template. Writes only allowed while template status is `draft`
  (409 TEMPLATE_NOT_EDITABLE otherwise)
- [ ] Every write endpoint is gated to `franchisor_admin` or
  `platform_admin`; franchisee-scoped callers get 403 CATALOG_READONLY
- [ ] All paths run through `requireScope` + `withScope` + explicit
  WHERE (same defence in depth as TEN-/CJ-)

### Franchisee pricebook (resolve + overrides)

- [ ] `GET /api/v1/pricebook` — returns every item in the caller's
  franchisor's currently-published template, merged with the
  franchisee's active overrides. Each row carries:
  `{ serviceItemId, sku, name, category, unit, basePrice,
     floorPrice, ceilingPrice, overridePrice (or null),
     effectivePrice, overridden (bool) }`
- [ ] Items from `draft` or `archived` templates MUST NOT appear
- [ ] `POST /api/v1/pricebook/overrides` body
  `{ serviceItemId, overridePrice, note? }` — validates
  `floor_price ≤ overridePrice ≤ ceiling_price` (when the bound is
  set); on violation returns `400 PRICE_OUT_OF_BOUNDS` with `{ floor,
  ceiling, attempted }` in the message
- [ ] Second override for the same service item UPSERTs in place
  (idempotent: one active override per item per franchisee)
- [ ] `DELETE /api/v1/pricebook/overrides/:id` soft-deletes the
  override; `GET /api/v1/pricebook` next call reflects the base price
- [ ] Cross-tenant attempts: creating an override on a
  `serviceItemId` not in the caller's franchisor → 400 INVALID_TARGET;
  deleting another franchisee's override → 404

### Seed

- [ ] `runSeed(pool)` extends the Elevated Doors tenant with one
  published template and ~50 service items across 5 categories
  (Installs, Repairs, Springs, Openers, Parts)
- [ ] Idempotent: re-running the seed does not duplicate items or
  templates
- [ ] At least two demo overrides on the Denver franchisee so the
  "inherited + override" flow is visible without manual setup
- [ ] Adds `service_catalog_templates` + `service_items` counts to
  the seed result object so live tests can assert expected numbers

### Web UI

- [ ] `/(app)/franchisor/catalog` — list of templates (status chip,
  published-at, item count). `New template` button. Access gated
  to platform + franchisor admins via `notFound()` for others
- [ ] `/(app)/franchisor/catalog/[templateId]` — item editor table
  with inline add + edit while status is `draft`; Publish + Archive
  buttons; readonly when status is `published` or `archived`
- [ ] `/(app)/pricebook` — franchisee view grouped by category.
  Each row: name, SKU, unit, base price, effective price column
  with inline override editor. Client-side validation enforces the
  floor/ceiling hint; server-side rejection surfaces as an inline
  error (no dead-end 400 page)
- [ ] AppShell nav adds Catalog (admins) + Pricebook (franchisee
  users) links; hidden while impersonating for consistency with
  phase-2 pattern

### Security test suite (live Postgres)

- [ ] ≥25 cases in `apps/api/src/__tests__/live-security-pb.test.ts`,
  all pass, <30 s runtime
- [ ] Anonymous 401 on every new endpoint
- [ ] Cross-franchisor read of templates blocked (404)
- [ ] Franchisee (any role) cannot POST/PATCH/DELETE templates or
  items — 403 CATALOG_READONLY
- [ ] Tech / dispatcher / csr can READ /api/v1/pricebook
- [ ] Override under floor / over ceiling returns 400
  PRICE_OUT_OF_BOUNDS with `{ floor, ceiling, attempted }` shape
- [ ] Cross-franchisee override write denied
- [ ] Publish/archive by a franchisee_owner rejected

### Unit + Integration Test Suite

- [ ] `pnpm turbo test --force` exits 0 across every workspace
  project, 0 cached, 0 skipped
- [ ] No regression in phases 1–3 (all 466 existing tests pass)

---

## Must Improve Over Previous Phase

- [ ] No regression in phase_customer_job tests
- [ ] No new `pnpm audit --audit-level=high` findings
- [ ] Web bundle First Load JS per route stays under 150 kB

---

## Security Baseline (inherited + tightened)

- [ ] Every new endpoint has 401 + 403 + 400 tests
- [ ] Cross-tenant access returns 404 (not 403) per the phase-3 rule
- [ ] Price columns stored as `numeric(12, 2)` — never float

---

## Documentation

- [ ] `docs/ARCHITECTURE.md` gains a "Pricebook model" subsection
  describing the inheritance + override chain and the floor/ceiling
  invariant
- [ ] `docs/api/pricebook.md` documents every new endpoint with
  request/response shapes + error codes
- [ ] `CLAUDE.md` gets a "Read-only scoped RLS policies" note if any
  new pattern emerges

---

## Gate Decision

**Verdict:** APPROVED

**Reviewer:** Joey Heinrichs (self-review against AUDIT_1)
**Date:** 2026-04-23
**Commit:** cf9b4b0 + docs/approval commit on top
**Notes:** Every BLOCKER criterion is independently verified in
`phase_pricebook_AUDIT_1.md` against the live docker Postgres stack.
544 tests across 9 packages, 0 cached, 0 skipped. Zero bugs surfaced
during the live-testing run — the defence-in-depth patterns from
phase 2/3 carried over cleanly, including for the new read-only
scoped RLS policy variant (franchisee can SELECT templates/items but
cannot mutate). Two minors carried forward (no un-archive endpoint,
no bulk item import) are explicit trade-offs. Tagged
`phase-pricebook-complete`.
