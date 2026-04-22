-- Migration: 0004_invitations (down)
-- Reverts 0004_invitations.sql. Drops policies, table, and clears FORCE.

DROP POLICY IF EXISTS invitations_platform_admin   ON invitations;
DROP POLICY IF EXISTS invitations_franchisor_admin ON invitations;
DROP POLICY IF EXISTS invitations_scoped           ON invitations;

ALTER TABLE IF EXISTS invitations NO FORCE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS invitations CASCADE;
