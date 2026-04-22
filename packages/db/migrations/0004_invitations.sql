-- Migration: 0004_invitations (up)
-- Adds the invitations table and its RLS policies. An invitation records
-- who may join a scope (franchisor / franchisee / location) and which role
-- they receive on redemption. Only a SHA-256 hash of the token is stored;
-- the raw token lives only in the email delivery link.

CREATE TABLE IF NOT EXISTS invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  role role NOT NULL,
  scope_type scope_type NOT NULL,
  franchisor_id UUID NOT NULL REFERENCES franchisors(id) ON DELETE CASCADE,
  franchisee_id UUID REFERENCES franchisees(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
  inviter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,
  redeemed_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS invitations_email_idx       ON invitations(email);
CREATE INDEX IF NOT EXISTS invitations_expires_idx     ON invitations(expires_at);
CREATE INDEX IF NOT EXISTS invitations_franchisor_idx  ON invitations(franchisor_id);
CREATE INDEX IF NOT EXISTS invitations_franchisee_idx  ON invitations(franchisee_id);
CREATE INDEX IF NOT EXISTS invitations_location_idx    ON invitations(location_id);
CREATE INDEX IF NOT EXISTS invitations_inviter_idx     ON invitations(inviter_user_id);

-- ---------------------------------------------------------------------------
-- Row Level Security — same three-policy pattern as 0003
-- ---------------------------------------------------------------------------

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE  ROW LEVEL SECURITY;

CREATE POLICY invitations_platform_admin ON invitations
  FOR ALL
  USING (current_setting('app.role', true) = 'platform_admin');

CREATE POLICY invitations_franchisor_admin ON invitations
  FOR ALL
  USING (
    current_setting('app.role', true) = 'franchisor_admin'
    AND franchisor_id = nullif(current_setting('app.franchisor_id', true), '')::uuid
  );

CREATE POLICY invitations_scoped ON invitations
  FOR ALL
  USING (
    current_setting('app.role', true) IS NOT NULL
    AND current_setting('app.role', true) NOT IN ('platform_admin', 'franchisor_admin')
    AND franchisee_id = nullif(current_setting('app.franchisee_id', true), '')::uuid
  );
