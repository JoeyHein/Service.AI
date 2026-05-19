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

## phase_foundation

- [LOW] TD-FND-01 · phase_foundation · Next.js ESLint plugin not wired
  - What: `apps/web` uses `next lint` but `eslint-config-next` is not installed; Next.js-specific rules (no-html-link-for-pages, no-sync-scripts, etc.) are not enforced. Build emits "The Next.js plugin was not detected in your ESLint configuration."
  - Where: `apps/web/package.json`, root `eslint.config.js`
  - Why deferred: Flat config + `eslint-config-next` has a version compatibility gap that needs testing. Fix during the next phase that touches the web app. Add `eslint-config-next` to `apps/web/devDependencies` and create `apps/web/eslint.config.js` extending `next/core-web-vitals`. See H-FND-01 in `docs/LESSONS.md`.

- [LOW] TD-FND-02 · phase_foundation · W1: Web structure test passes on comment text
  - What: `apps/web/src/__tests__/structure.test.ts` has a test named "references the GET /api/v1/health endpoint" that passes because `page.tsx` contains the string `api/v1/health` in a JSDoc comment, not in executable code. The actual network call is to `POST /api/v1/echo`.
  - Where: `apps/web/src/__tests__/structure.test.ts:164-172`
  - Why deferred: Deliberate architectural trade-off — the ts-rest echo call is the contract-enforcement mechanism. The test name is misleading but fixing it requires either adding a real health poll or renaming the test to describe what it actually asserts.

- [LOW] TD-FND-03 · phase_foundation · W6: ARCHITECTURE.md lacks explicit package dependency graph
  - What: `docs/ARCHITECTURE.md` implies the dependency graph through a directory tree but does not render it explicitly. Gate criterion asked for an "explicit dependency graph."
  - Where: `docs/ARCHITECTURE.md` Section 2
  - Why deferred: Information is present implicitly; the gap is presentational. Add a dedicated ASCII or Mermaid graph in the next architecture-touching phase.

---

## phase_corporate_hub_redesign

- [MED] TD-CHR-01 · phase_corporate_hub_redesign · Legacy `franchisees`/`franchisors` SQL in live tests
  - What: 15+ live tests still issue raw SQL against the dropped `franchisees` / `franchisors` tables (e.g. `INSERT INTO franchisees`, `UPDATE franchisees`, `SELECT … FROM franchisees`). They are auto-skipped today because `DATABASE_URL` is unreachable in CI, so `pnpm -r test` passes — but every one of them will error with "relation does not exist" the moment a real DB is wired.
  - Where: `apps/api/src/__tests__/live-{invites,collections,security-fc,security-cv,security-co,security-ta,security-di,security-ip,security-pb,suggestions,catalog,phone,pricebook,public-invoice,invoice-finalize,invoice-refund,dispatcher-tools,tech-assistant,csr-tools,seed,rag,voice-e2e,assignment,customers,audit-log,audit-filters,dashboard}.test.ts`
  - Why deferred: Rewriting every test to use `branches` instead of `franchisees` is a multi-day sweep that should happen alongside CI live-DB wiring. The new canonical `live-security-corporate.test.ts` covers the same ground.
  - Resolution: Either delete the franchise-era tests (their CHR-equivalents exist) or rewrite them to use `branches` and the new role enum. Track per file.

- [MED] TD-CHR-02 · phase_corporate_hub_redesign · `STRIPE_NOT_READY` + `applicationFeeAmount === 60` assertions outdated
  - What: `live-invoice-finalize.test.ts:191` asserts `applicationFeeAmount === 60` (Connect 5% fee) — the new corporate-hub finalize handler never stamps that field. `live-invoice-finalize.test.ts:221` and `live-security-ip.test.ts:319` assert a `409 STRIPE_NOT_READY` error code that the CHR-08 single-Stripe-account flow no longer returns. Auto-skipped today; will fail when live DB lands.
  - Where: `apps/api/src/__tests__/live-invoice-finalize.test.ts`, `apps/api/src/__tests__/live-security-ip.test.ts`
  - Resolution: Drop the fee assertion. Remove the `STRIPE_NOT_READY` test entirely or rewrite to assert the new behaviour (any branch with the corporate Stripe key configured is "ready").

- [LOW] TD-CHR-03 · phase_corporate_hub_redesign · `seed.demo.ts` still computes a fake 2.9% application fee
  - What: Demo seed at `apps/api/src/seed/demo.ts:349` populates `payments.applicationFeeAmount = round(total * 0.029)` — a franchise-era leftover. The new corporate model leaves the column at zero. Doesn't break anything, just produces misleading demo numbers.
  - Where: `apps/api/src/seed/demo.ts:349`
  - Resolution: Drop the line; let the schema default of `'0'` apply.

- [LOW] TD-CHR-04 · phase_corporate_hub_redesign · `TODO(CHR-06)` markers left after CHR-06 shipped
  - What: `apps/api/src/{phone-routes,pricebook-routes,catalog-routes,invites,auth-mount}.ts` carry `TODO(CHR-06)` / `TODO(CHR-06 follow-up)` markers for route path renames + body field renames that CHR-06 did not, in the end, perform (the path `/api/v1/franchisees/:id/phone/*` is still live; `catalog` is still per-template, no per-corporate-catalog table; `invites` still accepts the existing body shape, which is already correct). Markers are stale.
  - Where: `apps/api/src/phone-routes.ts:{57,63,150,198}`, `apps/api/src/pricebook-routes.ts:79`, `apps/api/src/catalog-routes.ts:129`, `apps/api/src/invites.ts:51`, `apps/api/src/auth-mount.ts:86`
  - Resolution: Either do the rename (medium-touch — phone/pricebook routes become `/api/v1/corporate/branches/:id/{phone,pricebook}`, with web callers + tests updated) or drop the TODOs. Public route surface change should be coordinated with `.do/app.yaml` health probes if any.

- [LOW] TD-CHR-05 · phase_corporate_hub_redesign · Web `MeResponse.impersonating` + accept-invite scope types still franchise-shaped
  - What: `apps/web/src/lib/session.ts` declares `impersonating: ImpersonatingContext | null` on `MeResponse`; the API always returns `null` (impersonation gone in CHR-02). `apps/web/src/app/(auth)/accept-invite/[token]/page.tsx:9` declares `scopeType: 'franchisor' | 'franchisee' | 'location'` — the API actually returns `'corporate' | 'branch'`. Neither field is consumed in a way that causes runtime breakage today.
  - Where: `apps/web/src/lib/session.ts:17-30`, `apps/web/src/app/(auth)/accept-invite/[token]/page.tsx:9`
  - Resolution: Drop `impersonating` from the type, rename `scopeType` enum, audit downstream usages.

- [LOW] TD-CHR-06 · phase_corporate_hub_redesign · Misleading comments + index name reference `franchisee`
  - What: Various inline comments still say "franchisee" instead of "branch" — `assignment-routes.ts:86-89`, `jobs-routes.ts:96`, `owner-dashboard.ts:164`, `customers-routes.ts:13`, `app.ts:319`, `assignment-routes.ts:81` (`scopedFranchiseeId` helper name), `live-public-invoice.test.ts:171` (`franchiseeName` interface field) and one Drizzle index in `schema.ts:986` still named `ai_metrics_franchisee_date_unique`. None affect runtime; all are cosmetic.
  - Where: see file list above
  - Resolution: Search-and-replace pass when next touching these files. The DB index name doesn't need to match Drizzle's accessor name; rename it in the next schema-touching migration if desired.

- [LOW] TD-CHR-07 · phase_corporate_hub_redesign · `applicationFeeAmount` column on `invoices` + `payments` still in schema
  - What: CHR-08 was code-only; the `application_fee_amount` columns on `invoices` and `payments` remain in the DB schema (per intentional comments in `packages/db/src/schema.ts`). The column always stays at zero in the corporate-hub model. Leaving it is correct for now (a column drop is destructive); flagged so a future cleanup migration can take care of it.
  - Where: `packages/db/src/schema.ts:613`, `packages/db/src/schema.ts:704`
  - Resolution: Optional migration after one prod cycle confirms no reads depend on the column.

- [LOW] TD-CHR-08 · phase_corporate_hub_redesign · `dispatch-ui-structure.test.ts` references franchisee-scoped gating in a passing assertion
  - What: `apps/web/src/__tests__/dispatch-ui-structure.test.ts:20` describes the test as "page gates to franchisee-scoped callers via notFound()" but actually asserts `scope?.type !== 'branch'` (correct under CHR). Test name is stale; assertion is correct.
  - Where: `apps/web/src/__tests__/dispatch-ui-structure.test.ts:20`
  - Resolution: Rename the `it()` describe string in a one-line change.

- [LOW] TD-CHR-09 · phase_corporate_hub_redesign · `live-security-corporate.test.ts` uses legacy `/api/v1/franchisees` route in CHR-era asserts
  - What: The CHR-canonical security test (live-security-corporate.test.ts) checks that `GET /api/v1/franchisees` returns the expected branch list for each role — but the canonical route under CHR-06 is `/api/v1/corporate/branches`. The legacy `/api/v1/franchisees` route presumably still serves the same payload via a shim; tests should switch to the canonical path so coverage tracks the surface that's actually documented in `corporate-routes.ts`.
  - Where: `apps/api/src/__tests__/live-security-corporate.test.ts:152-265`
  - Resolution: Update the tests to hit `/api/v1/corporate/branches` once a legacy-shim removal is planned.

## phase_supplier_quote_bridge

Items deferred (explicit out-of-scope per the SQB gate) — parked for follow-up phases. Each is LOW priority and was visible to the gate author at planning time, not introduced by audit findings.

- [LOW] TD-SQB-P1 · phase_supplier_quote_bridge · Multi-supplier per branch (UI)
  - What: The `suppliers` table is many-rows-per-corporate by design, but the v1 UI assumes one default supplier per corporate. `/quotes/new` does not render a supplier picker; `BcAiAgentProvider` is implicitly the only resolved provider. Works as long as Elevated Doors stays single-supplier.
  - Where: `apps/web/src/app/(app)/quotes/new/`, `apps/api/src/quote-routes.ts` (supplier resolution)
  - Resolution: Add `?supplierId=` URL param + a picker in the line item header when a second supplier is provisioned. Update the AI CSR tools to take an optional `supplierId` arg. Wait until a second supplier is real — premature picker UX would just clutter the live-quote surface.

- [LOW] TD-SQB-P2 · phase_supplier_quote_bridge · Quote PDF rendering
  - What: No PDF surface for a committed quote. Service.AI shows the SQ-XXXXXX number with a Copy button, but no downloadable PDF for the customer. Sales calls end with "I'll text you the quote number"; the customer can't see line items or totals on a document.
  - Where: would land at `/api/v1/quotes/:id/pdf` (new) + a Puppeteer or BC AI Agent passthrough renderer.
  - Resolution: Defer to the accept-link follow-up phase (TD-SQB-P4) — PDF + accept link + Stripe deposit collection ship together so the customer flow is coherent.

- [CLOSED] TD-SQB-P3 · phase_supplier_quote_bridge · Quote-to-order conversion → shipped as `phase_quote_order_conversion` (QOC-01..08, commit pending). `SupplierProvider.convertQuoteToOrder` + BC AI Agent's `POST /api/external/quotes/:id/convert-to-order` endpoint + `/accept` route wiring + UI badge all live. Closed 2026-05-18.

- [LOW] TD-SQB-P4 · phase_supplier_quote_bridge · Customer-facing accept link
  - What: No signed-URL surface lets a homeowner accept a committed quote without logging in. Today acceptance is recorded by a CSR / tech on the customer's verbal yes.
  - Where: new public route under `/public/quotes/:token/accept`, mirroring `public-invoice-routes.ts`.
  - Resolution: Ship together with PDF rendering (TD-SQB-P2) + Stripe deposit collection. Reuses the public-token-with-CSRF pattern proven for public invoices.

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

- [LOW] TD-SQB-A1 · phase_supplier_quote_bridge · `accepted → void` is in the matrix but not in the gate's allowed-transition list
  - What: `quote-status-machine.ts:32` permits `accepted → void`; the gate's allowed list does not. Implementation is stricter-than-spec in the safe direction (refunds-after-acceptance are a legitimate path), but the divergence is undocumented.
  - Where: `apps/api/src/quote-status-machine.ts`, `phases/phase_supplier_quote_bridge_GATE.md`
  - Resolution: Either add a JSDoc comment explaining the extension, or amend the gate text in a doc-only follow-up to reflect the legitimate refund path.

