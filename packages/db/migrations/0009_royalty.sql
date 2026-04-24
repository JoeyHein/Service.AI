-- Migration: 0009_royalty (up)
-- Adds the royalty engine tables for phase_royalty_engine:
-- franchise_agreements, royalty_rules, royalty_statements. All
-- three are tenant-scoped and get the standard 3-policy RLS
-- pattern. A partial unique index enforces "at most one active
-- agreement per franchisee".

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE agreement_status AS ENUM ('draft', 'active', 'ended');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE royalty_rule_type AS ENUM (
    'percentage', 'flat_per_job', 'tiered', 'minimum_floor'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE royalty_statement_status AS ENUM (
    'open', 'reconciled', 'disputed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- franchise_agreements
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS franchise_agreements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  franchisor_id UUID NOT NULL REFERENCES franchisors(id) ON DELETE CASCADE,
  status agreement_status NOT NULL DEFAULT 'draft',
  name TEXT NOT NULL,
  notes TEXT,
  starts_on TIMESTAMPTZ,
  ends_on TIMESTAMPTZ,
  currency TEXT NOT NULL DEFAULT 'usd',
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS franchise_agreements_franchisee_idx
  ON franchise_agreements(franchisee_id);
CREATE INDEX IF NOT EXISTS franchise_agreements_franchisor_idx
  ON franchise_agreements(franchisor_id);
CREATE UNIQUE INDEX IF NOT EXISTS franchise_agreements_one_active
  ON franchise_agreements(franchisee_id)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- royalty_rules
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS royalty_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id UUID NOT NULL REFERENCES franchise_agreements(id) ON DELETE CASCADE,
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  rule_type royalty_rule_type NOT NULL,
  params JSONB NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS royalty_rules_agreement_idx
  ON royalty_rules(agreement_id);
CREATE INDEX IF NOT EXISTS royalty_rules_franchisee_idx
  ON royalty_rules(franchisee_id);

-- ---------------------------------------------------------------------------
-- royalty_statements
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS royalty_statements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  franchisor_id UUID NOT NULL REFERENCES franchisors(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  gross_revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  refund_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
  net_revenue NUMERIC(14, 2) NOT NULL DEFAULT 0,
  royalty_owed NUMERIC(14, 2) NOT NULL DEFAULT 0,
  royalty_collected NUMERIC(14, 2) NOT NULL DEFAULT 0,
  variance NUMERIC(14, 2) NOT NULL DEFAULT 0,
  transfer_id TEXT,
  status royalty_statement_status NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS royalty_statements_franchisee_idx
  ON royalty_statements(franchisee_id);
CREATE INDEX IF NOT EXISTS royalty_statements_franchisor_idx
  ON royalty_statements(franchisor_id);
CREATE UNIQUE INDEX IF NOT EXISTS royalty_statements_period_unique
  ON royalty_statements(franchisee_id, period_start, period_end);
CREATE UNIQUE INDEX IF NOT EXISTS royalty_statements_transfer_unique
  ON royalty_statements(transfer_id)
  WHERE transfer_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE franchise_agreements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE franchise_agreements  FORCE  ROW LEVEL SECURITY;
ALTER TABLE royalty_rules         ENABLE ROW LEVEL SECURITY;
ALTER TABLE royalty_rules         FORCE  ROW LEVEL SECURITY;
ALTER TABLE royalty_statements    ENABLE ROW LEVEL SECURITY;
ALTER TABLE royalty_statements    FORCE  ROW LEVEL SECURITY;

CREATE POLICY franchise_agreements_platform_admin ON franchise_agreements
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY franchise_agreements_franchisor_admin ON franchise_agreements
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
  );
CREATE POLICY franchise_agreements_scoped ON franchise_agreements
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

CREATE POLICY royalty_rules_platform_admin ON royalty_rules
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY royalty_rules_franchisor_admin ON royalty_rules
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );
CREATE POLICY royalty_rules_scoped ON royalty_rules
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

CREATE POLICY royalty_statements_platform_admin ON royalty_statements
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY royalty_statements_franchisor_admin ON royalty_statements
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
  );
CREATE POLICY royalty_statements_scoped ON royalty_statements
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );
