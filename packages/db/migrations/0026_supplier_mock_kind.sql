-- Migration: 0026_supplier_mock_kind (up)
--
-- Adds the 'mock' label to the supplier_provider_kind enum so a BC AI Agent
-- outage can be rolled back with a one-row `suppliers.provider_kind` flip,
-- symmetric with every other integration's stub fallback. The app's
-- defaultProviderRegistry() registers a 'mock' factory that degrades the
-- supplier to the in-memory MockSupplierProvider. See
-- docs/deploy/PILOT_OPERATIONS.md §3.
--
-- NOT wrapped in a transaction: Postgres forbids using a newly added enum
-- label within the same transaction, and ADD VALUE is happiest in autocommit.
-- IF NOT EXISTS makes this idempotent (re-running is a no-op).

ALTER TYPE supplier_provider_kind ADD VALUE IF NOT EXISTS 'mock';
