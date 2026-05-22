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

- [WONTFIX-v1 / BLOCKED] TD-QF-01 · phase_quote_fulfillment · converted-order cancel on void
  - Decision 2026-05-22: BLOCKED on BC capability. VU already handles the financial unwind (deposit refund + unpaid balance-invoice void + BC sales-quote void). The remaining piece — cancelling an already-converted BC **sales order** on void — has no implementation path: `bc_client` exposes only create/update/ship for sales orders (no cancel/delete), and BC OData v2.0 does not expose order deletion (a created order is managed by status in BC, not deleted via API). Building a speculative "cancel via update_sales_order to some status" is unverifiable without live BC + BC docs and risks corrupting real orders. Workaround today: an order placed in error is cancelled by staff in BC directly; the Service.AI quote still voids + refunds. Reopen if BC adds a cancel-order action (then: `provider.cancelOrder` → `POST /api/external/quotes/:id/cancel-order` → wire into `/void` for the converted case). Refunding an already-PAID balance invoice is likewise a separate, deliberate finance flow (not auto on void).

- [WONTFIX-v1] TD-QF-02 · phase_quote_fulfillment · Materials reconciliation on the balance invoice
  - Decision 2026-05-22: deliberately deferred (the TD itself says "fine to defer — the office can edit the draft today"). The balance invoice is a DRAFT the office reviews + can edit before finalize, so substitutions/extra parts are already handleable manually. A structured quoted-vs-installed reconciliation surface only earns its keep once per-job materials tracking exists (INV consumption is auto from the quote, not a separate "what the tech actually installed" capture). Revisit alongside a tech materials-used capture feature.

- [CLOSED] TD-QF-03 · phase_quote_fulfillment · Office invoice console shipped (phase_office_invoicing)
  - Closed 2026-05-20. Phase 19 (OI-01..05): `GET /api/v1/invoices` list + `(app)/invoices` list + `(app)/invoices/[id]` detail (finalize/send/copy-link, reusing the existing endpoints) + Invoices nav + job-page invoice list. The QF-06 banner links to the detail page. See `docs/api/office-invoicing.md`.

## phase_customer_quote_acceptance (CQA)

