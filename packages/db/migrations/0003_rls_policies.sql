-- Migration: 0003_rls_policies (up)
-- Adds row-level security policies to the tenant-scoped tables whose RLS was
-- enabled in 0002. Policies read three session GUCs set by the API through
-- packages/db's withScope helper inside a transaction:
--
--   app.role            — the caller's role string (e.g. 'platform_admin',
--                         'franchisor_admin', 'franchisee_owner', ...)
--   app.franchisor_id   — the franchisor UUID when the role is franchisor_admin
--   app.franchisee_id   — the franchisee UUID for every non-platform-admin role
--
-- set_config(..., true) inside a transaction makes each GUC local: the value
-- auto-clears at COMMIT or ROLLBACK, so one request cannot leak scope to the
-- next. current_setting('app.x', true) returns NULL when the GUC is unset;
-- nullif(..., '') coerces the empty-string default back to NULL so the ::uuid
-- cast does not raise on unscoped requests.
--
-- FORCE ROW LEVEL SECURITY makes the policies apply even to the table owner,
-- so a dev machine where the API role happens to own the tables still sees
-- RLS enforced. Postgres superusers always bypass RLS — production
-- deployments must connect as a non-superuser DB role.
--
-- Policy roles are expressed as three independent USING clauses per table.
-- Postgres's rule is permissive by default: a row is visible if ANY policy's
-- USING clause returns true. Each role therefore gets its own named policy
-- so the privilege model is readable and each branch can be dropped
-- independently in the .down.sql.

-- ---------------------------------------------------------------------------
-- franchisees
-- ---------------------------------------------------------------------------

ALTER TABLE franchisees FORCE ROW LEVEL SECURITY;

CREATE POLICY franchisees_platform_admin ON franchisees
  FOR ALL
  USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY franchisees_franchisor_admin ON franchisees
  FOR ALL
  USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
  );

CREATE POLICY franchisees_scoped ON franchisees
  FOR ALL
  USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------------
-- locations
-- ---------------------------------------------------------------------------

ALTER TABLE locations FORCE ROW LEVEL SECURITY;

CREATE POLICY locations_platform_admin ON locations
  FOR ALL
  USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY locations_franchisor_admin ON locations
  FOR ALL
  USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );

CREATE POLICY locations_scoped ON locations
  FOR ALL
  USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------------
-- memberships
--
-- Non-admin roles see only memberships attached to their own franchisee.
-- franchisor_admin sees memberships at any franchisee under their franchisor,
-- plus memberships directly scoped to their franchisor (franchisee_id IS NULL
-- AND scope_type = 'franchisor' AND scope_id = app.franchisor_id).
-- ---------------------------------------------------------------------------

ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY memberships_platform_admin ON memberships
  FOR ALL
  USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY memberships_franchisor_admin ON memberships
  FOR ALL
  USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND (
      franchisee_id IN (
        SELECT id FROM franchisees
         WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
      )
      OR (
        franchisee_id IS NULL
        AND scope_type = 'franchisor'
        AND scope_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
      )
    )
  );

CREATE POLICY memberships_scoped ON memberships
  FOR ALL
  USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );

-- ---------------------------------------------------------------------------
-- audit_log
-- ---------------------------------------------------------------------------

ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_log_platform_admin ON audit_log
  FOR ALL
  USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY audit_log_franchisor_admin ON audit_log
  FOR ALL
  USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND target_franchisee_id IN (
      SELECT id FROM franchisees
       WHERE franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
    )
  );

CREATE POLICY audit_log_scoped ON audit_log
  FOR ALL
  USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND target_franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );
