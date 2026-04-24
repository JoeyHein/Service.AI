-- Migration: 0010_ai_voice (up)
-- Adds the AI CSR voice tables + franchisee AI/Twilio columns.
-- ai_conversations is parent; ai_messages is child with FK cascade.
-- call_sessions links a phone call to its underlying conversation.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE ai_capability AS ENUM (
    'csr.voice', 'dispatcher', 'tech.photoQuote', 'collections'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE ai_message_role AS ENUM (
    'system', 'user', 'assistant', 'tool'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE call_direction AS ENUM ('inbound', 'outbound');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE call_status AS ENUM (
    'ringing', 'in_progress', 'completed', 'transferred', 'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE call_outcome AS ENUM (
    'booked', 'transferred', 'abandoned', 'none'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- franchisees — AI + Twilio columns
-- ---------------------------------------------------------------------------

ALTER TABLE franchisees
  ADD COLUMN IF NOT EXISTS twilio_phone_number TEXT,
  ADD COLUMN IF NOT EXISTS ai_guardrails JSONB NOT NULL DEFAULT
    '{"confidenceThreshold": 0.8, "undoWindowSeconds": 900, "transferOnLowConfidence": true}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS franchisees_twilio_phone_unique
  ON franchisees(twilio_phone_number)
  WHERE twilio_phone_number IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ai_conversations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  capability ai_capability NOT NULL,
  subject_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  subject_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_conversations_franchisee_idx
  ON ai_conversations(franchisee_id);
CREATE INDEX IF NOT EXISTS ai_conversations_capability_idx
  ON ai_conversations(capability);

-- ---------------------------------------------------------------------------
-- ai_messages
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  role ai_message_role NOT NULL,
  content JSONB NOT NULL,
  tool_name TEXT,
  tool_input JSONB,
  tool_output JSONB,
  confidence NUMERIC(5, 4),
  cost_usd NUMERIC(12, 6),
  provider TEXT,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_messages_conversation_idx
  ON ai_messages(conversation_id);
CREATE INDEX IF NOT EXISTS ai_messages_franchisee_idx
  ON ai_messages(franchisee_id);

-- ---------------------------------------------------------------------------
-- call_sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS call_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES ai_conversations(id) ON DELETE SET NULL,
  twilio_call_sid TEXT NOT NULL,
  from_e164 TEXT NOT NULL,
  to_e164 TEXT NOT NULL,
  direction call_direction NOT NULL DEFAULT 'inbound',
  status call_status NOT NULL DEFAULT 'ringing',
  outcome call_outcome NOT NULL DEFAULT 'none',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  recording_key TEXT,
  transfer_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS call_sessions_franchisee_idx
  ON call_sessions(franchisee_id);
CREATE UNIQUE INDEX IF NOT EXISTS call_sessions_twilio_sid_unique
  ON call_sessions(twilio_call_sid);
CREATE INDEX IF NOT EXISTS call_sessions_status_idx
  ON call_sessions(status);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE ai_conversations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_conversations  FORCE  ROW LEVEL SECURITY;
ALTER TABLE ai_messages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_messages       FORCE  ROW LEVEL SECURITY;
ALTER TABLE call_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_sessions     FORCE  ROW LEVEL SECURITY;

-- ai_conversations — franchisee-scoped
CREATE POLICY ai_conversations_platform_admin ON ai_conversations
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY ai_conversations_franchisor_admin ON ai_conversations
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );
CREATE POLICY ai_conversations_scoped ON ai_conversations
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

CREATE POLICY ai_messages_platform_admin ON ai_messages
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY ai_messages_franchisor_admin ON ai_messages
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );
CREATE POLICY ai_messages_scoped ON ai_messages
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

CREATE POLICY call_sessions_platform_admin ON call_sessions
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');
CREATE POLICY call_sessions_franchisor_admin ON call_sessions
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );
CREATE POLICY call_sessions_scoped ON call_sessions
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );
