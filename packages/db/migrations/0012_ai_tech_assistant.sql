-- Migration: 0012_ai_tech_assistant (up)
-- Adds kb_docs (knowledge base for RAG) + ai_feedback
-- (accept/override telemetry) + bumps the ai_guardrails default
-- to include techPhotoQuoteCapCents.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE ai_feedback_kind AS ENUM ('accept', 'override');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ai_feedback_subject_kind AS ENUM (
    'photo_quote_item',
    'notes_invoice_draft',
    'dispatcher_assignment'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- kb_docs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kb_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisor_id UUID REFERENCES franchisors(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL,
  embedding JSONB NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kb_docs_franchisor_idx ON kb_docs(franchisor_id);
CREATE UNIQUE INDEX IF NOT EXISTS kb_docs_source_unique ON kb_docs(source);

-- ---------------------------------------------------------------------------
-- ai_feedback
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  conversation_id UUID,
  kind ai_feedback_kind NOT NULL,
  subject_kind ai_feedback_subject_kind NOT NULL,
  subject_ref JSONB NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_feedback_franchisee_idx ON ai_feedback(franchisee_id);
CREATE INDEX IF NOT EXISTS ai_feedback_kind_idx ON ai_feedback(kind);
CREATE INDEX IF NOT EXISTS ai_feedback_subject_kind_idx ON ai_feedback(subject_kind);

-- ---------------------------------------------------------------------------
-- Bump guardrails default — new franchisees inherit the $500 cap.
-- ---------------------------------------------------------------------------

ALTER TABLE franchisees
  ALTER COLUMN ai_guardrails SET DEFAULT
    '{"confidenceThreshold": 0.8, "undoWindowSeconds": 900, "transferOnLowConfidence": true, "dispatcherAutoApplyThreshold": 0.8, "techPhotoQuoteCapCents": 50000}'::jsonb;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE kb_docs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_docs       FORCE  ROW LEVEL SECURITY;
ALTER TABLE ai_feedback   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_feedback   FORCE  ROW LEVEL SECURITY;

-- kb_docs: everyone scoped to a franchisor (or platform) sees the
-- franchisor's docs + all NULL-franchisor (platform-global) docs.
CREATE POLICY kb_docs_platform_admin ON kb_docs
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY kb_docs_franchisor_visible ON kb_docs
  FOR ALL USING (
    franchisor_id IS NULL
    OR franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    OR franchisor_id IN (
      SELECT franchisor_id FROM franchisees
       WHERE id = nullif(current_setting('app.franchisee_id', true), '')::uuid
    )
  );

-- ai_feedback: standard three-policy franchisee-scoped pattern.
CREATE POLICY ai_feedback_platform_admin ON ai_feedback
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY ai_feedback_franchisor_admin ON ai_feedback
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );
CREATE POLICY ai_feedback_scoped ON ai_feedback
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );
