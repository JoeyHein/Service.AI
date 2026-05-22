# BC Purchasing & Availability Bridge (BCB) — phase 26

Closes TD-INV-01 + TD-PO-01. Two supplier-side capabilities reached through the
existing `SupplierProvider` seam (SQB pattern), spanning **both repos**:

1. **Availability read** — can the manufacturer (Elevated Doors' BC) fulfill a
   basket? Surfaced on the PO form.
2. **PO send** — submitting a Service.AI purchase order pushes a real BC
   purchase order and stamps the BC ref back, idempotent on the Service.AI PO id.

## Verification ceiling
Real BC calls can't run without creds. Both sides are covered by mocked
unit/integration tests + typecheck. The **live BC path is unvalidated** — same
ceiling as SQB/QOC/VP and the go-live one-real-transaction.

## SupplierProvider seam (`packages/suppliers`)
Two new optional ops on `SupplierProvider`:
- `checkAvailability(req)` → `{ allAvailable, items:[{ sku, onHand, available,
  shortfall, status: available|partial|unavailable, leadTimeDays }] }`.
- `createPurchaseOrder(req)` → `{ supplierPoRef, supplierPoId, createdAt }`;
  idempotent on `externalPoId`.
`MockSupplierProvider` implements both deterministically; `BcAiAgentProvider`
POSTs to the new BC endpoints (`X-Service-AI-Key`, retry/backoff,
`Idempotency-Key` = `externalPoId` on PO create).

## BC AI Agent endpoints (`bc-ai-agent/backend`)
- `POST /api/external/check-availability` — wraps
  `bc_inventory_service.check_availability` (`items:[{itemNumber, quantity}]`);
  account-scoped; returns the camelCase envelope. A read — no idempotency.
- `POST /api/external/purchase-orders` — wraps `bc_client.create_purchase_order`
  + `add_purchase_order_line`; idempotent on `externalPoId` via the new
  `external_purchase_orders` table (UNIQUE + the shared per-key in-process lock,
  mirrors `external_quote_commits`). Alembic `b1c2d3e4f5a6`. A replay returns the
  cached BC PO number with no BC traffic.
Both gated by `require_external_key`; cross-account probes → 404.

## Service.AI wiring (`apps/api`)
- Migration `0025_po_bc_ref.sql` — `purchase_orders.supplier_po_ref`,
  `supplier_po_id`, `bc_synced_at`.
- `POST /api/v1/purchase-orders/:id/submit` — flips `draft → submitted`
  (local source of truth) in one tx, then **best-effort** calls
  `provider.createPurchaseOrder` (idempotency key = the PO id) and stamps the BC
  ref on success. A BC failure leaves the PO submitted with a null ref (logged);
  a later retry can re-sync. Mirrors the QOC accept best-effort discipline.
- `POST /api/v1/inventory/check-availability` — `{ supplierId, items }` →
  resolves the provider (suppliers read under a corporate scope) → returns the
  availability envelope. Branch-scoped read.
- PO routes take the `ProviderRegistry`. Supplier config read under a corporate
  scope (suppliers RLS denies branch roles); the FK to suppliers is enforced by
  Postgres regardless of RLS.

## Web
- PO detail shows the synced BC PO ref + sync date.
- New-PO form: "Check supplier stock" annotates each line with
  available/partial/unavailable + on-hand.

## Out of scope / follow-ups
- Quote-builder availability badge (TD-BCB-01) — that surface has no wired
  supplier yet; the PO form is the v1 home.
- Receiving against the BC PO / BC purchase receipts (Service.AI receiving stays
  internal).
- A resync/retry endpoint for POs whose BC push failed (TD-BCB-02).
- Branched alembic history in bc-ai-agent (pre-existing 3 heads; `b1c2d3e4f5a6`
  is based on the external-tables lineage) — a merge revision is a follow-up.
