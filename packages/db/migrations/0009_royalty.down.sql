-- Migration: 0009_royalty (down)
-- FK-safe order: rules → agreements (rules FK agreements),
-- statements are independent of both.

DROP TABLE IF EXISTS royalty_statements    CASCADE;
DROP TABLE IF EXISTS royalty_rules         CASCADE;
DROP TABLE IF EXISTS franchise_agreements  CASCADE;

DROP TYPE IF EXISTS royalty_statement_status;
DROP TYPE IF EXISTS royalty_rule_type;
DROP TYPE IF EXISTS agreement_status;
