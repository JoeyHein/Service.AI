-- Migration: 0025_po_bc_ref (down)

BEGIN;

ALTER TABLE purchase_orders DROP COLUMN IF EXISTS bc_synced_at;
ALTER TABLE purchase_orders DROP COLUMN IF EXISTS supplier_po_id;
ALTER TABLE purchase_orders DROP COLUMN IF EXISTS supplier_po_ref;

COMMIT;
