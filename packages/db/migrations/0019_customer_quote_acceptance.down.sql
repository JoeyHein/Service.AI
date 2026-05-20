-- Migration: 0019_customer_quote_acceptance (down)
--
-- Drops everything the up path added. Idempotent (IF EXISTS).

BEGIN;

DROP INDEX IF EXISTS quotes_deposit_payment_intent_idx;
DROP INDEX IF EXISTS quotes_accept_token_unique;

ALTER TABLE quotes
  DROP COLUMN IF EXISTS deposit_paid_at,
  DROP COLUMN IF EXISTS deposit_payment_intent_id,
  DROP COLUMN IF EXISTS deposit_amount_cents,
  DROP COLUMN IF EXISTS accepted_channel,
  DROP COLUMN IF EXISTS accept_token_expires_at,
  DROP COLUMN IF EXISTS accept_token;

ALTER TABLE corporate
  DROP COLUMN IF EXISTS deposit_max_cents,
  DROP COLUMN IF EXISTS deposit_min_cents,
  DROP COLUMN IF EXISTS deposit_pct;

COMMIT;