- [LOW] TD-SQB-A2 · phase_supplier_quote_bridge · Commission ledger row skipped silently when a `corporate_admin` commits
  - What: `quote-routes.ts::/commit` guards `onQuoteCommitted` behind `scope.type === 'branch'`. A corporate_admin acting on behalf of a branch closes a sale but the manager's comp plan does not credit.
  - Where: `apps/api/src/quote-routes.ts` (commit handler, scope.type === 'branch' check)
  - Resolution: Drop the scope-type guard; `findActivePlan` keys on user, not scope. If "no commission when corporate commits" is intended, pin it with a unit test and document the rationale.

- [LOW] TD-SQB-A3 · phase_supplier_quote_bridge · Quote-routes Zod schemas are non-`.strict()`
  - What: `CreateQuoteSchema`, `LineItemSchema`, `PriceQuoteSchema`, `CommitQuoteSchema`, `VoidQuoteSchema`, `AcceptQuoteSchema` in `quote-routes.ts` do not call `.strict()`. The cost-forgery test passes today because the route doesn't read unknown fields, but a future contributor adding `unitCostCents` to `LineItemSchema` for a legit reason re-opens cost-forgery silently. `margin-routes.ts` uses `.strict()` — convention exists.
  - Where: `apps/api/src/quote-routes.ts:69-100`
  - Resolution: Add `.strict()` to all six schemas. Update the cost-forgery test to assert a 400 VALIDATION_ERROR when a body smuggles `unitCostCents`.

- [LOW] TD-SQB-A4 · phase_supplier_quote_bridge · Provider error → HTTP status mapping duplicated between price and commit handlers
  - What: Identical switch arms in `quote-routes.ts::/price` (lines 286-296) and `/commit` (lines 829-841). New error codes added to `SupplierError['code']` will be silently 502'd unless both arms are updated.
  - Where: `apps/api/src/quote-routes.ts`
  - Resolution: Extract `function providerErrorStatus(code: SupplierError['code']): number` (in `quote-routes.ts` or `packages/suppliers`) and call from both handlers.

- [MED] TD-SQB-A5 · phase_supplier_quote_bridge · Commission preview uses hardcoded 4% placeholder
  - What: `apps/web/src/app/(app)/quotes/new/QuoteBuilder.tsx:340-348` computes `commissionCents = Math.round(totals.totalCents * 0.04)` with an inline TODO. The gate explicitly required the preview to "read the active comp plan via computeCommissionPreview(quoteId, userId)". Manager sees a wrong commission preview.
  - Where: `apps/web/src/app/(app)/quotes/new/QuoteBuilder.tsx`, new `apps/api/src/commission-preview-route.ts` (or fold into `/price` response).
  - Resolution: Add `GET /api/v1/quotes/:id/commission-preview` returning `{ percent, cents }` from `findActivePlan` + the matching `flat_percent_of_quote_committed` rule. Call from `QuoteBuilder.tsx`. Could fold into the `/price` response as `data.commissionPreview` to skip a round trip.

- [LOW] TD-SQB-A6 · phase_supplier_quote_bridge · `accepted → void` reversal logic was unreachable; now reachable after M2
  - What: `quote-routes.ts:909-911` `if (from === 'committed' || from === 'accepted')` was dead-code on the `accepted` branch because no route set `status='accepted'`. After M2 (the new `/accept` route), the branch is now reachable but no test exercises it.
  - Where: `apps/api/src/__tests__/sqb-12-commission-reversal.test.ts` (add case), `apps/api/src/quote-routes.ts`
  - Resolution: Add a sqb-12 test case that accepts a committed quote then voids and asserts the balancing commission ledger row is written.

