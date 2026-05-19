# Phase Gate: phase_quote_order_conversion

**Written before build begins. Criteria here cannot be loosened mid-phase.**

Phase 16 — closes the loop between Service.AI's quote bridge
and BC's order-fulfilment side. When a CSR or tech records the
customer's acceptance via the SQB `/accept` route, Service.AI
asks the supplier provider to convert the committed BC sales
quote into a BC sales order; the new `SO-XXXXXX` ref + BC GUID
land on the Service.AI quote row. Pure additive on top of SQB —
no schema rewrites, no provider re-architecture.

**Goal (what success looks like):** the homeowner says yes on
the phone. The CSR / tech clicks "Accept" (the SQB-AUDIT M2 fix
added the route + state-machine transition; this phase adds the
UI button and the supplier hop). Within ~1.5 s, the Service.AI
quote shows a "BC order SO-001234 created" confirmation, the
underlying BC sales quote is now an order, and the OPENDC
production / fulfillment team can pick it up out of BC. From the
operator's perspective: one click, one number, one paper trail.

This phase depends on:
- `phase_supplier_quote_bridge` (SQB-01..13) — every reference
  to `external_quote_id` / `external_quote_commits` /
  `BcAiAgentProvider` / `quotes.supplier_quote_ref` assumes the
  SQB schema and the `/accept` route shipped in commit `e2d1c7d`.
- `phase_corporate_hub_redesign` (CHR-01..12) — branch scoping,
  the two-policy RLS template, the corporate role set.

This phase does NOT cover:
- Customer-facing accept link (TD-SQB-P4) — operator-records-
  acceptance only.
- PDF rendering or Stripe deposit collection (TD-SQB-P2).
- Order status sync from BC (delivery / shipped / invoiced
  states). One-way: Service.AI → BC, not BC → Service.AI.
- Linking the BC sales order to a Service.AI invoice. That is a
  separate follow-up; the corporate Stripe flow still invoices
  off the Service.AI job, not off the BC order.

---

## Architectural shape

```
Service.AI branch scope
  └─ quotes (status=accepted)
       │
       │  best-effort, same pattern as void
       ▼
  apps/api/src/quote-routes.ts::/accept
       │  after status update to 'accepted'
       │  provider.convertQuoteToOrder({ externalQuoteId })
       ▼
  packages/suppliers::SupplierProvider.convertQuoteToOrder
       └─ MockSupplierProvider     (tests; returns deterministic SO-XXXXXX)
       └─ BcAiAgentProvider        (production)
                          │  POST /api/external/quotes/{external_quote_id}/convert-to-order
                          │  X-Service-AI-Key, X-Request-ID
                          ▼
            BC AI Agent (bc-ai-agent repo)
                    │
                    │ load external_quote_commits row by external_quote_id
                    │ idempotency: if bc_order_id already set → return cached
                    │ otherwise → bc_client.convert_quote_to_order(bc_quote_id)
                    │ persist bc_order_id + bc_order_ref + converted_at on the same row
                    ▼
            BC: salesQuotes({id}).makeOrder
                 (with manual-fallback per existing client.py)
                          │
                          ▼
            BC sales order SO-XXXXXX (visible to fulfillment)
```

Quote → order is **1:1** in this model. The conversion record
lives on the same `external_quote_commits` row as the commit —
no parallel `external_order_conversions` table. On the
Service.AI side, the order ref lives on the existing `quotes`
row — no parallel `orders` table.

---

## Must Pass (BLOCKERS — any failure rejects the gate)

### Service.AI side — schema

- [ ] Migration `0018_quote_order_conversion.sql` adds three
  columns to `quotes`:
  - `supplier_order_ref` `text` (e.g. `SO-001234`) — null until conversion succeeds.
  - `supplier_order_id` `uuid` — BC's order GUID; null until conversion succeeds.
  - `ordered_at` `timestamptz` — null until conversion succeeds.
- [ ] The migration is reversible (`.down.sql` drops the columns;
  tested via up/down/up roundtrip in
  `packages/db/src/__tests__/qoc-01-migration-roundtrip.test.ts`).
- [ ] No new RLS policies needed — the existing `quotes_corporate_admin`
  + `quotes_scoped` policies already cover the new columns.
- [ ] Drizzle schema (`packages/db/src/schema.ts`) updates the `quotes`
  table definition to include the three new columns.

### Service.AI side — provider abstraction

