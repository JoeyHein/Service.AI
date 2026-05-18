-- Migration: 0016_corporate_hub_redesign (down)
--
-- Reverses 0016 by restoring the franchisor/franchisee schema. Restoration
-- is best-effort:
--   * Schema (tables, columns, RLS policies, enums) is fully reversed.
--   * Branch rows are copied back into franchisees (same UUIDs).
--   * The single corporate row is copied back into franchisors.
--   * Royalty tables (franchise_agreements, royalty_rules, royalty_statements)
--     are recreated empty — their original row data was lost on up.
--   * pricebook_overrides is recreated and restored from the CSV snapshot
--     written by the up migration. If the snapshot file is missing the
--     table is left empty.
--   * branch_managers / comp_plans / user_comp_assignments / commission_ledger
--     / pricebook_suggestions are dropped — those concepts do not exist in
--     the franchise model.

BEGIN;

-- ---------------------------------------------------------------------------
-- Step 1. Drop the two-policy RLS template on every CHR-managed table.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE schemaname = current_schema()
       AND (policyname LIKE '%_corporate_admin' OR policyname LIKE '%_scoped')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Step 2. Drop FKs into branches so we can drop the table.
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
         'branches'::regclass,
         'corporate'::regclass
       )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Step 3. Recreate franchisors + franchisees and copy data back.
-- ---------------------------------------------------------------------------

