-- Migration: 0015_dashboard_pass3 (down)

ALTER TABLE memberships DROP COLUMN IF EXISTS hourly_rate_cents;
ALTER TABLE service_items DROP COLUMN IF EXISTS cogs_price;
