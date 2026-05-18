# Supplier quote bridge (SQB)

The bridge that lets a branch CSR or tech build a live quote against a
real supplier price feed and commit it as a single click. First
provider: **BC AI Agent**, talking to OPENDC's Microsoft Business
Central tenant under the Elevated Doors customer account.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Service.AI (this repo)                                         │
│                                                                 │
│   apps/web                                                      │
│     /quotes/new                  /tech/jobs/:id/quote/new       │
│     QuoteBuilder.tsx             MobileQuoteBuilder.tsx         │
│                                                                 │
│   apps/api                                                      │
│     quote-routes.ts ─ resolveSellingPrice (margin engine)       │
│                     └ onQuoteCommitted   (commission engine)    │
│                                                                 │
│   packages/suppliers — SupplierProvider interface               │
│     ├── MockSupplierProvider   (tests)                          │
│     └── BcAiAgentProvider      (production)                     │
└─────────────────────────────────────────────────────────────────┘
                          │ HTTPS
                          │ X-Service-AI-Key
                          │ X-Request-ID
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  BC AI Agent (bc-ai-agent repo)                                 │
│                                                                 │
│   /api/external/price-items                                     │
│   /api/external/quotes                                          │
│   /api/external-keys (admin only)                               │
│                                                                 │
│   external_api_keys + external_quote_commits tables             │
│   bcrypt key hash · idempotency on external_quote_id            │
└─────────────────────────────────────────────────────────────────┘
                          │
                          │ OAuth2 (MSAL)
                          ▼
                  Microsoft Business Central
                  (SalesPriceLists, SalesQuotes)
```

## Endpoints

### Service.AI surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/v1/quotes` | branch+ | Create draft |
| POST | `/api/v1/quotes/:id/price` | branch+ | Replace lines + re-price |
| POST | `/api/v1/quotes/:id/commit` | branch+ | Supplier commit + commission write |
| POST | `/api/v1/quotes/:id/void` | branch+ | Void + commission reversal |
| GET | `/api/v1/quotes/:id` | branch+ | Detail + last 10 status_log rows |
| GET | `/api/v1/quotes` | branch+ | List with `branchId` / `customerId` / `jobId` / `status` |
| GET | `/api/v1/corporate/margins` | corporate | Margin policy + overrides |
| PATCH | `/api/v1/corporate/margins/policy` | corporate | Update default/min/max |
| POST | `/api/v1/corporate/margin-overrides` | corporate | Add category override |
| PATCH | `/api/v1/corporate/margin-overrides/:id` | corporate | Update category override |
| DELETE | `/api/v1/corporate/margin-overrides/:id` | corporate | Remove category override |

All endpoints return the standard envelope:
```json
{ "ok": true, "data": {...} }       // 2xx
{ "ok": false, "error": { "code": "...", "message": "...", "details": [...] } }
```

### BC AI Agent surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/external/price-items` | `X-Service-AI-Key` | Resolve BC SalesPriceLists for a basket |
| POST | `/api/external/quotes` | `X-Service-AI-Key` | Idempotent commit, returns SQ-XXXXXX |
| POST | `/api/external-keys` | admin JWT | Mint a new key (plaintext returned ONCE) |
| GET | `/api/external-keys` | admin JWT | List active + revoked keys |
| POST | `/api/external-keys/:id/revoke` | admin JWT | Revoke (idempotent) |
| POST | `/api/external-keys/:id/rotate` | admin JWT | Revoke + mint replacement |

## Sequence — live re-price (debounced keystroke)

```
manager           apps/web              apps/api              packages/         BC AI Agent
                                                              suppliers
   │                 │                     │                     │                 │
   │  type "9x7"     │                     │                     │                 │
   │ ───────────────▶│                     │                     │                 │
   │                 │ debounce 300ms      │                     │                 │
   │                 │ AbortController     │                     │                 │
   │                 │ supersede in-flight │                     │                 │
   │                 │                     │                     │                 │
   │                 │ POST /quotes/:id/price                    │                 │
   │                 │ X-Request-ID: <req.id>                    │                 │
   │                 │────────────────────▶│                     │                 │
   │                 │                     │ withScope(branch)   │                 │
   │                 │                     │ resolveLines(...)   │                 │
   │                 │                     │────────────────────▶│                 │
   │                 │                     │                     │ provider.priceItems(req)
   │                 │                     │                     │ POST /api/external/price-items
   │                 │                     │                     │ X-Service-AI-Key
   │                 │                     │                     │ X-Request-ID
   │                 │                     │                     │────────────────▶│
   │                 │                     │                     │                 │ verify key
   │                 │                     │                     │                 │ resolve customer
   │                 │                     │                     │                 │ → group → all-customers
   │                 │                     │                     │                 │ from SalesPriceLists
   │                 │                     │                     │◀────────────────│ unit_cost_cents per line
   │                 │                     │                     │                 │
   │                 │                     │                     │ apply marginEngine
   │                 │                     │                     │ (line→category→default)
   │                 │                     │                     │ bounds check
   │                 │                     │◀────────────────────│ resolved lines
   │                 │                     │                     │
   │                 │                     │ replace quote_line_items
   │                 │                     │ update totals
   │                 │                     │ status: draft|priced → priced
   │                 │                     │ insert quote_status_log
   │                 │◀────────────────────│ envelope
   │                 │                     │                     │                 │
   │ totals update   │                     │                     │                 │
   │ live in UI      │                     │                     │                 │
```

Latency budget (p95):

| Hop | Budget |
|---|---|
| `priceItems` Service.AI → BC AI Agent → BC → back | **< 1.0 s** |
| `commitQuote` end-to-end | **< 2.5 s** |
| BC AI Agent boundary alone (SQB-04) | **< 600 ms** |

## Sequence — commit (with idempotency)

```
manager           apps/web            apps/api          BcAiAgentProvider     BC AI Agent
   │                 │                   │                    │                 │
   │ click "Send"    │                   │                    │                 │
   │ ───────────────▶│                   │                    │                 │
   │                 │ POST /quotes/:id/commit                │                 │
   │                 │ Idempotency-Key: <uuid>                │                 │
   │                 │──────────────────▶│                    │                 │
   │                 │                   │ load lines snapshot│                 │
   │                 │                   │ provider.commitQuote                 │
   │                 │                   │ externalQuoteId    │                 │
   │                 │                   │  = idempotencyKey  │                 │
   │                 │                   │ ◀──────────────────│                 │
   │                 │                   │                    │ POST /api/external/quotes
   │                 │                   │                    │ X-Service-AI-Key│
   │                 │                   │                    │ X-Request-ID    │
   │                 │                   │                    │ ───────────────▶│
   │                 │                   │                    │                 │ verify key
   │                 │                   │                    │                 │ acquire in-process lock
   │                 │                   │                    │                 │ on external_quote_id
   │                 │                   │                    │                 │ INSERT external_quote_commits
   │                 │                   │                    │                 │ status='in_progress'
   │                 │                   │                    │                 │ bc_client.create_sales_quote
   │                 │                   │                    │                 │ bc_client.add_quote_line × N
   │                 │                   │                    │                 │ status='committed'
   │                 │                   │                    │ ◀──────────────│ supplierQuoteRef='SQ-001391'
   │                 │                   │ ◀──────────────────│                 │
   │                 │                   │ stamp quote ref    │                 │
   │                 │                   │ status: priced → committed
   │                 │                   │ insert quote_status_log
   │                 │                   │ onQuoteCommitted(tx, ...)
   │                 │                   │ ⇒ commission_ledger +cents row
   │                 │◀──────────────────│ envelope
   │                 │                   │                    │                 │
   │ SQ-001391 +     │                   │                    │                 │
   │ Copy button     │                   │                    │                 │
```

**Idempotency invariant**: a retried commit with the same
`Idempotency-Key` returns the same `supplierQuoteRef`, never creates a
second BC document. Stress test: 10 concurrent commits collapse to 1
winner + 9 cached replays (per
`bc-ai-agent/backend/tests/test_external_quote_commit.py::TestConcurrency`).

## Sequence — void (with commission reversal)

```
manager           apps/web            apps/api              commission-engine     BcAiAgentProvider
   │                 │                   │                       │                     │
   │ click "Void"    │                   │                       │                     │
   │ ───────────────▶│                   │                       │                     │
   │                 │ POST /quotes/:id/void                     │                     │
   │                 │──────────────────▶│                       │                     │
   │                 │                   │ status: committed →   │                     │
   │                 │                   │   void  (or draft→void etc.)               │
   │                 │                   │ reverseQuoteCommitted │                     │
   │                 │                   │ ─────────────────────▶│                     │
   │                 │                   │                       │ find ledger rows    │
   │                 │                   │                       │ INSERT balancing -X │
   │                 │                   │                       │ source_kind         │
   │                 │                   │                       │   = manual_adjustment
   │                 │                   │                       │ source_id           │
   │                 │                   │                       │   = reverse:quote_committed:<quoteId>
   │                 │                   │ ◀─────────────────────│                     │
   │                 │                   │ best-effort: provider.voidQuote(SQ-XXXXXX)
   │                 │                   │ (failure logged, does not roll back local void)
   │                 │◀──────────────────│ envelope
```

## Margin engine resolution

Per `apps/api/src/margin-engine.ts:resolveSellingPrice`. Three-level
fallback ladder:

