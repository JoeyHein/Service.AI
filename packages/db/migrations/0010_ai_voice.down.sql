-- Migration: 0010_ai_voice (down)
-- FK-safe order: call_sessions (FK ai_conversations) → ai_messages
-- (FK ai_conversations) → ai_conversations. Then franchisees columns.

DROP TABLE IF EXISTS call_sessions    CASCADE;
DROP TABLE IF EXISTS ai_messages      CASCADE;
DROP TABLE IF EXISTS ai_conversations CASCADE;

DROP INDEX IF EXISTS franchisees_twilio_phone_unique;

ALTER TABLE franchisees
  DROP COLUMN IF EXISTS twilio_phone_number,
  DROP COLUMN IF EXISTS ai_guardrails;

DROP TYPE IF EXISTS call_outcome;
DROP TYPE IF EXISTS call_status;
DROP TYPE IF EXISTS call_direction;
DROP TYPE IF EXISTS ai_message_role;
DROP TYPE IF EXISTS ai_capability;