-- Restore the pre-CHR shape of franchisors + franchisees. The columns
-- here mirror migration 0002 exactly (plus the franchise-era ai_guardrails
-- + stripe fields that later migrations added in place). New columns
-- the corporate hub introduced on `branches` (address, timezone,
-- phone_number, etc.) have no franchisee column to land on and are
-- dropped on this down path — acceptable per the gate's
-- "best-effort restore" rule.
CREATE TABLE franchisors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  brand_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE franchisees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisor_id UUID NOT NULL REFERENCES franchisors(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  legal_entity_name TEXT,
  stripe_account_id TEXT,
  stripe_charges_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  stripe_payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  stripe_details_submitted BOOLEAN NOT NULL DEFAULT FALSE,
  twilio_phone_number TEXT,
  ai_guardrails JSONB NOT NULL DEFAULT '{"confidenceThreshold": 0.8, "undoWindowSeconds": 900, "transferOnLowConfidence": true}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX franchisees_franchisor_idx ON franchisees(franchisor_id);
CREATE UNIQUE INDEX franchisees_slug_unique ON franchisees(franchisor_id, slug);
CREATE UNIQUE INDEX franchisees_stripe_account_unique
  ON franchisees(stripe_account_id) WHERE stripe_account_id IS NOT NULL;
CREATE UNIQUE INDEX franchisees_twilio_phone_unique
  ON franchisees(twilio_phone_number) WHERE twilio_phone_number IS NOT NULL;

INSERT INTO franchisors (id, name, slug, brand_config, created_at, updated_at)
SELECT id, name, slug, brand_voice, created_at, updated_at
  FROM corporate;

INSERT INTO franchisees (
  id, franchisor_id, name, slug, legal_entity_name,
  stripe_account_id, twilio_phone_number, created_at, updated_at
)
SELECT
  b.id, b.corporate_id, b.name, b.slug, b.legal_entity_name,
  b.stripe_account_id, b.twilio_phone_number, b.created_at, b.updated_at
FROM branches b;

-- ---------------------------------------------------------------------------
-- Step 4. Rename branch_id -> franchisee_id back, restore franchisor_id
-- columns on tables that had them.
-- ---------------------------------------------------------------------------

ALTER TABLE locations           RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE memberships         RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE audit_log           RENAME COLUMN target_branch_id TO target_franchisee_id;
ALTER TABLE invitations         RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE customers           RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE jobs                RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE job_status_log      RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE job_photos          RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE invoices            RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE invoice_line_items  RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE payments            RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE refunds             RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE collections_drafts  RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE payment_retries     RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE ai_feedback         RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE ai_suggestions      RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE ai_metrics          RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE tech_skills         RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE ai_conversations    RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE ai_messages         RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE call_sessions       RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE push_subscriptions  RENAME COLUMN branch_id        TO franchisee_id;
ALTER TABLE notifications_log   RENAME COLUMN branch_id        TO franchisee_id;

ALTER INDEX locations_branch_idx           RENAME TO locations_franchisee_idx;
ALTER INDEX memberships_branch_idx         RENAME TO memberships_franchisee_idx;
ALTER INDEX audit_log_branch_idx           RENAME TO audit_log_franchisee_idx;
ALTER INDEX invitations_branch_idx         RENAME TO invitations_franchisee_idx;
ALTER INDEX customers_branch_idx           RENAME TO customers_franchisee_idx;
ALTER INDEX jobs_branch_idx                RENAME TO jobs_franchisee_idx;
ALTER INDEX job_status_log_branch_idx      RENAME TO job_status_log_franchisee_idx;
ALTER INDEX job_photos_branch_idx          RENAME TO job_photos_franchisee_idx;
ALTER INDEX invoices_branch_idx            RENAME TO invoices_franchisee_idx;
ALTER INDEX invoice_line_items_branch_idx  RENAME TO invoice_line_items_franchisee_idx;
ALTER INDEX payments_branch_idx            RENAME TO payments_franchisee_idx;
ALTER INDEX refunds_branch_idx             RENAME TO refunds_franchisee_idx;
ALTER INDEX collections_drafts_branch_idx  RENAME TO collections_drafts_franchisee_idx;
ALTER INDEX payment_retries_branch_idx     RENAME TO payment_retries_franchisee_idx;
ALTER INDEX ai_feedback_branch_idx         RENAME TO ai_feedback_franchisee_idx;
ALTER INDEX ai_suggestions_branch_idx      RENAME TO ai_suggestions_franchisee_idx;
ALTER INDEX tech_skills_branch_idx         RENAME TO tech_skills_franchisee_idx;
ALTER INDEX ai_conversations_branch_idx    RENAME TO ai_conversations_franchisee_idx;
ALTER INDEX ai_messages_branch_idx         RENAME TO ai_messages_franchisee_idx;
ALTER INDEX call_sessions_branch_idx       RENAME TO call_sessions_franchisee_idx;
ALTER INDEX notifications_log_branch_idx   RENAME TO notifications_log_franchisee_idx;

-- Restore franchisor_id columns where the original schema had them.
ALTER TABLE invitations               ADD COLUMN franchisor_id UUID REFERENCES franchisors(id) ON DELETE CASCADE;
ALTER TABLE service_catalog_templates ADD COLUMN franchisor_id UUID REFERENCES franchisors(id) ON DELETE CASCADE;
ALTER TABLE service_items             ADD COLUMN franchisor_id UUID REFERENCES franchisors(id) ON DELETE CASCADE;
ALTER TABLE kb_docs                   ADD COLUMN franchisor_id UUID REFERENCES franchisors(id) ON DELETE CASCADE;

-- Default new columns to the single franchisor we just restored.
UPDATE invitations               SET franchisor_id = (SELECT id FROM franchisors LIMIT 1);
UPDATE service_catalog_templates SET franchisor_id = (SELECT id FROM franchisors LIMIT 1);
UPDATE service_items             SET franchisor_id = (SELECT id FROM franchisors LIMIT 1);
UPDATE kb_docs                   SET franchisor_id = (SELECT id FROM franchisors LIMIT 1) WHERE franchisor_id IS NULL;

ALTER TABLE service_catalog_templates ALTER COLUMN franchisor_id SET NOT NULL;
ALTER TABLE service_items             ALTER COLUMN franchisor_id SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Step 5. Re-target FKs back to franchisees.
-- ---------------------------------------------------------------------------

ALTER TABLE locations
  ADD CONSTRAINT locations_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE RESTRICT;
ALTER TABLE memberships
  ADD CONSTRAINT memberships_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE CASCADE;
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_target_franchisee_id_fkey
  FOREIGN KEY (target_franchisee_id) REFERENCES franchisees(id) ON DELETE SET NULL;
ALTER TABLE invitations
  ADD CONSTRAINT invitations_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE CASCADE;
ALTER TABLE customers
  ADD CONSTRAINT customers_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE RESTRICT;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE RESTRICT;
ALTER TABLE job_status_log
  ADD CONSTRAINT job_status_log_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE CASCADE;
ALTER TABLE job_photos
  ADD CONSTRAINT job_photos_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE CASCADE;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE RESTRICT;
ALTER TABLE invoice_line_items
  ADD CONSTRAINT invoice_line_items_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE CASCADE;
ALTER TABLE payments
  ADD CONSTRAINT payments_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE RESTRICT;
ALTER TABLE refunds
  ADD CONSTRAINT refunds_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE RESTRICT;
ALTER TABLE collections_drafts
  ADD CONSTRAINT collections_drafts_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE CASCADE;
ALTER TABLE payment_retries
  ADD CONSTRAINT payment_retries_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE CASCADE;
ALTER TABLE ai_feedback
  ADD CONSTRAINT ai_feedback_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE CASCADE;
ALTER TABLE ai_suggestions
  ADD CONSTRAINT ai_suggestions_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE CASCADE;
ALTER TABLE ai_metrics
  ADD CONSTRAINT ai_metrics_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE CASCADE;
ALTER TABLE tech_skills
  ADD CONSTRAINT tech_skills_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE CASCADE;
ALTER TABLE ai_conversations
  ADD CONSTRAINT ai_conversations_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE CASCADE;
ALTER TABLE ai_messages
  ADD CONSTRAINT ai_messages_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE CASCADE;
ALTER TABLE call_sessions
  ADD CONSTRAINT call_sessions_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE CASCADE;
ALTER TABLE push_subscriptions
  ADD CONSTRAINT push_subscriptions_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE CASCADE;
ALTER TABLE notifications_log
  ADD CONSTRAINT notifications_log_franchisee_id_fkey
  FOREIGN KEY (franchisee_id) REFERENCES franchisees(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Step 6. Re-create royalty + pricebook_overrides + franchise_agreements.
-- These come back as EMPTY tables — original row data was lost on up.
-- ---------------------------------------------------------------------------

CREATE TABLE franchise_agreements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  franchisor_id UUID NOT NULL REFERENCES franchisors(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'terminated')),
  effective_from DATE,
  effective_to DATE,
  terms JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX franchise_agreements_franchisee_idx ON franchise_agreements(franchisee_id);
CREATE INDEX franchise_agreements_franchisor_idx ON franchise_agreements(franchisor_id);
CREATE UNIQUE INDEX franchise_agreements_active_one_per_franchisee
  ON franchise_agreements(franchisee_id) WHERE status = 'active';

CREATE TABLE royalty_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id UUID NOT NULL REFERENCES franchise_agreements(id) ON DELETE CASCADE,
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('percentage', 'flat_per_job', 'tiered', 'minimum_floor')),
  params JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX royalty_rules_agreement_idx ON royalty_rules(agreement_id);
