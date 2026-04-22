-- Migration: 0002_tenancy_franchise (down)
-- Reverts 0002_tenancy_franchise.sql. Drops tables in dependency order,
-- then the enum types. Idempotent: IF EXISTS guards so partial prior
-- failures do not block rollback.

-- Disable RLS first so DROP proceeds cleanly even if policies were later added.
ALTER TABLE IF EXISTS audit_log    DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS memberships  DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS locations    DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS franchisees  DISABLE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS audit_log     CASCADE;
DROP TABLE IF EXISTS memberships   CASCADE;
DROP TABLE IF EXISTS locations     CASCADE;
DROP TABLE IF EXISTS franchisees   CASCADE;
DROP TABLE IF EXISTS franchisors   CASCADE;

DROP TABLE IF EXISTS verifications CASCADE;
DROP TABLE IF EXISTS accounts      CASCADE;
DROP TABLE IF EXISTS sessions      CASCADE;
DROP TABLE IF EXISTS users         CASCADE;

DROP TYPE IF EXISTS role;
DROP TYPE IF EXISTS scope_type;