- [ ] `SupplierProvider` in `packages/suppliers/src/types.ts` adds:
  ```ts
  convertQuoteToOrder?(input: {
    externalQuoteId: string;
    requestId?: string;
  }): Promise<
    | { ok: true; data: { supplierOrderRef: string; supplierOrderId: string; orderedAt: string } }
    | { ok: false; error: SupplierError }
  >;
  ```
  Optional on the interface so older mock providers can omit it; routes
  null-check before invocation (consistent with `voidQuote`).
- [ ] `MockSupplierProvider` implements `convertQuoteToOrder` returning
  a deterministic `SO-<8 hex>` per `externalQuoteId` (used by Service.AI
  tests).
- [ ] `BcAiAgentProvider` implements `convertQuoteToOrder` by POSTing
  to `/api/external/quotes/{external_quote_id}/convert-to-order`
  on the BC AI Agent base URL. Same auth (`X-Service-AI-Key`),
  same `X-Request-ID` propagation, same backoff (50/200/800 ms on 5xx + 429)
  as the existing `priceItems` + `commitQuote` calls.

### Service.AI side — route wiring

- [ ] `apps/api/src/quote-routes.ts::/accept` handler, after the
  status update to `accepted` and the `quote_status_log` insert,
  calls `provider.convertQuoteToOrder` **outside** the transaction.
  Same pattern as `voidQuote`: a provider-side failure logs a
  warning and is swallowed; it does NOT roll back the local
  `accepted` state.
- [ ] On a successful conversion, the `supplier_order_ref` +
  `supplier_order_id` + `ordered_at` columns are written via a
  follow-up `UPDATE quotes ... WHERE id = ?` inside a
  `withScope(db, scope, ...)` tx. The status remains `accepted`
  (no new state for "ordered" — the columns are the data point).
- [ ] If the provider has no `convertQuoteToOrder` (older mock),
  the route does NOT error — it just skips the call and returns
  the same `accepted` detail.
- [ ] The handler returns the updated `loadQuoteDetail` result,
  which already includes the new columns by virtue of `SELECT *`.

### BC AI Agent side — schema

- [ ] Alembic migration extending `external_quote_commits` with
  three nullable columns:
  - `bc_order_id` `varchar(100)` indexed
  - `bc_order_ref` `varchar(100)`
  - `converted_at` `timestamptz`
- [ ] Migration is reversible.

### BC AI Agent side — endpoint

- [ ] `POST /api/external/quotes/{external_quote_id}/convert-to-order`:
  - Auth via `X-Service-AI-Key`, same validation path as `priceItems`
    / `quotes` (bcrypt key hash + supplier-account-code scoping).
  - 404 NOT_FOUND on unknown `external_quote_id` OR on a quote
    bound to a different key's `supplier_account_code` (never 403).
  - 422 UNPROCESSABLE if the source `external_quote_commits` row
    is not in `status='committed'` (i.e., the commit hasn't completed
    or already failed). Same envelope shape as other external routes.
  - Idempotency: if `bc_order_id` is already set on the row, return
    the cached `{ supplier_order_ref, supplier_order_id, converted_at }`
    without any BC traffic.
  - Otherwise: acquire a per-key in-process `threading.Lock` (same
    pattern as commit), call `bc_client.convert_quote_to_order(bc_quote_id)`,
    persist `bc_order_id` + `bc_order_ref` + `converted_at` on the
    row, return the same payload.
  - On BC failure: do NOT mark the row failed (the commit succeeded;
    only the conversion failed). Return 502 BC_ORDER_FAILED with the
    BC error message in the envelope; the row's `bc_order_*` stays null
    so a retry will re-attempt.
- [ ] `external_call_log` entry written for every call (success and
  failure), same fields as existing rows.
- [ ] Rate limit: same per-key limit as `quotes` (default 600 rpm).

### Idempotency proof

- [ ] Test: 10 concurrent convert-to-order calls for the same
  `external_quote_id` collapse to exactly one BC sales order. Asserted
  by counting BC orders via `bc_client.get_sales_orders` filtered by
  the original quote's `externalDocumentNumber`.
- [ ] Test: simulate BC failure on first convert call (mock the BC
  client to raise); retry; assert no orphan rows; assert eventual
  success persists the order ref on the original row.

### Auth + observability

- [ ] `X-Service-AI-Key` redacted in five shapes by Pino (already
  the case from SQB-11; this phase reuses).
