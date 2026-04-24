-- Migration: 0011_ai_dispatcher (down)

DROP TABLE IF EXISTS tech_skills     CASCADE;
DROP TABLE IF EXISTS ai_metrics      CASCADE;
DROP TABLE IF EXISTS ai_suggestions  CASCADE;

-- Revert the guardrails default to the phase-9 shape.
ALTER TABLE franchisees
  ALTER COLUMN ai_guardrails SET DEFAULT
    '{"confidenceThreshold": 0.8, "undoWindowSeconds": 900, "transferOnLowConfidence": true}'::jsonb;

DROP TYPE IF EXISTS ai_suggestion_status;
DROP TYPE IF EXISTS ai_suggestion_kind;
