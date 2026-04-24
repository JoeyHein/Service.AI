-- Migration: 0008_payments_stripe (down)
-- Reverses 0008: drops stripe_events, refunds, payments tables, the
-- two invoice columns, and the four franchisee Stripe columns.
-- FK-safe order: refunds before payments (refunds.payment_id FK),
-- payments before invoices (payments.invoice_id FK).

DROP TABLE IF EXISTS stripe_events CASCADE;
DROP TABLE IF EXISTS refunds       CASCADE;
DROP TABLE IF EXISTS payments      CASCADE;

DROP INDEX IF EXISTS invoices_stripe_payment_intent_unique;
DROP INDEX IF EXISTS invoices_payment_link_token_unique;

ALTER TABLE invoices
  DROP COLUMN IF EXISTS stripe_payment_intent_id,
  DROP COLUMN IF EXISTS payment_link_token,
  DROP COLUMN IF EXISTS application_fee_amount;

DROP INDEX IF EXISTS franchisees_stripe_account_unique;

ALTER TABLE franchisees
  DROP COLUMN IF EXISTS stripe_account_id,
  DROP COLUMN IF EXISTS stripe_charges_enabled,
  DROP COLUMN IF EXISTS stripe_payouts_enabled,
  DROP COLUMN IF EXISTS stripe_details_submitted;
