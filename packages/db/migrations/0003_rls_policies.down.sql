-- Migration: 0003_rls_policies (down)
-- Drops every policy introduced by 0003 and clears FORCE ROW LEVEL SECURITY.
-- RLS remains ENABLED (established by 0002) so the rollback only removes the
-- policy logic; running this leaves the tables in "fail-closed" state for
-- non-superuser roles. Idempotent: IF EXISTS guards on every drop.

DROP POLICY IF EXISTS franchisees_platform_admin   ON franchisees;
DROP POLICY IF EXISTS franchisees_franchisor_admin ON franchisees;
DROP POLICY IF EXISTS franchisees_scoped           ON franchisees;

DROP POLICY IF EXISTS locations_platform_admin   ON locations;
DROP POLICY IF EXISTS locations_franchisor_admin ON locations;
DROP POLICY IF EXISTS locations_scoped           ON locations;

DROP POLICY IF EXISTS memberships_platform_admin   ON memberships;
DROP POLICY IF EXISTS memberships_franchisor_admin ON memberships;
DROP POLICY IF EXISTS memberships_scoped           ON memberships;

DROP POLICY IF EXISTS audit_log_platform_admin   ON audit_log;
DROP POLICY IF EXISTS audit_log_franchisor_admin ON audit_log;
DROP POLICY IF EXISTS audit_log_scoped           ON audit_log;

ALTER TABLE IF EXISTS franchisees NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS locations   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS memberships NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS audit_log   NO FORCE ROW LEVEL SECURITY;
