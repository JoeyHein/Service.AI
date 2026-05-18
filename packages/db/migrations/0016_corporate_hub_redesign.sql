-- Migration: 0016_corporate_hub_redesign (up)
--
-- Replaces the franchisor/franchisee tenancy model (migrations 0002 + 0003)
-- with a corporate hub-and-spoke model. One corporate parent (single row).
-- Many branches (replacing franchisees). Each branch run by a W2 local
-- manager paid base + commission.
--
-- This migration is destructive at the row-type level:
--   * franchisors rows are consolidated into a single corporate row
--   * franchisees rows are copied verbatim into branches (preserving id)
--   * franchise_agreements / royalty_rules / royalty_statements are dropped
--   * pricebook_overrides is snapshotted to CSV and dropped
--   * memberships of role 'franchisee_owner' (renamed to 'manager') become
--     the seed rows for branch_managers
--
-- The whole DDL+DML block is wrapped in a single transaction so the
-- structural move lands atomically. The CSV snapshot runs FIRST, outside
-- the transaction, so a write-failure aborts before any DDL happens.
--
-- Reversibility: see 0016_corporate_hub_redesign.down.sql. The down
-- migration restores the franchisor/franchisee tables, undoes the renames,
-- and re-creates royalty + pricebook overrides tables. Data restoration
-- on the down path is best-effort: row data was preserved via the
-- branches/corporate copy, but royalty rows are lost when the up migration
-- drops them (this is acceptable — the corporate model removes royalty
-- accounting entirely; restoring it on down recreates the schema only).

-- ---------------------------------------------------------------------------
-- Step 0. Pre-flight: snapshot pricebook_overrides to CSV.
--
-- \copy is a psql client meta-command that streams TO/FROM the caller's
-- filesystem, not the server's. Path is resolved relative to psql's
-- working directory; the db:migrate npm script invokes psql from
-- packages/db, so the path here climbs two levels to the repo root.
-- If the file already exists from a prior run it will be overwritten.
-- ---------------------------------------------------------------------------

\copy pricebook_overrides TO '../../docs/migrations/0016_pricebook_overrides_snapshot.csv' CSV HEADER

BEGIN;

-- ---------------------------------------------------------------------------
-- Step 1. Enum value renames.
--
-- Postgres 12+ supports ALTER TYPE ... RENAME VALUE. It does NOT support
-- dropping enum values, so values that disappear in the corporate model
-- (e.g. 'location_manager') are left in place after we re-tag the rows
-- that used them. The down migration renames the values back.
--
-- Mapping:
--   role:        franchisor_admin  -> corporate_admin
--                franchisee_owner  -> manager
--                location_manager  -> (dropped semantically; rows promoted to manager)
--   scope_type:  franchisor        -> corporate
--                franchisee        -> branch
--                location          -> (dropped semantically; rows promoted to branch)
-- ---------------------------------------------------------------------------

-- Promote location_manager rows to manager BEFORE renaming franchisee_owner
-- (so the UPDATE doesn't temporarily violate the enum constraint).
UPDATE memberships SET role = 'franchisee_owner' WHERE role = 'location_manager';

ALTER TYPE role RENAME VALUE 'franchisor_admin' TO 'corporate_admin';
ALTER TYPE role RENAME VALUE 'franchisee_owner' TO 'manager';

-- Promote location-scoped memberships to branch-scoped before the
-- scope_type rename.
UPDATE memberships SET scope_type = 'franchisee' WHERE scope_type = 'location';

ALTER TYPE scope_type RENAME VALUE 'franchisor' TO 'corporate';
ALTER TYPE scope_type RENAME VALUE 'franchisee'  TO 'branch';

-- ---------------------------------------------------------------------------
-- Step 2. New tables — corporate hub, branches, comp + commission.
-- ---------------------------------------------------------------------------

CREATE TABLE corporate (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  legal_entity_name TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Edmonton',
  currency_code CHAR(3) NOT NULL DEFAULT 'CAD',
  brand_assets JSONB NOT NULL DEFAULT '{}'::jsonb,
  brand_voice JSONB NOT NULL DEFAULT '{}'::jsonb,
  default_margin_pct NUMERIC(6,2) NOT NULL DEFAULT 60.00,
  min_margin_pct NUMERIC(6,2) NOT NULL DEFAULT 20.00,
  max_margin_pct NUMERIC(6,2) NOT NULL DEFAULT 200.00,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT corporate_margin_bounds_chk CHECK (
    min_margin_pct >= 0
    AND max_margin_pct > min_margin_pct
    AND default_margin_pct BETWEEN min_margin_pct AND max_margin_pct
  )
);

CREATE TABLE branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_id UUID NOT NULL REFERENCES corporate(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  legal_entity_name TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  region TEXT,
  postal_code TEXT,
  country_code CHAR(2),
  timezone TEXT NOT NULL DEFAULT 'America/Edmonton',
  phone_number TEXT,
  twilio_phone_number TEXT,
  twilio_phone_sid TEXT,
  stripe_account_id TEXT,
  brand_voice JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX branches_corporate_idx ON branches(corporate_id);
CREATE UNIQUE INDEX branches_slug_unique ON branches(slug);

CREATE TABLE branch_managers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX branch_managers_branch_idx ON branch_managers(branch_id);
CREATE INDEX branch_managers_user_idx ON branch_managers(user_id);
CREATE UNIQUE INDEX branch_managers_active_one_per_branch
  ON branch_managers(branch_id) WHERE ended_at IS NULL;

CREATE TABLE comp_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('base_plus_commission', 'commission_only')),
  base_salary_cents BIGINT NOT NULL DEFAULT 0 CHECK (base_salary_cents >= 0),
  pay_period TEXT NOT NULL DEFAULT 'monthly'
    CHECK (pay_period IN ('monthly', 'biweekly')),
  commission_rules JSONB NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT comp_plans_effective_range_chk CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  )
);

CREATE INDEX comp_plans_effective_idx ON comp_plans(effective_from, effective_to);

CREATE TABLE user_comp_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comp_plan_id UUID NOT NULL REFERENCES comp_plans(id) ON DELETE RESTRICT,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_comp_assignments_effective_range_chk CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  )
);

CREATE INDEX user_comp_user_idx ON user_comp_assignments(user_id);
CREATE INDEX user_comp_plan_idx ON user_comp_assignments(comp_plan_id);
CREATE INDEX user_comp_branch_idx ON user_comp_assignments(branch_id);
CREATE INDEX user_comp_user_active_idx
  ON user_comp_assignments(user_id, effective_from)
  WHERE effective_to IS NULL;

CREATE TABLE commission_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('invoice_paid', 'quote_committed', 'manual_adjustment')),
  source_id TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  rule_snapshot JSONB NOT NULL,
  period_label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT commission_ledger_period_format_chk CHECK (period_label ~ '^\d{4}-\d{2}$')
);

CREATE INDEX commission_ledger_user_idx ON commission_ledger(user_id);
CREATE INDEX commission_ledger_branch_idx ON commission_ledger(branch_id);
CREATE INDEX commission_ledger_period_idx ON commission_ledger(period_label);
CREATE UNIQUE INDEX commission_ledger_source_unique
  ON commission_ledger(user_id, source_kind, source_id);

CREATE TABLE pricebook_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  service_item_id UUID NOT NULL REFERENCES service_items(id) ON DELETE CASCADE,
  suggested_price_cents BIGINT NOT NULL,
  reason TEXT,
  suggested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  resolved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX pricebook_suggestions_branch_idx ON pricebook_suggestions(branch_id);
CREATE INDEX pricebook_suggestions_status_idx ON pricebook_suggestions(status);

-- ---------------------------------------------------------------------------
-- Step 3. Data migration: franchisors -> corporate, franchisees -> branches.
--
-- v1 collapses multiple franchisors (test fixtures may have more than one)
-- into a single corporate row by keeping the earliest-created franchisor.
-- All franchisees keep their original UUIDs as branches.id, so every FK
-- that previously referenced franchisees(id) can be re-pointed at
-- branches(id) without rewriting row data.
-- ---------------------------------------------------------------------------

