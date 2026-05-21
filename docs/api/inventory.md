# Inventory — branch parts stock (INV) — phase 24

Service.AI's own branch-level service-parts inventory: per-(branch, sku) levels,
an append-only movement ledger, low-stock/reorder reporting, and
auto-consumption of a quote's parts when its job completes. Mirrors the
*concepts* in BC AI Agent's inventory (item levels, `itemLedgerEntries` movement
history, availability, reorder/demand signals) but is Service.AI's own
branch-owned stock — not the manufacturer's BC inventory.

## Why branch-scoped
The platform's corporate-only tables (`service_items`) use a `_scoped` RLS
policy of `false`, so branch roles can't read them under RLS in production. A
shared corporate item master would be invisible to branches. Branch stock is
also the real model (each branch/truck holds its own parts), so **all three
tables are branch-scoped** (two-policy RLS) and each item row is self-describing.

## Data model (migration `0023_inventory_management.sql`)

- `inventory_items` — one row per `(branch_id, sku)` (unique). `name, category,
  unit, unit_cost_cents, qty_on_hand, qty_reserved, reorder_point, reorder_qty,
  bin, active`. **Available = on_hand − reserved.**
- `inventory_movements` — append-only ledger. `delta_qty` (signed), `reason`
  (`receipt|consumption|adjustment|reserve|release|transfer_in|transfer_out`
  CHECK), `ref_type`/`ref_id` (e.g. `job`/jobId), `unit_cost_cents`, `note`,
  `actor_user_id`. `qty_on_hand` is the running balance, updated in the same tx
  as each movement so state + ledger can't drift.
- `inventory_consumption_exceptions` — auto-consume couldn't match a quote line's
  SKU to a stocked item. `job_id, quote_id, sku, description, quantity, status
  (pending|resolved|ignored), resolved_item_id`.

## Endpoints (`apps/api/src/inventory-routes.ts`)
All branch-scoped (`requireScope`/`withScope`, cross-tenant probe → 404). Reads
open to any scope; **writes are manager / corporate_admin only** (csr/tech
read-only).

- `POST /api/v1/inventory/items` — create (corporate must pass `branchId`).
  Duplicate `(branch, sku)` → 409.
- `GET  /api/v1/inventory/items` — list; `search` (sku/name), `category`,
  `lowStock=true`, pagination.
- `GET  /api/v1/inventory/items/:id` — item + last 50 movements.
- `PATCH /api/v1/inventory/items/:id` — edit name/category/unit/cost/reorder/
  bin/active.
- `POST /api/v1/inventory/items/:id/adjust` — `{ deltaQty, reason
  (receipt|adjustment|consumption), note?, unitCostCents? }`. Updates on-hand +
  writes a movement in one tx. `consumption` that would go below 0 → 422
  (manual guard); `receipt` may update unit cost.
- `GET  /api/v1/inventory/low-stock` — active items where
  `on_hand − reserved <= reorder_point` (the reorder report; feeds PO mgmt).
- `GET  /api/v1/inventory/exceptions` — reconciliation queue (`status`,
  default pending).
- `POST /api/v1/inventory/exceptions/:id/resolve` — `{ itemId }` (link existing)
  or `{ create: {...} }` (make a stocked item), then consume the exception's
  quantity from that item. `POST .../ignore` marks it ignored.

## Auto-consumption (`inventory-consume.ts`)
On `job → completed` (in `jobs-routes.ts`, the same tx as the balance invoice):
for the linked quote's lines, match `supplier_sku → inventory_items(branch_id,
sku, active)`. Matched → decrement on-hand + a `consumption` movement
(`ref_type='job'`, `ref_id=jobId`). **Auto-consume may drive on-hand negative**
(the parts were used; a negative balance flags a discrepancy rather than
blocking completion). Unmatched → a `consumption_exceptions` row. Idempotent:
skips if the job already has consumption movements (re-completion can't
double-deduct).

## Web (`apps/web/src/app/(app)/inventory`)
- list (low-stock badges, search, low-stock filter, "Reconcile (n)" + "New item"),
- item detail (level KPI cards, receive/adjust/consume form, movement history),
- new-item form,
- reconciliation inbox (create stocked item & consume, or ignore).
"Inventory" nav link.

## Out of scope (deferred — see TECH_DEBT)
- TD-INV-01: BC supplier-availability overlay (SupplierProvider.checkAvailability
  → new BC external endpoint) — "can the manufacturer fulfill this?".
- TD-INV-02: auto-reserve stock on quote accept (`qty_reserved` exists; hook not
  wired).
- TD-INV-03: multi-location/bin within a branch; branch-to-branch transfers
  (movement reasons exist, no workflow).
- TD-INV-04: inventory valuation/COGS reporting.
