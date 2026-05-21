# Phase Gate: phase_purchase_orders

**STATUS: SHIPPED 2026-05-21. PO-01..05 landed. Ref: `docs/api/purchase-orders.md`. Local-only.**

Phase 25 — closes the inventory loop. INV-03 handles *consumption* (jobs use
parts); this handles *replenishment* (order parts from a supplier, receive them,
stock goes up). Branch-scoped POs against the real `suppliers` table, seeded
from the INV low-stock report, with receiving that writes `receipt` movements
into the inventory ledger and bumps on-hand.

## What BC AI Agent has (and what we improve)
BC AI Agent has demand-signal → PO-draft → approve → submit-to-BC, but **no
receiving, no inventory update on receipt**, and vendors are **free-text
strings**. Service.AI improves on all three: POs reference the real `suppliers`
row, receiving updates inventory, and the low-stock report (INV) is the demand
source. The actual "send the PO to the supplier / BC" is deferred (TD-PO-01),
same call as the deferred BC availability overlay — `submit` is an internal
state for v1.

## Must Pass

- [x] **PO-01** — schema (migration `0024_purchase_orders.sql` + `.down` +
  Drizzle + round-trip test `po-01`). Two branch-scoped tables + a PO-number
  sequence; two-policy RLS; append to `db:migrate`:
  - `purchase_orders`: `id, branch_id (NOT NULL→branches restrict), supplier_id
    (NOT NULL→suppliers restrict), po_number TEXT, status TEXT
    (draft|submitted|partial|received|canceled CHECK), currency_code,
    subtotal_cents bigint, notes, expected_date, submitted_at, received_at,
    created_by_user_id (→users set null), created_at, updated_at`. Indexes:
    branch_id, supplier_id, status. `CREATE SEQUENCE purchase_order_number_seq`.
  - `purchase_order_lines`: `id, po_id (→purchase_orders cascade), branch_id
    (denormalized for RLS, →branches cascade), position int, sku, description,
    quantity numeric(14,3), unit_cost_cents bigint, received_qty numeric default
    0, item_id (nullable→inventory_items set null), created_at, updated_at`.
    Unique `(po_id, position)`. Indexes: po_id, branch_id.
- [x] **PO-02** — PO API (`apps/api/src/purchase-order-routes.ts`), branch-scoped
  (`requireScope`/`withScope`/cross-tenant 404; writes manager+/corporate_admin):
  - `POST /api/v1/purchase-orders` — create draft `{ supplierId, expectedDate?,
    notes?, lines: [{ sku, description?, quantity, unitCostCents, itemId? }] }`.
    `po_number` from the sequence (`PO-000123`). `subtotal_cents` = Σ qty×cost.
    Corporate must pass `branchId`. Supplier must exist.
  - `POST /api/v1/purchase-orders/from-low-stock` — `{ supplierId }`: build a
    draft from the branch's low-stock items (qty = `reorder_qty>0 ? reorder_qty :
    reorder_point − available`, min 1; unit cost + sku + itemId from the item).
    422 if nothing is low.
  - `GET /api/v1/purchase-orders` — list (`status`, `supplierId`, pagination).
  - `GET /api/v1/purchase-orders/:id` — PO + lines.
  - `POST /api/v1/purchase-orders/:id/submit` — draft → submitted
    (sets `submitted_at`; actual supplier send deferred — TD-PO-01).
  - `POST /api/v1/purchase-orders/:id/cancel` — → canceled (not if `received`).
  - Tests: 401/403, create + number, from-low-stock, list/filter, cross-tenant
    404, submit/cancel transitions, invalid transition 409.
- [x] **PO-03** — receiving (`POST /api/v1/purchase-orders/:id/receive`,
  `{ lines: [{ lineId, receiveQty }] }`). In one `withScope` tx, per line:
  bump `received_qty` (reject over-receive beyond ordered → 422); upsert the
  branch inventory item by `(branch_id, sku)` — exists → on-hand += received (+
  refresh unit cost); missing → create it stocked at the received qty; write a
  `receipt` movement (`ref_type='po'`, `ref_id=poId`). Recompute PO status: all
  lines fully received → `received` (+`received_at`); any partial → `partial`.
  Must be valid only from `submitted|partial`. Tests: receive full → received +
  on-hand up + movement; partial → partial; receive into a new SKU creates the
  item; over-receive 422; receive on a draft 409.
- [x] **PO-04** — web UI (`(app)/purchase-orders`): list (status badges,
  supplier, total, expected date) + "New PO" + "From low stock"; detail (lines
  with ordered/received progress, submit/cancel, a receive form per line); new-PO
  form (supplier select + line rows). "Purchase Orders" nav link. Verified via
  `next build`.
- [x] **PO-05** — docs (`docs/api/purchase-orders.md`) + TD (TD-PO-01 send-to-BC,
  others) + gate SHIPPED + memory.

## Security / tenancy rules
- Branch-scoped; `branch_id` from `request.scope`, never the body. Cross-tenant
  → 404. Writes manager+/corporate_admin.
- Costs/quantities for receiving come from the PO line (server-held), not
  trusted as absolute from the request beyond the `receiveQty` delta.
- Receiving updates inventory + writes the movement in the SAME tx as the PO
  line/status update — stock, ledger, and PO can't drift. Mirrors INV-03's
  one-tx discipline.

## Out of scope (deferred)
- TD-PO-01: send the PO to the supplier / BC (SupplierProvider.createPurchaseOrder
  → a new BC external endpoint). `submit` is internal-only for v1.
- TD-PO-02: demand-signal acknowledge workflow (we use the live low-stock report
  directly, no separate signal table).
- TD-PO-03: vendor invoice / 3-way match; over-receipt; partial-line edits after
  submit; PO line editing after creation (recreate for now).

## Tasks: PO-01 (schema) → PO-02 (API) → PO-03 (receiving) → PO-04 (web) → PO-05 (docs).

## Gate Decision
**APPROVED** (2026-05-21, Joey). Local-only.
