-- Migration: 0015_dashboard_pass3 (up)
-- Adds cost-of-goods-sold per pricebook item + per-tech hourly rate
-- so the owner dashboard can project gross profit and labor margin.
--
-- Both fields are nullable. NULL means "unknown / not modeled" and
-- the projector treats those rows as zero-cost. Operators set real
-- values via the pricebook editor and the staff invite flow when
-- they have the data; the dashboard degrades gracefully until then.

ALTER TABLE service_items
  ADD COLUMN IF NOT EXISTS cogs_price NUMERIC(12, 2);

ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS hourly_rate_cents NUMERIC(12, 2);

-- An index on hourly_rate_cents would only help if we filtered or
-- ordered by it; the projector joins by user_id which is already
-- indexed. No new indexes needed.
