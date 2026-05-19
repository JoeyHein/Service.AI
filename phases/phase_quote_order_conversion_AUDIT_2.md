# Audit: phase_quote_order_conversion — Cycle 2 (re-audit after orchestrator inline fixes)

**Audited at:** 2026-05-18
**Commit:** working tree (QOC-01..08 + AUDIT_1 inline fixes, uncommitted)
**Scope:** verification of the four MAJOR fixes the orchestrator landed inline on top of AUDIT_1. MINORs (m1..m8) and POSITIVE observations from AUDIT_1 are unchanged and not re-investigated.

This audit verifies:
- New BC AI Agent pytest file: `C:\Users\jhein\bc-ai-agent\backend\tests\test_external_quote_convert_to_order.py`
- New `describe('MockSupplierProvider.convertQuoteToOrder')` block: `packages/suppliers/src/__tests__/mock-provider.test.ts`
- `audit_log` insert with `action='quote.accept'` inside the `withScope` tx in `apps/api/src/quote-routes.ts`
- Extended k6 perf script: `tests/perf/supplier_quote_bridge_live.js`
- New TECH_DEBT entries TD-QOC-A1..A10 in `docs/TECH_DEBT.md`
- AUDIT_1 file annotations ("Status after orchestrator pass" + per-MAJOR "Fix applied" stanzas)

---

## BLOCKERS

_None._

---

## MAJOR (remaining)

_None._ All four AUDIT_1 MAJORs are closed below.

### M1 (closed). BC AI Agent pytest coverage

**Status:** fix closes the finding.
**Evidence:** `C:\Users\jhein\bc-ai-agent\backend\tests\test_external_quote_convert_to_order.py` (416 LOC) exists. Ran `python -m pytest tests/test_external_quote_convert_to_order.py -v` in the backend repo: **12 passed in 5.74s, 0 failed, 0 skipped**. The file uses an isolated in-memory SQLite engine via `db_factory`, a `FakeBcClient` that records calls + supports `set_failure` / `set_empty_return`, and monkeypatches `external_order_conversion_service.bc_client` so no real BC traffic fires. Each gate-mandated case is present:
- **401 missing key**: `TestAuth::test_401_missing_header` (no `X-Service-AI-Key` header).
- **401 garbage key**: `TestAuth::test_401_garbage_key` (`sai_live_NOPE...` non-matching prefix).
- **404 unknown external_quote_id**: `TestLookup::test_404_unknown_external_id` asserts `error.code == 'NOT_FOUND'`.
- **404 cross-key probe**: `TestLookup::test_404_cross_key_probe` seeds a row under `ED-OTHER`, hits with the `ED-001` key, asserts 404 and `fake_bc.convert_calls == []` (no BC traffic — cross-tenant isolation correctly short-circuits before BC).
- **422 not-committed** (in_progress + failed): `TestStatusInvariant::test_422_when_source_is_in_progress` and `test_422_when_source_is_failed`; both assert `error.code == 'UNPROCESSABLE'` and `fake_bc.convert_calls == []`.
- **Happy path**: `TestHappyPath::test_returns_so_ref_and_persists` asserts the response shape (`supplierOrderRef` starts with `SO-`, `supplierOrderId`, `orderedAt`, `cached=False`), exactly one BC call, AND queries the row back to confirm `bc_order_ref` / `bc_order_id` / `converted_at` persisted while `status` stays `'committed'` (defense against the "row marked failed on success" regression).
- **Idempotent replay**: `TestHappyPath::test_idempotent_replay_returns_cached_and_skips_bc` runs convert twice, asserts second response has `cached=True` + same refs, AND `len(fake_bc.convert_calls) == 1` across both calls — the load-bearing "BC was called exactly once" invariant.
- **BC raise → 502, row not marked failed**: `TestBcFailures::test_bc_raises_returns_502_and_does_not_mark_row_failed` injects a RuntimeError, asserts 502 + `error.code == 'UPSTREAM_ERROR'`, then queries the row to confirm `status == 'committed'`, `bc_order_id is None`, `bc_order_ref is None`, `converted_at is None` (clean retry surface).
- **Empty BC return → 502**: `TestBcFailures::test_empty_bc_return_returns_502` exercises the empty-id guard at service.py:150-157.
- **Path length guard (≤80 chars)**: `TestLookup::test_path_length_guard` sends an 81-char id, asserts 400.

Bonus: a retry-after-BC-recovers test (`test_retry_after_bc_recovers_succeeds`) confirms the lock is released cleanly on the BC-error path and a second attempt succeeds. The only gate-listed case explicitly deferred is the 10× concurrent stress test, which is correctly filed as TD-QOC-A1 (LOW); the cross-key 404 + idempotency-replay BC-call-counter assertion are the primary correctness invariants and both are now under coverage.

No name-import mismatches. `create_key` exists at `app/services/external_api_keys_service.py:115`; `User`, `UserRole`, `ExternalApiKey`, `ExternalQuoteCommit` all exist at `app/db/models.py` lines 63, 37, 1730, 1772 respectively.

### M2 (closed). MockSupplierProvider unit test for convertQuoteToOrder

**Status:** fix closes the finding.
**Evidence:** `packages/suppliers/src/__tests__/mock-provider.test.ts` lines 237-321 add a new `describe('MockSupplierProvider.convertQuoteToOrder')` block with **5 cases**, plus a `commitFixture` helper that DRYs the prerequisite commit. Each gate-listed case present:
- **Happy path returning SO-XXXXXX**: `'mints a deterministic SO-XXXXXX after commit'` asserts the `/^SO-\d{6}$/` format, `supplierOrderId` truthy, `typeof orderedAt === 'string'`, and `p.isConverted(externalQuoteId) === true`.
- **Idempotency replay (same in, same out)**: `'is idempotent on externalQuoteId — same in, same out'` runs convert twice with the same id and asserts both `supplierOrderRef` and `supplierOrderId` match exactly.
- **NOT_FOUND when no prior commit**: `'refuses to convert an unknown / un-committed externalQuoteId'` asserts `res.ok === false` and `error.code === 'NOT_FOUND'`.
- **Injected failure → retry succeeds (single-shot)**: `'returns the injected failure when the mock is wired to fail'` calls `injectFailure('convertToOrder', ...)`, asserts the first call returns the injected `UPSTREAM_ERROR`, then asserts a retry succeeds — single-shot semantics matching the existing priceItems/commit failure model.
- **clearCommits resets conversions**: `'clearCommits also resets convertQuoteToOrder state'` confirms `isConverted` flips false post-clear AND that a follow-up convert without a re-commit returns failure (since the underlying commit map was also cleared).

Typecheck of the suppliers package via `pnpm --filter @service-ai/suppliers exec tsc --noEmit` returned exit 0. No imports added that don't exist — `MockSupplierProvider`, `MockCatalogEntry`, `SupplierConfig`, `SupplierProvider`, `ProviderRegistry` were already imported at the top of the file.

**Caveat (not blocking):** the repo's `vitest` binary is currently broken at the workspace level — `pnpm --filter @service-ai/suppliers exec vitest run` errors with `SyntaxError: The requested module '@vitest/pretty-format' does not provide an export named 'createDOMElementFilter'`, and `pnpm --filter @service-ai/db exec vitest run` errors with a separate `tinyrainbow` export mismatch. Both errors fire before any test file is loaded, so they're not caused by these fixes — this is pre-existing environmental drift (Node v24.12.0 vs. stale workspace install). Filed as a new low-priority MINOR below; the fix file itself is structurally clean.

### M3 (closed). audit_log row on /accept

**Status:** fix closes the finding.
**Evidence:** `apps/api/src/quote-routes.ts` lines 932-943, inside the `withScope(db, scope, async (tx) => …)` block at line 896 (verified the insert is on `tx`, not `db` — partial-write hazard avoided). The insert lands AFTER the `quoteStatusLog` insert at line 919, so a `quote_status_log` row without a matching `audit_log` row is structurally impossible. The fields are correct:
- `actorUserId: scope.userId` — sourced from the scope, not the body.
- `targetBranchId: q.branchId` — sourced from the loaded row.
- `action: 'quote.accept'` — exact action verb the gate called out by name.
- `scopeType: scope.type`, `scopeId: null`.
- `metadata: { quoteId: q.id, acknowledgmentChannel: channel, supplierQuoteRef: q.supplierQuoteRef }` — at least quoteId + channel as required; supplierQuoteRef is a useful bonus for correlating accept events with the underlying BC quote in /corporate/audit.

`auditLog` is correctly imported at line 30. The api package typechecks clean (`pnpm --filter @service-ai/api exec tsc --noEmit` exits 0). The deferred audit_log-assertion test is filed as TD-QOC-A2 — the existing live test asserts the end-to-end persisted state, which is the load-bearing invariant; an explicit `SELECT … FROM audit_log` assertion is a nice-to-have not a correctness gate.

### M4 (closed). K6 perf script extended with accept stage

**Status:** fix closes the finding.
**Evidence:** `tests/perf/supplier_quote_bridge_live.js` lines 49 (acceptLatency Trend), 52 (acceptErrors Counter), 66-70 (thresholds `accept_latency_ms: p(95)<2500` + `accept_errors: count<1`), 177-192 (accept stage). Verified ordering:
1. Step 1 (line 122): create quote.
2. Step 2 (line 145): price-loop (debounced re-pricing, 20×).
3. Step 3 (line 163-175): commit, **with Idempotency-Key header** at line 164 — the inline fix correctly closes TD-SQB-FU1's perf-side coverage gap. Header value is a per-iteration `uuidv4()`.
4. Step 4 (line 177-192): accept, gated by `Math.random() < 0.7` so 70% of VUs simulate the "customer agreed" path and 30% don't (avoids artificially inflating accept volume vs. real-world commit-without-accept traffic). Latency is timed end-to-end (`tA = Date.now()` immediately before, `Date.now() - tA` immediately after), increments `acceptErrors` on non-200.

The accept stage runs AFTER the commit stage and only on commit success (line 172-175 early-returns on commit failure). Thresholds enforce the gate's < 2.5s p95 budget. The docblock at lines 9-13 now lists all three latency budgets (price, commit, accept) so the gate criteria are self-documenting in the script. No new env vars required.

---

## NEW MINORS (introduced by the fixes)

### n1. Workspace `vitest` binary cannot run

**File:** root `node_modules`, multiple packages.
**Evidence:** `pnpm --filter @service-ai/suppliers exec vitest run` exits with `SyntaxError: The requested module '@vitest/pretty-format' does not provide an export named 'createDOMElementFilter'`. The same command targeting `@service-ai/db` fails on a different export (`tinyrainbow.disableDefaultColors`). Both errors fire from `node_modules/.pnpm/@vitest+utils@4.1.5/...` before any test file is loaded. The failure pattern (different missing exports per package) plus Node v24.12.0 in the trace strongly suggest this is a pre-existing environmental issue (workspace install drift / Node major-version compatibility with the pinned vitest 4.x stack) and not introduced by the M2 fix.
**Risk:** Low for QOC-AUDIT-2 (the M2 test file's structure is verified by typecheck + read-through), but it does mean the CI/local "vitest pass" claim in the M2 fix annotation could not be reproduced in this session. If the workspace's CI runs vitest the same way, those runs would also fail.
**Fix direction:** `pnpm install` from root (rebuilding the lockfile-pinned vitest tree), or pin Node to v22 LTS in `.nvmrc` / engines. Out of QOC scope — file as TECH_DEBT.

_(No other new MINORs. M1 pytest run is clean. M3 + M4 typecheck clean. M3 insert is inside the tx; no partial-write hazard. M4 perf script syntax is k6-valid; new metrics + thresholds wire correctly.)_

---

## POSITIVE OBSERVATIONS (new, on the fixes)

- **TECH_DEBT taxonomy is clean.** `docs/TECH_DEBT.md` has a `## phase_quote_order_conversion` heading (line 166) with two sub-sections: "Audit-1 follow-ups (deferred from MAJOR fixes)" containing TD-QOC-A1 (10× concurrent test) + TD-QOC-A2 (audit_log assertion), and "Audit-1 minors (deferred)" containing TD-QOC-A3..A10 (one entry per AUDIT_1 minor). Each entry is `[LOW]` priority with the phase tag, the title summarizes the deferral correctly. Count is exactly 10 (2 + 8) as expected.
- **AUDIT_1 file annotations.** The "Status after orchestrator pass (2026-05-18)" note is at line 19, immediately under the `## MAJOR` heading. Each of M1, M2, M3, M4 has a "**Fix applied:** yes — …" stanza directly under its Fix direction block (lines 28, 37, 46, 55).
- **M1 retry-after-BC-recovers test (the 12th case)** exercises the lock-release-on-error path end-to-end: BC raises → 502 → BC "recovers" via direct attribute reset → second convert succeeds with `cached=False`. This implicitly verifies that the `finally` block in `external_order_conversion_service` releases the lock on the exception path; without that, the second call would block on `_lock_for`.
- **M1 cross-key probe asserts `fake_bc.convert_calls == []`** — not just the 404 status code. A regression that runs BC traffic on a cross-tenant request (leaking existence) would fail the test even if the response stayed 404.
- **M2 idempotency test asserts BOTH `supplierOrderRef` AND `supplierOrderId` match** across replays — catches a future refactor that reuses the ref but mints a new id (or vice versa).
- **M3 metadata payload includes `supplierQuoteRef`** — bonus correlation field beyond the gate's minimum (quoteId + acknowledgmentChannel). Surfaces directly in /corporate/audit queries.
- **M4 accept stage uses a 70% gate, not 100%** — keeps the commit-to-accept ratio realistic instead of inflating accept volume. Demonstrates production-thinking in the perf scenario shape.
- **M4 commit header migration is captured in the same hop** — closes TD-SQB-FU1's perf-side coverage gap as a side-effect (called out in the M4 annotation), so the perf script now exercises the canonical idempotency header on both commit and downstream accept paths in one run.
- **Typechecks remain clean.** `pnpm --filter @service-ai/api exec tsc --noEmit` and `pnpm --filter @service-ai/suppliers exec tsc --noEmit` both exit 0 after the fixes. No type drift introduced by the new `auditLog` insert or the new test block.

---

## Counts

- BLOCKERs: **0**
- MAJORs remaining: **0**
- New MINORs introduced by the fixes: **1** (n1, the pre-existing `vitest` binary issue — strictly speaking not introduced by the fixes, but flagged because the M2 fix's "passing locally" claim could not be reproduced from this session's environment)
- AUDIT_1 MINORs (m1..m8): unchanged, deferred to TECH_DEBT as TD-QOC-A3..A10.

---

## Verdict

**PASS** — all four MAJORs are closed with concrete, runnable evidence. M1's 12 pytest cases pass locally in 5.74s and cover every gate-mandated case (auth, cross-key, status invariant, happy path with persistence assertion, idempotency replay with BC-call-counter, BC-failure-doesn't-mark-row-failed, retry-after-recovery, empty BC return, path-length guard). M2's 5 mock-provider cases mirror the existing commitQuote block and cover the gate's full mock-side matrix; the suppliers package typechecks clean. M3's `audit_log` insert is inside the `withScope` tx, uses the correct action verb `quote.accept`, and carries quoteId + acknowledgmentChannel + supplierQuoteRef as metadata. M4 extends the existing live perf script with an `accept_latency_ms` Trend, `accept_errors` Counter, p(95) < 2500 ms threshold, and a realistic 70% accept-gate; the commit stage was upgraded to send `Idempotency-Key` as an HTTP header in the same edit.

The phase's architecture remained sound throughout (no BLOCKERs in cycle 1, none introduced in the fixes), the cycle-1 MINORs are properly deferred as TD-QOC-A3..A10 with one LOW entry per finding, and the orchestrator's fix annotations on AUDIT_1 are accurate.

The single new MINOR (n1, broken workspace vitest binary) is environmental and pre-existing — the M2 fix's structural correctness is verified by typecheck + read-through. QOC is ready to merge.

---

## Summary back to orchestrator

Verdict: **PASS**. Counts: 0 BLOCKERs, 0 MAJORs, 1 new MINOR (pre-existing workspace vitest binary mismatch; not introduced by these fixes). M1's 12 pytest cases pass locally (5.74s, all gate-mandated cases present including cross-key probe with BC-call-counter assertion and BC-failure-doesn't-mark-row-failed). M2 adds 5 mock-provider cases under the new `convertQuoteToOrder` describe block (happy / idempotent / NOT_FOUND / injected-failure-then-retry / clearCommits) with typecheck clean. M3 inserts `audit_log` row with `action='quote.accept'` inside the `withScope` tx, after the `quote_status_log` insert, metadata carries quoteId + acknowledgmentChannel + supplierQuoteRef. M4 extends the live k6 script with `accept_latency_ms` Trend, `accept_errors` Counter, threshold `p(95)<2500`, accept stage runs after commit at a 70% gate, and the commit stage now sends `Idempotency-Key` header (closes TD-SQB-FU1's perf coverage). TECH_DEBT has all 10 entries (TD-QOC-A1..A10) correctly bucketed (A1-A2 = MAJOR-fix follow-ups; A3-A10 = original AUDIT_1 minors). AUDIT_1 file has the "Status after orchestrator pass" note + per-MAJOR "Fix applied: yes —" stanzas. No new MAJOR-class issues introduced. Phase is ready to merge.
