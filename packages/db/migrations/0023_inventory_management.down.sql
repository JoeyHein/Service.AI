-- Migration: 0023_inventory_management (down)

BEGIN;

DROP TABLE IF EXISTS inventory_consumption_exceptions;
DROP TABLE IF EXISTS inventory_movements;
DROP TABLE IF EXISTS inventory_items;

COMMIT;
