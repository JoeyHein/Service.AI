-- Migration: 0013_ai_collections (down)

DROP TABLE IF EXISTS payment_retries     CASCADE;
DROP TABLE IF EXISTS collections_drafts  CASCADE;

-- Revert guardrails default to the phase-11 shape.
ALTER TABLE franchisees
  ALTER COLUMN ai_guardrails SET DEFAULT
    '{"confidenceThreshold": 0.8, "undoWindowSeconds": 900, "transferOnLowConfidence": true, "dispatcherAutoApplyThreshold": 0.8, "techPhotoQuoteCapCents": 50000}'::jsonb;

DROP TYPE IF EXISTS payment_retry_status;
DROP TYPE IF EXISTS collections_draft_status;
DROP TYPE IF EXISTS collections_tone;
