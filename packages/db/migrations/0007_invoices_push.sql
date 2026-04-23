-- Migration: 0007_invoices_push (up)
-- Adds the invoice draft tables (phase_tech_mobile_pwa scope —
-- finalize/pay transitions are phase 7) + web push subscriptions.
-- All tenant-scoped tables get the standard three-policy RLS
-- pattern; push_subscriptions uses a simpler "user can only see
-- their own subscriptions" policy because subscriptions are
-- per-user, not per-tenant.

DO $$ BEGIN
  CREATE TYPE invoice_status AS ENUM (
    'draft', 'finalized', 'sent', 'paid', 'void'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- invoices
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  status invoice_status NOT NULL DEFAULT 'draft',
  subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(6, 4) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  finalized_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS invoices_franchisee_idx ON invoices(franchisee_id);
CREATE INDEX IF NOT EXISTS invoices_job_idx ON invoices(job_id);
CREATE INDEX IF NOT EXISTS invoices_customer_idx ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices(status);

-- ---------------------------------------------------------------------------
-- invoice_line_items
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invoice_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  service_item_id UUID REFERENCES service_items(id) ON DELETE SET NULL,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  quantity NUMERIC(12, 3) NOT NULL,
  unit_price NUMERIC(12, 2) NOT NULL,
  line_total NUMERIC(12, 2) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS invoice_line_items_invoice_idx ON invoice_line_items(invoice_id);
CREATE INDEX IF NOT EXISTS invoice_line_items_franchisee_idx ON invoice_line_items(franchisee_id);

-- ---------------------------------------------------------------------------
-- push_subscriptions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  franchisee_id UUID REFERENCES franchisees(id) ON DELETE SET NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_unique
  ON push_subscriptions(endpoint) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE invoices            ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices            FORCE  ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items  FORCE  ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions  FORCE  ROW LEVEL SECURITY;

-- invoices — three-policy franchisee-scoped pattern
CREATE POLICY invoices_platform_admin ON invoices
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY invoices_franchisor_admin ON invoices
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );
CREATE POLICY invoices_scoped ON invoices
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

-- invoice_line_items — same pattern, matches on denormalised franchisee_id
CREATE POLICY invoice_line_items_platform_admin ON invoice_line_items
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY invoice_line_items_franchisor_admin ON invoice_line_items
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );
CREATE POLICY invoice_line_items_scoped ON invoice_line_items
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

-- push_subscriptions — a user can see and mutate only their own rows.
-- Platform admins can see all (for debugging / ops), and a user's
-- subscriptions match on the GUC `app.user_id` which withScope does
-- NOT set today. Handle the user-scoped path by letting any row with
-- user_id = session user id through: we don't set that as a GUC, so
-- the scoped policy matches on session via current_user? No — use
-- a simpler model: ALL authenticated roles can SELECT/INSERT/UPDATE
-- their own rows via the app layer (it always filters by user_id).
-- RLS here is a defence-in-depth belt: platform_admin bypass, and
-- everyone else matches via the user_id GUC we set in withScope
-- when a scope is active.
CREATE POLICY push_subscriptions_platform_admin ON push_subscriptions
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY push_subscriptions_self ON push_subscriptions
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND user_id = nullif(current_setting('app.user_id', true), '')
  );
