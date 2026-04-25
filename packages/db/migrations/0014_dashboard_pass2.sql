-- Migration: 0014_dashboard_pass2 (up)
-- Adds:
--   - invoices.due_date column (TIMESTAMPTZ, nullable). Backfills
--     existing rows to finalized_at + 30 days so aging math works
--     immediately. New rows are populated by the invoice route.
--   - notifications_log table — one row per outbound email / SMS
--     send. Dashboard tiles read from it; nothing else depends on
--     it. Tenant-scoped under franchisee_id with the standard three
--     RLS policies.

-- ---------------------------------------------------------------------------
-- invoices.due_date
-- ---------------------------------------------------------------------------

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ;

-- Backfill for invoices that are already finalized/sent/paid so
-- aging buckets render meaningfully on the first pass.
UPDATE invoices
   SET due_date = COALESCE(finalized_at, sent_at, created_at) + INTERVAL '30 days'
 WHERE due_date IS NULL
   AND status IN ('finalized', 'sent', 'paid');

CREATE INDEX IF NOT EXISTS invoices_due_date_idx ON invoices (due_date);

-- ---------------------------------------------------------------------------
-- notifications_log
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE notification_channel AS ENUM ('email', 'sms');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_direction AS ENUM ('outbound', 'inbound');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS notifications_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id  UUID NOT NULL REFERENCES franchisees (id) ON DELETE CASCADE,
  channel        notification_channel NOT NULL,
  direction      notification_direction NOT NULL DEFAULT 'outbound',
  to_address     TEXT NOT NULL,
  from_address   TEXT,
  subject        TEXT,
  body_preview   TEXT,
  provider_ref   TEXT,
  job_id         UUID REFERENCES jobs (id) ON DELETE SET NULL,
  invoice_id     UUID REFERENCES invoices (id) ON DELETE SET NULL,
  customer_id    UUID REFERENCES customers (id) ON DELETE SET NULL,
  related_kind   TEXT,
  status         TEXT NOT NULL DEFAULT 'sent',
  error_message  TEXT,
  created_by_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_log_franchisee_idx
  ON notifications_log (franchisee_id);
CREATE INDEX IF NOT EXISTS notifications_log_channel_idx
  ON notifications_log (franchisee_id, channel);
CREATE INDEX IF NOT EXISTS notifications_log_sent_idx
  ON notifications_log (franchisee_id, sent_at DESC);

-- ---------------------------------------------------------------------------
-- RLS on notifications_log
-- ---------------------------------------------------------------------------

ALTER TABLE notifications_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_log FORCE  ROW LEVEL SECURITY;

CREATE POLICY notifications_log_platform_admin ON notifications_log
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY notifications_log_franchisor_admin ON notifications_log
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );

CREATE POLICY notifications_log_scoped ON notifications_log
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );
