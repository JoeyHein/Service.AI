# Purchase Orders — internal replenishment (PO) — phase 25

Closes the inventory loop. INV-03 handles *consumption* (jobs use parts); this
handles *replenishment* — order parts from a supplier, receive them, and stock
goes up (with `receipt` movements written into the INV ledger). Branch-scoped
POs against the real `suppliers` row, seeded from the INV low-stock report.

## What we improved over BC AI Agent
BC AI Agent has demand-signal → PO-draft → approve → submit-to-BC, but **no
receiving, no inventory update on receipt**, and vendors are free-text strings.
Service.AI: POs reference the real `suppliers` row, **receiving updates
inventory**, and the live INV low-stock report is the demand source. Sending the
PO to the supplier / BC is deferred (TD-PO-01) — `submit` is an internal state.

## Data model (migration `0024_purchase_orders.sql`)
- `purchase_orders` — branch-scoped. `supplier_id → suppliers`, `po_number`
  (`PO-000123` from `purchase_order_number_seq`), `status`
  (`draft|submitted|partial|received|canceled` CHECK), `subtotal_cents`, `notes`,
  `expected_date`, `submitted_at`, `received_at`.
- `purchase_order_lines` — `sku, description, quantity, unit_cost_cents,
  received_qty, item_id (→inventory_items)`. Unique `(po_id, position)`.
Two-policy RLS on both.

## Endpoints (`apps/api/src/purchase-order-routes.ts`)
Branch-scoped (`requireScope`/`withScope`, cross-tenant → 404); writes are
manager / corporate_admin.

- `GET  /api/v1/suppliers` — corporate-shared vendor list (read under a corporate
  scope, since `suppliers` RLS denies branch roles). Any authenticated user.
- `POST /api/v1/purchase-orders` — create draft `{ supplierId, expectedDate?,
  notes?, lines:[{sku, description?, quantity, unitCostCents, itemId?}] }`.
  `po_number` from the sequence; `subtotal_cents = Σ qty×cost`. Corporate must
  pass `branchId`. Supplier validated under a corporate scope.
- `POST /api/v1/purchase-orders/from-low-stock` — `{ supplierId }`: a draft
  seeded from the branch's low-stock items (qty = `reorder_qty>0 ? reorder_qty :
  reorder_point − available`, min 1). 422 if nothing is low.
- `GET  /api/v1/purchase-orders` — list (`status`, `supplierId`, pagination).
- `GET  /api/v1/purchase-orders/:id` — PO + lines.
- `POST /api/v1/purchase-orders/:id/submit` — `draft → submitted`.
- `POST /api/v1/purchase-orders/:id/cancel` — → `canceled` (not if `received`).
- `POST /api/v1/purchase-orders/:id/receive` — `{ lines:[{lineId, receiveQty}] }`.
  See below.

## Receiving (PO-03) — the replenishment hook
In one `withScope` tx, per received line: bump `received_qty` (reject
over-receipt beyond ordered → 422); **upsert the branch inventory item by
`(branch_id, sku)`** — exists → on-hand += received (+ refresh unit cost),
missing → create it stocked at the received qty (so a brand-new part gets
stocked on first receipt); write a `receipt` movement (`ref_type='po'`,
`ref_id=poId`); link the line's `item_id`. Then recompute PO status: all lines
fully received → `received` (+`received_at`); any partial → `partial`. Valid
only from `submitted|partial` (receive-on-draft → 409). Same one-tx discipline
as INV-03 — PO, lines, stock, and the ledger commit together.

## Web (`apps/web/src/app/(app)/purchase-orders`)
- list (status filter + badges, PO number, total, dates),
- new-PO form (supplier select + line rows + "Generate from low stock"),
- detail (ordered/received progress per line, submit/cancel, a per-line receive
  form that defaults to the remaining qty).
"POs" nav link.

## Out of scope (deferred — see TECH_DEBT)
- TD-PO-01: send the PO to the supplier / BC (`SupplierProvider.createPurchaseOrder`
  → a new BC external endpoint). `submit` is internal-only for v1.
- TD-PO-02: demand-signal acknowledge workflow (we read the live low-stock
  report directly; no separate signal table like BC AI Agent's `demand_signals`).
- TD-PO-03: vendor invoice / 3-way match; over-receipt; PO line editing after
  creation (recreate for now).
