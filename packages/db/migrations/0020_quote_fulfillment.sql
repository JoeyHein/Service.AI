-- Migration: 0020_quote_fulfillment (up)
--
-- Phase 18 (QF). Links the fulfillment loop: an accepted quote spawns a job
-- (jobs.quote_id), and the balance invoice generated on job completion is
-- tied back to the quote (invoices.quote_id) so it can credit the deposit
-- and so commission isn't double-counted at balance payment.
--
-- Both FKs are nullable ON DELETE SET NULL. quotes already references jobs
-- (quotes.job_id), so jobs.quote_id closes a nullable cycle — fine in
-- Postgres since neither side is required.
--
-- One balance invoice per quote: a partial-unique index on invoices.quote_id
-- (live rows only) enforces it; the completion handler is the writer.

BEGIN;

ALTER TABLE jobs
  ADD COLUMN quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL;

CREATE INDEX jobs_quote_idx ON jobs (quote_id) WHERE quote_id IS NOT NULL;

ALTER TABLE invoices
  ADD COLUMN quote_id uuid REFERENCES quotes(id) ON DELETE SET NULL;

-- At most one live balance invoice per quote. Soft-deleted drafts don't
-- count, so a voided/deleted draft can be regenerated.
CREATE UNIQUE INDEX invoices_quote_id_unique
  ON invoices (quote_id)
  WHERE quote_id IS NOT NULL AND deleted_at IS NULL;

COMMIT;
