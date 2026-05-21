-- Migration: 0020_quote_fulfillment (down)
--
-- Drops the quote-link columns + indexes. Idempotent (IF EXISTS).

BEGIN;

DROP INDEX IF EXISTS invoices_quote_id_unique;
ALTER TABLE invoices DROP COLUMN IF EXISTS quote_id;

DROP INDEX IF EXISTS jobs_quote_idx;
ALTER TABLE jobs DROP COLUMN IF EXISTS quote_id;

COMMIT;