- [ ] `X-Request-ID` propagated end-to-end (already the case from
  SQB-11; this phase reuses).
- [ ] Service.AI's `audit_log` table receives one row per accept
  attempt (action verb `quote.accept`), separate from the BC
  AI Agent's `external_call_log`.

### Test coverage matrix (per CLAUDE.md)

For Service.AI `/accept` AND its now-active conversion side effect:
- [ ] 401 unauthenticated
- [ ] 403 wrong tenant → returns 404
- [ ] 400 invalid input
- [ ] Happy path — accept transition + order ref stamped
- [ ] Edge case — provider returns NETWORK_ERROR; accept still succeeds;
  `supplier_order_ref` stays null; quote remains in `accepted` status
- [ ] Edge case — provider has no `convertQuoteToOrder` (mock without
  the method); accept succeeds; no error; order ref stays null

For BC AI Agent `/api/external/quotes/.../convert-to-order`:
- [ ] 401 missing / bad key
- [ ] 404 unknown external_quote_id
- [ ] 404 cross-key probe (key bound to a different supplier_account_code)
- [ ] 422 source quote is not in `status='committed'`
- [ ] Happy path — returns SO-XXXXXX, persists on the row
- [ ] Idempotency replay — same call returns same ref, no second BC order

### Live quote UI

- [ ] `apps/web/src/app/(app)/quotes/new/QuoteBuilder.tsx`:
  - When `supplier_order_ref` is set on the loaded quote, render a
    secondary badge near the SQ-XXXXXX line: `BC order: SO-XXXXXX`
    with the same Copy affordance as the supplier quote ref.
  - The "Accept" button (filed as TD-SQB-FU2 from the SQB audit) is
    promoted from TECH_DEBT to in-phase deliverable here: a single
    button after the commit banner that POSTs to `/api/v1/quotes/:id/accept`
    with `{ acknowledgmentChannel: 'verbal_phone' }`. On 200, the UI
    re-fetches the detail, sees `ordered_at` populated, and renders
    the BC order badge.
- [ ] Same affordance on the tech PWA at `apps/web/src/app/tech/jobs/[id]/quote/new/MobileQuoteBuilder.tsx`.

### Performance

- [ ] p95 end-to-end accept → BC order → Service.AI sees SO ref: **< 2.5 s**.
  Verified by extending `tests/perf/supplier_quote_bridge_live.js` with a
  conversion stage after the commit stage (or a new `supplier_quote_bridge_order.js`).

---

## Must Improve Over Previous Phase

- [ ] No regression in SQB or CHR test suites
  - **Verification:** `pnpm -r exec tsc --noEmit` exits 0; `pnpm -r --workspace-concurrency=4 test` baseline matches the SQB-AUDIT baseline (195 passing + 443 auto-skipped without live DB).
- [ ] Web bundle does NOT grow beyond +1% (the only new UI is two text
  spans + one button, no new dynamic import).

## Security Baseline

- [ ] `pnpm audit --audit-level=high` — no new findings.
- [ ] No new env vars on the BC AI Agent side (reuse `BC_*`, no new keys).
- [ ] Cross-tenant IDOR test on the new endpoint: a key bound to
  Elevated Doors cannot convert a quote committed under a different
  `supplier_account_code`. Returns 404 NOT_FOUND, never 403.
- [ ] Semgrep clean on `packages/suppliers` (the existing rules still cover
  the new `convertQuoteToOrder` shape; no new rule needed if the existing
  "no direct fetch outside packages/suppliers" rule catches `/convert-to-order`).
  Verify the rule pattern covers the new path.

## Documentation

- [ ] `docs/api/supplier-quote-bridge.md` adds:
  - Service.AI surface row: `POST /api/v1/quotes/:id/accept` (this phase
    promotes it to a documented endpoint; SQB had it as audit-fix only).
  - BC AI Agent surface row: `POST /api/external/quotes/:id/convert-to-order`.
  - New sequence diagram: "accept → convert-to-order" mirroring the existing
    "commit (with idempotency)" diagram. Show the per-key lock and the row reuse.
  - Idempotency map row: `convert-to-order` keyed on the SAME `external_quote_id`
    that keyed the commit.
- [ ] `docs/PHASES.md` adds:
  - The missing `phase_supplier_quote_bridge` section (SQB-shaped, mirroring
    the format of other phases). This was a doc gap from SQB shipping.
  - The new `phase_quote_order_conversion` section.
- [ ] `CLAUDE.md` (Service.AI):
  - In the "Supplier integration (SQB, load-bearing)" section, note that
    the `SupplierProvider` interface now also has `convertQuoteToOrder` and
    the `/accept` route is the trigger.
  - Reference `phase_quote_order_conversion` in the model-change-note block
    at the top.
- [ ] `CLAUDE.md` (bc-ai-agent):
  - Add the new endpoint to the "External API (SQB phase, 2026-05)" bullet
    list (rename the section to "External API (SQB + QOC, 2026-05)" or add
    a sub-bullet).
- [ ] `docs/LESSONS.md` reserved entry for QOC; evolver fills after audit.
- [ ] `docs/TECH_DEBT.md`:
  - Close TD-SQB-P3 (quote-to-order conversion — superseded by this phase).
  - Close TD-SQB-FU2 (Accept route → ts-rest + UI button — UI lands here;
    ts-rest contract migration can stay as a follow-up under a new TD if
    the gate's UI requirement is met without ts-rest).

---

## Out of scope (explicitly deferred)

- BC → Service.AI order status sync (shipped / delivered / invoiced).
  Pulling those back as state on the Service.AI quote needs a poller
  or a BC webhook; deferred to a future phase or to the customer-portal
  follow-up.
- Linking the BC sales order to a Service.AI invoice. Today the
  Service.AI invoice flow stays job-driven; the BC order is a parallel
  document in BC for OPENDC's fulfillment team. A future phase reconciles.
- Customer-facing order confirmation email / SMS. Reuses Donna PA's
  email stack when that phase lands; out-of-scope here.
- Multi-supplier order conversion. The endpoint is single-supplier
  (`X-Service-AI-Key` is supplier-scoped). When a second supplier ships
  (TD-SQB-P1), each provider impl adds its own `convertQuoteToOrder`;
  no changes needed at the interface level.
- Voiding an order. The current `quote/:id/void` route reverses the
  commission on a void-after-accepted but does NOT cancel the BC sales
  order. A follow-up adds `provider.cancelOrder` and ties it into
  `accepted → void`. The current phase does not break existing void
  behavior; it just leaves the BC order alive if the local Service.AI
  side voids.

---

## Tasks (build order)

1. **QOC-01** — Service.AI: migration `0018_quote_order_conversion.sql`
   + `.down.sql` + `qoc-01-migration-roundtrip.test.ts` + Drizzle
   schema update on `quotes`.
2. **QOC-02** — `SupplierProvider` interface extension + `MockSupplierProvider`
   impl + `MockSupplierProvider` unit test; `BcAiAgentProvider` impl
   pointing at the new BC AI Agent endpoint.
3. **QOC-03** — BC AI Agent: alembic migration extending
   `external_quote_commits` with `bc_order_id` + `bc_order_ref` +
   `converted_at`. SQLAlchemy model update.
4. **QOC-04** — BC AI Agent: `POST /api/external/quotes/{external_quote_id}/convert-to-order`
   endpoint, full auth + idempotency + per-key lock + `external_call_log`
   wiring. Wraps `bc_client.convert_quote_to_order`. Pytest coverage
   for the 6-case test matrix above.
5. **QOC-05** — Service.AI: wire `provider.convertQuoteToOrder` into the
   `/accept` handler. Persist the order ref on success; skip silently
   when the provider has no method. Same best-effort error handling as
   void.
6. **QOC-06** — Tests: `live-quote-order-conversion.test.ts` (Service.AI
   side, full 6-case matrix); idempotency stress test on the BC AI Agent
   side (10× concurrent convert-to-order); supplier-down resilience test.
7. **QOC-07** — UI: `QuoteBuilder.tsx` + `MobileQuoteBuilder.tsx` add the
   "Accept" button + the SO-XXXXXX badge. Re-fetch quote detail after
   accept to pick up `ordered_at`.
8. **QOC-08** — Docs: `supplier-quote-bridge.md` updates (endpoints +
   sequence + idempotency map), `docs/PHASES.md` (add missing SQB section
   + new QOC section), `CLAUDE.md` updates on both repos, TECH_DEBT
   closures (TD-SQB-P3, TD-SQB-FU2 if UI satisfies).

---

## Gate Decision

**APPROVED** (2026-05-18, Joey). Build proceeds per the task order above.
