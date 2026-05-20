# Phase Gate: phase_supplier_quote_bridge

**Written before build begins. Criteria here cannot be loosened mid-phase.**

Phase 15 — adds a supplier-side quote bridge so any branch
can pull real-time prices and create live sales quotes against
an external supplier's ERP account. The first (and currently
only) provider is **BC AI Agent** acting as a vendor for the
corporate parent, talking to OPENDC's Microsoft Business
Central tenant under the Elevated Doors customer account. The
abstraction is provider-shaped so future suppliers can plug in
without re-touching the Service.AI core.

**Goal (what success looks like):** a CSR or local branch
manager is on the phone with a homeowner. While talking, they
(or the AI CSR voice agent) configures a door — size, model,
options. Within ~600 ms of each change, Service.AI shows the
live price pulled from BC SalesPriceLists. When the homeowner
says "yes, let's do it," one click persists the quote as a
real BC sales quote under Elevated Doors' BC customer record,
an SQ-XXXXXX number comes back, the same number is stamped
onto the Service.AI job, and a `commission_ledger` row is
written for the manager / closer on plans that pay on
`quote_committed`. Sale is closeable on the call. The same
flow works for an in-person tech on the PWA.

This phase depends on `phase_corporate_hub_redesign` having
landed first — every scoping reference here uses `branch_id`,
the simplified two-policy RLS template, and the new role set
(`corporate_admin` / `manager` / `csr` / `tech`).

This phase does NOT cover customer-facing accept links, PDF
rendering, or quote-to-order conversion. Those are follow-ups.

---

## Architectural shape

```
Service.AI branch scope
  └─ quotes (new) ─┬─ quote_line_items (new)
                   ├─ supplier_quote_ref (BC SQ-XXXXXX)
                   └─ commission_ledger (CHR-05) on commit
                          │
                          ▼
            packages/suppliers (new)
                provider registry + types
                          │
                          ▼
            BcAiAgentProvider (first impl)
                          │  HTTPS, API-key auth
                          ▼
            BC AI Agent  POST /api/external/...
                          │
                          ▼
            BC OData (Elevated Doors customer)
```

Service.AI does not know about BC. It knows about a
`SupplierProvider` interface with two operations: `priceItems`
(sub-second, idempotent, no side effects) and `commitQuote`
(creates a real document in the supplier's system, returns a
reference). BC AI Agent is the first provider. The corporate
hub uses a single supplier configuration that every branch
inherits; later versions can override per branch.

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### Data model (Service.AI side)

- [ ] New tables in `packages/db` migration `0017_supplier_quote_bridge.sql`:
  - `suppliers` (corporate-scoped registry of supplier
    providers; v1 expects exactly one row; `provider_kind`
    enum starts with `bc_ai_agent` only; stores
    `endpoint_url`, `api_key_secret_ref`,
    `supplier_account_code` — for BC AI Agent this is the
    Elevated Doors BC customer number).
  - `margin_overrides` (corporate-scoped, keyed by
    supplier `item_category` — mirrors BC's
    `itemCategoryCode` strings: `ALUMINIUM`, `ROLLUP`,
    `LIFTMASTER`, `COMPONENT`, etc.). Columns:
    `id`, `item_category`, `margin_pct`, `created_by`,
    `created_at`, `updated_at`. UNIQUE on
    `item_category`. Corporate-only writes.
  - `quotes`: `id`, `branch_id`, `customer_id`, `job_id?`,
    `supplier_id`, `status` enum
    (`draft` / `priced` / `committed` / `accepted` / `void`),
    `subtotal_cents`, `tax_cents`, `total_cents`,
    `currency_code`, `supplier_quote_ref?` (e.g. SQ-001391),
    `supplier_quote_id?` (provider-native UUID),
    `valid_until?`, `created_by_user_id`, `closer_user_id?`
    (whichever user clicks "commit" — drives the commission
    ledger row), timestamps.
  - `quote_line_items`: `id`, `quote_id`, `position`,
    `supplier_sku`, `description`, `quantity`,
    `unit_price_cents`, `line_total_cents`,
    `supplier_unit_cost_cents?` (margin shown to manager +
    corporate only — never to the customer),
    `applied_margin_pct` (which margin actually fired:
    line override → category override → corporate default),
    `applied_margin_source` enum
    (`line_override` / `category_override` /
    `corporate_default`),
    `margin_override_pct?` (manager-only per-line
    discretion; NULL when not overridden),
    `margin_override_reason?` (required when
    `margin_override_pct` is set — short free-text audit
    note),
    `metadata jsonb` for provider-specific configurator
    state.
  - `quote_status_log`: id, quote_id, from_status, to_status,
    actor_user_id, reason, created_at.
- [ ] All four tables have `branch_id`, RLS enabled +
  FORCE RLS, the two named policies (`_corporate_admin`,
  `_scoped`) per the post-CHR template.
- [ ] Migration is reversible (`.down.sql` drops policies +
  tables in the right order; tested by running up/down/up in
  CI).
- [ ] FK indexes present on every FK column. No N+1 query in
  list endpoints (assertion in integration tests).

### Provider abstraction (Service.AI side)

- [ ] New package `packages/suppliers` exporting:
  - `SupplierProvider` interface with:
    - `priceItems(scope, supplier, input): Promise<PriceResult>`
      — input is `{ items: [{ sku, quantity, options }] }`,
      output is `{ items: [{ sku, unitPriceCents, lineTotalCents, currency, unitCostCents?, validUntil? }], subtotalCents, taxCents, totalCents }`. Pure read. Idempotent. Must return in **p95 < 800 ms** under the live test (see Performance).
    - `commitQuote(scope, supplier, input): Promise<CommitResult>`
      — input is the whole priced quote + customer ref;
      returns `{ supplierQuoteRef, supplierQuoteId, validUntil }`.
      MUST support `Idempotency-Key` end-to-end so a retried
      commit returns the same `supplierQuoteRef` instead of
      creating a duplicate BC quote.
  - `ProviderRegistry` keyed by `provider_kind`. Resolves a
    `Supplier` row to its provider impl.
  - `BcAiAgentProvider` implementing the interface against BC
    AI Agent's external API (below).
- [ ] No direct fetch of BC OData from Service.AI. All BC
  traffic flows through `BcAiAgentProvider` → BC AI Agent.

### BC AI Agent side — `/api/external/*` endpoints

- [ ] `POST /api/external/price-items` (BC AI Agent):
  - Auth: `X-Service-AI-Key` header, validated against a new
    `external_api_keys` table (hashed). Per-key scoping so
    the corporate key can only price under the Elevated Doors
    BC customer account.
  - Body: `{ supplierAccountCode, items: [{ sku, quantity, options? }], currency? }`.
  - Resolves prices using existing BC SalesPriceLists pipeline
    (per `project_pricing_flow` memory — no unitPrice
    override, BC fall-through respected, ALUM bypasses curve,
    volume curve gated by `pricing_enable_volume_curve`).
  - Returns prices + per-line `unit_cost_cents` (so Service.AI
    can show owner-side margin).
  - **p95 latency target: < 600 ms** measured at BC AI Agent
    boundary under the perf test.
- [ ] `POST /api/external/quotes` (BC AI Agent):
  - Body: priced quote + `customer_ref` (Elevated Doors BC
    customer id) + `external_quote_id` (Service.AI's quote
    UUID — used for idempotency).
  - Creates a real BC sales quote via existing
    `bc_quote_service` (reuses part-number generation, BC
    description truncation, etc.).
  - Idempotency: a repeat call with the same `external_quote_id`
    returns the existing `supplier_quote_ref`. Does NOT create
    a second BC quote.
  - Returns `{ supplier_quote_ref, supplier_quote_id, valid_until }`.