- [LOW] TD-SQB-A7 · phase_supplier_quote_bridge · Pino redact bracket-keyed glob may miss deeply-nested API key
  - What: `apps/api/src/logger.ts:64` uses `*["x-service-ai-key"]` (single-star, depth-1). CLAUDE.md claims "five shapes" of redaction; a deeply-nested `{ supplier: { config: { 'x-service-ai-key': ... } } }` would leak. Low likelihood (production logs don't usually nest the header that deep).
  - Where: `apps/api/src/logger.ts:51-67`
  - Resolution: Either switch the glob to `**["x-service-ai-key"]` (recursive), or add explicit `**.xServiceAiKey` and `**.apiKey` variants. Verify against the SQB-11 redaction test.

- [MED] TD-SQB-A8 · phase_supplier_quote_bridge · `provider.voidQuote` is wired but BC AI Agent does not expose the endpoint
  - What: `packages/suppliers/src/bc-ai-agent-provider.ts:228-237` returns `UPSTREAM_ERROR` for `voidQuote`; `quote-routes.ts` swallows the error best-effort. Result: voiding a committed Service.AI quote leaves the BC SQ-XXXXXX alive in BC. Local + BC state drift on every void of a committed quote.
  - Where: bc-ai-agent's `external_quotes` API + `bc_quote_service` (add `void_sales_quote` op), then `packages/suppliers/src/bc-ai-agent-provider.ts::voidQuote`.
  - Resolution: Either (a) push BC-side `/api/external/quotes/:id/void` into BC AI Agent and wire `BcAiAgentProvider.voidQuote` to it (best fix; gate doesn't strictly require it since voidQuote is best-effort), or (b) add a void-followup queue and an operator runbook to manually void the BC quote via the OPENDC portal. Recommend (a).

## phase_quote_order_conversion

### Audit-1 follow-ups (deferred from MAJOR fixes — see phase_quote_order_conversion_AUDIT_1.md)

- [LOW] TD-QOC-A1 · phase_quote_order_conversion · 10× concurrent convert-to-order stress test
  - What: The QOC audit M1 was closed by a 12-case pytest file (`test_external_quote_convert_to_order.py`) that covers single-threaded happy path + replay + cross-key + status-invariant + BC-failure modes. The gate's stretch goal was a 10× concurrent stress test asserting "exactly one BC `convert_quote_to_order` call across all 10 racers." The single-process test exists; the concurrency test does not.
  - Where: `bc-ai-agent/backend/tests/test_external_quote_convert_to_order.py` (add a `TestConcurrency` class), mirror `test_external_quote_commit.py`'s pattern.
  - Resolution: Add a `threading`-based test that spawns 10 threads calling the endpoint with the same `external_quote_id` and asserts `fake_bc.convert_calls` length ≤ 1 (or exactly 1 if the lock holds across threads in the test environment). Useful once BC AI Agent runs in production with gunicorn workers.

- [LOW] TD-QOC-A2 · phase_quote_order_conversion · `audit_log` insert assertion in live test
  - What: The QOC audit M3 wired a `quote.accept` audit_log row into the /accept handler's tx, but the existing live test (`live-quote-routes.test.ts::accept happy path`) does not directly assert the row landed. The persisted state (status='accepted', supplierOrderRef populated) IS asserted, which exercises the same code path; but a future refactor that drops the audit_log insert silently would not be caught by the existing test.
  - Where: `apps/api/src/__tests__/live-quote-routes.test.ts::quote routes — accept + quote-to-order conversion`
  - Resolution: Add a `SELECT * FROM audit_log WHERE action = 'quote.accept' AND metadata->>'quoteId' = $1` query after the happy-path accept call; assert exactly one row exists with the expected actor + metadata.

### Audit-1 minors (deferred — see phase_quote_order_conversion_AUDIT_1.md)

- [LOW] TD-QOC-A3 · phase_quote_order_conversion · Lock-map release race (inherited from SQB)
  - What: `external_order_conversion_service.py:171-179` reuses `_release_lock` from `external_quote_service.py`, which pops the per-id lock from the global `_locks` dict on every release — creating a window where a concurrent caller can acquire a stale lock that no longer guards the same row. BC's `makeOrder` is idempotent on the quote id so the blast radius is at most one extra BC HTTP call.
  - Where: `bc-ai-agent/backend/app/services/external_quote_service.py:87-89` (`_release_lock` definition), `external_order_conversion_service.py:178` (caller).
  - Resolution: Either (a) move lock map cleanup to a process-lifecycle hook (or just leak — UUID keys, conversion is once-per-quote), or (b) replace the in-process lock with a Postgres advisory lock keyed on `hashtext(external_quote_id)` so cross-worker concurrency is handled correctly.

- [LOW] TD-QOC-A4 · phase_quote_order_conversion · `quote_status_log` self-loop row on order conversion
  - What: On a successful supplier conversion, `quote-routes.ts::/accept` writes a `quote_status_log` row with `fromStatus='accepted', toStatus='accepted', reason='order_converted'`. The status didn't actually change; the log table is being used as an event log here. A downstream consumer assuming `fromStatus !== toStatus` would see surprising data.
  - Where: `apps/api/src/quote-routes.ts` (accept handler, ~line 991)
  - Resolution: Move the order_converted event into `audit_log` (consistent with the M3 fix's audit_log row pattern) and drop the self-loop status-log row.

- [LOW] TD-QOC-A5 · phase_quote_order_conversion · `db.select().from(suppliers)` outside `withScope` in the new convert call path
  - What: After the local accept tx commits, the convert path reads the suppliers row with `db.select().from(suppliers)` — no `withScope` wrapper. The suppliers table is corporate-only with `_scoped USING (false)`, so the read is safe (corporate_admin or RLS-bypassing builder); but the pattern diverges from the codebase's "every tenant-scoped read goes through `withScope`" convention.
  - Where: `apps/api/src/quote-routes.ts` (accept handler, supplier lookup ~line 950)
  - Resolution: Wrap the suppliers read in `withScope` for consistency, even though the table's RLS happens to permit raw reads from any scope today.

- [LOW] TD-QOC-A6 · phase_quote_order_conversion · BC AI Agent convert endpoint accepts any content-type
  - What: The new `POST /api/external/quotes/:id/convert-to-order` endpoint has no request body (the operation is keyed entirely on the path param). FastAPI accepts any content-type for empty-body POSTs; a future regression that adds a body would not detect mismatched content-types.
  - Where: `bc-ai-agent/backend/app/api/external_quotes.py::convert_to_order`
  - Resolution: Either explicitly accept `None` body type with `Body(None)`, or add a request-body model that validates `{}` strictly. Low priority; tighten when body fields are added.

- [LOW] TD-QOC-A7 · phase_quote_order_conversion · `convertQuoteToOrder` provider call doesn't pass `Idempotency-Key` header
  - What: The Service.AI provider's `BcAiAgentProvider.convertQuoteToOrder` does not send an HTTP `Idempotency-Key` header. Idempotency is enforced via the URL path's `external_quote_id` instead, which is sufficient for the BC AI Agent endpoint's contract. But the header convention would be useful for nginx/reverse-proxy debugging and for any future generic-replay middleware.
  - Where: `packages/suppliers/src/bc-ai-agent-provider.ts::convertQuoteToOrder`
  - Resolution: Add `Idempotency-Key: ${externalQuoteId}` to the request headers. Cosmetic but consistent.

- [LOW] TD-QOC-A8 · phase_quote_order_conversion · `external_call_log` not implemented (inherited from SQB)
  - What: The SQB gate called for an `external_call_log` table that records every external API call (key_id, latency, status). It was never implemented in SQB; QOC's convert endpoint inherits the gap.
  - Where: bc-ai-agent's `external_quotes.py`, `external_pricing.py`, new `external_quotes/convert-to-order` (all three lack the call log).
  - Resolution: Add an `external_call_log` table + a small wrapper that records every external call. One follow-up phase that covers all three endpoints. Useful for billing / rate limiting / debug.

- [LOW] TD-QOC-A9 · phase_quote_order_conversion · Migration 0018 not transactional-DDL-safe under CONCURRENTLY
  - What: `0018_quote_order_conversion.sql` uses plain `ALTER TABLE` + `CREATE UNIQUE INDEX`. Postgres holds an ACCESS EXCLUSIVE lock on `quotes` for the duration of the ALTER. On a hot table at scale this would briefly block all writes. v1 tables are small so this is a non-issue; flagged for awareness.
  - Where: `packages/db/migrations/0018_quote_order_conversion.sql`
  - Resolution: For large-table cases, switch to `ALTER TABLE ... ADD COLUMN <name> <type> NULL` (cheap) + `CREATE UNIQUE INDEX CONCURRENTLY` (no exclusive lock). Not yet needed.

- [LOW] TD-QOC-A10 · phase_quote_order_conversion · Live happy-path test doesn't directly query the `quotes` row
  - What: `live-quote-routes.test.ts::accept happy path` asserts the route's response body but doesn't issue a SELECT to confirm the columns persisted on the `quotes` row. The response is built from `loadQuoteDetail` which IS a `SELECT *`, so the assertion does exercise the persistence — but a future regression that omits the write but somehow keeps the response shape (e.g., projected from in-memory state) wouldn't be caught.
  - Where: `apps/api/src/__tests__/live-quote-routes.test.ts::happy path: accept stamps SO-XXXXXX...`
  - Resolution: Add a direct `pool.query(...)` after the response assertion to read `supplier_order_ref`, `supplier_order_id`, `ordered_at` from the row.
