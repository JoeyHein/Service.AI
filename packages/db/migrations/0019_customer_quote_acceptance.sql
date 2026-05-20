-- Migration: 0019_customer_quote_acceptance (up)
--
-- Phase 17 (CQA). Lets a homeowner accept a committed quote via a signed
-- link and (optionally) pay a deposit. Pure additive — new nullable
-- columns on `quotes` plus a corporate-level deposit policy on
-- `corporate`. No new tables, no new RLS (the existing
-- quotes_corporate_admin + quotes_scoped policies cover the new columns;
-- the public token routes read OUTSIDE RequestScope by token, never via
-- a scoped query).
--
-- Acceptance + the BC order ref already live on the `quotes` row (QOC).
-- This phase adds the share token + the single-deposit-per-quote fields
-- on the same row (1:1, same reasoning as quote→order).

BEGIN;

ALTER TABLE quotes
  -- 32-byte base64url token minted at "Share"; the customer's only auth.
  ADD COLUMN accept_token text,
  ADD COLUMN accept_token_expires_at timestamptz,
  -- How acceptance was recorded. Promoted from quote_status_log metadata
  -- so the manager board can distinguish self-serve from operator closes.
  -- 'verbal_phone' | 'verbal_inperson' | 'signed_pdf' | 'customer_link' | 'other'
  ADD COLUMN accepted_channel text,
  -- Deposit asked for, frozen at share time from the corporate policy so a
  -- later policy change never moves the customer's number. NULL = no deposit.
  ADD COLUMN deposit_amount_cents integer,
  ADD COLUMN deposit_payment_intent_id text,
  ADD COLUMN deposit_paid_at timestamptz;

-- One live share token per quote. Partial unique so the many null rows
-- (un-shared quotes) don't collide.
CREATE UNIQUE INDEX quotes_accept_token_unique
  ON quotes (accept_token)
  WHERE accept_token IS NOT NULL;

-- The Stripe webhook matches an incoming PaymentIntent id back to the
-- quote that owns the deposit. Partial index keeps the lookup cheap.
CREATE INDEX quotes_deposit_payment_intent_idx
  ON quotes (deposit_payment_intent_id)
  WHERE deposit_payment_intent_id IS NOT NULL;

-- Corporate-level deposit policy (mirrors the margin policy shape).
-- deposit_pct = 0 means the branch does not collect deposits.
ALTER TABLE corporate
  ADD COLUMN deposit_pct numeric(5,2) NOT NULL DEFAULT '0.00',
  ADD COLUMN deposit_min_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN deposit_max_cents integer;

COMMIT;