- [ ] Both endpoints reject requests for any
  `supplierAccountCode` not bound to the calling key. Cross-
  key probes return 404 NOT_FOUND (same rule as Service.AI:
  never 403 on cross-tenant probes).
- [ ] BC AI Agent persists every external call in a new
  `external_call_log` table (request hash, response status,
  latency_ms, key_id, external_quote_id) for debugging and
  rate-limit accounting.

### Service.AI API surface

- [ ] ts-rest contract added in `packages/contracts` under
  `quotes` namespace. All endpoints return the standard
  `{ ok: true, data } | { ok: false, error }` envelope.
- [ ] `POST /api/v1/quotes` — create draft quote
  `{ customerId, jobId?, supplierId, lineItems[] }`. Scopes
  off `request.scope`. Idempotency-Key supported.
- [ ] `POST /api/v1/quotes/:id/price` — calls
  `provider.priceItems`, persists prices on the quote, moves
  status `draft → priced`. p95 < 1.0 s including DB writes.
- [ ] `POST /api/v1/quotes/:id/commit` — calls
  `provider.commitQuote`, persists `supplier_quote_ref`,
  moves status `priced → committed`. Idempotency-Key
  required; replays do not create a second BC quote.
- [ ] `POST /api/v1/quotes/:id/void` — moves to `void`. Logs
  to `quote_status_log`. Cannot void after `accepted`.
- [ ] `GET /api/v1/quotes` and `GET /api/v1/quotes/:id` —
  scoped reads with the standard 401/403/404/happy-path test
  matrix. List endpoint supports `?customerId=`, `?jobId=`,
  `?status=`, pagination.
- [ ] All five endpoints have the full test matrix per
  CLAUDE.md: 401, 403 (wrong tenant — returns 404), 400,
  happy-path, edge-case.

### Margin policy + selling-price resolution

- [ ] `resolveSellingPrice({ unitCostCents, itemCategory,
  lineOverridePct? }, tx)` pure projector that returns
  `{ unitPriceCents, marginPct, marginSource }`. Resolution
  order:
  1. `lineOverridePct` (manager-set per-line) if not NULL
  2. `margin_overrides.margin_pct` matching the BC
     `itemCategory` if present
  3. `corporate.default_margin_pct` (always populated)
  The formula is `unitPriceCents = round(unitCostCents *
  (1 + marginPct / 100))`. This intentionally uses the
  multiplicative form (not the divisive one OPENDC's
  legacy engine uses) — it's the form managers reason
  about ("50% markup on cost"). The OPENDC legacy form
  stays in BC AI Agent for the GNB Manitoba use case.
- [ ] `unit_cost_cents` returned by the supplier provider
  IS the platinum-tier price BC resolves for the Elevated
  Doors customer account — i.e., what we actually pay
  OPENDC. Service.AI never displays that to the customer;
  it is the input to `resolveSellingPrice`.
- [ ] Cost is NOT trusted from the web client. The price
  endpoint always re-fetches `unit_cost_cents` from the
  supplier provider before applying margin — the client
  cannot manipulate cost to inflate margin.
- [ ] Per-line margin override:
  - Only `manager` and `corporate_admin` roles can set
    `margin_override_pct` (CSR / tech UI does not render
    the input)
  - Override must include a non-empty `margin_override_reason`
    (server-side validation, 4xx if missing)
  - Override is bounded by corporate config:
    `corporate.min_margin_pct` (default 20%) and
    `corporate.max_margin_pct` (default 200%). Outside
    the range → 422 `MARGIN_OUT_OF_BOUNDS`.
  - Every override write produces an `audit_log` row.
- [ ] Re-pricing (`/quotes/:id/price`) re-evaluates
  resolution on every line every time. Editing a category
  override in `/corporate/settings/margins` does NOT
  retroactively rewrite committed quotes; their
  `applied_margin_pct` is frozen at commit time.

### Status state machine

