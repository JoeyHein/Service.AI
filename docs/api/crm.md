# CRM — Customer 360 + interaction timeline (CRM) — phase 23

Turns the flat `customers` table into a relationship hub: an interaction-note
log, a unified activity timeline, headline business KPIs per client, and an
ingest path so Donna PA / the AI CSR can auto-log calls and emails. Ported from
the BC AI Agent portal's `CustomerNote` model + Customer 360 page and Donna's
`createCrmNote` ingest shape, adapted to Service.AI's corporate-hub tenancy.

## Data model

`customer_notes` (migration `0022_crm_customer_notes.sql`):

| Column | Notes |
|---|---|
| `branch_id` | NOT NULL → branches. The tenancy scope key. |
| `customer_id` | nullable → customers. **NULL = unmatched** (ingest found no customer; awaiting triage). |
| `note_type` | `call \| email \| meeting \| sms \| manual` (CHECK). |
| `subject`, `body` | body NOT NULL. |
| `source` | `manual \| donna_pa \| ai_csr \| system` (free text). |
| `source_ref` | external id; `(source, source_ref)` is partial-unique → ingest dedup. |
| `match_key`, `match_key_type` | the phone/email an ingested note matched on. |
| `author_user_id` | nullable → users. NULL for ingest/system. |
| `metadata` | jsonb (call duration, transcript ref, …). |
| `occurred_at` | when the interaction happened (timeline orders on this). |

Two-policy RLS (`_corporate_admin` + `_scoped` on `branch_id`).

## Endpoints (`apps/api/src/crm-routes.ts`)

### Staff (session-scoped)
- `GET /api/v1/customers/:id/metrics` — Customer 360 KPIs. One fixed set of
  aggregate queries (no N+1):
  `lifetimeRevenueCents` (paid invoices), `outstandingCents` +
  `outstandingInvoices` (finalized/sent), `avgOrderValueCents`, `paidInvoices`,
  `jobsByStatus` + `totalJobs` + `openJobs` + `firstJobAt`/`lastJobAt`,
  `quotesByStatus` + `totalQuotes` + `openQuotes` + `conversionRatePct`
  (accepted ÷ non-void), `lastContactAt` (max note `occurred_at`).
- `GET /api/v1/customers/:id/timeline` — unified activity feed. One `UNION ALL`
  across notes + jobs + quotes + invoices, ordered by event time, `type`
  filter (`note|job|quote|invoice`), paginated. Rows:
  `{ id, kind, ts, subtype, title, detail, status, amount_cents, ref }`.
- `GET  /api/v1/customers/:id/notes` — per-customer note list, `type` filter.
- `POST /api/v1/customers/:id/notes` — staff manual note (`source='manual'`,
  `author_user_id = scope.userId`).
- `GET  /api/v1/crm/notes-feed` — org/branch feed; filters `type` +
  `matched=matched|unmatched`. Joins customer name. (The CRM Inbox UI.)
- `POST /api/v1/crm/notes/:id/link` — triage: assign an unmatched note to a
  customer (sets `customer_id` + `branch_id`).

All staff reads/writes: `requireScope` → app-layer WHERE → `withScope`
(RLS). Cross-tenant probe → 404.

### Ingest (server-to-server, no session)
- `POST /api/v1/crm/notes` — Donna PA / AI CSR log a call/email/etc. Runs
  **outside RequestScope**. Auth: `X-Service-AI-Ingest-Key` header compared to
  `CRM_INGEST_KEY` (fail closed when the env is set; open in dev when unset).
  Matches a customer by `email` (preferred) or `phone`, corporate-wide; the
  note inherits that customer's branch. No match → unmatched note in the intake
  branch (`LEAD_INTAKE_BRANCH_SLUG` / first branch). Idempotent on
  `(source, source_ref)`: a replay returns the existing note (`200`,
  `deduped:true`) instead of double-logging.

Donna's `lib/crm/opendc.ts::createCrmNote` maps 1:1 onto this body
(`phone/email/note_type/subject/body/source/source_ref/note_metadata`).

## Web (`apps/web/src/app/(app)`)
- `customers/[id]` — the Customer 360: profile header, KPI cards (lifetime
  revenue, outstanding, jobs/quotes activity + conversion, AOV + recency), a
  unified activity timeline (`CustomerActivity.tsx`) with type filters + an
  inline note composer, and the edit form moved into a disclosure.
- `crm/notes` — the CRM Inbox (`NotesFeed.tsx`): the feed with type +
  matched/unmatched filters and an inline customer search to link unmatched
  notes. Reachable via the "CRM Inbox" nav link.

## Out of scope (deferred)
- External BC metrics overlay (sales YTD vs PY, credit limit, on-time delivery,
  shipments) — those are BC-OData numbers; Service.AI's 360 is computed from
  its own jobs/quotes/invoices. See TD-CRM-01.
- A dedicated payments stream in the timeline (folded into invoice events for
  v1). See TD-CRM-02.
- Pricing-tier / credit management UI; duplicate-customer merge.
