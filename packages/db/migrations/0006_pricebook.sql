-- Migration: 0006_pricebook (up)
-- Adds service catalog templates, items, and per-franchisee overrides.
-- Templates + items live at the franchisor level (one active published
-- template per franchisor); overrides live at the franchisee level and
-- are soft-deletable.
--
-- RLS pattern: platform admin sees everything, franchisor admin sees
-- their franchisor's templates/items, and franchisee-scoped users get
-- a READ-only policy so they can resolve their pricebook. Overrides
-- use the standard three-policy pattern.

DO $$ BEGIN
  CREATE TYPE catalog_status AS ENUM ('draft', 'published', 'archived');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- service_catalog_templates
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS service_catalog_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisor_id UUID NOT NULL REFERENCES franchisors(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status catalog_status NOT NULL DEFAULT 'draft',
  notes TEXT,
  published_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS service_catalog_templates_franchisor_idx
  ON service_catalog_templates(franchisor_id);
CREATE INDEX IF NOT EXISTS service_catalog_templates_status_idx
  ON service_catalog_templates(status);
CREATE UNIQUE INDEX IF NOT EXISTS service_catalog_templates_slug_unique
  ON service_catalog_templates(franchisor_id, slug);

-- ---------------------------------------------------------------------------
-- service_items
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS service_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES service_catalog_templates(id) ON DELETE CASCADE,
  franchisor_id UUID NOT NULL REFERENCES franchisors(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  base_price NUMERIC(12, 2) NOT NULL,
  floor_price NUMERIC(12, 2),
  ceiling_price NUMERIC(12, 2),
  sort_order INTEGER NOT NULL DEFAULT 0,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS service_items_template_idx   ON service_items(template_id);
CREATE INDEX IF NOT EXISTS service_items_franchisor_idx ON service_items(franchisor_id);
CREATE INDEX IF NOT EXISTS service_items_category_idx   ON service_items(category);
CREATE UNIQUE INDEX IF NOT EXISTS service_items_template_sku_unique
  ON service_items(template_id, sku);

-- ---------------------------------------------------------------------------
-- pricebook_overrides
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pricebook_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  franchisor_id UUID NOT NULL REFERENCES franchisors(id) ON DELETE CASCADE,
  service_item_id UUID NOT NULL REFERENCES service_items(id) ON DELETE CASCADE,
  override_price NUMERIC(12, 2) NOT NULL,
  note TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pricebook_overrides_franchisee_idx
  ON pricebook_overrides(franchisee_id);
CREATE INDEX IF NOT EXISTS pricebook_overrides_franchisor_idx
  ON pricebook_overrides(franchisor_id);
CREATE INDEX IF NOT EXISTS pricebook_overrides_item_idx
  ON pricebook_overrides(service_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS pricebook_overrides_unique_active
  ON pricebook_overrides(franchisee_id, service_item_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE service_catalog_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_catalog_templates FORCE  ROW LEVEL SECURITY;
ALTER TABLE service_items             ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_items             FORCE  ROW LEVEL SECURITY;
ALTER TABLE pricebook_overrides       ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricebook_overrides       FORCE  ROW LEVEL SECURITY;

-- service_catalog_templates policies
CREATE POLICY service_catalog_templates_platform_admin ON service_catalog_templates
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY service_catalog_templates_franchisor_admin ON service_catalog_templates
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
  );

-- Franchisee-scoped users can READ templates in their franchisor (to
-- resolve their pricebook). Writes are denied by omission.
CREATE POLICY service_catalog_templates_scoped_read ON service_catalog_templates
  FOR SELECT USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
  );

-- service_items policies (same shape as templates)
CREATE POLICY service_items_platform_admin ON service_items
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY service_items_franchisor_admin ON service_items
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
  );

CREATE POLICY service_items_scoped_read ON service_items
  FOR SELECT USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
  );

-- pricebook_overrides — standard three-policy franchisee-scoped pattern
CREATE POLICY pricebook_overrides_platform_admin ON pricebook_overrides
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY pricebook_overrides_franchisor_admin ON pricebook_overrides
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
  );

CREATE POLICY pricebook_overrides_scoped ON pricebook_overrides
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );
