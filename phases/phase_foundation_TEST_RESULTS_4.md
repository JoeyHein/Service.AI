# TEST RESULTS — phase_foundation — Run 4

**Date:** 2026-04-22
**Runner:** test-runner agent (claude-sonnet-4-6)
**Trigger:** Post-correction re-check following CORRECTION_2 and CORRECTION_3; verifying working-tree state is clean before next gate review.
**Commit:** db987187 (HEAD) + staged/working-tree changes from CORRECTION_1, CORRECTION_2, CORRECTION_3
**Fix applied this run:** Removed redundant `require('fs')`/`require('path')` calls on lines 300-301 of `apps/web/src/__tests__/structure.test.ts` — replaced with existing ES module imports (`readFileSync`, `join`) from lines 13-14. Lint and build now pass.

---

## Summary

| Suite | Result | Pass | Fail | Skip | Duration |
|---|---|---|---|---|---|
| Unit/Integration — tests/foundation | PASS | 132 | 0 | 0 | 1.55s |
| Unit/Integration — apps/api | PASS | 49 | 0 | 0 | 11.43s |
| Unit/Integration — apps/voice | PASS | 11 | 0 | 0 | 6.44s |
| Unit/Integration — apps/web | PASS | 29 | 0 | 0 | 7.79s |
| Unit/Integration — packages/contracts | PASS | 21 | 0 | 0 | 8.33s |
| Unit/Integration — packages/db | FAIL | 15 | 4 | 0 | 9.24s |
| Unit/Integration — packages/ai | SKIP | — | — | — | stub |
| Unit/Integration — packages/auth | SKIP | — | — | — | stub |
| Unit/Integration — packages/ui | SKIP | — | — | — | stub |
| Typecheck | PASS | 8/8 pkgs | 0 errors | — | 32.38s |
| Lint | PASS | 8/8 pkgs | 0 errors | — | 45.46s |
| Build | PASS | 4/4 tasks | 0 errors | — | 1m 29.83s |
| Security (audit --audit-level=high) | PASS | — | 0 high/critical | — | — |
| E2E | SKIP | — | — | — | Not configured |
| Perf baseline | SKIP | — | — | — | Not configured |

**Overall: PASS (with infrastructure caveat)**

Lint and build pass after removing redundant `require()` calls in `apps/web/src/__tests__/structure.test.ts`. Four live-DB integration tests in `packages/db` fail because no Postgres is running at `localhost:5434` in this environment — unchanged infrastructure issue from all prior runs except Run 3; not a code defect.

---

## Failures

### 1. apps/web lint — FIXED this run

**Root cause (resolved):** The `AUDIT-3 / B1 regression / rollup CVE pnpm override` describe block used `require('fs')` and `require('path')` inside a `try` block instead of the ES module `readFileSync` and `join` already imported at lines 13-14. Removed the two redundant `require()` calls. Lint now exits 0.

---

### 2. apps/web build — FIXED this run (cascaded from lint fix)

`next build` invokes `next lint` internally; with lint clean, the production build completes successfully.

---

### 3. packages/db — live Postgres integration (infrastructure only, unchanged)

**File:** `packages/db/src/__tests__/health-checks.test.ts`
**Failing tests (4):**
- `health_checks live integration > inserts and retrieves a health_check row`
- `health_checks live integration > rejects a row with a service value exceeding 100 characters`
- `health_checks live integration > rejects a row with a status value exceeding 20 characters`
- `health_checks live integration > defaults checked_at to the current timestamp when not supplied`

**Error:** `Error: connect ECONNREFUSED 127.0.0.1:5434`

**Root cause:** No Postgres service is running at `localhost:5434` in the current environment. These tests require `docker-compose up` with the `db` service before `pnpm test`. The schema, migrations, and Drizzle code are correct; this is a pure infrastructure availability issue. These same 4 tests passed in Run 3 when Postgres was available and have failed in all other runs.

**This is not a code defect.** CI must start the Postgres service container before running `pnpm -r test`.

---

## Security Findings

`pnpm audit --audit-level=high` exits 0. No HIGH or CRITICAL vulnerabilities.

`pnpm audit` (all severities) reports 3 moderate vulnerabilities, all in the `vitest` -> `vite` -> `esbuild` dev dependency chain. Not reachable in production builds or at runtime.

| Advisory | Package | Severity | Vulnerable | Fixed In | Path |
|---|---|---|---|---|---|
| GHSA-67mh-4wv8-2f99 | esbuild | moderate | <=0.24.2 | >=0.25.0 | vitest -> vite -> esbuild |
| GHSA-4w7w-66w2-5vf9 | vite | moderate | <=6.4.1 | >=6.4.2 | vitest -> vite |
| (transitive duplicate) | esbuild (transitive) | moderate | — | — | dev toolchain |

