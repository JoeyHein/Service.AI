-- Migration: 0022_crm_customer_notes (up)
--
-- Phase 23 (CRM). Adds the customer interaction log that powers the Customer
-- 360 activity timeline + the global CRM notes feed. Ported from the BC AI
-- Agent portal's CustomerNote model and Donna's createCrmNote ingest shape.
--
-- A note may be UNMATCHED (customer_id NULL) when it arrives from Donna/AI
-- ingest and no customer matched the phone/email — those land in the intake
-- branch and are assigned to a customer later via the triage feed.
--
-- Dedup: a repeat ingest with the same (source, source_ref) collapses to one
-- row (partial-unique index), so Donna replaying a webhook can't double-log.

BEGIN;

CREATE TABLE customer_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  note_type TEXT NOT NULL DEFAULT 'manual',
  subject TEXT,
  body TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  match_key TEXT,
  match_key_type TEXT,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_notes_type_chk CHECK (
    note_type IN ('call', 'email', 'meeting', 'sms', 'manual')
  )
);

CREATE INDEX customer_notes_customer_idx ON customer_notes (customer_id);
CREATE INDEX customer_notes_branch_idx ON customer_notes (branch_id);
CREATE INDEX customer_notes_branch_occurred_idx
  ON customer_notes (branch_id, occurred_at DESC);
CREATE INDEX customer_notes_match_key_idx ON customer_notes (match_key);
CREATE UNIQUE INDEX customer_notes_source_ref_unique
  ON customer_notes (source, source_ref)
  WHERE source_ref IS NOT NULL;

-- RLS — two-policy template (mirrors CHR-01 / SQB step 7).
ALTER TABLE customer_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_notes FORCE ROW LEVEL SECURITY;

CREATE POLICY customer_notes_corporate_admin ON customer_notes
  FOR ALL USING (current_setting('app.role', true) = 'corporate_admin');

CREATE POLICY customer_notes_scoped ON customer_notes
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) <> 'corporate_admin'
    AND branch_id = nullif(current_setting('app.branch_id', true), '')::uuid
  );

COMMIT;