- [CLOSED] TD-CQA-01 · phase_customer_quote_acceptance · DB-level RLS test for the corporate model
  - Closed 2026-05-22. Added `packages/db/src/__tests__/live-rls-corporate.test.ts`: creates a dedicated NON-superuser, NOBYPASSRLS role (`rls_probe`), seeds a corporate + 2 branches + a customer each, sets the `app.role`/`app.branch_id` GUCs the way `withScope` does (txn-local), and asserts on raw SELECTs that the `<table>_scoped` policy isolates a branch role to its own branch, the `<table>_corporate_admin` policy lets a corporate_admin see all, and an unset role sees nothing (fails closed). Auto-skips if the probe role can't connect (pg_hba). Verified the probe connects + policies fire in the local docker DB.
  - (original) What: `packages/db/src/__tests__/live-rls.test.ts` was deleted during CQA-01 — it tested the defunct franchise RLS model (franchisors→franchisees→locations, `franchisor_admin` role, `app.franchisor_id` GUC), all dropped by CHR-01, so it could only fail against a live post-CHR DB. Corporate RLS is covered at the route/scope level by `apps/api/src/__tests__/live-security-corporate.test.ts` (8 cases) and the policy creation by `chr-01-migration-roundtrip.test.ts`, but there is no longer a db-level test that connects as a NON-superuser and asserts the `<table>_corporate_admin` / `<table>_scoped` policies actually fire on raw SELECTs (the dev docker Postgres connects as superuser and bypasses RLS, so route tests don't exercise the policy directly).
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

- [WONTFIX-v1] TD-CHR-07 · phase_corporate_hub_redesign · `applicationFeeAmount` columns still in schema
  - Decision 2026-05-22: deliberately deferred to post-go-live. The column drop is destructive and the TD's own bar ("after one prod cycle confirms no reads depend on the column") isn't met — Service.AI hasn't gone live, and the column is still read in `invoice-payment-routes.ts` + asserted (=== 0) in 4 live tests. Dropping it now means rewriting those for zero functional gain and reintroducing a destructive migration before the first prod cycle. The column is harmless (always 0, defaulted). Revisit as a cleanup migration after the 30-day pilot.

- [CLOSED] TD-CHR-08 · phase_corporate_hub_redesign · dispatch-ui test name fixed
  - Closed 2026-05-20. Renamed the `it()` to "page gates to branch-scoped callers via notFound()". Assertion was already correct.

- [CLOSED] TD-CHR-09 · phase_corporate_hub_redesign · security test already on canonical route
  - Closed 2026-05-20. Verified `live-security-corporate.test.ts` already hits `/api/v1/corporate/branches` (lines 157-191) — no `/api/v1/franchisees` references remain. The TD was stale; the canonical path was adopted during the CHR audit.

## phase_supplier_quote_bridge

Items deferred (explicit out-of-scope per the SQB gate) — parked for follow-up phases. Each is LOW priority and was visible to the gate author at planning time, not introduced by audit findings.

- [WONTFIX-v1] TD-SQB-P1 · phase_supplier_quote_bridge · Multi-supplier per branch (UI)
  - Decision 2026-05-22: deliberately NOT built. Elevated Doors is single-supplier (one BC account); the TD itself flags that a picker now "would just clutter the live-quote surface" and to "wait until a second supplier is real." The plumbing is ready — `GET /api/v1/suppliers` lists all rows, `quotes/new` resolves the default (first), and `bindProvider` is keyed by `supplierId` — so adding a `<select>` is a ~1h change when a 2nd supplier is provisioned. Tracked here; reopen at that point.

- [CLOSED] TD-SQB-P2 · phase_supplier_quote_bridge · Quote PDF rendering → shipped in CQA-04
  - Closed 2026-05-20. `apps/api/src/quote-pdf.ts` (`@react-pdf/renderer`, modeled on `receipt-pdf.ts`) serves a branded quote PDF at `GET /api/v1/quotes/:id/quote.pdf` (operator) and `GET /api/v1/public/quotes/:token/pdf` (customer, token-gated, field-leak-safe). See `phase_customer_quote_acceptance`.

- [CLOSED] TD-SQB-P3 · phase_supplier_quote_bridge · Quote-to-order conversion → shipped as `phase_quote_order_conversion` (QOC-01..08, commit pending). `SupplierProvider.convertQuoteToOrder` + BC AI Agent's `POST /api/external/quotes/:id/convert-to-order` endpoint + `/accept` route wiring + UI badge all live. Closed 2026-05-18.

- [CLOSED] TD-SQB-P4 · phase_supplier_quote_bridge · Customer-facing accept link → shipped as phase_customer_quote_acceptance (CQA)
  - Closed 2026-05-20. `POST /quotes/:id/share` mints a signed token; public `app/quotes/[token]/accept` + `public-quote-routes.ts` let a homeowner accept (and pay a deposit via Stripe Elements) with no login. CSRF is Origin-allowlist + JSON-only (not cookie double-submit — there is no session cookie; the original "proven invoice CSRF pattern" never existed). See `docs/api/customer-acceptance.md`.

- [CLOSED] TD-SQB-P5 · phase_supplier_quote_bridge · Configurator UX inside Service.AI
  - Closed 2026-05-22 — superseded by WI-02 (phase 22). The quote builder already embeds the OPENDC door designer IIFE in-app via the "Design a door" modal (`DesignDoorModal.tsx`), which posts the config to `/quotes/:id/design-config`. A Service.AI user can configure a door without leaving the app; the deferred friction this TD described no longer exists.

### Audit-1 follow-ups (deferred from MAJOR fixes — see phase_supplier_quote_bridge_AUDIT_1.md)

- [CLOSED] TD-SQB-FU1 · phase_supplier_quote_bridge · QuoteBuilder + MobileQuoteBuilder now send `Idempotency-Key: <quoteId>` header on commit (shipped in QOC alongside the accept-button wiring). A live concurrent-commit test under the header path remains a smaller follow-up (filed as TD-QOC-A1 if the auditor surfaces it).

- [CLOSED] TD-SQB-FU2 · phase_supplier_quote_bridge · "Customer accepted" button shipped in QOC-07 (both `QuoteBuilder.tsx` and `MobileQuoteBuilder.tsx`). The ts-rest contract migration is a smaller follow-up under TD-QOC-FU1 below if desired.

- [WONTFIX-v1] TD-QOC-FU1 · phase_quote_order_conversion · `/accept` should be a ts-rest contract entry
  - Decision 2026-05-22: deliberately deferred. Purely a type-safety/consistency nicety — the endpoint works and is covered by live integration tests; migrating it to ts-rest touches the contracts package + client regen + two UI call sites for zero functional change. Several other quote routes (`/share`, `/void`, `/design-config`, `/accept`) are also raw handlers; a single sweep migrating them all to ts-rest is the right unit of work, not a one-off for `/accept`. Revisit when the contracts layer gets a broader pass.

- [CLOSED] TD-SQB-FU3 · phase_supplier_quote_bridge · Per-tool AI guardrails
  - Closed 2026-05-22. `guardrails.perTool` (`Record<toolName, { confidenceThreshold?, dollarCapCents?, undoWindowMin? }>`) added to the call-context + tool-context types, seeded from the CLAUDE.md table (commitQuote 0.9/$5k, bookJob 0.8, quoteConfigurator 0.7, autoAssign 0.8, photoQuote 0.75/$500, sendDraft 0.9). `loop.ts` now resolves `perTool[toolName]?.confidenceThreshold ?? confidenceThreshold` for the gate — a new gated tool just adds a `perTool` entry, no per-tool global. Loop test asserts a per-tool floor overrides the global. The in-tool `commitQuote` confidence+dollar guard is kept as defense-in-depth (the tool can be invoked outside the loop's gating), now redundant with the loop's floor rather than the only enforcement.

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

- [CLOSED] TD-QOC-A6 · phase_quote_order_conversion · convert endpoint body tightened
  - Closed 2026-05-22. `convert_to_order` now takes `Optional[ConvertToOrderIn]` (`model_config = ConfigDict(extra='forbid')`) — empty body still works (path-keyed), smuggled fields → 422. pytest asserts the 422. (bc-ai-agent local commit 4320ba3.)

- [CLOSED] TD-QOC-A7 · phase_quote_order_conversion · `Idempotency-Key` header on convert call
  - Closed 2026-05-20. `ConvertQuoteToOrderRequest` gained an optional `idempotencyKey`; `BcAiAgentProvider` threads it through `callWithRetry`/`doFetch` to set the `Idempotency-Key` header. `quote-routes.ts::/accept` passes the quoteId. Belt-and-suspenders alongside the path-param idempotency BC already enforces.

- [CLOSED] TD-QOC-A8 · phase_quote_order_conversion · `external_call_log` implemented
  - Closed 2026-05-22. `external_call_log` table (model + alembic `e5f6a7b8c9d0`) + an `/api/external/*` HTTP middleware in `main.py` that records method/path/status/latency_ms + the 12-char key prefix (never the secret), best-effort (a log failure never affects the response) — covers all external endpoints (pricing, quotes, convert, void, availability, purchase-orders) at once. (bc-ai-agent local commit 4320ba3.)

- [WONTFIX-v1] TD-QOC-A9 · phase_quote_order_conversion · Migration 0018 not CONCURRENTLY-safe
  - Decision 2026-05-22: accepted for v1. 0018 is already applied; rewriting an applied migration achieves nothing, and `CREATE INDEX CONCURRENTLY` can't run inside a transaction (our migration runner wraps each file in BEGIN/COMMIT). The brief ACCESS EXCLUSIVE lock only matters on a hot, large `quotes` table — Elevated Doors' single-branch pilot is nowhere near that. Documented as the pattern to use for any FUTURE index on a large table; no change to the existing migration.

- [CLOSED] TD-QOC-A10 · phase_quote_order_conversion · Live happy-path test now queries the `quotes` row directly
  - Closed 2026-05-20. Added a `pool.query` after the response assertion reading `supplier_order_ref`, `supplier_order_id`, `ordered_at` straight from the `quotes` row, so a regression that keeps the response shape but drops the write would be caught.

### Widget integration follow-ups (WI) — phase 22

- [CLOSED] TD-WI-01 · phase_widget_integration · Auto-SKU resolution for door-designer leads
  - Closed 2026-05-22 (cross-repo). BC AI Agent: `POST /api/external/door-config/resolve-parts` maps the widget's config (familyId/colorId/designId/widthInches…) onto `get_parts_for_door_config` and returns `[{ sku, quantity, description, category }]` (3 pytest). Service.AI: `SupplierProvider.resolveDoorConfig` (Mock + BcAiAgent), and the public widget intake now best-effort resolves the config → SKUs and **seeds them as (unpriced) draft quote lines** so a manager opens a pre-populated quote and just hits price (the `/quotes/:id/price` flow recomputes with the margin engine). Falls back to notes-only when resolve fails. Response carries `partsResolved`. Test asserts 2 seeded lines. (Left intentionally unpriced at intake rather than replicating the full margin pipeline in the public path — the draft is priced in one click.)

- [CLOSED] TD-WI-02 · phase_widget_integration · In-app design image now stored
  - Closed 2026-05-22. Threaded `objectStore` into `QuoteRoutesDeps`; `/quotes/:id/design-config` now best-effort stores the door image under `quote-designs/<quoteId>.png` (reusing `storeDoorImage`) and stamps the key on the notes — same as the public widget path. Test asserts the `Image: quote-designs/...` line.

- [CLOSED] TD-WI-03 · phase_widget_integration · Widget lead dedupe by (email, config)
  - Closed 2026-05-22. The public widget intake now de-dupes a double-submit: if the matched customer already has an open `draft` lead with the same `Config: <json>` from the last 10 minutes, it returns that quote (`deduped: true`) instead of spawning a second draft. Test posts the same email+config twice and asserts one draft + same quoteId.

### CRM follow-ups (CRM) — phase 23

- [WONTFIX-v1] TD-CRM-01 · phase_crm · External BC metrics overlay on the Customer 360
  - Decision 2026-05-22: conceptual mismatch with the corporate-hub model. `bc_metrics_service.get_customer_metrics(customer_number)` is keyed by a **BC customer = a dealer/account** (in the OPENDC portal, "customers" are BC dealer accounts). In Service.AI, `customers` are **homeowners (end consumers)** and the single BC account is the SUPPLIER (Elevated Doors). So "sales YTD / credit limit / on-time % for this customer" has no per-homeowner meaning — those numbers describe the whole Elevated Doors↔BC relationship. The right home for that data is a future **corporate supplier-account dashboard** (one card for the Elevated Doors BC account: YTD vs PY, open orders, recent shipments), not the homeowner 360. Filed as that future feature; the per-homeowner overlay this TD described is intentionally not built. (Service.AI's own per-homeowner 360 metrics — lifetime revenue, jobs/quotes, recency — already shipped in CRM-03.)

- [CLOSED] TD-CRM-02 · phase_crm · Payments are a distinct timeline stream
  - Closed 2026-05-22. The 360 timeline UNION gained `payments` (positive) + `refunds` (negative) arms (joined to invoices by customer), surfaced as `kind='payment'` with subtype payment/refund. Web `CustomerActivity` got a "Payments" filter + teal badge. Test seeds a payment + refund and asserts the `payment` kind + count.

- [CLOSED] TD-CRM-03 · phase_crm · Per-caller ingest keys + rate limit
  - Closed 2026-05-22. `CRM_INGEST_KEYS` ("donna:k1,ai_csr:k2") gives each caller its own key (for attribution + independent rotation); `resolveIngestCaller` matches it (or the single `CRM_INGEST_KEY` as the "default" caller), logs the resolved caller, and rejects unknown keys 401. The ingest route now has its own rate-limit bucket (120/min). Tests cover single-key, wrong-key, and per-caller-key paths. (A full bcrypt-hashed mint UI like SQB external-keys is heavier than warranted for two internal callers.)

- [CLOSED] TD-CRM-04 · phase_crm · Phone match normalized (last-10-digit)
  - Closed 2026-05-22. Ingest phone matching now compares the last 10 digits of both sides via `right(regexp_replace(phone,'\D','','g'),10)`, so `+1`, dashes, parens and spaces no longer cause a miss (NANP). No new column needed — normalized in SQL. Test ingests a `+1 (xxx) xxx-xxxx` number and matches a customer stored as plain digits. (Near-match triage UI remains a future nicety, not required.)

### Inventory follow-ups (INV) — phase 24

- [CLOSED] TD-INV-01 · phase_inventory · BC supplier-availability overlay
  - Closed 2026-05-21 (phase 26, BCB). `SupplierProvider.checkAvailability` + BC AI Agent `POST /api/external/check-availability` (wraps `bc_inventory_service.check_availability`) + Service.AI `POST /api/v1/inventory/check-availability` + a "Check supplier stock" affordance on the PO form. Live BC path unvalidated (mocked tests). Ref: `docs/api/bc-purchasing-bridge.md`.

- [CLOSED] TD-INV-02 · phase_inventory · Auto-reserve stock on quote accept
  - Closed 2026-05-22. `reserveInventoryForQuote` (in `inventory-consume.ts`) runs inside `ensureJobForAcceptedQuote`: for each accepted-quote line matching an active stocked item, bumps `qty_reserved` + writes a zero-delta `reserve` movement (idempotent on the quote). `consumeInventoryForJob` now releases the reservation (decrements `qty_reserved` + a zero-delta `release` movement) before consuming on-hand. So `available = on_hand − reserved` and low-stock are truthful for in-flight work. Test: accept reserves 1, completion releases + consumes (reserved→0, on_hand 10→9).

- [CLOSED] TD-INV-03 · phase_inventory · Branch-to-branch transfers
  - Closed 2026-05-22. `POST /api/v1/inventory/transfer` (corporate-only — it writes two branches' rows) `{ fromItemId, toBranchId, quantity, note? }`: decrements the source + `transfer_out` movement, upserts the dest item by (toBranch, sku) + `transfer_in` movement, one tx; 403 for branch roles, 422 on insufficient on-hand, 400 same-branch. (Bin sub-locations remain a future nicety — the `bin` free-text label suffices for v1.)

- [CLOSED] TD-INV-04 · phase_inventory · Inventory valuation rollup
  - Closed 2026-05-22. `GET /api/v1/inventory/valuation` returns `{ totalValueCents, byCategory:[{ category, items, onHandValueCents }] }` summing `qty_on_hand * unit_cost_cents` over active items, branch-scoped. Test asserts the per-category rollup. (Moving-average COGS-from-consumption is a deeper accounting feature, not needed for v1.)

### Purchase order follow-ups (PO) — phase 25

- [CLOSED] TD-PO-01 · phase_purchase_orders · Send the PO to the supplier / BC
  - Closed 2026-05-21 (phase 26, BCB). `SupplierProvider.createPurchaseOrder` (idempotent on externalPoId) + BC AI Agent `POST /api/external/purchase-orders` (wraps create_purchase_order + add_purchase_order_line, idempotency via `external_purchase_orders` table) + Service.AI `submit` best-effort push that stamps `supplier_po_ref`/`bc_synced_at`. Live BC path unvalidated (mocked tests). Ref: `docs/api/bc-purchasing-bridge.md`.

### BC purchasing bridge follow-ups (BCB) — phase 26

- [CLOSED] TD-BCB-01 · phase_bc_purchasing_bridge · Quote-builder availability badge
  - Closed 2026-05-21. `quotes/new/page.tsx` now resolves the corporate's default supplier via `GET /api/v1/suppliers` (first row) and passes `supplierId` into the builder — which also un-stubs the previously-deferred draft-quote creation. QuoteBuilder gained a "Check supplier stock" button + a supplier-stock panel showing per-SKU available/partial/unavailable from `/api/v1/inventory/check-availability`.

- [CLOSED] TD-BCB-02 · phase_bc_purchasing_bridge · No PO BC-resync endpoint
  - Closed 2026-05-21. `POST /api/v1/purchase-orders/:id/sync-bc` (manager+) re-calls `createPurchaseOrder` (idempotent on the PO id), stamps the ref; 409 on draft/canceled, idempotent no-op when already synced. A "Sync to BC" button shows on the PO detail when post-draft + unsynced. 2 tests.

- [CLOSED] TD-BCB-03 · phase_bc_purchasing_bridge · bc-ai-agent alembic has 3 heads
  - Closed 2026-05-21. Added no-op merge revision `d4e5f6a7b8c9` (down_revision = the 3 heads: `b1c2d3e4f5a6`, `c7d8e9f0a1b2`, `m7n8o9p0q1r2`) so `alembic upgrade head` resolves to a single head. No schema change. (bc-ai-agent local commit.)

- [WONTFIX-v1] TD-PO-02 · phase_purchase_orders · No demand-signal acknowledge workflow
  - Decision 2026-05-22: deliberately not built. The live `GET /inventory/low-stock` report + `POST /purchase-orders/from-low-stock` already give the manager the full review-then-order loop (they see what's low and choose to draft a PO, which they then review/edit before submit). A persisted demand-signal table with severity + ack/snooze (BC AI Agent's pattern) adds a table + UI for marginal value on a single-branch pilot. Reopen if a manager wants to snooze/track suggestions over time across many branches.

- [CLOSED] TD-PO-03 · phase_purchase_orders · Over-receipt flag + draft-line edits
  - Closed 2026-05-22. Receiving accepts an `allowOver: true` flag to receive beyond the ordered quantity (real over-shipments); without it the 422 guard stands. `PATCH /api/v1/purchase-orders/:id/lines` replaces lines on a DRAFT PO (recomputes subtotal); 409 once submitted. 2 tests. (Vendor-invoice / 3-way AP match is a separate finance feature, intentionally out of scope for v1.)
