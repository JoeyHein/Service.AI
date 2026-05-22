# Tech Debt

Items deferred from phase audits as MINOR. Curated and prioritized by the evolver.

Format:
```
- [priority] <id> · <phase added> · <short title>
  - What: <one-line description>
  - Where: <file or module>
  - Why deferred: <reason>
```

---

## phase_quote_fulfillment (QF)

- [LOW] TD-QF-01 · phase_quote_fulfillment · `accepted → void` unwind — mostly done (VU); one remnant
  - DONE (phase_void_unwind, VU, 2026-05-20): voiding now refunds the paid deposit (Stripe `createRefund`, idempotent via `quotes.deposit_refunded_at`, migration 0021) and voids the unpaid balance invoice (in the void tx). `provider.voidQuote` already voids the BC sales quote.
  - REMAINING (the one remnant): if the quote was already **converted to a BC sales order**, the order stays alive — `provider.voidQuote` returns 422 for a converted quote (BC AI Agent rejects it), and there is no order-cancel operation. Needs a BC-side `cancel/delete sales order` endpoint + a `provider.cancelOrder` method, then wire it into `/void` for the converted case. Also: voiding does NOT refund an already-PAID balance invoice (only voids unpaid ones) — refunding a collected balance is a separate flow.
  - Where: bc-ai-agent external order API (new cancel-order op), `packages/suppliers` (`cancelOrder`), `quote-routes.ts::/void`.

- [LOW] TD-QF-02 · phase_quote_fulfillment · Materials reconciliation on the balance invoice
  - What: The balance invoice bills the accepted quote total as-is. If what was installed differs from what was quoted (substitutions, extra parts), there's no reconciliation step — the office would manually edit the draft invoice.
  - Where: `balance-invoice.ts` + the invoice PATCH flow.
  - Resolution: A reconciliation surface (quoted vs. installed) when materials tracking exists. Fine to defer — the office can edit the draft today.

- [CLOSED] TD-QF-03 · phase_quote_fulfillment · Office invoice console shipped (phase_office_invoicing)
  - Closed 2026-05-20. Phase 19 (OI-01..05): `GET /api/v1/invoices` list + `(app)/invoices` list + `(app)/invoices/[id]` detail (finalize/send/copy-link, reusing the existing endpoints) + Invoices nav + job-page invoice list. The QF-06 banner links to the detail page. See `docs/api/office-invoicing.md`.

## phase_customer_quote_acceptance (CQA)

- [LOW] TD-CQA-01 · phase_customer_quote_acceptance · DB-level RLS test for the corporate model
  - What: `packages/db/src/__tests__/live-rls.test.ts` was deleted during CQA-01 — it tested the defunct franchise RLS model (franchisors→franchisees→locations, `franchisor_admin` role, `app.franchisor_id` GUC), all dropped by CHR-01, so it could only fail against a live post-CHR DB. Corporate RLS is covered at the route/scope level by `apps/api/src/__tests__/live-security-corporate.test.ts` (8 cases) and the policy creation by `chr-01-migration-roundtrip.test.ts`, but there is no longer a db-level test that connects as a NON-superuser and asserts the `<table>_corporate_admin` / `<table>_scoped` policies actually fire on raw SELECTs (the dev docker Postgres connects as superuser and bypasses RLS, so route tests don't exercise the policy directly).
  - Where: new `packages/db/src/__tests__/live-rls-corporate.test.ts`
  - Why deferred: out of scope for CQA-01 (which only added the deposit/accept columns). Worth adding so prod RLS — the real backstop on a non-superuser connection — has explicit coverage. Model on the deleted file's non-superuser `rlsPool` approach but seed `corporate` + `branches` + set `app.role`/`app.branch_id` and assert branch isolation + corporate-sees-all.

## phase_foundation

- [CLOSED] TD-FND-01 · phase_foundation · Next.js ESLint plugin wired
  - Closed 2026-05-20 (verified already done). `eslint-config-next` is in `apps/web` deps; `apps/web/eslint.config.js` loads `eslint-config-next/core-web-vitals` via createRequire (CJS-in-ESM). `pnpm exec eslint .` runs clean (0 errors) with the Next core-web-vitals rules active. The TD entry was stale.

- [CLOSED] TD-FND-02 · phase_foundation · Web structure test asserts a real fetch
  - Closed 2026-05-20 (verified already done). `structure.test.ts` now has "issues a GET request to /healthz for liveness display" which asserts `page.tsx` contains a `fetch(` call targeting `/healthz` (not comment text). `page.tsx` does `fetch(\`${BASE_URL}/healthz\`)` for liveness + `POST /api/v1/echo` for contract enforcement. The TD entry was stale.

- [CLOSED] TD-FND-03 · phase_foundation · ARCHITECTURE.md has an explicit dependency graph
  - Closed 2026-05-20 (verified already done). `docs/ARCHITECTURE.md` §2a "Package dependency graph" renders the explicit app→package edges plus a "Forbidden edges" list (web/voice → db, any → direct LLM SDK). The TD entry was stale.

---

## phase_corporate_hub_redesign

- [CLOSED] TD-CHR-01 · phase_corporate_hub_redesign · Legacy franchise-table SQL in live tests resolved
  - Closed 2026-05-20. Verified against a live local DB: there is NO remaining raw SQL against the dropped `franchisees`/`franchisors` tables — `grep -i "INSERT/UPDATE/FROM/DELETE … franchisee[s]"` across `__tests__` returns nothing. The CHR-audit blocker fixes already migrated those tests to `branches`. The full api suite (702 tests) plus the 5 files that still mention `franchisee` all PASS against the reachable local DB — which is exactly the "real DB wired" scenario the TD warned about, so the failure mode no longer exists.
  - Remaining `franchisee` references are all legitimate: the live route paths `/api/v1/franchisees/:id/{phone,connect,ai-guardrails}` (intentionally kept per CHR-06) and explanatory comments. Cleaned up the last leftover smell: removed the dead `const franchisees = branches` alias + its `void` silencers in `live-voice-e2e.test.ts` and the unused `and`/`branches` imports it propped up.

- [CLOSED] TD-CHR-02 · phase_corporate_hub_redesign · Stale Stripe Connect assertions
  - Closed 2026-05-19. Verified the assertions were rewritten in the CHR-08 commit itself: `live-invoice-finalize.test.ts:190` already asserts `applicationFeeAmount === 0` with a CHR-08 comment, and the `STRIPE_NOT_READY` 409 test was replaced with `live-invoice-finalize.test.ts:220` ("finalize succeeds for a branch without per-branch Connect"). `STRIPE_NOT_READY` no longer appears in any test file. The TD entry was stale, not the code.

- [CLOSED] TD-CHR-03 · phase_corporate_hub_redesign · Demo seed no longer fakes an application fee
  - Closed 2026-05-20. Dropped the `applicationFeeAmount` line from the demo payment insert in `seed/demo.ts`; the column defaults to `'0'` as the corporate-hub model expects.

- [CLOSED] TD-CHR-04 · phase_corporate_hub_redesign · Stale `TODO(CHR-06)` markers removed
  - Closed 2026-05-20. Dropped all `TODO(CHR-06)` / `TODO(CHR-06 follow-up)` markers in `phone-routes.ts`, `pricebook-routes.ts`, `catalog-routes.ts`, `invites.ts`, `auth-mount.ts`. Decision was to keep the legacy route paths (a public-surface cut needs coordinated web + .do health-probe changes); reworded the comments as plain rationale (no `TODO`, per the no-TODO-without-task rule). The `impersonating: null` server stamp was removed entirely (see TD-CHR-05).

- [CLOSED] TD-CHR-05 · phase_corporate_hub_redesign · Web session types de-franchised
  - Closed 2026-05-20. Dropped `ImpersonatingContext` + `impersonating` from `MeResponse` (and the server-side `impersonating: null` stamp in `auth-mount.ts`), plus the unused `locationId` from `MeScope`. `accept-invite` `scopeType` is now `'branch'` (the only value the invite API issues). Verified no consumers reference the removed fields; updated the stale impersonation comment in `dispatch/page.tsx`.

- [CLOSED] TD-CHR-06 · phase_corporate_hub_redesign · franchisee→branch identifier + comment sweep
  - Closed 2026-05-20. Renamed the per-file `scopedFranchiseeId` helper → `scopedBranchId` and `inScopeByFranchisee` → `inScopeByBranch` across assignment/collections/invoice/job-photos/jobs/suggestion routes. Fixed the named misleading comments (assignment, jobs, customers, owner-dashboard, app.ts). `franchiseeName` was already fixed in CHR-B03.
  - Deliberately left open (one item): the Drizzle index string `ai_metrics_franchisee_date_unique` in `schema.ts:986` still matches the actual DB index created by migration `0011`. Renaming it would require a DDL rename migration for zero functional benefit (it's only an accessor-name string; the column is already `branchId`). Defer to the next ai_metrics-touching migration.

- [LOW] TD-CHR-07 · phase_corporate_hub_redesign · `applicationFeeAmount` column on `invoices` + `payments` still in schema
  - What: CHR-08 was code-only; the `application_fee_amount` columns on `invoices` and `payments` remain in the DB schema (per intentional comments in `packages/db/src/schema.ts`). The column always stays at zero in the corporate-hub model. Leaving it is correct for now (a column drop is destructive); flagged so a future cleanup migration can take care of it.
  - Where: `packages/db/src/schema.ts:613`, `packages/db/src/schema.ts:704`
  - Resolution: Optional migration after one prod cycle confirms no reads depend on the column.

- [CLOSED] TD-CHR-08 · phase_corporate_hub_redesign · dispatch-ui test name fixed
  - Closed 2026-05-20. Renamed the `it()` to "page gates to branch-scoped callers via notFound()". Assertion was already correct.

- [CLOSED] TD-CHR-09 · phase_corporate_hub_redesign · security test already on canonical route
  - Closed 2026-05-20. Verified `live-security-corporate.test.ts` already hits `/api/v1/corporate/branches` (lines 157-191) — no `/api/v1/franchisees` references remain. The TD was stale; the canonical path was adopted during the CHR audit.

## phase_supplier_quote_bridge

Items deferred (explicit out-of-scope per the SQB gate) — parked for follow-up phases. Each is LOW priority and was visible to the gate author at planning time, not introduced by audit findings.

- [LOW] TD-SQB-P1 · phase_supplier_quote_bridge · Multi-supplier per branch (UI)
  - What: The `suppliers` table is many-rows-per-corporate by design, but the v1 UI assumes one default supplier per corporate. `/quotes/new` does not render a supplier picker; `BcAiAgentProvider` is implicitly the only resolved provider. Works as long as Elevated Doors stays single-supplier.
  - Where: `apps/web/src/app/(app)/quotes/new/`, `apps/api/src/quote-routes.ts` (supplier resolution)
  - Resolution: Add `?supplierId=` URL param + a picker in the line item header when a second supplier is provisioned. Update the AI CSR tools to take an optional `supplierId` arg. Wait until a second supplier is real — premature picker UX would just clutter the live-quote surface.

- [CLOSED] TD-SQB-P2 · phase_supplier_quote_bridge · Quote PDF rendering → shipped in CQA-04
  - Closed 2026-05-20. `apps/api/src/quote-pdf.ts` (`@react-pdf/renderer`, modeled on `receipt-pdf.ts`) serves a branded quote PDF at `GET /api/v1/quotes/:id/quote.pdf` (operator) and `GET /api/v1/public/quotes/:token/pdf` (customer, token-gated, field-leak-safe). See `phase_customer_quote_acceptance`.

- [CLOSED] TD-SQB-P3 · phase_supplier_quote_bridge · Quote-to-order conversion → shipped as `phase_quote_order_conversion` (QOC-01..08, commit pending). `SupplierProvider.convertQuoteToOrder` + BC AI Agent's `POST /api/external/quotes/:id/convert-to-order` endpoint + `/accept` route wiring + UI badge all live. Closed 2026-05-18.

- [CLOSED] TD-SQB-P4 · phase_supplier_quote_bridge · Customer-facing accept link → shipped as phase_customer_quote_acceptance (CQA)
  - Closed 2026-05-20. `POST /quotes/:id/share` mints a signed token; public `app/quotes/[token]/accept` + `public-quote-routes.ts` let a homeowner accept (and pay a deposit via Stripe Elements) with no login. CSRF is Origin-allowlist + JSON-only (not cookie double-submit — there is no session cookie; the original "proven invoice CSRF pattern" never existed). See `docs/api/customer-acceptance.md`.

- [LOW] TD-SQB-P5 · phase_supplier_quote_bridge · Configurator UX inside Service.AI
  - What: Service.AI consumes resolved SKUs (e.g. `AL976-9X7-…`) — it does not host the door configurator. The configurator stays on the OPENDC portal / widget; if a Service.AI user wants to build an aluminium door from scratch, they leave the app, configure, copy the SKU back. Friction is acceptable while a single product line is in scope.
  - Where: would live alongside `apps/web/src/app/(app)/quotes/new/` — likely a `/quotes/new/configure` route loading the widget IIFE.
  - Resolution: Embed the OPENDC widget in an iframe / dynamic import once a configurator-driven product sells from Service.AI more than ~once a week.

### Audit-1 follow-ups (deferred from MAJOR fixes — see phase_supplier_quote_bridge_AUDIT_1.md)

- [CLOSED] TD-SQB-FU1 · phase_supplier_quote_bridge · QuoteBuilder + MobileQuoteBuilder now send `Idempotency-Key: <quoteId>` header on commit (shipped in QOC alongside the accept-button wiring). A live concurrent-commit test under the header path remains a smaller follow-up (filed as TD-QOC-A1 if the auditor surfaces it).

- [CLOSED] TD-SQB-FU2 · phase_supplier_quote_bridge · "Customer accepted" button shipped in QOC-07 (both `QuoteBuilder.tsx` and `MobileQuoteBuilder.tsx`). The ts-rest contract migration is a smaller follow-up under TD-QOC-FU1 below if desired.

- [LOW] TD-QOC-FU1 · phase_quote_order_conversion · `/accept` should be a ts-rest contract entry
  - What: QOC ships the accept endpoint as a raw Fastify handler. Other quote routes in `packages/contracts/src/quotes.ts` live as ts-rest contracts. The UI works today by calling fetch directly; type safety would improve with the contract layer.
  - Where: `packages/contracts/src/` (new entry), `apps/api/src/quote-routes.ts::/accept` (migrate the binding).
  - Resolution: Add the ts-rest contract entry, generate the client, switch QuoteBuilder/MobileQuoteBuilder to use the typed client.

- [LOW] TD-SQB-FU3 · phase_supplier_quote_bridge · Per-tool AI guardrails in `ctx.guardrails`
  - What: M3 added an in-tool confidence + dollar-cap guard inside `commitQuoteTool` (floors hard-coded to 0.9 and $5,000 per CLAUDE.md). The agent loop still uses a single global `confidenceThreshold` for every gated tool; per-tool floors are encoded only inside the tool that needs them. Works today (only `commitQuote` has a higher floor than the global), will get noisy once a fourth gated tool with its own floor lands.
  - Where: `packages/ai/src/loop.ts`, `packages/ai/src/call-context.ts::DEFAULT_GUARDRAILS`, all gated tool files.
  - Resolution: Reshape `ctx.guardrails` to `Record<toolName, { confidenceThreshold, dollarCap?, undoWindowMin? }>`. Have `loop.ts` look up `guardrails[toolName]` before falling back to the global. Remove the in-tool guard once the loop enforces.

### Audit-1 minors (deferred — see phase_supplier_quote_bridge_AUDIT_1.md)

- [CLOSED] TD-SQB-A1 · phase_supplier_quote_bridge · `accepted → void` documented in the gate
  - Closed 2026-05-20. The matrix docstring in `quote-status-machine.ts` already documented the edge; added the matching `accepted → void` bullet to `phase_supplier_quote_bridge_GATE.md`'s allowed-transition list with the rationale (legitimate refund-after-acceptance, manager-only, reverses commission like committed→void).

- [CLOSED] TD-SQB-A2 · phase_supplier_quote_bridge · Commission credited regardless of scope on commit
  - Closed 2026-05-20. Dropped the `scope.type === 'branch'` guard around `onQuoteCommitted` in `quote-routes.ts::/commit`. The engine keys on `closerUserId` and no-ops when the user has no active plan, so a corporate_admin closing on behalf of a branch is now credited iff they carry a personal comp assignment — no silent skip.

- [CLOSED] TD-SQB-A3 · phase_supplier_quote_bridge · Quote-routes Zod schemas are now `.strict()`
  - Closed 2026-05-20. All six schemas (`CreateQuoteSchema`, `LineItemSchema`, `PriceQuoteSchema`, `CommitQuoteSchema`, `VoidQuoteSchema`, `AcceptQuoteSchema`) call `.strict()`. The cost-forgery test now asserts a 400 VALIDATION_ERROR when a body smuggles `unitCostCents`, plus a separate clean-path test confirms cost still comes from the supplier.

- [CLOSED] TD-SQB-A4 · phase_supplier_quote_bridge · Provider error → HTTP status mapping deduplicated
  - Closed 2026-05-20. Extracted `providerErrorStatus(code: SupplierError['code'])` in `quote-routes.ts`; both the `/price` resolve path and the `/commit` handler call it. New `SupplierError` codes now map consistently in both arms (default 502).

- [CLOSED] TD-SQB-A5 · phase_supplier_quote_bridge · Commission preview now reads the active comp plan
  - Closed 2026-05-19. `previewQuoteCommission` exported from `apps/api/src/commission-engine.ts`; `/api/v1/quotes/:id/price` returns `data.commissionPreview = { commissionCents, percentEffective } | null` resolved off the would-be closer's active comp plan + `flat_percent_of_quote_committed` rules. `QuoteBuilder.tsx` reads from state instead of the 4% placeholder; preview hides when the user has no active plan. Two new cases added to `live-quote-routes.test.ts::commission preview (TD-SQB-A5)`.

- [CLOSED] TD-SQB-A6 · phase_supplier_quote_bridge · `accepted → void` reversal now tested
  - Closed 2026-05-20. Added `live-quote-routes.test.ts::reverses commission when an ACCEPTED quote is voided (TD-SQB-A6)`: commits (+300), accepts, then voids and asserts the balancing −300 `manual_adjustment` row lands and the user's net for the quote is zero.

- [CLOSED] TD-SQB-A7 · phase_supplier_quote_bridge · Pino redact covers deeply-nested API key
  - Closed 2026-05-20. pino's fast-redact has no recursive `**`, so added explicit depth-2/3 paths for the bracket-keyed header (`*.*["x-service-ai-key"]`, `*.*.*[...]`), the camelCase `xServiceAiKey`, and `apiKey`/`api_key` shapes. Two new SQB-11 redaction test cases assert a `{ supplier: { config: { 'x-service-ai-key' } } }` style nest is censored. Test redact list kept in sync with `logger.ts`.

- [CLOSED] TD-SQB-A8 · phase_supplier_quote_bridge · BC void-quote endpoint shipped end-to-end
  - Closed 2026-05-19. Added `POST /api/external/quotes/{external_quote_id}/void` to BC AI Agent (`external_quote_void_service.py` + alembic `c5d6e7f8g9h0`; idempotent on `external_quote_id`, persists `voided_at` + `void_reason` on the existing `external_quote_commits` row; rejects already-converted quotes with 422; swallows BC 404 as success). `BcAiAgentProvider.voidQuote` now takes `{ externalQuoteId, supplierQuoteRef, reason, requestId }` and hits the new endpoint. `quote-routes.ts::/void` passes `req.params.id` as `externalQuoteId` so BC's idempotency key matches commit + accept. 13 new pytest cases + 3 new vitest cases against the provider. Local + BC state no longer drift on void.

## phase_quote_order_conversion

### Audit-1 follow-ups (deferred from MAJOR fixes — see phase_quote_order_conversion_AUDIT_1.md)

- [CLOSED] TD-QOC-A1 · phase_quote_order_conversion · 10× concurrent convert-to-order stress test
  - Closed 2026-05-20. Added `TestConcurrency::test_10x_concurrent_conversions_yield_one_bc_call` to `test_external_quote_convert_to_order.py`, mirroring the commit test: 10 threads convert the same `external_quote_id` against a delayed fake BC client; asserts `fake_bc.convert_calls` ≤ 1 and exactly one distinct order ref. Added a `set_delay` knob + lock to the convert fake.

- [CLOSED] TD-QOC-A2 · phase_quote_order_conversion · `audit_log` insert assertion added
  - Closed 2026-05-20. The QOC accept happy-path test now queries `audit_log WHERE action='quote.accept' AND metadata->>'quoteId'=$1`, asserts exactly one row with `actor_user_id = MANAGER_USER`. Also asserts the new `quote.order_converted` audit row (see TD-QOC-A4).

### Audit-1 minors (deferred — see phase_quote_order_conversion_AUDIT_1.md)

- [CLOSED] TD-QOC-A3 · phase_quote_order_conversion · Lock-map release race fixed
  - Closed 2026-05-20. `_release_lock` in `external_quote_service.py` is now a documented no-op: popping the per-key lock on release was the race (a concurrent `_lock_for` would mint a fresh lock for a still-in-use key). Keeping the lock in the map means `_lock_for` always returns the same object for a key, which is what makes the mutual exclusion correct. Memory growth is bounded (UUID keys, fixed ops per quote, cleared on restart). The function is kept as a named single release point in case the strategy moves to a Postgres advisory lock later. Shared by commit + convert + void.

- [CLOSED] TD-QOC-A4 · phase_quote_order_conversion · order-conversion event moved to `audit_log`
  - Closed 2026-05-20. The accepted→accepted `quote_status_log` self-loop is gone; the conversion now writes an `audit_log` row with `action='quote.order_converted'` (+ quoteId/orderRef/orderId metadata), consistent with the `quote.accept` row. Test asserts the audit row exists and that NO accepted→accepted status_log row was written.

- [CLOSED] TD-QOC-A5 · phase_quote_order_conversion · suppliers read wrapped in `withScope`
  - Closed 2026-05-20. Both the accept-path convert lookup and the void-path supplier lookup now read `suppliers` inside `withScope(db, scope, ...)`, matching the codebase convention even though the corporate-only table reads safely from any scope today.

- [LOW] TD-QOC-A6 · phase_quote_order_conversion · BC AI Agent convert endpoint accepts any content-type
  - What: The `POST /api/external/quotes/:id/convert-to-order` endpoint has no request body (keyed entirely on the path param). FastAPI accepts any content-type for empty-body POSTs.
  - Where: `bc-ai-agent/backend/app/api/external_quotes.py::convert_to_order`
  - Why still deferred (2026-05-20): genuinely cosmetic — there is no body to validate, so there is no injection/parse surface. Tighten with `Body(None)` or a strict `{}` model only when/if the endpoint grows real body fields. Not worth the churn now. (The newer `/void` endpoint already takes an optional `VoidQuoteIn` model.)

- [CLOSED] TD-QOC-A7 · phase_quote_order_conversion · `Idempotency-Key` header on convert call
  - Closed 2026-05-20. `ConvertQuoteToOrderRequest` gained an optional `idempotencyKey`; `BcAiAgentProvider` threads it through `callWithRetry`/`doFetch` to set the `Idempotency-Key` header. `quote-routes.ts::/accept` passes the quoteId. Belt-and-suspenders alongside the path-param idempotency BC already enforces.

- [LOW] TD-QOC-A8 · phase_quote_order_conversion · `external_call_log` not implemented (inherited from SQB)
  - What: The SQB gate called for an `external_call_log` table that records every external API call (key_id, latency, status). It was never implemented in SQB; QOC's convert endpoint inherits the gap.
  - Where: bc-ai-agent's `external_quotes.py`, `external_pricing.py`, new `external_quotes/convert-to-order` (all three lack the call log).
  - Resolution: Add an `external_call_log` table + a small wrapper that records every external call. One follow-up phase that covers all three endpoints. Useful for billing / rate limiting / debug.

- [LOW] TD-QOC-A9 · phase_quote_order_conversion · Migration 0018 not transactional-DDL-safe under CONCURRENTLY
  - What: `0018_quote_order_conversion.sql` uses plain `ALTER TABLE` + `CREATE UNIQUE INDEX`. Postgres holds an ACCESS EXCLUSIVE lock on `quotes` for the duration of the ALTER. On a hot table at scale this would briefly block all writes. v1 tables are small so this is a non-issue; flagged for awareness.
  - Where: `packages/db/migrations/0018_quote_order_conversion.sql`
  - Resolution: For large-table cases, switch to `ALTER TABLE ... ADD COLUMN <name> <type> NULL` (cheap) + `CREATE UNIQUE INDEX CONCURRENTLY` (no exclusive lock). Not yet needed.

- [CLOSED] TD-QOC-A10 · phase_quote_order_conversion · Live happy-path test now queries the `quotes` row directly
  - Closed 2026-05-20. Added a `pool.query` after the response assertion reading `supplier_order_ref`, `supplier_order_id`, `ordered_at` straight from the `quotes` row, so a regression that keeps the response shape but drops the write would be caught.

### Widget integration follow-ups (WI) — phase 22

- [HIGH] TD-WI-01 · phase_widget_integration · Auto-SKU resolution for door-designer leads
  - What: The door-designer widget emits a human-readable `doorConfig` (family/size/design/color/windows), not resolved BC SKUs. v1 captures the config on a draft quote's notes and a manager prices it by hand. This is the deliberate v1 scope line, but it leaves a manual step on every widget lead.
  - Where: `apps/api/src/public-widget-routes.ts` (lead intake), `apps/api/src/quote-routes.ts::/design-config` (in-app). Resolution lives behind a NEW BC AI Agent external endpoint wrapping `part_number_service`.
  - Resolution: Add `POST /api/external/door-config/resolve-parts` to BC AI Agent that maps a `doorConfig` → `[{ sku, quantity }]` (it already does this internally for `get_parts_for_door_config`). Add a `resolveDoorConfig` op to `SupplierProvider` + `BcAiAgentProvider`; on widget intake, resolve → seed priced quote lines instead of (or in addition to) the notes block. Then the lead arrives priced.

- [LOW] TD-WI-02 · phase_widget_integration · In-app design image not stored
  - What: The in-app "Design a door" path (`/quotes/:id/design-config`) captures the config to notes but does not store the door image. Only the public lead path stores the image. Rationale: the in-app manager just saw the design on screen.
  - Where: `apps/api/src/quote-routes.ts::/design-config`.
  - Resolution: If managers later want the rendered image attached to the in-app quote, thread `objectStore` into `QuoteRoutesDeps` and reuse `storeDoorImage` keyed by quote id (same as the public path).

- [LOW] TD-WI-03 · phase_widget_integration · Widget lead dedupe is per-email, not per-config
  - What: A homeowner who submits the designer twice for the same email gets one customer but two draft lead quotes. The gate allowed either behavior for v1; we create a fresh draft each time.
  - Where: `apps/api/src/public-widget-routes.ts`.
  - Resolution: If lead spam becomes a problem, de-dupe to one open draft per (email, config-hash) within a short window, or collapse onto the most recent open draft for that customer.

### CRM follow-ups (CRM) — phase 23

- [MED] TD-CRM-01 · phase_crm · External BC metrics overlay on the Customer 360
  - What: The Customer 360 KPIs are computed from Service.AI's own jobs/quotes/invoices. The BC AI Agent portal also surfaced BC-OData numbers (sales YTD vs prior year, credit limit + utilization, on-time delivery %, recent shipments, monthly sales chart) that Service.AI does not have.
  - Where: `apps/api/src/crm-routes.ts` (metrics), `bc_metrics_service.get_customer_metrics` in bc-ai-agent.
  - Resolution: Add a `customerMetrics` op to `SupplierProvider` + a BC AI Agent `GET /api/external/customers/:account/metrics` endpoint, and render a "Business Central" overlay section on the 360 when the customer is BC-linked. Needs the supplier_account_code ↔ customer mapping.

- [LOW] TD-CRM-02 · phase_crm · Payments not a distinct timeline stream
  - What: The unified timeline UNIONs notes + jobs + quotes + invoices. Individual payments/refunds are reflected via the invoice's status (paid/void) rather than as their own events.
  - Where: `apps/api/src/crm-routes.ts::/timeline`.
  - Resolution: Add a `payments` (and `refunds`) arm to the UNION (amount + created_at + invoice ref) if a payment-level history is wanted on the 360.

- [LOW] TD-CRM-03 · phase_crm · Ingest key is a single shared secret
  - What: `POST /api/v1/crm/notes` authenticates with one `CRM_INGEST_KEY` shared by all callers (Donna PA, AI CSR). No per-caller key, rotation, or rate limit; when the env is unset (dev) the endpoint is open.
  - Where: `apps/api/src/crm-routes.ts::POST /api/v1/crm/notes`.
  - Resolution: Mint per-caller ingest keys (mirror the SQB `external-keys` bcrypt-hashed pattern) and add a rate limit. Until then, keep `CRM_INGEST_KEY` set in every non-dev environment.

- [LOW] TD-CRM-04 · phase_crm · Phone/email match is exact, single-customer
  - What: Ingest matches a customer by exact `email` (ilike) or exact `phone` string, picking the most-recently-created on a tie. Phone-format variance (e.g. `+1` prefix, dashes) and shared household contacts can mis-match or fall through to unmatched.
  - Where: `apps/api/src/crm-routes.ts::POST /api/v1/crm/notes`.
  - Resolution: Normalize phone to E.164 before matching (store a normalized column), and surface near-matches in the triage UI rather than only exact hits.

### Inventory follow-ups (INV) — phase 24

- [CLOSED] TD-INV-01 · phase_inventory · BC supplier-availability overlay
  - Closed 2026-05-21 (phase 26, BCB). `SupplierProvider.checkAvailability` + BC AI Agent `POST /api/external/check-availability` (wraps `bc_inventory_service.check_availability`) + Service.AI `POST /api/v1/inventory/check-availability` + a "Check supplier stock" affordance on the PO form. Live BC path unvalidated (mocked tests). Ref: `docs/api/bc-purchasing-bridge.md`.

- [MED] TD-INV-02 · phase_inventory · Auto-reserve stock on quote accept
  - What: `inventory_items.qty_reserved` exists and `available = on_hand - reserved` is computed everywhere, but nothing populates `qty_reserved`. Reserving stock when a quote is accepted (before the job consumes it) would make `available` and low-stock truthful for in-flight work.
  - Where: the quote accept path (`runOrderConversion`/`ensureJobForAcceptedQuote`) + `inventory-consume.ts` (release reserved when consumed).
  - Resolution: On accept, write `reserve` movements + bump `qty_reserved` for matched lines; on completion, `release` then `consume`. Mirror the auto-consume matching logic.

- [LOW] TD-INV-03 · phase_inventory · No multi-location/bin or branch transfers
  - What: Stock is a single on-hand number per (branch, sku). The `transfer_in`/`transfer_out` movement reasons exist but there's no transfer workflow, and no bin-level detail (the `bin` column is a free-text label only).
  - Where: `inventory-routes.ts`, schema.
  - Resolution: Add a transfer endpoint (paired out/in movements across two branches in one tx) and, if needed, a bin sub-location model.

- [LOW] TD-INV-04 · phase_inventory · No inventory valuation / COGS reporting
  - What: `unit_cost_cents` is stored per item + per receipt movement, but there's no valuation rollup (on-hand value per branch/category) or COGS-from-consumption report.
  - Where: a new `GET /api/v1/inventory/valuation` aggregate + a dashboard tile.
  - Resolution: Sum `qty_on_hand * unit_cost_cents` by branch/category; optionally moving-average cost from receipt movements.

### Purchase order follow-ups (PO) — phase 25

- [CLOSED] TD-PO-01 · phase_purchase_orders · Send the PO to the supplier / BC
  - Closed 2026-05-21 (phase 26, BCB). `SupplierProvider.createPurchaseOrder` (idempotent on externalPoId) + BC AI Agent `POST /api/external/purchase-orders` (wraps create_purchase_order + add_purchase_order_line, idempotency via `external_purchase_orders` table) + Service.AI `submit` best-effort push that stamps `supplier_po_ref`/`bc_synced_at`. Live BC path unvalidated (mocked tests). Ref: `docs/api/bc-purchasing-bridge.md`.

### BC purchasing bridge follow-ups (BCB) — phase 26

- [CLOSED] TD-BCB-01 · phase_bc_purchasing_bridge · Quote-builder availability badge
  - Closed 2026-05-21. `quotes/new/page.tsx` now resolves the corporate's default supplier via `GET /api/v1/suppliers` (first row) and passes `supplierId` into the builder — which also un-stubs the previously-deferred draft-quote creation. QuoteBuilder gained a "Check supplier stock" button + a supplier-stock panel showing per-SKU available/partial/unavailable from `/api/v1/inventory/check-availability`.

- [CLOSED] TD-BCB-02 · phase_bc_purchasing_bridge · No PO BC-resync endpoint
  - Closed 2026-05-21. `POST /api/v1/purchase-orders/:id/sync-bc` (manager+) re-calls `createPurchaseOrder` (idempotent on the PO id), stamps the ref; 409 on draft/canceled, idempotent no-op when already synced. A "Sync to BC" button shows on the PO detail when post-draft + unsynced. 2 tests.

- [LOW] TD-BCB-03 · phase_bc_purchasing_bridge · bc-ai-agent alembic has 3 heads
  - What: bc-ai-agent's alembic history is branched (3 heads pre-existing). The new `b1c2d3e4f5a6` migration is based on the external-tables lineage head (`c5d6e7f8g9h0`); `alembic upgrade head` would need `--heads` or a merge revision.
  - Where: `bc-ai-agent/backend/alembic/versions`.
  - Resolution: Add an alembic merge revision unifying the heads (separate from this phase; pre-existing condition).

- [LOW] TD-PO-02 · phase_purchase_orders · No demand-signal acknowledge workflow
  - What: `from-low-stock` reads the live low-stock report directly. BC AI Agent had a `demand_signals` table with severity + acknowledge gating before PO generation; Service.AI has no equivalent persistence/triage.
  - Where: `inventory-routes.ts` (low-stock), `purchase-order-routes.ts` (from-low-stock).
  - Resolution: If managers want to review/snooze reorder suggestions before ordering, add a lightweight reorder-suggestion table + an acknowledge step. Not needed while the live report suffices.

- [LOW] TD-PO-03 · phase_purchase_orders · No vendor invoice / over-receipt / line edits
  - What: Receiving caps at the ordered quantity (no over-receipt). There's no vendor-invoice / 3-way match, and PO lines can't be edited after creation (recreate the PO instead).
  - Where: `purchase-order-routes.ts`.
  - Resolution: Allow over-receipt with a flag if real-world receiving needs it; add a draft-line PATCH; add an invoices arm if AP reconciliation is wanted.
