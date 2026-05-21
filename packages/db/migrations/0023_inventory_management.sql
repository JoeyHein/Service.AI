-- Migration: 0023_inventory_management (up)
--
-- Phase 24 (INV). Service.AI's own branch-level service-parts inventory:
-- on-hand / reserved levels per (branch, sku), an append-only movement ledger,
-- and a consumption-exception queue for quote-line SKUs that auto-consumption
-- could not match to a stocked item.
--
-- All three tables are branch-scoped (two-policy RLS, mirrors CHR/SQB) — there
-- is no shared corporate item master because the platform's corporate-only
-- tables are unreadable by branch roles under RLS. Each branch owns its
-- stocked-parts catalog + levels.

BEGIN;

CREATE TABLE inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'each',
  unit_cost_cents BIGINT NOT NULL DEFAULT 0,
  qty_on_hand NUMERIC(14,3) NOT NULL DEFAULT 0,
  qty_reserved NUMERIC(14,3) NOT NULL DEFAULT 0,
  reorder_point NUMERIC(14,3) NOT NULL DEFAULT 0,
  reorder_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  bin TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX inventory_items_branch_sku_unique ON inventory_items (branch_id, sku);
CREATE INDEX inventory_items_branch_idx ON inventory_items (branch_id);
CREATE INDEX inventory_items_category_idx ON inventory_items (category);

CREATE TABLE inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  delta_qty NUMERIC(14,3) NOT NULL,
  reason TEXT NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  unit_cost_cents BIGINT,
  note TEXT,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT inventory_movements_reason_chk CHECK (
    reason IN ('receipt', 'consumption', 'adjustment', 'reserve', 'release', 'transfer_in', 'transfer_out')
  )
);

CREATE INDEX inventory_movements_branch_idx ON inventory_movements (branch_id);
CREATE INDEX inventory_movements_item_idx ON inventory_movements (item_id);
CREATE INDEX inventory_movements_branch_created_idx ON inventory_movements (branch_id, created_at DESC);

CREATE TABLE inventory_consumption_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  quote_id UUID REFERENCES quotes(id) ON DELETE SET NULL,
  sku TEXT NOT NULL,
  description TEXT,
  quantity NUMERIC(14,3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT inventory_exc_status_chk CHECK (status IN ('pending', 'resolved', 'ignored'))
);

CREATE INDEX inventory_exc_branch_idx ON inventory_consumption_exceptions (branch_id);
CREATE INDEX inventory_exc_branch_status_idx ON inventory_consumption_exceptions (branch_id, status);

-- RLS — two-policy template (branch-scoped) for all three tables.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'inventory_items',
      'inventory_movements',
      'inventory_consumption_exceptions'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (current_setting(''app.role'', true) = ''corporate_admin'')',
      t || '_corporate_admin', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING ('
      || 'current_setting(''app.role'', true) IS NOT NULL '
      || 'AND current_setting(''app.role'', true) <> ''corporate_admin'' '
      || 'AND branch_id = nullif(current_setting(''app.branch_id'', true), '''')::uuid)',
      t || '_scoped', t
    );
  END LOOP;
END $$;

COMMIT;
