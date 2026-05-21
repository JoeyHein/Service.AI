# Phase Gate: phase_inventory

**STATUS: APPROVED 2026-05-21 (Joey). Branch-level service-parts inventory with auto-consumption on job completion. Local-only.**

Phase 24 — first genuinely-new (non-harvest) feature. Service.AI has **zero**
inventory today. This builds the ServiceTitan-style branch stock model
(on-hand, reserve, receive, consume, reorder/low-stock + a movements ledger),
mirroring the *concepts* in BC AI Agent's inventory (item levels,
`itemLedgerEntries` movement history, availability check, demand-signal/reorder
engine) but implemented as Service.AI's own branch-owned stock.

## Why branch-scoped (not a shared corporate item master)
The platform's corporate-only tables (`service_items`) use a `_scoped` RLS
policy of `false`, so branch roles cannot read them under RLS in production. A
shared item master would be unreadable by branches. Branch stock is also the
real-world model: each branch/truck holds its own parts. So **every inventory
table is branch-scoped** (standard two-policy RLS), and each row is
self-describing (sku/name/category/unit live on the branch's item row).

## Resolved decisions (2026-05-21, Joey)
1. **Auto-deduct on job completion.** When a job transitions to `completed`,
   read its linked quote's line items, match each `supplier_sku` to a stocked
   item in the job's branch, and decrement on-hand (+ a `consumption` movement).
   Unmatched SKUs are recorded as **consumption exceptions** for a
   reconciliation inbox (create/link an item, or ignore).
2. **BC supplier-availability overlay is deferred** (TD-INV-01). This phase is
   fully local-only — no bc-ai-agent edits. "Can the manufacturer fulfill this?"
   (SupplierProvider.checkAvailability → a new BC external endpoint) is a later
   small bridge phase.

## Must Pass

- [ ] **INV-01** — schema (migration `0023_inventory_management.sql` + `.down` +
  Drizzle + round-trip test `inv-01`). Three branch-scoped tables, two-policy
  RLS, append to `db:migrate`:
  - `inventory_items`: `id, branch_id (NOT NULL→branches restrict), sku, name,
    category, unit (default 'each'), unit_cost_cents bigint, qty_on_hand
    numeric(14,3) default 0, qty_reserved numeric default 0, reorder_point
    numeric default 0, reorder_qty numeric default 0, bin, active bool default
    true, created_at, updated_at`. Unique `(branch_id, sku)`. Indexes:
    branch_id, category.
  - `inventory_movements` (append-only ledger): `id, branch_id, item_id
    (→inventory_items cascade), delta_qty numeric, reason
    (receipt|consumption|adjustment|reserve|release|transfer_in|transfer_out
    CHECK), ref_type, ref_id, unit_cost_cents bigint, note, actor_user_id
    (→users set null), created_at`. Indexes: branch_id, item_id, (branch_id,
    created_at desc).
  - `inventory_consumption_exceptions`: `id, branch_id, job_id, quote_id, sku,
    description, quantity numeric, status (pending|resolved|ignored CHECK),
    resolved_item_id (nullable→inventory_items set null), created_at,
    resolved_at`. Indexes: branch_id, (branch_id, status).
- [ ] **INV-02** — inventory API (`apps/api/src/inventory-routes.ts`), all
  branch-scoped (`requireScope`/`withScope`/cross-tenant 404):
  - `POST /api/v1/inventory/items` (manager+/corporate_admin), `GET` list
    (search sku/name, `category`, `lowStock=true`, pagination), `GET /:id`
    (item + recent movements), `PATCH /:id`.
  - `POST /api/v1/inventory/items/:id/adjust` — `{ deltaQty, reason
    (receipt|adjustment|consumption), note?, unitCostCents? }`: updates
    `qty_on_hand` + writes a movement in one tx. Receipt may update unit cost.
    Reject moves that would drive on-hand below 0 only for `consumption`
    (receipts/adjustments may correct).
  - `GET /api/v1/inventory/low-stock` — active items where
    `qty_on_hand - qty_reserved <= reorder_point` (the reorder report; feeds PO
    mgmt later).
  - Tests: 401/403 (csr/tech cannot create), 400, list/search/lowStock filter,
    cross-tenant 404, adjust receipt + adjust below-zero guard.
- [ ] **INV-03** — auto-consumption + reconciliation. On `job → completed`
  (in `jobs-routes.ts`, same tx as the balance invoice): for the linked quote's
  lines, match `supplier_sku → inventory_items(branch_id, sku, active)`; matched
  → decrement on-hand + `consumption` movement (`ref_type='job'`,
  `ref_id=jobId`); unmatched → `inventory_consumption_exceptions` row. Idempotent
  (skip if movements already exist for this job). Endpoints:
  `GET /api/v1/inventory/exceptions` (pending, paginated),
  `POST /api/v1/inventory/exceptions/:id/resolve`
  (`{ itemId }` → links + consumes, or `{ create: {...} }` → makes a stocked item
  then consumes), `POST .../ignore`. Tests: matched decrement + movement,
  unmatched → exception, idempotent re-complete, resolve creates+consumes.
- [ ] **INV-04** — web UI (`(app)/inventory`): item list with low-stock badges +
  search/category/low-stock filter; item detail (levels, available =
  on_hand−reserved, reorder, recent movements, an Adjust/Receive form);
  reconciliation inbox for pending exceptions (link/create/ignore). "Inventory"
  nav link. Server-fetch lists; client forms.
- [ ] **INV-05** — docs (`docs/api/inventory.md`) + TD (TD-INV-01 BC availability
  overlay, TD-INV-02 reservation-on-accept, others) + gate SHIPPED + memory.

## Security / tenancy rules
- Every table branch-scoped; `branch_id` from `request.scope`, never the body.
  Cross-tenant probe → 404.
- Quantities/costs never trusted as absolute from the client for movements —
  adjust takes a *delta* + reason and the server computes the new on-hand inside
  `withScope` in one tx with the movement insert (state + ledger can't drift).
- Item create/edit/adjust = manager+ / corporate_admin; csr/tech read-only.
- Auto-consumption runs inside the existing job-completion transaction so stock,
  the movement ledger, and the balance invoice all commit together or not at all.

## Out of scope (deferred)
- BC supplier-availability overlay (TD-INV-01).
- Auto-reserve stock on quote accept (TD-INV-02) — `qty_reserved` column exists;
  hook deferred.
- Multi-location/bin within a branch; stock transfers between branches (movement
  reasons exist; no transfer workflow yet).
- Inventory valuation/COGS reporting beyond unit_cost on movements.

## Tasks: INV-01 (schema) → INV-02 (API) → INV-03 (auto-consume + reconcile) → INV-04 (web) → INV-05 (docs).

## Gate Decision
**APPROVED** (2026-05-21, Joey). Local-only.