```
        ┌─────────────────────────┐
        │ line override?          │ ──► yes ──► use it
        └────────────┬────────────┘
                     │ no
        ┌────────────▼────────────┐
        │ category override       │ ──► yes ──► use it
        │  matching itemCategory? │
        └────────────┬────────────┘
                     │ no
        ┌────────────▼────────────┐
        │ corporate.default_margin_pct ──► use it
        └─────────────────────────┘
                     │
                     ▼
        bounds check against
        corporate.min_margin_pct
        corporate.max_margin_pct
                     │
                     ▼
        unit_price_cents = round(
          unit_cost_cents * (1 + margin/100)
        )
```

Key invariants:

* **Cost is never trusted from the client.** The route re-fetches
  `unit_cost_cents` from the supplier provider on every price call.
  Verified by `live-quote-routes.test.ts::test_cost_forgery`.
* **A line override of 0% wins over the default 60%.** Zero is a
  valid choice ("sell at cost — relationship customer"). Verified by
  `margin-engine.test.ts::line override of 0 still wins over both`.
* **`applied_margin_pct` is frozen at commit.** Editing a category
  override after commit does NOT rewrite the committed quote's
  totals. Verified by the integration test of the same name.
* **Override requires a reason.** `marginOverridePct` without
  `marginOverrideReason` → 422 `OVERRIDE_REASON_REQUIRED`. Manager+
  role required; csr/tech/dispatcher get 403 `OVERRIDE_NOT_PERMITTED`.

## Auth + observability

* **Service.AI side**: branch users see only their branch's quotes
  (RLS + app-layer WHERE). Corporate sees all. Cross-tenant probes
  return 404, never 403.
* **BC AI Agent side**: `X-Service-AI-Key` (bcrypt-hashed,
  plaintext-shown-once) gates every external call. Each key is bound
  to one `supplier_account_code` (BC customer number). Cross-key
  probes return 404 NOT_FOUND.
* **Request-ID propagation**: Service.AI's Fastify request id is
  threaded through `BcAiAgentProvider` as `X-Request-ID`. BC AI
  Agent's `RequestIdMiddleware` echoes it back. One id traces the
  whole chain web → Service.AI → BC AI Agent → BC OData.
* **Pino redact list** (`apps/api/src/logger.ts`) covers
  `X-Service-AI-Key` in five shapes (inbound headers, outbound
  headers, generic apiKey/api_key fields, camelCase, arbitrary
  bracket-keyed parent). Verified by `sqb-11-redaction.test.ts`.
* **Semgrep rules** in `.semgrep.yml` block: raw key in console.log,
  fs writes from supplier code, body-derived branch_id, direct
  fetch to BC AI Agent's external surface from outside
  `packages/suppliers`.

## Idempotency map

| Layer | Key | Backing |
|---|---|---|
| `BcAiAgentProvider.commitQuote` | `externalQuoteId` field | passes through to BC AI Agent |
| `/api/external/quotes` (BC AI Agent) | `external_quote_id` body | `external_quote_commits.external_quote_id` UNIQUE + per-key in-process lock |
| Service.AI `/quotes/:id/commit` | `Idempotency-Key` header → `idempotencyKey` body | request body → BC AI Agent |
| `commission_ledger` | `(user_id, source_kind, source_id)` | DB UNIQUE index |

A 10× concurrent commit with the same key collapses to one BC
document, one `external_quote_commits` row, one `commission_ledger`
row.

## Perf scenarios

See `tests/perf/`:

* `supplier_quote_bridge_live.js` — 20 CSRs, 5-minute scenario
* `supplier_quote_bridge_idempotency.js` — 10 concurrent commits with the same key

Run against staging:

```bash
k6 run \
  -e API_BASE=https://api.staging.service.ai \
  -e SESSION_COOKIE='better-auth.session_token=…' \
  -e BRANCH_ID=… -e SUPPLIER_ID=… -e CUSTOMER_ID=… \
  tests/perf/supplier_quote_bridge_live.js
```

## Related files

* Migration: `packages/db/migrations/0017_supplier_quote_bridge.sql`
* Engine: `apps/api/src/margin-engine.ts`
* State machine: `apps/api/src/quote-status-machine.ts`
* Routes: `apps/api/src/quote-routes.ts`, `apps/api/src/margin-routes.ts`
* Provider: `packages/suppliers/src/bc-ai-agent-provider.ts`
* Web: `apps/web/src/app/(app)/quotes/new/`, `apps/web/src/app/(app)/corporate/settings/margins/`
* Mobile: `apps/web/src/app/tech/jobs/[id]/quote/new/`
* CSR voice tools: `apps/api/src/ai-tools/csr-tools.ts` (`quoteConfigurator`, `commitQuote`)
* BC AI Agent: `backend/app/api/external_pricing.py`, `external_quotes.py`, `external_keys.py`
