-- Migration: 0006_pricebook (down). Drops policies + tables + enum.

DROP POLICY IF EXISTS service_catalog_templates_platform_admin   ON service_catalog_templates;
DROP POLICY IF EXISTS service_catalog_templates_franchisor_admin ON service_catalog_templates;
DROP POLICY IF EXISTS service_catalog_templates_scoped_read      ON service_catalog_templates;
DROP POLICY IF EXISTS service_items_platform_admin               ON service_items;
DROP POLICY IF EXISTS service_items_franchisor_admin             ON service_items;
DROP POLICY IF EXISTS service_items_scoped_read                  ON service_items;
DROP POLICY IF EXISTS pricebook_overrides_platform_admin         ON pricebook_overrides;
DROP POLICY IF EXISTS pricebook_overrides_franchisor_admin       ON pricebook_overrides;
DROP POLICY IF EXISTS pricebook_overrides_scoped                 ON pricebook_overrides;

ALTER TABLE IF EXISTS service_catalog_templates NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS service_items             NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS pricebook_overrides       NO FORCE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS pricebook_overrides        CASCADE;
DROP TABLE IF EXISTS service_items              CASCADE;
DROP TABLE IF EXISTS service_catalog_templates  CASCADE;

DROP TYPE IF EXISTS catalog_status;