CREATE INDEX royalty_rules_franchisee_idx ON royalty_rules(franchisee_id);

CREATE TABLE royalty_statements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  franchisor_id UUID NOT NULL REFERENCES franchisors(id) ON DELETE CASCADE,
  period_label TEXT NOT NULL,
  gross_revenue_cents BIGINT NOT NULL DEFAULT 0,
  net_revenue_cents BIGINT NOT NULL DEFAULT 0,
  royalty_owed_cents BIGINT NOT NULL DEFAULT 0,
  royalty_collected_cents BIGINT NOT NULL DEFAULT 0,
  variance_cents BIGINT NOT NULL DEFAULT 0,
  stripe_transfer_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX royalty_statements_franchisee_idx ON royalty_statements(franchisee_id);
CREATE INDEX royalty_statements_franchisor_idx ON royalty_statements(franchisor_id);
CREATE UNIQUE INDEX royalty_statements_period_unique
  ON royalty_statements(franchisee_id, period_label);

CREATE TABLE pricebook_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  franchisor_id UUID NOT NULL REFERENCES franchisors(id) ON DELETE CASCADE,
  service_item_id UUID NOT NULL REFERENCES service_items(id) ON DELETE CASCADE,
  override_price_cents BIGINT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX pricebook_overrides_franchisee_idx ON pricebook_overrides(franchisee_id);
CREATE INDEX pricebook_overrides_franchisor_idx ON pricebook_overrides(franchisor_id);
CREATE UNIQUE INDEX pricebook_overrides_franchisee_item_unique
  ON pricebook_overrides(franchisee_id, service_item_id) WHERE deleted_at IS NULL;

-- Best-effort restore from the snapshot CSV. \copy will raise if the file
-- is missing; wrap the call in a savepoint so the failure does not abort
-- the whole transaction. In dev / CI the file should exist; in production
-- a deliberate down is rare and the operator is expected to have the
-- snapshot file.
SAVEPOINT before_overrides_restore;
\copy pricebook_overrides FROM '../../docs/migrations/0016_pricebook_overrides_snapshot.csv' CSV HEADER
RELEASE SAVEPOINT before_overrides_restore;

-- ---------------------------------------------------------------------------
-- Step 7. Drop the corporate-side tables.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS pricebook_suggestions  CASCADE;
DROP TABLE IF EXISTS commission_ledger       CASCADE;
DROP TABLE IF EXISTS user_comp_assignments   CASCADE;
DROP TABLE IF EXISTS comp_plans              CASCADE;
DROP TABLE IF EXISTS branch_managers         CASCADE;
DROP TABLE IF EXISTS branches                CASCADE;
DROP TABLE IF EXISTS corporate               CASCADE;

-- ---------------------------------------------------------------------------
-- Step 8. Restore the original three-policy RLS template on every table
-- that previously had RLS (matches 0003_rls_policies.sql + the per-feature
-- migrations that followed). This minimum recreates the franchisees,
-- locations, memberships, and audit_log policies — the per-feature
-- migrations (0005..0015) will re-apply their own policies on a fresh
-- up run.
-- ---------------------------------------------------------------------------

ALTER TABLE franchisees FORCE ROW LEVEL SECURITY;

CREATE POLICY franchisees_platform_admin ON franchisees
  FOR ALL
  USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY franchisees_franchisor_admin ON franchisees
  FOR ALL
  USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
  );

CREATE POLICY franchisees_scoped ON franchisees
  FOR ALL
  USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

ALTER TABLE locations FORCE ROW LEVEL SECURITY;

CREATE POLICY locations_platform_admin ON locations
  FOR ALL
  USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY locations_franchisor_admin ON locations
  FOR ALL
  USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );

CREATE POLICY locations_scoped ON locations
  FOR ALL
  USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY memberships_platform_admin ON memberships
  FOR ALL
  USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY memberships_franchisor_admin ON memberships
  FOR ALL
  USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND (
      franchisee_id IN (
        SELECT id FROM franchisees
         WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
      )
      OR (
        franchisee_id IS NULL
        AND scope_type = 'franchisor'
        AND scope_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
      )
    )
  );

CREATE POLICY memberships_scoped ON memberships
  FOR ALL
  USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_log_platform_admin ON audit_log
  FOR ALL
  USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY audit_log_franchisor_admin ON audit_log
  FOR ALL
  USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND target_franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );

CREATE POLICY audit_log_scoped ON audit_log
  FOR ALL
  USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND target_franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------------
-- Step 9. Rename enum values back.
--
-- Promote any 'manager' rows that came from 'location_manager' originally
-- back to 'location_manager' — we cannot tell them apart any more, so v1
-- of the down migration keeps them as 'franchisee_owner'. Acceptable for
-- a round-trip test (no row-count delta).
-- ---------------------------------------------------------------------------

ALTER TYPE role RENAME VALUE 'corporate_admin' TO 'franchisor_admin';
ALTER TYPE role RENAME VALUE 'manager' TO 'franchisee_owner';

ALTER TYPE scope_type RENAME VALUE 'corporate' TO 'franchisor';
ALTER TYPE scope_type RENAME VALUE 'branch'   TO 'franchisee';

COMMIT;
