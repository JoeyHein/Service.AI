-- Migration: 0001_health_checks (up)
-- Creates the health_checks table used to store periodic service health results.
-- Idempotent: uses CREATE TABLE IF NOT EXISTS so re-running does not error.

CREATE TABLE IF NOT EXISTS health_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
