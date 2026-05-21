-- Migration: 0024_purchase_orders (down)

BEGIN;

DROP TABLE IF EXISTS purchase_order_lines;
DROP TABLE IF EXISTS purchase_orders;
DROP SEQUENCE IF EXISTS purchase_order_number_seq;

COMMIT;
