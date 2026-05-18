-- Migration: 0017_supplier_quote_bridge (up)
--
-- Adds the supplier-quote-bridge tables (SQB phase). Layers on top of
-- the corporate hub model (CHR-01..12, migration 0016).
--
-- New surface:
--   * suppliers           — corporate-scoped provider registry (one row
--                           in v1: BC AI Agent for the Elevated Doors
--                           customer account).
--   * margin_overrides    — corporate-scoped, keyed by BC `itemCategoryCode`.
--                           Drives the SQB-07 margin engine alongside the
--                           corporate.default_margin_pct / min / max
--                           fields already shipped by CHR-01.
--   * quotes              — branch-scoped quote header with the supplier
--                           reference (SQ-XXXXXX) populated once committed.
--   * quote_line_items    — per-line resolved price + the margin trail
--                           (applied_margin_pct, applied_margin_source,
--                           margin_override_pct?, margin_override_reason?).
--   * quote_status_log    — append-only audit of every status transition.
--
-- RLS:
--   * suppliers + margin_overrides: corporate-only (corporate_admin sees
--     all rows; everyone else's _scoped policy returns false — these are
--     corporate-managed records with no branch dimension).
--   * quotes / quote_line_items / quote_status_log: standard two-policy
--     template per CHR (corporate_admin + branch-scoped on branch_id).

BEGIN;

-- ---------------------------------------------------------------------------
-- Step 1. Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE supplier_provider_kind AS ENUM ('bc_ai_agent');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE quote_status AS ENUM (
    'draft', 'priced', 'committed', 'accepted', 'void'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE margin_source AS ENUM (
    'line_override', 'category_override', 'corporate_default'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Step 2. suppliers — corporate-scoped provider registry.
--
-- v1 holds exactly one row (BC AI Agent → Elevated Doors BC customer).
-- The seed lives in apps/api/src/seed/ so the migration stays
-- data-free; this lets the same SQL run in CI without env coupling.
-- ---------------------------------------------------------------------------

CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  provider_kind supplier_provider_kind NOT NULL,
  endpoint_url TEXT NOT NULL,
  api_key_secret_ref TEXT NOT NULL,
  supplier_account_code TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX suppliers_provider_idx ON suppliers(provider_kind);

-- ---------------------------------------------------------------------------
-- Step 3. margin_overrides — corporate-scoped, keyed by item_category.
--
-- Resolution order in SQB-07 is: line override → category override →
-- corporate.default_margin_pct. UNIQUE on item_category enforces "one
-- override per BC category" at the DB layer.
-- ---------------------------------------------------------------------------

CREATE TABLE margin_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_category TEXT NOT NULL,
  margin_pct NUMERIC(6,2) NOT NULL,
  notes TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT margin_overrides_pct_bounds_chk CHECK (
    margin_pct >= 0 AND margin_pct <= 1000
  )
);

CREATE UNIQUE INDEX margin_overrides_item_category_unique
  ON margin_overrides(item_category);

-- ---------------------------------------------------------------------------
-- Step 4. quotes — header row per supplier quote, branch-scoped.
--
-- supplier_quote_ref is the BC-side SQ-XXXXXX assigned at commit. UNIQUE
-- partial index lets multiple drafts coexist (NULL refs) while keeping
-- committed refs unique.
-- ---------------------------------------------------------------------------

CREATE TABLE quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  status quote_status NOT NULL DEFAULT 'draft',
  subtotal_cents BIGINT NOT NULL DEFAULT 0,
  tax_cents BIGINT NOT NULL DEFAULT 0,
  total_cents BIGINT NOT NULL DEFAULT 0,
  currency_code CHAR(3) NOT NULL DEFAULT 'CAD',
  supplier_quote_ref TEXT,
  supplier_quote_id TEXT,
  valid_until TIMESTAMPTZ,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  closer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  committed_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX quotes_branch_idx ON quotes(branch_id);
CREATE INDEX quotes_customer_idx ON quotes(customer_id);
CREATE INDEX quotes_job_idx ON quotes(job_id);
CREATE INDEX quotes_status_idx ON quotes(status);
CREATE INDEX quotes_supplier_idx ON quotes(supplier_id);
CREATE UNIQUE INDEX quotes_supplier_quote_ref_unique
  ON quotes(supplier_quote_ref)
  WHERE supplier_quote_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Step 5. quote_line_items — per-line resolved price + margin trail.
--
-- applied_margin_pct / applied_margin_source are populated by SQB-07's
-- resolveSellingPrice helper. margin_override_pct is the per-line
-- discretion field (manager+ only); it requires margin_override_reason
-- via the CHECK constraint so a forged client body cannot bypass it.
-- ---------------------------------------------------------------------------

CREATE TABLE quote_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  supplier_sku TEXT NOT NULL,
  description TEXT NOT NULL,
  item_category TEXT,
  quantity NUMERIC(12,3) NOT NULL,
  unit_price_cents BIGINT NOT NULL,
  line_total_cents BIGINT NOT NULL,
  supplier_unit_cost_cents BIGINT,
  applied_margin_pct NUMERIC(6,2) NOT NULL,
  applied_margin_source margin_source NOT NULL,
  margin_override_pct NUMERIC(6,2),
  margin_override_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT qli_override_reason_required_chk CHECK (
    margin_override_pct IS NULL
    OR (margin_override_reason IS NOT NULL AND length(margin_override_reason) > 0)
  )
);

CREATE INDEX quote_line_items_quote_idx ON quote_line_items(quote_id);
CREATE INDEX quote_line_items_branch_idx ON quote_line_items(branch_id);
CREATE UNIQUE INDEX quote_line_items_position_unique
  ON quote_line_items(quote_id, position);

-- ---------------------------------------------------------------------------
-- Step 6. quote_status_log — append-only audit of every status move.
-- ---------------------------------------------------------------------------

CREATE TABLE quote_status_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  from_status quote_status,
  to_status quote_status NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX quote_status_log_quote_idx ON quote_status_log(quote_id);
CREATE INDEX quote_status_log_branch_idx ON quote_status_log(branch_id);

-- ---------------------------------------------------------------------------
-- Step 7. RLS — two-policy template (mirrors CHR-01 step 10).
--
-- suppliers + margin_overrides are corporate-only: the _corporate_admin
-- policy lets the corporate role through, the _scoped policy denies
-- everyone else by returning false. Branch users never touch these
-- tables directly.
--
-- quotes / quote_line_items / quote_status_log are branch-scoped: the
-- _scoped policy matches branch_id = app.branch_id (the GUC set by
-- withScope in CHR-02).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t TEXT;
  has_branch BOOLEAN;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'suppliers',
      'margin_overrides',
      'quotes',
      'quote_line_items',
      'quote_status_log'
    ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL USING (current_setting(''app.role'', true) = ''corporate_admin'')',
      t || '_corporate_admin', t
    );

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = t
         AND column_name = 'branch_id'
    ) INTO has_branch;

    IF has_branch THEN
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL USING ('
        || 'current_setting(''app.role'', true) IS NOT NULL '
        || 'AND current_setting(''app.role'', true) <> ''corporate_admin'' '
        || 'AND branch_id = nullif(current_setting(''app.branch_id'', true), '''')::uuid)',
        t || '_scoped', t
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL USING (false)',
        t || '_scoped', t
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