-- Franchisors had a narrow shape — name, slug, brand_config — so
-- legal_entity_name + timezone fall through to corporate's defaults.
INSERT INTO corporate (id, name, slug, brand_voice, created_at, updated_at)
SELECT id, name, slug,
       COALESCE(brand_config, '{}'::jsonb),
       created_at, updated_at
  FROM franchisors
  ORDER BY created_at ASC
  LIMIT 1;

-- Franchisees carried legal_entity_name + stripe + twilio bits + the
-- inline ai_guardrails JSONB. Everything else on branches (address,
-- timezone, phone_number, etc.) is new in the corporate hub model
-- and starts NULL / default — the per-branch onboarding wizard
-- (CHR-06) fills the operational fields when a real branch is created.
INSERT INTO branches (
  id, corporate_id, name, slug, legal_entity_name,
  twilio_phone_number, stripe_account_id,
  status, created_at, updated_at
)
SELECT
  f.id,
  (SELECT id FROM corporate LIMIT 1),
  f.name,
  f.slug,
  f.legal_entity_name,
  f.twilio_phone_number,
  f.stripe_account_id,
  'active',
  f.created_at, f.updated_at
FROM franchisees f;

-- Seed branch_managers from existing franchisee_owner memberships
-- (already renamed to 'manager' in Step 1).
INSERT INTO branch_managers (branch_id, user_id, started_at)
SELECT DISTINCT m.franchisee_id, m.user_id, m.created_at
  FROM memberships m
  WHERE m.role = 'manager'
    AND m.franchisee_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Step 4. Drop existing RLS policies that reference franchisor_admin or
-- the franchisor-level columns. They will be replaced by the new
-- two-policy template after the renames.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS franchisees_platform_admin       ON franchisees;
DROP POLICY IF EXISTS franchisees_franchisor_admin     ON franchisees;
DROP POLICY IF EXISTS franchisees_scoped               ON franchisees;
DROP POLICY IF EXISTS locations_platform_admin         ON locations;
DROP POLICY IF EXISTS locations_franchisor_admin       ON locations;
DROP POLICY IF EXISTS locations_scoped                 ON locations;
DROP POLICY IF EXISTS memberships_platform_admin       ON memberships;
DROP POLICY IF EXISTS memberships_franchisor_admin     ON memberships;
DROP POLICY IF EXISTS memberships_scoped               ON memberships;
DROP POLICY IF EXISTS audit_log_platform_admin         ON audit_log;
DROP POLICY IF EXISTS audit_log_franchisor_admin       ON audit_log;
DROP POLICY IF EXISTS audit_log_scoped                 ON audit_log;

-- Per-feature policies created in later migrations follow the same
-- naming pattern: <table>_platform_admin / <table>_franchisor_admin /
-- <table>_scoped. Drop them too.
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE schemaname = current_schema()
       AND (policyname LIKE '%_platform_admin'
            OR policyname LIKE '%_franchisor_admin'
            OR policyname LIKE '%_scoped')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Step 5. Drop FK constraints that reference franchisors(id) or
-- franchisees(id) so we can drop the parent tables in Step 8.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname, conrelid::regclass AS tbl
      FROM pg_constraint
     WHERE contype = 'f'
       AND confrelid IN (
         'franchisees'::regclass,
         'franchisors'::regclass
       )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Step 6. Rename franchisee_id -> branch_id on every business table.
-- ---------------------------------------------------------------------------

ALTER TABLE locations           RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE memberships         RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE audit_log           RENAME COLUMN target_franchisee_id TO target_branch_id;
ALTER TABLE invitations         RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE customers           RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE jobs                RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE job_status_log      RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE job_photos          RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE invoices            RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE invoice_line_items  RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE payments            RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE refunds             RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE collections_drafts  RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE payment_retries     RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE ai_feedback         RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE ai_suggestions      RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE ai_metrics          RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE tech_skills         RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE ai_conversations    RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE ai_messages         RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE call_sessions       RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE push_subscriptions  RENAME COLUMN franchisee_id        TO branch_id;
ALTER TABLE notifications_log   RENAME COLUMN franchisee_id        TO branch_id;

-- Rename associated indexes so introspection-driven tooling (Drizzle,
-- pg_dump diffing) sees consistent names matching the new column.
ALTER INDEX locations_franchisee_idx           RENAME TO locations_branch_idx;
ALTER INDEX memberships_franchisee_idx         RENAME TO memberships_branch_idx;
ALTER INDEX audit_log_franchisee_idx           RENAME TO audit_log_branch_idx;
ALTER INDEX invitations_franchisee_idx         RENAME TO invitations_branch_idx;
ALTER INDEX customers_franchisee_idx           RENAME TO customers_branch_idx;
ALTER INDEX jobs_franchisee_idx                RENAME TO jobs_branch_idx;
ALTER INDEX job_status_log_franchisee_idx      RENAME TO job_status_log_branch_idx;
ALTER INDEX job_photos_franchisee_idx          RENAME TO job_photos_branch_idx;
ALTER INDEX invoices_franchisee_idx            RENAME TO invoices_branch_idx;
ALTER INDEX invoice_line_items_franchisee_idx  RENAME TO invoice_line_items_branch_idx;
ALTER INDEX payments_franchisee_idx            RENAME TO payments_branch_idx;
ALTER INDEX refunds_franchisee_idx             RENAME TO refunds_branch_idx;
ALTER INDEX collections_drafts_franchisee_idx  RENAME TO collections_drafts_branch_idx;
ALTER INDEX payment_retries_franchisee_idx     RENAME TO payment_retries_branch_idx;
ALTER INDEX ai_feedback_franchisee_idx         RENAME TO ai_feedback_branch_idx;
ALTER INDEX ai_suggestions_franchisee_idx      RENAME TO ai_suggestions_branch_idx;
ALTER INDEX tech_skills_franchisee_idx         RENAME TO tech_skills_branch_idx;
ALTER INDEX ai_conversations_franchisee_idx    RENAME TO ai_conversations_branch_idx;
ALTER INDEX ai_messages_franchisee_idx         RENAME TO ai_messages_branch_idx;
ALTER INDEX call_sessions_franchisee_idx       RENAME TO call_sessions_branch_idx;
ALTER INDEX notifications_log_franchisee_idx   RENAME TO notifications_log_branch_idx;

-- ---------------------------------------------------------------------------
-- Step 7. Drop franchisor_id columns on tables that no longer need
-- franchisor-level scoping (corporate is now implicit). Drops associated
-- indexes automatically.
-- ---------------------------------------------------------------------------

-- CASCADE drops any dependent RLS policies or constraints from the
-- per-feature migrations (e.g., the franchisor_admin-scoped policies
-- on service_catalog_templates from 0006 reference these columns).
ALTER TABLE invitations              DROP COLUMN franchisor_id CASCADE;
ALTER TABLE service_catalog_templates DROP COLUMN franchisor_id CASCADE;
ALTER TABLE service_items            DROP COLUMN franchisor_id CASCADE;
ALTER TABLE kb_docs                  DROP COLUMN franchisor_id CASCADE;

-- ---------------------------------------------------------------------------
-- Step 8. Drop tables that are removed entirely.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS pricebook_overrides   CASCADE;
DROP TABLE IF EXISTS royalty_statements    CASCADE;
DROP TABLE IF EXISTS royalty_rules         CASCADE;
DROP TABLE IF EXISTS franchise_agreements  CASCADE;
DROP TABLE IF EXISTS franchisees           CASCADE;
DROP TABLE IF EXISTS franchisors           CASCADE;

-- ---------------------------------------------------------------------------
-- Step 9. Re-target FK references from the now-dropped franchisees onto
-- branches. branches.id reuses franchisees.id, so existing branch_id
-- column values still point at the right row.
-- ---------------------------------------------------------------------------

ALTER TABLE locations
  ADD CONSTRAINT locations_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT;

ALTER TABLE memberships
  ADD CONSTRAINT memberships_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_target_branch_id_fkey
  FOREIGN KEY (target_branch_id) REFERENCES branches(id) ON DELETE SET NULL;

ALTER TABLE invitations
  ADD CONSTRAINT invitations_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

ALTER TABLE customers
  ADD CONSTRAINT customers_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT;

ALTER TABLE job_status_log
  ADD CONSTRAINT job_status_log_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

ALTER TABLE job_photos
  ADD CONSTRAINT job_photos_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT;

ALTER TABLE invoice_line_items
  ADD CONSTRAINT invoice_line_items_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

ALTER TABLE payments
  ADD CONSTRAINT payments_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT;

ALTER TABLE refunds
  ADD CONSTRAINT refunds_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT;

ALTER TABLE collections_drafts
  ADD CONSTRAINT collections_drafts_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

ALTER TABLE payment_retries
  ADD CONSTRAINT payment_retries_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

ALTER TABLE ai_feedback
  ADD CONSTRAINT ai_feedback_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

ALTER TABLE ai_suggestions
  ADD CONSTRAINT ai_suggestions_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

ALTER TABLE ai_metrics
  ADD CONSTRAINT ai_metrics_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

ALTER TABLE tech_skills
  ADD CONSTRAINT tech_skills_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

ALTER TABLE ai_conversations
  ADD CONSTRAINT ai_conversations_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

ALTER TABLE ai_messages
  ADD CONSTRAINT ai_messages_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

ALTER TABLE call_sessions
  ADD CONSTRAINT call_sessions_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

ALTER TABLE push_subscriptions
  ADD CONSTRAINT push_subscriptions_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

ALTER TABLE notifications_log
  ADD CONSTRAINT notifications_log_branch_id_fkey
  FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Step 10. New two-policy RLS template on every branch-scoped table.
--
-- Reads two session GUCs set by withScope (rewritten in CHR-02):
--   app.role        — 'corporate_admin' / 'manager' / 'csr' / 'tech'
--   app.branch_id   — empty string for corporate scope, branch UUID otherwise
--
-- Policy roles:
--   <table>_corporate_admin — corporate_admin sees everything
--   <table>_scoped          — anyone else sees only their branch's rows
--
-- New tables (corporate, branches, branch_managers, comp_plans,
-- user_comp_assignments, commission_ledger, pricebook_suggestions) also
-- get RLS enabled below.
-- ---------------------------------------------------------------------------

-- Tables that previously had RLS plus the new ones.
DO $$
DECLARE
  t TEXT;
  has_branch BOOLEAN;
  has_target_branch BOOLEAN;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'corporate', 'branches', 'branch_managers',
      'comp_plans', 'user_comp_assignments', 'commission_ledger',
      'pricebook_suggestions',
      'locations', 'memberships', 'audit_log', 'invitations',
      'customers', 'jobs', 'job_status_log', 'job_photos',
      'service_catalog_templates', 'service_items',
      'invoices', 'invoice_line_items', 'payments', 'refunds',
      'collections_drafts', 'payment_retries',
      'kb_docs', 'ai_feedback', 'ai_suggestions', 'ai_metrics',
      'tech_skills', 'ai_conversations', 'ai_messages', 'call_sessions',
      'push_subscriptions', 'notifications_log'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (current_setting(''app.role'', true) = ''corporate_admin'')',
      t || '_corporate_admin', t
    );

    -- Pick the right scoping column for the scoped policy.
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = t AND column_name = 'branch_id'
    ) INTO has_branch;
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = t AND column_name = 'target_branch_id'
    ) INTO has_target_branch;

    IF has_branch THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL USING ('
        || 'current_setting(''app.role'', true) IS NOT NULL '
        || 'AND current_setting(''app.role'', true) <> ''corporate_admin'' '
        || 'AND branch_id = nullif(current_setting(''app.branch_id'', true), '''')::uuid)',
        t || '_scoped', t
      );
    ELSIF has_target_branch THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL USING ('
        || 'current_setting(''app.role'', true) IS NOT NULL '
        || 'AND current_setting(''app.role'', true) <> ''corporate_admin'' '
        || 'AND target_branch_id = nullif(current_setting(''app.branch_id'', true), '''')::uuid)',
        t || '_scoped', t
      );
    ELSE
      -- Tables without a branch_id column (corporate, branches,
      -- branch_managers, comp_plans, service_catalog_templates,
      -- service_items, kb_docs) are corporate-only: the scoped
      -- policy denies everyone except corporate_admin (which already
      -- has its own permissive policy).
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL USING (false)',
        t || '_scoped', t
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
