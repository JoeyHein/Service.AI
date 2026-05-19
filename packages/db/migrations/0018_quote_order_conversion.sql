-- Migration: 0018_quote_order_conversion (up)
--
-- Closes the SQB loop by recording BC sales-order references on the
-- Service.AI quote row after the operator clicks Accept. Pure additive
-- — three nullable columns on the existing `quotes` table; no new
-- tables, no new RLS, no FK changes.
--
-- One BC quote → one BC order in this phase (BC's `makeOrder` is 1:1).
-- A future phase that introduces a multi-order conversion path would
-- replace these columns with a dedicated `orders` table.
--
-- The columns are null until the supplier provider successfully
-- converts the BC quote to an order. A provider-side failure does
-- NOT roll back the local `accepted` state — the columns simply stay
-- null and a retry of /accept will re-attempt the conversion (the
-- BC AI Agent endpoint is idempotent on `external_quote_id`).

BEGIN;

ALTER TABLE quotes
  ADD COLUMN supplier_order_ref text,
  ADD COLUMN supplier_order_id uuid,
  ADD COLUMN ordered_at timestamptz;

-- Unique on the BC order ref to mirror `supplier_quote_ref` — one BC
-- order document per Service.AI quote. Partial index so multiple
-- null rows are allowed.
CREATE UNIQUE INDEX quotes_supplier_order_ref_unique
  ON quotes (supplier_order_ref)
  WHERE supplier_order_ref IS NOT NULL;

COMMIT;
