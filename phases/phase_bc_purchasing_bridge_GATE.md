# Phase Gate: phase_bc_purchasing_bridge

**STATUS: SHIPPED 2026-05-21. BCB-01..05 landed across both repos (local commits, not pushed). Ref: `docs/api/bc-purchasing-bridge.md`. Closes TD-INV-01 + TD-PO-01.**

Phase 26 — the BC purchasing bridge that closes TD-INV-01 + TD-PO-01. Two
supplier-side capabilities reached through the existing `SupplierProvider` seam
(SQB pattern: `X-Service-AI-Key`, retry/backoff, `{ok,data}` envelope):

1. **Availability read** — "can the manufacturer (Elevated Doors' BC) fulfill
   this basket?" BC AI Agent already computes it (`bc_inventory_service
   .check_availability`); we expose it externally + surface it in the quote
   builder.
2. **PO send** — Service.AI `submit` of a purchase order pushes a real BC
   purchase order (`bc_client.create_purchase_order` + `add_purchase_order_line`)
   and stamps the BC PO ref back on the Service.AI PO. Idempotent on the
   Service.AI PO id so a retried submit doesn't create a duplicate BC PO.

## Verification ceiling
Like SQB/QOC/VP: real BC calls can't run here (no creds). Both sides are covered
by mocked unit/integration tests + typecheck. The live BC path is unvalidated
(documented) — same as the go-live one-real-transaction.

## Must Pass

- [x] **BCB-01** — `SupplierProvider` gains two optional ops (`packages/suppliers`):
  - `checkAvailability(req)` → `{ allAvailable, items:[{ sku, onHand, available,
    shortfall, status, leadTimeDays }] }`.
  - `createPurchaseOrder(req)` → `{ supplierPoRef, supplierPoId, createdAt }`;
    idempotent on `externalPoId`.
  Implement in `MockSupplierProvider` (deterministic) + `BcAiAgentProvider`
  (POST `/api/external/check-availability`, `/api/external/purchase-orders`;
  widen the retry `operation` union; `Idempotency-Key` on PO create). Types in
  `types.ts`. Mocked tests for both providers.
- [x] **BCB-02** — BC AI Agent endpoints (`bc-ai-agent/backend`):
  - `POST /api/external/check-availability` — `require_external_key` +
    `assert_account_code`; wraps `bc_inventory_service.check_availability`
    (`items:[{itemNumber, quantity}]`); returns the camelCase envelope.
  - `POST /api/external/purchase-orders` — wraps `create_purchase_order` +
    `add_purchase_order_line`; idempotent on `externalPoId` via a new
    `external_purchase_orders` table (UNIQUE on `external_po_id`, stores
    `bc_po_id`/`bc_po_number`) + per-key lock (mirror `external_quote_service`).
    Returns `{ supplierPoRef, supplierPoId, createdAt }`. Alembic migration.
  - Register the router; pytest with a fake bc_client + service (mirror
    `test_external_*`). Auth 401, account-mismatch 404, happy path, idempotent
    replay.
- [x] **BCB-03** — Service.AI wiring (`apps/api`):
  - Migration `0025_po_bc_ref.sql` — add `supplier_po_ref`, `supplier_po_id`,
    `bc_synced_at` to `purchase_orders` (+ Drizzle + roundtrip `bcb-01`).
  - PO routes get the `ProviderRegistry` dep; `POST /purchase-orders/:id/submit`
    calls `provider.createPurchaseOrder` **best-effort** (failure doesn't block
    the local submit — mirror QOC accept), stamps `supplier_po_ref`/`_id`/
    `bc_synced_at` on success. Idempotency key = the PO id.
  - `POST /api/v1/inventory/check-availability` — `{ supplierId, items:[{sku,
    quantity}] }` → resolves the provider, returns the availability envelope.
    Branch-scoped read.
  - Tests with a mock provider: submit stamps the ref; provider failure leaves
    the PO submitted with null ref; availability happy path + cross-tenant.
- [x] **BCB-04** — web: an availability check in the quote builder (badge per
  line / a "Check supplier stock" affordance) and the BC PO ref shown on the PO
  detail once synced. Verified via `next build`.
- [x] **BCB-05** — docs (`docs/api/bc-purchasing-bridge.md`) + close TD-INV-01 +
  TD-PO-01 + new TDs + gate SHIPPED + memory.

## Security / tenancy
- All Service.AI surfaces branch-scoped (`requireScope`/`withScope`,
  cross-tenant 404); supplier resolved via the registry (corporate-shared).
- `X-Service-AI-Key` never logged (existing Pino redaction). PO create is
  idempotent on `externalPoId` so a retry can't double-order at BC.
- Best-effort BC calls never roll back the local Service.AI state (PO submit
  succeeds even if BC is down; a later retry syncs).

## Out of scope
- Receiving against the BC PO / BC purchase receipts (Service.AI receiving stays
  internal — INV/PO already handle stock).
- Vendor master sync; BC availability caching beyond BC AI Agent's own.
- Auto-PO generation from availability shortfalls.

## Tasks: BCB-01 (TS providers) → BCB-02 (BC endpoints) → BCB-03 (Service.AI wiring) → BCB-04 (web) → BCB-05 (docs).

## Gate Decision
**APPROVED** (2026-05-21, Joey). Cross-repo; commit locally, do not push.
