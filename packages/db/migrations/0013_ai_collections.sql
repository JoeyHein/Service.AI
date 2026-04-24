-- Migration: 0013_ai_collections (up)
-- Adds collections_drafts + payment_retries tables + bumps
-- franchisees.ai_guardrails default to include a collections
-- config sub-object (autoSendTone null = always queue).

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE collections_tone AS ENUM ('friendly', 'firm', 'final');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE collections_draft_status AS ENUM (
    'pending', 'approved', 'edited', 'rejected', 'sent', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_retry_status AS ENUM (
    'scheduled', 'succeeded', 'failed', 'canceled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- collections_drafts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS collections_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  conversation_id UUID,
  tone collections_tone NOT NULL,
  sms_body TEXT NOT NULL,
  email_subject TEXT NOT NULL,
  email_body TEXT NOT NULL,
  status collections_draft_status NOT NULL DEFAULT 'pending',
  delivery_channels JSONB NOT NULL DEFAULT '{"email": true, "sms": true}'::jsonb,
  decided_at TIMESTAMPTZ,
  decided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS collections_drafts_franchisee_idx
  ON collections_drafts(franchisee_id);
CREATE INDEX IF NOT EXISTS collections_drafts_invoice_idx
  ON collections_drafts(invoice_id);
CREATE INDEX IF NOT EXISTS collections_drafts_status_idx
  ON collections_drafts(status);
CREATE UNIQUE INDEX IF NOT EXISTS collections_drafts_pending_unique
  ON collections_drafts(invoice_id, tone)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- payment_retries
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS payment_retries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
  failure_code TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status payment_retry_status NOT NULL DEFAULT 'scheduled',
  attempt_index INTEGER NOT NULL DEFAULT 1,
  result_ref JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payment_retries_franchisee_idx
  ON payment_retries(franchisee_id);
CREATE INDEX IF NOT EXISTS payment_retries_invoice_idx
  ON payment_retries(invoice_id);
CREATE INDEX IF NOT EXISTS payment_retries_status_idx
  ON payment_retries(status);

-- ---------------------------------------------------------------------------
-- Bump guardrails default to include a collections config.
-- autoSendTone=null means every draft is always queued for
-- review — the gate default never auto-sends.
-- ---------------------------------------------------------------------------

ALTER TABLE franchisees
  ALTER COLUMN ai_guardrails SET DEFAULT
    '{"confidenceThreshold": 0.8, "undoWindowSeconds": 900, "transferOnLowConfidence": true, "dispatcherAutoApplyThreshold": 0.8, "techPhotoQuoteCapCents": 50000, "collections": {"autoSendTone": null, "cadenceDaysFriendly": 7, "cadenceDaysFirm": 14, "cadenceDaysFinal": 30}}'::jsonb;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE collections_drafts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections_drafts  FORCE  ROW LEVEL SECURITY;
ALTER TABLE payment_retries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_retries     FORCE  ROW LEVEL SECURITY;

CREATE POLICY collections_drafts_platform_admin ON collections_drafts
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY collections_drafts_franchisor_admin ON collections_drafts
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );
CREATE POLICY collections_drafts_scoped ON collections_drafts
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

CREATE POLICY payment_retries_platform_admin ON payment_retries
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY payment_retries_franchisor_admin ON payment_retries
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );
CREATE POLICY payment_retries_scoped ON payment_retries
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );
