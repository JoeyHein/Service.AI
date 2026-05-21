-- Migration: 0021_void_unwind (down)

BEGIN;

ALTER TABLE quotes DROP COLUMN IF EXISTS deposit_refunded_at;

COMMIT;
