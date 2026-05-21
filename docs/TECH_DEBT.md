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

- [MED] TD-QF-01 · phase_quote_fulfillment · `accepted → void` doesn't unwind fulfillment
  - What: Voiding a quote reverses commission (SQB) but, now that QF exists, leaves the downstream artifacts intact: the BC order stays alive (TD-SQB-A8 added the void endpoint but the void route doesn't call it for the order), a paid deposit is neither refunded nor captured-decision'd, and a drafted balance invoice (if the job completed) is not voided. The pilot will hit this the first time a customer cancels after accepting/paying.
  - Where: `apps/api/src/quote-routes.ts::/void`, `balance-invoice.ts`, the deposit PaymentIntent.
  - Resolution: On `accepted → void`: call `provider.voidQuote` (cancel/delete the BC order too if converted), refund the deposit PaymentIntent (Stripe refund), and soft-delete/void any draft balance invoice. Sequence + idempotency need a small design pass. Was explicitly out of scope for QF.

- [LOW] TD-QF-02 · phase_quote_fulfillment · Materials reconciliation on the balance invoice
  - What: The balance invoice bills the accepted quote total as-is. If what was installed differs from what was quoted (substitutions, extra parts), there's no reconciliation step — the office would manually edit the draft invoice.
  - Where: `balance-invoice.ts` + the invoice PATCH flow.
  - Resolution: A reconciliation surface (quoted vs. installed) when materials tracking exists. Fine to defer — the office can edit the draft today.

- [LOW] TD-QF-03 · phase_quote_fulfillment · No office invoice view to link the balance invoice
  - What: QF-06 surfaces a "balance invoice drafted" banner on the completed job, but there's no office-facing invoice detail page to link to (only the public pay page + the tech invoice editor). The office finds the invoice via... no dedicated route.
  - Where: `apps/web/src/app/(app)/` — a new `invoices/[id]` office view.
  - Resolution: Add an office invoice detail/finalize page; link the QF-06 banner to it.

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