All three are identical to prior runs. No new CVEs introduced. No action required for gate passage.

---

## E2E Tests

Not run. No `tests/e2e/` Playwright specs or configuration exist. E2E infrastructure is not required for phase_foundation.

---

## Performance Baseline

Not run. No `tests/perf/` k6 scripts exist. Performance test infrastructure is not required for phase_foundation.

---

## Passing Suites Detail

### tests/foundation — 132/132 PASS (Vitest v4.1.5)

| File | Tests | Status |
|---|---|---|
| fnd-01-monorepo.test.ts | 67 | PASS |
| fnd-07-ci.test.ts | 22 | PASS |
| fnd-08-observability.test.ts | 11 | PASS |
| fnd-09-do-spec.test.ts | 15 | PASS |
| fnd-10-compose.test.ts | 17 | PASS |

### apps/api — 49/49 PASS (Vitest v3.2.4)

| File | Tests | Status |
|---|---|---|
| health.test.ts | 29 | PASS |
| echo.test.ts | 20 | PASS |

Note: The working tree has the regression line (`const x: number = "this is a string";`) removed. The staged change still shows in `git status` (added by a prior agent), but the actual working-tree file is clean. Vitest runs from working-tree source and sees the correct file.

### apps/voice — 11/11 PASS (Vitest v3.2.4)

`src/__tests__/voice.test.ts` — all 11 tests pass.

### apps/web — 29/29 PASS (Vitest v3.2.4, unit tests only)

`src/__tests__/structure.test.ts` — 29 tests pass when run via `vitest run` directly. The `require()` violations are caught only by ESLint (`next lint` / `eslint`), not by Vitest's transpiler, so unit tests pass while lint and build fail.

### packages/contracts — 21/21 PASS (Vitest v3.2.4)

`src/__tests__/echo.test.ts` — all 21 tests pass including numeric key casting regression test.

### packages/db — 15/19 PASS (Vitest v4.1.5)

15 schema/SQL tests pass. 4 live-DB integration tests fail with ECONNREFUSED (see failure #3 above).

---

## Comparison vs Run 3

| Check | Run 3 | Run 4 | Delta |
|---|---|---|---|
| tests/foundation | 132/132 PASS | 132/132 PASS | no change |
| apps/api unit tests | 49/49 PASS | 49/49 PASS | no change |
| apps/voice unit tests | 11/11 PASS | 11/11 PASS | no change |
| apps/web unit tests | 24/24 PASS | **29/29 PASS** | +5 tests added |
| packages/contracts | 21/21 PASS | 21/21 PASS | no change |
| packages/db (schema/SQL) | 15/15 PASS | 15/15 PASS | no change |
| packages/db (live DB) | 4/4 PASS | **4/4 FAIL** (ECONNREFUSED) | Postgres not available this run |
| typecheck | 8/8 PASS | 8/8 PASS | no change |
| lint | 8/8 PASS | 8/8 PASS | FIXED — require() regression removed this run |
| build | 4/4 PASS | 4/4 PASS | FIXED — cascaded from lint fix |
| security (high/critical) | 0 | 0 | no change |

### Regression introduced and fixed this run

`apps/web/src/__tests__/structure.test.ts` lines 300-301 had `require('fs')` and `require('path')` inside a `try` block (introduced by CORRECTION_3), violating `@typescript-eslint/no-require-imports`. Fixed by removing the two redundant `require()` calls — `readFileSync` and `join` were already imported as ES modules at lines 13-14.

---

## Notes

1. **apps/web unit tests grew from 24 to 29.** Five additional tests were added in the working-tree changes (CORRECTION_3). The new tests themselves pass; only the `require()` style used in the describe block setup code causes the lint/build failure.

2. **Vitest version split** (v3.2.4 in apps/packages vs v4.1.5 in tests/foundation and packages/db) is unchanged and functional.

3. **Staged `apps/api/src/app.ts` change.** Git status shows a staged change to `apps/api/src/app.ts` that added the regression line; the working tree has that line removed. Vitest and `tsc` run from working tree and see the correct file, so typecheck and unit tests pass. However, this unstaged removal should be committed to clean up git state.

4. **Coverage tooling absent.** `@vitest/coverage-v8` is not installed; no `coverage` script exists. The >=80% line coverage gate criterion cannot be measured. Carried forward as an open item.

5. **Graceful-shutdown test absent.** No test exercises SIGTERM + in-flight request draining. Carried forward.

6. **`pnpm db:migrate` from root untested.** Requires live DB; not a test-runner concern.
