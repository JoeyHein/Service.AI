-- Migration: 0008_payments_stripe (up)
-- Extends invoicing with Stripe Connect Standard payments. Adds
-- franchisee.stripe_account_* columns, invoice.stripe_payment_intent_id
-- + payment_link_token, and the payments / refunds / stripe_events
-- tables. Tenant-scoped tables get the standard three-policy RLS
-- pattern (platform_admin / franchisor_admin / scoped).
--
-- stripe_events is deliberately NOT tenant-scoped — the webhook
-- runs before any franchisee has been resolved from the event, so
-- we store the event id unconditionally and short-circuit replays
-- on unique-violation.

-- ---------------------------------------------------------------------------
-- franchisees — Stripe Connect columns
-- ---------------------------------------------------------------------------

ALTER TABLE franchisees
  ADD COLUMN IF NOT EXISTS stripe_account_id TEXT,
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stripe_details_submitted BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS franchisees_stripe_account_unique
  ON franchisees(stripe_account_id)
  WHERE stripe_account_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- invoices — payment intent + public payment token
-- ---------------------------------------------------------------------------

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS application_fee_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_link_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_stripe_payment_intent_unique
  ON invoices(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_payment_link_token_unique
  ON invoices(payment_link_token)
  WHERE payment_link_token IS NOT NULL;

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  stripe_payment_intent_id TEXT NOT NULL,
  stripe_charge_id TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  application_fee_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payments_franchisee_idx ON payments(franchisee_id);
CREATE INDEX IF NOT EXISTS payments_invoice_idx ON payments(invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS payments_charge_unique ON payments(stripe_charge_id);

-- ---------------------------------------------------------------------------
-- refunds
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
  stripe_refund_id TEXT NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS refunds_franchisee_idx ON refunds(franchisee_id);
CREATE INDEX IF NOT EXISTS refunds_invoice_idx ON refunds(invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS refunds_stripe_refund_unique
  ON refunds(stripe_refund_id);

-- ---------------------------------------------------------------------------
-- stripe_events — webhook idempotency log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stripe_events_type_idx ON stripe_events(type);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE payments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments  FORCE  ROW LEVEL SECURITY;
ALTER TABLE refunds   ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds   FORCE  ROW LEVEL SECURITY;

-- payments — three-policy franchisee-scoped
CREATE POLICY payments_platform_admin ON payments
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY payments_franchisor_admin ON payments
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );
CREATE POLICY payments_scoped ON payments
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

-- refunds — same pattern
CREATE POLICY refunds_platform_admin ON refunds
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY refunds_franchisor_admin ON refunds
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );
CREATE POLICY refunds_scoped ON refunds
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

-- stripe_events — deliberately not RLS-gated. The webhook runs
-- outside of any RequestScope (Stripe callers have no tenant
-- identity until we resolve the event metadata), and we only
-- write the event id + timestamp which carries no tenant secrets.
