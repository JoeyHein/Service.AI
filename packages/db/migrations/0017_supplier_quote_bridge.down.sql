-- Migration: 0017_supplier_quote_bridge (down)
--
-- Reverses 0017. Drops in FK-safe order: status log → line items →
-- quotes → margin_overrides → suppliers. Enums dropped last.
--
-- Drops are CASCADE-free deliberately — if a downstream table somehow
-- holds an FK we didn't expect, the drop will error and surface the
-- coupling rather than silently amputating it.

BEGIN;

-- Drop policies first (CASCADE on the table drops them, but explicit
-- DROP POLICY keeps the down-migration symmetric with the up).
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE schemaname = current_schema()
       AND tablename IN (
         'suppliers',
         'margin_overrides',
         'quotes',
         'quote_line_items',
         'quote_status_log'
       )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

DROP TABLE IF EXISTS quote_status_log;
DROP TABLE IF EXISTS quote_line_items;
DROP TABLE IF EXISTS quotes;
DROP TABLE IF EXISTS margin_overrides;
DROP TABLE IF EXISTS suppliers;

DROP TYPE IF EXISTS margin_source;
DROP TYPE IF EXISTS quote_status;
DROP TYPE IF EXISTS supplier_provider_kind;

COMMIT;
