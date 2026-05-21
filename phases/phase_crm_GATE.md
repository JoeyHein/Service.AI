# Phase Gate: phase_crm

**STATUS: SHIPPED 2026-05-21. CRM-01..06 landed. Ref: `docs/api/crm.md`. Local-only.**

Phase 23 — third "harvest existing assets" phase. Ports the CRM shape proven
in the BC AI Agent portal (`CustomerNote` interaction log + a Customer 360
detail page + a global notes feed with unmatched-note triage) and Donna's
`createCrmNote` ingest pattern (match-by-phone/email, `source_ref` dedup) into
Service.AI, adapted to its corporate-hub tenancy and existing `customers`/
`jobs`/`quotes`/`invoices` schema.

Service.AI today has only a flat `customers` table (contact + address + one
free-text `notes` field) and a CRUD detail page that is just an edit form. This
phase turns the customer detail into a **relationship hub** carrying the
business-valuable data Joey wants on each client.

## Resolved decisions (2026-05-21, Joey)
1. **Activity = one unified timeline.** Reverse-chronological feed interleaving
   notes + jobs + quotes + invoices + payments, with type filters. Not separate
   per-entity tabs.
2. **Headline KPIs (all four groups):** lifetime revenue (paid invoices),
   outstanding balance (unpaid/overdue), jobs+quotes activity (counts by status
   + quote→order conversion), avg order value + recency (first/last job,
   last contact).
3. **AI/Donna ingest is in-scope now** (not deferred): an ingest endpoint that
   matches a note to a customer by phone/email, dedupes on `source_ref`, and a
   triage feed to assign unmatched notes.

## Must Pass

- [x] **CRM-01** — `customer_notes` table (migration `0022_crm_customer_notes.sql`
  + `.down.sql` + Drizzle schema + round-trip test `crm-01`). Columns:
  `id, branch_id (NOT NULL → branches restrict), customer_id (nullable →
  customers SET NULL — null = unmatched, awaiting triage), note_type
  (call|email|meeting|sms|manual), subject, body (NOT NULL), source
  (manual|donna_pa|ai_csr|system), source_ref, match_key, match_key_type
  (phone|email), author_user_id (nullable → users SET NULL), metadata jsonb,
  occurred_at, created_at, updated_at`. Partial-unique `(source, source_ref)`
  where `source_ref` not null (dedup). Indexes: `customer_id`, `branch_id`,
  `(branch_id, occurred_at desc)`, `match_key`. RLS two-policy template
  (`_corporate_admin` + `_scoped` on `branch_id`). Append 0022 to `db:migrate`
  + `db:migrate:down`.
- [x] **CRM-02** — notes API (`apps/api/src/crm-routes.ts`):
  - `GET /api/v1/customers/:id/notes` — per-customer timeline, paginated,
    `type` filter. Branch-scoped, cross-tenant 404.
  - `POST /api/v1/customers/:id/notes` — staff manual note (`author_user_id =
    scope.userId`, `source='manual'`).
  - `POST /api/v1/crm/notes` — AI/Donna ingest. **Header-key auth**
    (`X-Service-AI-Ingest-Key` vs `CRM_INGEST_KEY`), runs OUTSIDE RequestScope.
    Matches a customer by `phone`/`email`; on match the note inherits that
    customer's branch; no match → unmatched note in the intake branch
    (`LEAD_INTAKE_BRANCH_SLUG`/first). Dedupe: a repeat `(source, source_ref)`
    returns the existing note id (idempotent).
  - `GET /api/v1/crm/notes-feed` — org/branch feed, filter by `type` +
    `matched` (matched|unmatched|all), paginated.
  - `POST /api/v1/crm/notes/:id/link` — triage: assign an unmatched note to a
    customer (sets `customer_id` + `branch_id`). Staff-auth (`requireScope`).
  - Tests: 401/403/400, per-customer list + cross-tenant 404, manual create,
    ingest match + ingest-unmatched + ingest dedup, feed filters, link triage.
- [x] **CRM-03** — customer metrics (`GET /api/v1/customers/:id/metrics`). One
  aggregation pass (no N+1): `lifetimeRevenueCents` (sum paid invoices),
  `outstandingCents` (unpaid/overdue invoice totals), `jobsByStatus`,
  `quotesByStatus` + `conversionRate`, `avgOrderValueCents`, `firstJobAt`,
  `lastJobAt`, `lastContactAt` (max note `occurred_at`), `openJobs`,
  `openQuotes`. Cross-tenant 404. Tests incl. a query-count assertion.
- [x] **CRM-04** — Customer 360 web page (`(app)/customers/[id]`). Rebuild the
  detail into: profile header (contact + address), KPI cards row (the four
  groups), a **unified activity timeline** with type filters, and an inline
  "Add note" form. Keep edit reachable (move the edit form to a panel or
  `[id]/edit`). Server-fetch metrics + first timeline page; client "Add note"
  + filter.
- [x] **CRM-05** — triage UI (`(app)/crm/notes`): the notes feed with type +
  matched/unmatched filters and a "Link to customer" action for unmatched
  notes. Add a `CRM` / `Inbox` nav link.
- [x] **CRM-06** — docs (`docs/api/crm.md`) + TD follow-ups + gate SHIPPED.

## Tenancy + security rules (load-bearing)
- Notes are branch-scoped; every staff read/write goes through
  `requireScope` + app-layer WHERE + `withScope`. Cross-tenant probe → 404.
- The ingest endpoint runs outside RequestScope (no session) — it is the only
  writer that resolves a synthetic branch scope from the matched customer (or
  the intake branch for unmatched). Header-key auth; fail closed if
  `CRM_INGEST_KEY` is set and the header is wrong/missing.
- Metrics/timeline must never leak cross-branch rows: aggregate only rows whose
  `branch_id`/customer matches the scope.
- No money amounts trusted from input; all metrics are server-computed from
  `invoices`/`payments`.

## Out of scope
- Pulling external BC metrics (sales YTD vs PY, credit limit, on-time delivery,
  shipments) — those are BC-OData numbers in the portal; Service.AI's 360 is
  computed from its own jobs/quotes/invoices. A BC-metrics overlay can be a
  later supplier-bridge follow-up.
- Pricing-tier / credit management UI.
- Merge/dedupe of duplicate customer records.

## Tasks: CRM-01 (schema) → CRM-02 (notes API) → CRM-03 (metrics) → CRM-04 (360 UI) → CRM-05 (triage UI) → CRM-06 (docs).

## Gate Decision
**APPROVED** (2026-05-21, Joey). Local-only.
