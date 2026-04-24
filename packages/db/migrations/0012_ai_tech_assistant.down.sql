-- Migration: 0012_ai_tech_assistant (down)

DROP TABLE IF EXISTS ai_feedback CASCADE;
DROP TABLE IF EXISTS kb_docs     CASCADE;

-- Revert guardrails default to phase-10 shape.
ALTER TABLE franchisees
  ALTER COLUMN ai_guardrails SET DEFAULT
    '{"confidenceThreshold": 0.8, "undoWindowSeconds": 900, "transferOnLowConfidence": true, "dispatcherAutoApplyThreshold": 0.8}'::jsonb;

DROP TYPE IF EXISTS ai_feedback_subject_kind;
DROP TYPE IF EXISTS ai_feedback_kind;
