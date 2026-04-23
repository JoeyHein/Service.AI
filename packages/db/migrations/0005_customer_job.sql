-- Migration: 0005_customer_job (up)
-- Adds the customer + job backbone for phase_customer_job. Every table
-- follows the tenancy pattern from migrations 0002/0003: franchisee_id
-- column (denormalised where the join would cost), RLS enabled + forced,
-- three policies per table (platform/franchisor/scoped) reading the
-- same session GUCs set by withScope().

-- ---------------------------------------------------------------------------
-- Enum
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE job_status AS ENUM (
    'unassigned', 'scheduled', 'en_route', 'arrived',
    'in_progress', 'completed', 'canceled'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT,
  place_id TEXT,
  latitude NUMERIC(10, 7),
  longitude NUMERIC(10, 7),
  notes TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customers_franchisee_idx ON customers(franchisee_id);
CREATE INDEX IF NOT EXISTS customers_location_idx   ON customers(location_id);
CREATE INDEX IF NOT EXISTS customers_email_idx      ON customers(email);
CREATE INDEX IF NOT EXISTS customers_phone_idx      ON customers(phone);
CREATE INDEX IF NOT EXISTS customers_place_idx      ON customers(place_id);

-- ---------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  status job_status NOT NULL DEFAULT 'unassigned',
  title TEXT NOT NULL,
  description TEXT,
  scheduled_start TIMESTAMPTZ,
  scheduled_end TIMESTAMPTZ,
  actual_start TIMESTAMPTZ,
  actual_end TIMESTAMPTZ,
  assigned_tech_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS jobs_franchisee_idx        ON jobs(franchisee_id);
CREATE INDEX IF NOT EXISTS jobs_location_idx          ON jobs(location_id);
CREATE INDEX IF NOT EXISTS jobs_customer_idx          ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS jobs_status_idx            ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_scheduled_start_idx   ON jobs(scheduled_start);
CREATE INDEX IF NOT EXISTS jobs_assigned_tech_idx     ON jobs(assigned_tech_user_id);

-- ---------------------------------------------------------------------------
-- job_status_log — append-only audit of state transitions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS job_status_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  from_status job_status,
  to_status job_status NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS job_status_log_job_idx        ON job_status_log(job_id);
CREATE INDEX IF NOT EXISTS job_status_log_franchisee_idx ON job_status_log(franchisee_id);
CREATE INDEX IF NOT EXISTS job_status_log_created_idx    ON job_status_log(created_at);

-- ---------------------------------------------------------------------------
-- job_photos
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS job_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER,
  label VARCHAR(50),
  uploaded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS job_photos_job_idx        ON job_photos(job_id);
CREATE INDEX IF NOT EXISTS job_photos_franchisee_idx ON job_photos(franchisee_id);
CREATE UNIQUE INDEX IF NOT EXISTS job_photos_storage_key_unique ON job_photos(storage_key);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE customers       ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers       FORCE  ROW LEVEL SECURITY;
ALTER TABLE jobs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs            FORCE  ROW LEVEL SECURITY;
ALTER TABLE job_status_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_status_log  FORCE  ROW LEVEL SECURITY;
ALTER TABLE job_photos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_photos      FORCE  ROW LEVEL SECURITY;

-- customers policies ---------------------------------------------------------

CREATE POLICY customers_platform_admin ON customers
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY customers_franchisor_admin ON customers
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );

CREATE POLICY customers_scoped ON customers
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

-- jobs policies --------------------------------------------------------------

CREATE POLICY jobs_platform_admin ON jobs
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY jobs_franchisor_admin ON jobs
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );

CREATE POLICY jobs_scoped ON jobs
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

-- job_status_log policies ----------------------------------------------------

CREATE POLICY job_status_log_platform_admin ON job_status_log
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY job_status_log_franchisor_admin ON job_status_log
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );

CREATE POLICY job_status_log_scoped ON job_status_log
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

-- job_photos policies --------------------------------------------------------

CREATE POLICY job_photos_platform_admin ON job_photos
  FOR ALL USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY job_photos_franchisor_admin ON job_photos
  FOR ALL USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );

CREATE POLICY job_photos_scoped ON job_photos
  FOR ALL USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );
