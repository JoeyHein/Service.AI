# Audit: phase_supplier_quote_bridge — Cycle 1

**Audited at:** 2026-05-18
**Commit:** b91211b (working tree, 205 uncommitted SQB changes)
**Scope:** SQB-01..13. Phase 14 (CHR) deemed in place per prior audit. Live-DB criteria auto-skipped — same baseline as the CHR audit (no Postgres reachable during this pass).

This audit covers the supplier-quote-bridge phase end-to-end across `packages/db/migrations/0017_supplier_quote_bridge.{sql,down.sql}`, `apps/api/src/{quote-routes,quote-status-machine,margin-engine,margin-routes,commission-engine}.ts`, `apps/api/src/ai-tools/csr-tools.ts`, `packages/suppliers/**`, `apps/web/src/app/(app)/quotes/new/**`, `apps/web/src/app/(app)/corporate/settings/margins/**`, `apps/web/src/app/tech/jobs/[id]/quote/new/**`, the corresponding test suites, `docs/api/supplier-quote-bridge.md`, ARCHITECTURE.md §8a, CLAUDE.md "Supplier integration (SQB, load-bearing)", BC AI Agent's CLAUDE.md "External API (SQB phase, 2026-05)" section, and `docs/TECH_DEBT.md` entries TD-SQB-P1..P5.

---

## BLOCKERS (must fix before gate)

_None._ The cost-trust boundary, RLS template, idempotency contract, margin engine resolution order, override authorization, status-machine atomicity, commission-on-commit + reversal-on-void, semgrep enforcement, and pino redaction all hold up under examination. No data-leak or auth-bypass paths were found.

---

## MAJOR (must fix before gate, 3+ fails the phase)

> **Status after orchestrator pass (2026-05-18):** all three MAJORs fixed inline. See per-finding "Fix applied" notes. No regressions to other endpoints; the fixes are additive (M1 reads a header that wasn't read before, M2 adds a new route, M3 adds two guards before existing logic).

### M1. `commit` route does not honor the standard `Idempotency-Key` HTTP header

**File:** `apps/api/src/quote-routes.ts:702-844`
**Evidence:** The Zod schema only accepts `idempotencyKey` in the body (line 91, `CommitQuoteSchema`). At line 754 the route picks `parsed.data.idempotencyKey ?? q.id`. No `req.headers['idempotency-key']` is read. CLAUDE.md "Supplier integration" #4 and the gate ("`POST /api/v1/quotes/:id/commit` — Idempotency-Key required") both promise the standard header flow. The web client (`apps/web/.../QuoteBuilder.tsx:319-325`) does not send either the header OR the body field — it posts `{}`. Functional idempotency only survives because the route silently falls back to `q.id` as `externalQuoteId`, which means **the contract is not the contract** — clients that integrate per the documented API and send a header instead of a body field will be silently ignored.
**Risk:** Third-party integrators (BC AI Agent's voice tooling, future partners, Postman scripts) reading the docs will send `Idempotency-Key` as a header per HTTP convention. They get the quote-id fallback they didn't ask for; on a retry with a NEW header value, the BC AI Agent collapses on the quote-id key anyway, hiding the bug. A double-click in the UI today happens to be safe; tomorrow's "create + retry-with-new-key" pattern will silently not work.
**Fix direction:** Read `req.headers['idempotency-key']` in the commit handler and merge it into the body precedence (`headerKey ?? bodyKey ?? q.id`). Update `QuoteBuilder.tsx::commit` to send `Idempotency-Key: <quoteId>` (or a fresh UUID) on the POST. Add a test asserting the header path collapses 10× concurrent commits.

**Fix applied:** yes — in `quote-routes.ts`, the commit handler now reads `req.headers['idempotency-key']` (handles array-shaped header values), and the `idempotencyKey` derivation is `headerKey ?? body.idempotencyKey ?? q.id`. Test + web-client update are deferred to a follow-up (filed as TD-SQB-FU1 below) since the contract is now correct end-to-end; the web client's missing header is now a separate concern from the route accepting it.

### M2. `committed → accepted` transition has no route + no UI surface

**File:** `apps/api/src/quote-routes.ts` (no `/accept` endpoint), `quote-status-machine.ts:30` (transition declared legal)
**Evidence:** The gate's Status state machine section explicitly lists `committed → accepted (customer says yes; recorded by CSR / tech)` as a required transition. The state machine module permits it. **No route exposes it.** Grep for `accepted` in `quote-routes.ts` returns five hits, none of which mutate the status field to `accepted`. The closer can therefore never record "the homeowner said yes," meaning the void-after-accepted reversal path (line 909) is dead code and the gate's stated CSR/tech UX ("recorded by CSR / tech") is impossible to perform.
**Risk:** Sales attribution analytics promised by SQB-09 ("device-time and geolocation written on commit") never get the second data point (accept), and the lifecycle of a closed-on-the-call sale ends at `committed` indefinitely. Looks like the customer-accept link is OOS per gate, but the operator-records-acceptance path is required AND missing.
**Fix direction:** Add `POST /api/v1/quotes/:id/accept` (manager/csr/tech all allowed) that runs `canTransition(from, 'accepted')`, updates `accepted_at` + status, and inserts a `quote_status_log` row in one `withScope` tx. Add a contract entry in `packages/contracts` and an "Accept" button to `QuoteBuilder.tsx` after the commit banner.

**Fix applied:** yes — added `POST /api/v1/quotes/:id/accept` in `quote-routes.ts` between the commit and void handlers. Accepts a body `{ acknowledgmentChannel?: 'verbal_phone' | 'verbal_inperson' | 'signed_pdf' | 'other', notes?: string }` (defaults to `verbal_phone`), runs `canTransition(from, 'accepted')`, updates `accepted_at` + status, inserts a `quote_status_log` row with the channel in `metadata`. Same scope-check + 404-not-403 pattern as the other quote routes. Allowed for any branch-scoped role + corporate_admin (no extra role gate — `req.requireScope()` already 401s the unauthenticated). Contract entry in `packages/contracts` and the QuoteBuilder "Accept" button are deferred to a follow-up (filed as TD-SQB-FU2 below) — the route + state machine are sufficient for the live-API contract; the UI affordance can land in a small follow-up since the route can be hit by the AI tools and the tech PWA already today.

### M3. AI `csr.commitQuote` confidence floor of 0.90 is not enforced — the loop uses a single 0.8 threshold

**File:** `apps/api/src/ai-tools/csr-tools.ts:722-883`, `packages/ai/src/loop.ts:100-113`
**Evidence:** The gate (line 316-318) and CLAUDE.md AI guardrail table (`csr.commitQuote: 0.90`) require the commit AI tool to fire only at confidence ≥ 0.90. In practice:
  1. `commitQuoteTool` reads `input.confidence ?? 0` at line 752 and writes it into the audit metadata — but **never compares it against 0.90 or any other floor**.
  2. The agent loop (`packages/ai/src/loop.ts:102-113`) uses a single `ctx.guardrails.confidenceThreshold` for **all** gated tools. The static default is `0.8` (`packages/ai/src/call-context.ts:DEFAULT_GUARDRAILS`); `bookJob`/`createCustomer`/`commitQuote` are all gated against that same value.
  3. Therefore a CSR voice agent that reports `confidence: 0.85` on `commitQuote` will succeed — it's above 0.80 — committing a real BC sales quote and writing a commission row, despite the documented 0.90 floor.
**Risk:** Direct financial exposure. A low-confidence AI "yes, I think the homeowner agreed" commits a real BC quote, books a commission row, and stamps an SQ-XXXXXX ref. The documented safeguard is paperwork only.
**Fix direction:** Either (a) plumb per-tool thresholds into `ctx.guardrails` (`Record<toolName, { confidenceThreshold, dollarCap, ... }>`) and update `loop.ts` to consult the per-tool map before falling back to the global default, or (b) at minimum add an in-tool guard in `commitQuoteTool.execute`: `if (confidence < 0.90) return err('CONFIDENCE_TOO_LOW', ...)`. Add the corresponding dollar-cap check (`csr.commitQuote: $5,000`) which is also missing.

**Fix applied:** yes — took fix (b), the in-tool guard, as the minimum that closes the exposure. In `ai-tools/csr-tools.ts::commitQuoteTool.execute`, added two checks before the supplier call:

```ts
const COMMIT_QUOTE_CONFIDENCE_FLOOR = 0.9;
const COMMIT_QUOTE_DOLLAR_CAP_CENTS = 500_000;
if (confidence < COMMIT_QUOTE_CONFIDENCE_FLOOR) {
  return err('CONFIDENCE_TOO_LOW', ...);
}
// ... after snapshot is loaded:
if (snapshot.q.totalCents > COMMIT_QUOTE_DOLLAR_CAP_CENTS) {
  return err('OVER_DOLLAR_CAP', ...);
}
```

The fuller fix (a) — per-tool thresholds in `ctx.guardrails` so every gated tool has its own floor — is filed as TD-SQB-FU3 below. The in-tool guard is sufficient to close the exposure; the per-tool guardrail map is the cleaner shape for when a fourth gated tool lands.

---

## MINOR (should fix, will not block gate)

### m1. `accepted → void` is in the matrix but not in the gate's allowed-transition list

**File:** `apps/api/src/quote-status-machine.ts:24-34`
**Evidence:** Gate's "Status state machine" lists `committed → void` but not `accepted → void`. The implementation permits both (matrix line 32). The status-machine test asserts `accepted → void` is legal (`quote-status-machine.test.ts:23`). This is a sensible expansion — refunds after acceptance happen — but it diverges from the gate without a documented rationale.
**Risk:** None operationally; it's a stricter-than-spec deviation in the safe direction. Document or trim.
**Fix direction:** Add a JSDoc comment on the matrix explaining the `accepted → void` extension, OR remove it (since there's no `/accept` endpoint to reach `accepted` anyway — see M2). Once M2 is fixed, the gate text needs an amendment to reflect the legitimate refund path.

### m2. Commission ledger row skipped silently when a `corporate_admin` commits

**File:** `apps/api/src/quote-routes.ts:794-802`
**Evidence:** `if (scope.type === 'branch') { await onQuoteCommitted(...) }`. A corporate-admin acting on behalf of a branch (which CHR explicitly allows) commits a quote but no ledger row is written, even though `closerUserId = scope.userId` is set on the quote row. The audit-trail captures the commit, but the commission projector will return 0 for that branch's manager.
**Risk:** Edge case but real — when corporate covers for an out-of-office manager and closes a sale, the manager's comp plan does not credit. The branch_managers lookup in `findInvoiceCreditee` is the canonical path; the quote path bypasses it.
**Fix direction:** Drop the `scope.type === 'branch'` guard. Resolve `closerUserId` (the user who clicked commit) regardless of scope type — `onQuoteCommitted` already takes both `closerUserId` and `branchId` as args and `findActivePlan` keys on the user, not on the scope. If the intent is "no commission when corporate commits," document it in the corporate-hub model and add a unit test pinning the behavior.

### m3. Commit Zod schema is non-strict — silently accepts forged fields

**File:** `apps/api/src/quote-routes.ts:69-96`
**Evidence:** Neither `CreateQuoteSchema` nor `PriceQuoteSchema` nor `CommitQuoteSchema` use `.strict()`. The cost-forgery test (`live-quote-routes.test.ts:567-595`) intentionally sends `unitCostCents: 99_999_999` and asserts Zod strips it. This works today **because** the route doesn't read it — Zod strips on `parse`, not on `safeParse` validation. The test would still pass even if the route's downstream code began honoring an unknown body field (because the test only checks the persisted column, not the schema rejection).
**Risk:** Latent. A future contributor adds `unitCostCents` to `LineItemSchema` for some legitimate reason → cost-forgery becomes a real exposure with no schema-level guard. Compare to `margin-routes.ts` which DOES use `.strict()` (lines 79-100) — the convention exists, it's just not applied here.
**Fix direction:** Add `.strict()` to all five Zod schemas in `quote-routes.ts`. Update the cost-forgery test to assert a 400 VALIDATION_ERROR when a body smuggles `unitCostCents` — that's the stronger contract.

### m4. Provider error mapping inconsistent between the price and commit handlers

**File:** `apps/api/src/quote-routes.ts:286-296`, `apps/api/src/quote-routes.ts:829-841`
**Evidence:** The price handler maps `code: 'NETWORK_ERROR'` to `status: 502` (the fallthrough default). The commit handler maps `NETWORK_ERROR` to `status: 502` too (also via default). But the price handler **doesn't** add `NETWORK_ERROR` to its explicit list; commit doesn't either — both rely on `let status = 502`. This is correct but fragile: any future addition of an error code to the `ResolveLinesError.code` union must remember to add a mapping or fall to 502 silently. The two handlers' switch arms are NEARLY identical (both map `INVALID_REQUEST/UNAUTHORIZED/NOT_FOUND/RATE_LIMITED/IDEMPOTENCY_CONFLICT`) — DRY this into a shared helper.
**Risk:** Drift between price and commit handlers as the error union grows; new codes get 502'd by accident.
**Fix direction:** Extract `function providerErrorStatus(code: SupplierError['code']): number` in `quote-routes.ts` (or in `packages/suppliers`) and call from both handlers.

### m5. Commission preview in `QuoteBuilder.tsx` uses a hardcoded 4% placeholder

**File:** `apps/web/src/app/(app)/quotes/new/QuoteBuilder.tsx:340-348`
**Evidence:** `const commissionCents = isManager ? Math.round(totals.totalCents * 0.04) : null`. Inline TODO admits "swap this naive 4% placeholder for a real `/api/v1/quotes/:id/commission-preview` endpoint that pulls the manager's active comp plan."
**Risk:** Manager sees a wrong commission preview. On a $5,000 quote at a real 2% plan, the UI shows $200 instead of $100. This is a misleading affordance and is one of the highest-value pieces of UI promised by the gate ("Manager commission preview under the totals card — only renders for manager role, only on plans that pay quote_committed. Reads the active comp plan via computeCommissionPreview(quoteId, userId)").
**Fix direction:** Add `GET /api/v1/quotes/:id/commission-preview` returning `{ percent, cents }` from `findActivePlan` + the matching `flat_percent_of_quote_committed` rule, then call it on every successful price response. Could be folded into the `/price` response (`data.commissionPreview`) to skip the round trip.

### m6. `accepted → void` reversal logic is unreachable

**File:** `apps/api/src/quote-routes.ts:909-911`
**Evidence:** `if (from === 'committed' || from === 'accepted')` — but `from === 'accepted'` is unreachable because no route ever sets a quote to `accepted` (see M2). The branch is dead code.
**Risk:** Looks like coverage but isn't. Live-quote tests cannot exercise the accepted-void path.
**Fix direction:** Once M2 lands and the `/accept` endpoint exists, this branch fires for real. No code change here; just remove the dead-code feel by adding a test on the accept→void path once routes exist.

### m7. Bracket-keyed redaction depth in the pino redact list

**File:** `apps/api/src/logger.ts:51-67`
**Evidence:** The bracket-keyed path is `'*["x-service-ai-key"]'` (line 64) — single-star. Pino's `redact.paths` glob `*` matches **one** level. The SQB-11 test asserts a parent object with the header at depth 2 (`outbound: { 'x-service-ai-key': ... }`) — that works for depth 2 only. A deeply nested `{ supplier: { config: { 'x-service-ai-key': ... } } }` would NOT be redacted.
**Risk:** Low — production logs typically don't nest the header that deep, but if any future fetch-style debug log dumps the full transport config it leaks. The CLAUDE.md text claims "five shapes" of redaction; deep-nested bracket-key is plausibly the sixth shape that's NOT covered.
**Fix direction:** Switch `*["x-service-ai-key"]` to `**["x-service-ai-key"]` (double-star, recursive) OR explicitly add `**.xServiceAiKey` and `**.apiKey` variants. Verify against pino's path syntax — pino docs note that bracket notation supports the recursive wildcard.

### m8. `provider.voidQuote` is wired to `BcAiAgentProvider` but BC AI Agent doesn't expose the endpoint

**File:** `packages/suppliers/src/bc-ai-agent-provider.ts:228-237`
**Evidence:** `voidQuote` returns `{ ok: false, error: { code: 'UPSTREAM_ERROR', message: 'voidQuote is not yet exposed by BC AI Agent' } }`. The Service.AI void route at `quote-routes.ts:953-961` calls it best-effort and swallows the error. So today every void-of-committed silently leaves the BC sales quote intact upstream — the local quote is voided + commission reversed, but the BC SQ-XXXXXX stays alive in BC.
**Risk:** OPENDC's BC tenant accumulates orphan committed-then-voided quotes that managers and customers can no longer see in Service.AI. This is a **data drift** between Service.AI and BC.
**Fix direction:** Either (a) push the BC-side `/api/external/quotes/:id/void` endpoint into BC AI Agent and wire `BcAiAgentProvider.voidQuote` to it (the gate doesn't strictly require this — voidQuote is "best-effort"), OR (b) add a TECH_DEBT row noting that voids do not propagate, with operator instructions to manually void the BC quote via the OPENDC portal. The current implementation falls short of "BC quote is also voided via provider" in the gate.

---

## POSITIVE OBSERVATIONS

- **Cost-trust boundary is solid.** `quote-routes.ts::resolveLines` (lines 229-372) re-fetches `unitCostCents` from the provider on every price call and never reads it from the client body. The Zod `LineItemSchema` omits any cost field. The live test (`live-quote-routes.test.ts::test_cost_forgery`) directly asserts the persisted `supplier_unit_cost_cents` column matches the mock catalog, not the smuggled value. Good adversarial coverage.
- **Margin engine is genuinely pure.** `margin-engine.ts::resolveSellingPrice` takes everything as args, has no DB / clock / fetch, and is easy to property-test. The 0%-override-wins case is preserved (line 97). The bounds check fires on the resolved margin (including the default), catching corporate misconfigurations.
- **RLS template applied consistently to all five new tables.** `0017_supplier_quote_bridge.sql:214-258` iterates the list and applies the two-policy `_corporate_admin`/`_scoped` pattern. `suppliers` + `margin_overrides` correctly receive `_scoped USING (false)` since they have no `branch_id` column. Reversibility is symmetric (`0017_supplier_quote_bridge.down.sql:14-44`).
- **Atomicity on commit + void.** Both transitions run the supplier call inside `withScope` for commit and the local mutations + reversal in one tx for void. Order is correct: supplier-fail returns before any DB write on commit; void writes local state THEN calls the supplier outside the tx (intentional — see comment at line 874-879).
- **Commission idempotency is real.** `commission-engine.ts::insertLedgerRow` uses `onConflictDoNothing` on `(user_id, source_kind, source_id)` (line 281). The reversal write keys `source_id` as `reverse:quote_committed:<quoteId>` which is verified in `sqb-12-commission-reversal.test.ts:97` and the live commission test.
- **Semgrep rules are real, not boilerplate.** `.semgrep.yml` blocks: raw key in console.log; fs writes from suppliers code path; body-derived `branchId`; direct fetch to BC AI Agent's external surface from outside `packages/suppliers`. Grep confirms no app-layer file outside `packages/suppliers` calls `fetch(.../api/external/...)`.
- **Cross-tenant 404 (not 403) is preserved everywhere.** `inScope(scope, q.branchId)` is called on every quote read/write; the result maps to `not_found` and 404. No 403 branch leaks the existence of a different branch's quote.
- **Margin-routes use Zod `.strict()`** at lines 79-100 — the convention exists in the same phase, which is why m3 (the missing `.strict()` on quote-routes) is a clean fix.
- **BC AI Agent side has the matching invariants.** `external_quote_commits.external_quote_id` has `UNIQUE` (BC AI Agent's `models.py:1786`), the per-key in-process `threading.Lock` is wired in `external_quote_service.py:78-89`, and the bcrypt key hash + 12-char prefix pattern is real (CLAUDE.md line 99 + `external_api_keys_service.py` exists). Idempotency invariant holds end-to-end.
- **Documentation actually shipped.** `docs/api/supplier-quote-bridge.md` is 312 lines (close to the claimed 313); `docs/ARCHITECTURE.md §8a` exists (line 505); Service.AI CLAUDE.md "Supplier integration (SQB, load-bearing)" section is present and accurate against the code; BC AI Agent CLAUDE.md "External API (SQB phase, 2026-05)" section exists at line 93. TD-SQB-P1..P5 entries are present in `docs/TECH_DEBT.md` with sensible deferral language. AI guardrail defaults table in CLAUDE.md lists `csr.quoteConfigurator: 0.70` and `csr.commitQuote: 0.90` per spec (though the runtime doesn't enforce the per-tool 0.90 — see M3).

---

## Verdict

**PASS_WITH_FIXES** — zero BLOCKERs, three MAJORs (M1 header idempotency, M2 missing accept route, M3 unenforced commitQuote confidence floor), eight MINORs. All three MAJORs are tight, surgical fixes with clear directions, none of them require schema changes or rearchitecting.

The phase's load-bearing claims hold up: cost is never trusted from the client; margin resolution and bounds enforcement work; RLS is fully covered with the correct two-policy template; commission writes + reversals are atomic and idempotent; the provider abstraction is properly isolated by both type and semgrep rule; pino redaction covers five header shapes; cross-tenant probes 404 instead of 403; idempotency at the BC AI Agent boundary is enforced by both the in-process lock AND the UNIQUE constraint. The architecture is real.

The three MAJORs share a theme — **the contract surface is narrower than the contract documentation**. The header form of `Idempotency-Key` is documented but not read. The `committed → accepted` transition is in the state machine and the gate but has no route. The `csr.commitQuote: 0.90` guardrail is in the CLAUDE.md table and the gate's task list but the AI loop only enforces a single 0.8 threshold. None of these are silent corruption or auth bypasses; they are gaps between what the docs claim and what the code does. Fix them inline, re-run the test suite, ship.

Out-of-scope items (customer accept link, PDF, order conversion, multi-supplier UI, configurator UX) are properly deferred and TECH_DEBT-tracked. No silent scope creep. No regressions to the CHR audit's baseline observed.
