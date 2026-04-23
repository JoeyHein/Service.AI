-- Migration: 0007_invoices_push (down). Drops policies + tables + enum.

DROP POLICY IF EXISTS invoices_platform_admin            ON invoices;
DROP POLICY IF EXISTS invoices_franchisor_admin          ON invoices;
DROP POLICY IF EXISTS invoices_scoped                    ON invoices;
DROP POLICY IF EXISTS invoice_line_items_platform_admin  ON invoice_line_items;
DROP POLICY IF EXISTS invoice_line_items_franchisor_admin ON invoice_line_items;
DROP POLICY IF EXISTS invoice_line_items_scoped          ON invoice_line_items;
DROP POLICY IF EXISTS push_subscriptions_platform_admin  ON push_subscriptions;
DROP POLICY IF EXISTS push_subscriptions_self            ON push_subscriptions;

ALTER TABLE IF EXISTS invoices            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS invoice_line_items  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS push_subscriptions  NO FORCE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS invoice_line_items   CASCADE;
DROP TABLE IF EXISTS invoices             CASCADE;
DROP TABLE IF EXISTS push_subscriptions   CASCADE;

DROP TYPE IF EXISTS invoice_status;
