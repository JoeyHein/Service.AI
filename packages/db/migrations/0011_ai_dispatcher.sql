-- Migration: 0011_ai_dispatcher (up)
-- Adds the AI dispatcher tables: ai_suggestions (human-review
-- queue + auto-applied history), ai_metrics (daily per-franchisee
-- rollup), tech_skills (dispatcher agent matches required skills
-- against the tech roster). Also bumps the franchisees default
-- ai_guardrails jsonb to include a dispatcherAutoApplyThreshold.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE ai_suggestion_kind AS ENUM ('assignment');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE ai_suggestion_status AS ENUM (
    'pending', 'approved', 'rejected', 'applied', 'expired'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- ai_suggestions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  conversation_id UUID,
  kind ai_suggestion_kind NOT NULL,
  subject_job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  proposed_tech_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  proposed_scheduled_start TIMESTAMPTZ,
  proposed_scheduled_end TIMESTAMPTZ,
  reasoning TEXT NOT NULL,
  confidence NUMERIC(5, 4) NOT NULL,
  status ai_suggestion_status NOT NULL DEFAULT 'pending',
  decided_at TIMESTAMPTZ,
  decided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_suggestions_franchisee_idx
  ON ai_suggestions(franchisee_id);
CREATE INDEX IF NOT EXISTS ai_suggestions_job_idx
  ON ai_suggestions(subject_job_id);
CREATE INDEX IF NOT EXISTS ai_suggestions_status_idx
  ON ai_suggestions(status);

-- ---------------------------------------------------------------------------
-- ai_metrics
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  date TIMESTAMPTZ NOT NULL,
  suggestions_total INTEGER NOT NULL DEFAULT 0,
  auto_applied INTEGER NOT NULL DEFAULT 0,
  queued INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  override_rate NUMERIC(5, 4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_metrics_franchisee_date_unique
  ON ai_metrics(franchisee_id, date);

-- ---------------------------------------------------------------------------
-- tech_skills (composite PK enforced via a unique index)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tech_skills (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  skill TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS tech_skills_pk
  ON tech_skills(user_id, franchisee_id, skill);
CREATE INDEX IF NOT EXISTS tech_skills_franchisee_idx
  ON tech_skills(franchisee_id);

-- ---------------------------------------------------------------------------
-- Bump the existing guardrails default to include the dispatcher
-- threshold. Does not touch any already-populated row — only the
-- schema default.
-- ---------------------------------------------------------------------------

ALTER TABLE franchisees
  ALTER COLUMN ai_guardrails SET DEFAULT
    '{"confidenceThreshold": 0.8, "undoWindowSeconds": 900, "transferOnLowConfidence": true, "dispatcherAutoApplyThreshold": 0.8}'::jsonb;

-- ---------------------------------------------------------------------------
-- RLS — 3-policy franchisee-scoped (same template as phases 6/9)
-- ---------------------------------------------------------------------------

ALTER TABLE ai_suggestions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_suggestions  FORCE  ROW LEVEL SECURITY;
ALTER TABLE ai_metrics      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_metrics      FORCE  ROW LEVEL SECURITY;
ALTER TABLE tech_skills     ENABLE ROW LEVEL SECURITY;
ALTER TABLE tech_skills     FORCE  ROW LEVEL SECURITY;

CREATE POLICY ai_suggestions_platform_admin ON ai_suggestions
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY ai_suggestions_franchisor_admin ON ai_suggestions
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );
CREATE POLICY ai_suggestions_scoped ON ai_suggestions
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

CREATE POLICY ai_metrics_platform_admin ON ai_metrics
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY ai_metrics_franchisor_admin ON ai_metrics
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );
CREATE POLICY ai_metrics_scoped ON ai_metrics
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

CREATE POLICY tech_skills_platform_admin ON tech_skills
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY tech_skills_franchisor_admin ON tech_skills
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );
CREATE POLICY tech_skills_scoped ON tech_skills
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );
