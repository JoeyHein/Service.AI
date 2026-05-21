-- Migration: 0024_purchase_orders (up)
--
-- Phase 25 (PO). Internal purchase orders that replenish branch inventory.
-- Branch-scoped POs reference the corporate `suppliers` row; receiving a PO
-- writes `receipt` movements into the inventory ledger and bumps on-hand
-- (handled in the API, INV-03 one-tx discipline). The low-stock report (INV)
-- is the demand source. "Send to supplier/BC" is deferred — `submit` is an
-- internal state for v1.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS purchase_order_number_seq;

CREATE TABLE purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  po_number TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  currency_code CHAR(3) NOT NULL DEFAULT 'CAD',
  subtotal_cents BIGINT NOT NULL DEFAULT 0,
  notes TEXT,
  expected_date TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT purchase_orders_status_chk CHECK (
    status IN ('draft', 'submitted', 'partial', 'received', 'canceled')
  )
);

CREATE INDEX purchase_orders_branch_idx ON purchase_orders (branch_id);
CREATE INDEX purchase_orders_supplier_idx ON purchase_orders (supplier_id);
CREATE INDEX purchase_orders_status_idx ON purchase_orders (status);
CREATE UNIQUE INDEX purchase_orders_po_number_unique
  ON purchase_orders (po_number) WHERE po_number IS NOT NULL;

CREATE TABLE purchase_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  sku TEXT NOT NULL,
  description TEXT,
  quantity NUMERIC(14,3) NOT NULL,
  unit_cost_cents BIGINT NOT NULL DEFAULT 0,
  received_qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX purchase_order_lines_po_idx ON purchase_order_lines (po_id);
CREATE INDEX purchase_order_lines_branch_idx ON purchase_order_lines (branch_id);
CREATE UNIQUE INDEX purchase_order_lines_position_unique
  ON purchase_order_lines (po_id, position);

-- RLS — two-policy template (branch-scoped).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['purchase_orders', 'purchase_order_lines'])
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
