-- Migration: 0018_quote_order_conversion (down)
--
-- Drops the three columns added on the up path. Idempotent.

BEGIN;

DROP INDEX IF EXISTS quotes_supplier_order_ref_unique;

ALTER TABLE quotes
  DROP COLUMN IF EXISTS supplier_order_ref,
  DROP COLUMN IF EXISTS supplier_order_id,
  DROP COLUMN IF EXISTS ordered_at;

COMMIT;
