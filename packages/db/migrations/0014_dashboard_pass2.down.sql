-- Migration: 0014_dashboard_pass2 (down)

DROP POLICY IF EXISTS notifications_log_scoped ON notifications_log;
DROP POLICY IF EXISTS notifications_log_franchisor_admin ON notifications_log;
DROP POLICY IF EXISTS notifications_log_platform_admin ON notifications_log;

DROP TABLE IF EXISTS notifications_log;

DROP TYPE IF EXISTS notification_direction;
DROP TYPE IF EXISTS notification_channel;

DROP INDEX IF EXISTS invoices_due_date_idx;
ALTER TABLE invoices DROP COLUMN IF EXISTS due_date;
