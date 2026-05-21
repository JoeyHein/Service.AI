-- Migration: 0021_void_unwind (up)
--
-- Phase 20 (VU). Tracks deposit refunds so voiding an accepted/paid quote
-- can refund the deposit idempotently (and the UI can show "refunded").
-- One nullable column on quotes; the refund itself is a Stripe call made
-- best-effort outside the void transaction.

BEGIN;

ALTER TABLE quotes
  ADD COLUMN deposit_refunded_at timestamptz;

COMMIT;
