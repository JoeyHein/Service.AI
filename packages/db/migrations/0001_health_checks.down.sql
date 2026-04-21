-- Migration: 0001_health_checks (down)
-- Reverts the up migration by dropping the health_checks table.

DROP TABLE IF EXISTS health_checks;