- [ ] `apps/api/src/quote-status-machine.ts` modelled on
  `job-status-machine.ts`. Allowed transitions:
  - `draft → priced` (price call succeeds)
  - `draft → void`, `priced → void`
  - `priced → priced` (re-price after edit, same status,
    history row written)
  - `priced → committed` (commit call succeeds — atomically
    writes a `commission_ledger` row for the `closer_user_id`
    on any active comp plan with a
    `flat_percent_of_quote_committed` rule, per CHR-05)
  - `committed → accepted` (customer says yes; recorded by
    CSR / tech)
  - `committed → void` (within the BC `valid_until` window;
    BC quote is also voided via provider; the
    `commission_ledger` row is reversed by a balancing
    negative row with `source_kind = 'manual_adjustment'`)
  - `accepted → void` (TD-SQB-A1: refund / cancel after the
    customer already accepted — manager-only path. Reverses
    the commission row the same way `committed → void` does.
    This is a deliberate stricter-than-original extension: a
    legitimate refund-after-acceptance must be representable,
    so the matrix in `quote-status-machine.ts` permits it and
    its docstring documents it.)
- [ ] Illegal moves return `409 INVALID_TRANSITION` with
  `{ from, to }`.
- [ ] Status update + log row run in one `withScope` tx.

### Live quote UI (web)

- [ ] New route `/quotes/new?customerId=…&jobId=…`:
  - Pricebook-aware line item picker (existing
    `phase_tech_mobile_pwa` line picker as base).
  - Debounced live re-price: any line edit fires
    `/quotes/:id/price` after 300 ms of idle typing. Spinner
    state visible. Cancels superseded in-flight requests.
  - Subtotal/tax/total updates in place. Per-line manager-only
    margin pill (gated by role; CSR / tech do not see cost).
  - **Per-line margin column** (manager + corporate_admin
    only): shows the resolved `applied_margin_pct` + a
    badge for the source (`line` / `category` /
    `default`). Inline edit pencil opens a small popover:
    new % + required reason text. On save, line re-prices
    against the override.
  - **Manager commission preview** under the totals card
    ("Your commission @ X%: $YYY") — only renders for
    `manager` role, only on plans that pay
    `quote_committed`. Reads the active comp plan via
    `computeCommissionPreview(quoteId, userId)`.
  - "Send to supplier" button → `/commit`. After success,
    the BC SQ-XXXXXX number is shown and copyable.
- [ ] New route `/corporate/settings/margins`
  (corporate_admin only):
  - Field: corporate default margin % (single input).
  - Table: category overrides — BC `itemCategoryCode` +
    margin %. Add / edit / delete rows. Autocomplete on
    `item_category` against the list of categories
    actually present in the BC catalog.
  - Two read-only fields: `min_margin_pct` and
    `max_margin_pct` (bounds on per-line overrides).
    Editable by `platform_admin` only (kept off the
    surface for managers to discover).
- [ ] Same component reused under the tech PWA at
  `/tech/jobs/:id/quote/new`. Works offline-with-stale-cache
  for `priceItems` (last quoted price shown with a "stale"
  badge); commit is blocked offline and queued.

### Live quote — voice (AI CSR)

- [ ] New AI CSR tool `quoteConfigurator` in
  `packages/ai/prompts/csr/` + the dispatcher tool list:
  inputs `{ supplierSku, quantity, options? }[]`; calls
  `provider.priceItems` directly (no full Service.AI quote
  row yet); voice agent reads the price aloud within the
  600 ms p95 budget.
- [ ] New AI CSR tool `commitQuote`: requires confidence ≥
  the `csr.commitQuote` guardrail (default 0.90, dollar cap
  inherited from `csr.bookJob`), and emits an `ai_actions`
  row with the supplier ref.
- [ ] Guardrail defaults added to CLAUDE.md table.

### Live quote — in-person (tech)

- [ ] `/tech/jobs/:id` adds a "New quote" tile that opens
  the live quote view above.
- [ ] Tech can commit a quote from the field; tech's
  device-time and geolocation are written to `quote_status_log`
  on commit (for sales-attribution analytics later).

### Observability + auditing

- [ ] Every supplier call (price + commit + void) writes an
  `audit_log` row on the Service.AI side and an
  `external_call_log` row on the BC AI Agent side. A request
  ID flows from the inbound web request → through the
  provider call → BC AI Agent's log → BC OData traffic, so
  one ID traces the whole chain.
- [ ] pino logs in Service.AI redact API keys and customer
  PII per the existing logger config.
- [ ] Sentry captures provider errors with the request ID
  attached as a tag.

### Performance (load-bearing for "live on phone")

- [ ] k6 scenario `tests/perf/supplier_quote_bridge_live.js`:
  20 concurrent CSRs, each re-pricing every 1.5 s for 5 min
  against the staging BC AI Agent.
  - **p95 `priceItems` end-to-end (Service.AI → BC AI Agent →
    BC → back) < 1.0 s.**
  - **p95 `commitQuote` end-to-end < 2.5 s.**
  - 0 5xx, 0 timeouts.
- [ ] Caching strategy documented: BC AI Agent caches
  SalesPriceLists rows per (customer, sku) for 60 s in
  Redis; cache key invalidated by the existing BC sync job
  when a price changes. Verified by a perf test that re-
  prices the same line twice and asserts the second call is
  served from cache (latency < 80 ms).

### Idempotency proof

- [ ] Test: commit the same quote 10× concurrently with the
  same `Idempotency-Key`. Assert exactly one BC sales quote
  exists (queried via BC AI Agent's `get_sales_quotes`
  filtered by `externalDocumentNumber`).
- [ ] Test: simulate Service.AI → BC AI Agent network drop
  during commit. Service.AI retries. Asserts no duplicate BC
  quote, status converges to `committed` with the original
  `supplier_quote_ref`.

---

## Must Improve Over Previous Phase

- [ ] No regression in prior phase test suites
  - **Verification:** `pnpm -r test` across all prior phases exits 0.
- [ ] Build time does not grow >20% over phase 13
  - **Verification:** CI timing comparison.
- [ ] Web bundle size growth <15% (quote UI lives behind a
  dynamic import on `/quotes` and `/tech/.../quote`)
  - **Verification:** `pnpm --filter web analyze` diff.

## Security Baseline

- [ ] No new `pnpm audit --audit-level=high` findings.
- [ ] External API keys are stored hashed (argon2id) in
  `external_api_keys`. Plaintext is shown once at creation
  and never again.
- [ ] Service.AI never logs the supplier API key. Verified
  by grep gate in CI: `grep -R "X-Service-AI-Key" apps/api/logs`
  returns nothing under load.
- [ ] All `/api/external/*` endpoints on BC AI Agent enforce
  rate limits (default 600 rpm per key, configurable per
  key row). Excess returns 429 with Retry-After.
- [ ] Cross-tenant IDOR test: a key bound to Elevated Doors
  cannot price or commit under a different
  `supplierAccountCode`. Returns 404.
- [ ] Semgrep SAST run on the new packages exits clean.

## Documentation

- [ ] `docs/api/supplier-quote-bridge.md` — full endpoint
  reference on both sides, sequence diagrams (live re-price,
  commit with idempotency, commit with retry).
- [ ] `docs/ARCHITECTURE.md` updated: new `packages/suppliers`
  in the dependency graph; quote tables added to the data
  model section; sequence note that quote pricing happens
  out-of-process.
- [ ] CLAUDE.md updated:
  - Add `quoteConfigurator` + `commitQuote` to the AI
    guardrail defaults table.
  - Add a new "Supplier providers" section under "Required
    patterns" describing the `SupplierProvider` interface
    and the rule "no direct supplier-ERP calls from
    Service.AI app code; route through `packages/suppliers`".
- [ ] BC AI Agent's `CLAUDE.md` gets a "External API"
  section linking the new endpoint docs and the API-key
  management UI path.
- [ ] `docs/LESSONS.md` reserved entry for this phase; the
  evolver fills it after the audit.
- [ ] `docs/TECH_DEBT.md` parked items (LOW priority):
  multi-supplier per franchisee, quote PDF rendering, order
  conversion, accept-from-customer link.

---

## Out of scope (explicitly deferred)

- Customer-facing accept link (homeowner clicks a link to
  accept the quote). Handled in a follow-up phase together
  with PDF rendering and Stripe deposit collection.
- Converting a committed supplier quote into an order +
  fulfilment status sync. BC AI Agent already has
  `convert_quote_to_order`; wiring is deferred.
- Multiple suppliers per franchisee. Schema supports it
  (`suppliers` table is many-per-franchisee), but UI assumes
  one default supplier; "pick supplier" UX is follow-up.
- Royalty implications of supplier purchases — phase 8
  royalty engine continues to compute royalty on
  franchisee → customer revenue only, not on franchisee →
  supplier cost.
- BC SWD / aluminium / hardware-kit configurator UX inside
  Service.AI. The configurator stays on the OPENDC portal /
  widget for now; Service.AI consumes the resulting SKUs.

---

## Tasks (build order)

1. **SQB-01** — `packages/db` migration 0015 + Drizzle schema
   for `suppliers`, `margin_overrides`, `quotes`,
   `quote_line_items` (with `applied_margin_pct` /
   `applied_margin_source` / `margin_override_pct` /
   `margin_override_reason` columns), `quote_status_log`,
   two-policy RLS, seed one `suppliers` row pointing at BC AI
   Agent staging with the Elevated Doors BC customer code.
2. **SQB-02** — `packages/suppliers` with `SupplierProvider`
   interface, registry, and a `MockProvider` for unit tests.
3. **SQB-03** — BC AI Agent: `external_api_keys` table +
   management endpoints (admin-only) + key generation tool.
4. **SQB-04** — BC AI Agent: `POST /api/external/price-items`
   wrapping BC SalesPriceLists resolution + 60 s Redis cache.
5. **SQB-05** — BC AI Agent: `POST /api/external/quotes`
   wrapping `bc_quote_service` with full idempotency.
6. **SQB-06** — `BcAiAgentProvider` impl in
   `packages/suppliers`; integration test against a recorded
   BC AI Agent fixture, then a live test against staging.
7. **SQB-07** — Service.AI ts-rest contracts +
   `/api/v1/quotes/*` routes + status machine +
   `resolveSellingPrice` margin engine (line override →
   category override → corporate default) + commission
   ledger write on commit (depends on CHR-05) + the 5-case
   test matrix per endpoint, including property tests for
   the margin resolution order and bounds.
8. **SQB-08** — Live quote web UI (`/quotes/new`) with
   debounced re-price + commit + margin pill +
   manager-only per-line margin override popover +
   commission preview. Also ships
   `/corporate/settings/margins` (default + category
   overrides) and the `[platform_admin]` margin-bounds
   editor.
9. **SQB-09** — Tech PWA quote view reusing SQB-08
   component; offline cache for `priceItems`.
10. **SQB-10** — AI CSR tools `quoteConfigurator` +
    `commitQuote` with guardrails + `ai_actions` logging.
11. **SQB-11** — Observability: request-ID propagation,
    audit-log integration, Sentry tags, pino redaction.
12. **SQB-12** — k6 perf scenario + idempotency stress test
    + commission-ledger reversal test on void + Semgrep +
    live-staging end-to-end test.
13. **SQB-13** — Docs (`supplier-quote-bridge.md`,
    ARCHITECTURE updates, CLAUDE.md updates on both repos).

---

## Gate Decision

<filled in by reviewer>
APPROVED | REJECTED
