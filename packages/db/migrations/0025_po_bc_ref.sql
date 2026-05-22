-- Migration: 0025_po_bc_ref (up)
--
-- Phase 26 (BCB / TD-PO-01). Stamps the BC purchase-order reference back onto
-- the Service.AI PO when `submit` pushes it to the supplier via the bridge.
-- Best-effort: null until a successful BC create.

BEGIN;

ALTER TABLE purchase_orders ADD COLUMN supplier_po_ref TEXT;
ALTER TABLE purchase_orders ADD COLUMN supplier_po_id TEXT;
ALTER TABLE purchase_orders ADD COLUMN bc_synced_at TIMESTAMPTZ;

COMMIT;
