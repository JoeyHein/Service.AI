-- Migration: 0002_tenancy_franchise (up)
-- Creates Better Auth core tables plus the franchisor -> franchisee -> location
-- hierarchy, memberships, and audit log.
--
-- RLS is ENABLED on every tenant-scoped table. Policies themselves are added
-- by a later migration in TASK-TEN-03 once the RequestScope middleware sets
-- session GUCs (app.franchisee_id, app.role). Until then, the superuser role
-- used by the API bypasses RLS; non-superuser DB roles will see zero rows.
-- Idempotent: uses IF NOT EXISTS where possible. Reversible: see .down.sql.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE scope_type AS ENUM ('platform', 'franchisor', 'franchisee', 'location');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE role AS ENUM (
    'platform_admin',
    'franchisor_admin',
    'franchisee_owner',
    'location_manager',
    'dispatcher',
    'tech',
    'csr'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Auth tables (Better Auth)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  image TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique
  ON users (phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  scope TEXT,
  password TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS accounts_user_idx ON accounts(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_provider_account_idx
  ON accounts(provider_id, account_id);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS verifications_identifier_idx ON verifications(identifier);
CREATE INDEX IF NOT EXISTS verifications_expires_idx ON verifications(expires_at);

-- ---------------------------------------------------------------------------
-- Franchise hierarchy
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS franchisors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  brand_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS franchisees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisor_id UUID NOT NULL REFERENCES franchisors(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  legal_entity_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS franchisees_franchisor_idx ON franchisees(franchisor_id);
CREATE UNIQUE INDEX IF NOT EXISTS franchisees_franchisor_slug_unique
  ON franchisees(franchisor_id, slug);

CREATE TABLE IF NOT EXISTS locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  franchisee_id UUID NOT NULL REFERENCES franchisees(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Denver',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS locations_franchisee_idx ON locations(franchisee_id);

CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type scope_type NOT NULL,
  scope_id UUID,
  role role NOT NULL,
  franchisee_id UUID REFERENCES franchisees(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);
CREATE INDEX IF NOT EXISTS memberships_scope_idx ON memberships(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS memberships_franchisee_idx ON memberships(franchisee_id);
CREATE INDEX IF NOT EXISTS memberships_location_idx ON memberships(location_id);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_unique_active
  ON memberships(user_id, scope_type, scope_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  target_franchisee_id UUID REFERENCES franchisees(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  scope_type scope_type,
  scope_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log(actor_user_id);
CREATE INDEX IF NOT EXISTS audit_log_franchisee_idx ON audit_log(target_franchisee_id);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log(action);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at);

-- ---------------------------------------------------------------------------
-- Row Level Security (ENABLE only — policies added in TASK-TEN-03)
-- ---------------------------------------------------------------------------
-- Tenant-scoped tables: franchisees, locations, memberships, audit_log.
-- franchisors is NOT tenant-scoped (it IS a tenant root); franchisor_admin
-- scope for cross-franchisee visibility is enforced by the app layer.

ALTER TABLE franchisees    ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log      ENABLE ROW LEVEL SECURITY;
