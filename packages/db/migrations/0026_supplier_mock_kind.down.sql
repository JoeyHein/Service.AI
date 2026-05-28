-- Migration: 0026_supplier_mock_kind (down)
--
-- Postgres has no `ALTER TYPE ... DROP VALUE`, so rebuild the enum without
-- 'mock'. The USING cast fails loudly if any suppliers row still uses 'mock'
-- (repoint those rows to 'bc_ai_agent' before rolling back). suppliers.
-- provider_kind is the only column on this type, so this is the full surface.

BEGIN;

ALTER TYPE supplier_provider_kind RENAME TO supplier_provider_kind_old;

CREATE TYPE supplier_provider_kind AS ENUM ('bc_ai_agent');

ALTER TABLE suppliers
  ALTER COLUMN provider_kind TYPE supplier_provider_kind
  USING provider_kind::text::supplier_provider_kind;

DROP TYPE supplier_provider_kind_old;

COMMIT;
