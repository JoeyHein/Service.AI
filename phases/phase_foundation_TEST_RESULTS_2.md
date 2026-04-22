# phase_foundation — Test Results Run 2

**Date**: 2026-04-21
**Runner**: test-runner agent (claude-sonnet-4-6)
**Branch**: main
**Commit**: db987187 (HEAD) + 1 staged change to `apps/api/src/app.ts`

---

## Summary

| Suite | Status | Pass | Fail | Skip | Duration |
|---|---|---|---|---|---|
| unit/integration (foundation phase tests) | PASS | 132 | 0 | 0 | 1.60s |
| unit/integration (apps/api) | PASS | 48 | 0 | 0 | 16.68s |
| unit/integration (apps/voice) | PASS | 11 | 0 | 0 | 7.02s |
| unit/integration (apps/web) | PASS | 20 | 0 | 0 | 8.46s |
| unit/integration (packages/contracts) | PASS | 20 | 0 | 0 | 2.42s |
| unit/integration (packages/db — schema/SQL only) | PASS | 15 | 0 | 0 | — |
| unit/integration (packages/db — live DB) | FAIL | 15 | 4 | 0 | 5.18s |
| unit/integration (packages/ai) | SKIP | 0 | 0 | — | — (stub) |
| unit/integration (packages/auth) | SKIP | 0 | 0 | — | — (stub) |
| unit/integration (packages/ui) | SKIP | 0 | 0 | — | — (stub) |
| typecheck | **FAIL** | 7/8 pkgs | **1** | 0 | 24.8s |
| lint | **FAIL** | 7/8 pkgs | **1** | 0 | 26.3s |
| build | **FAIL** | 3/4 tasks | **1** | 0 | 24.5s |
| security scan (pnpm audit) | WARNING | — | — | — | — |
| e2e | NOT RUN | — | — | — | Not configured |
| perf baseline | NOT RUN | — | — | — | Not configured |

**Overall result: FAIL** — New regression in `apps/api/src/app.ts` blocks typecheck, lint, and build.

---

## Failures

### REGRESSION — apps/api: type error + lint error at line 182

A line was added to `apps/api/src/app.ts` after the last gate-approved commit (`db987187`) that introduces two defects:

**File**: `apps/api/src/app.ts`  
**Line**: 182  
**Content**: `const x: number = "this is a string";`

This line is a **staged working-tree change** (not yet committed), visible in `git diff HEAD -- apps/api/src/app.ts`.

**TypeScript error** (`apps/api` typecheck — exit code 2):
```
src/app.ts(182,7): error TS2322: Type 'string' is not assignable to type 'number'.
```

**Lint error** (`apps/api` lint — exit code 1):
```
/workspace/apps/api/src/app.ts
  182:7  error  'x' is assigned a value but never used  @typescript-eslint/no-unused-vars
```

**Build error** (`apps/api` build — exit code 2):
```
src/app.ts(182,7): error TS2322: Type 'string' is not assignable to type 'number'.
```

**Root cause**: The line `const x: number = "this is a string";` appended after the closing `}` of `buildApp()` is a deliberate type-safety violation and dead code. It violates the project's TypeScript strict mode and `@typescript-eslint/no-unused-vars` lint rules.

**Resolution required**: Remove line 182 from `apps/api/src/app.ts`.

---

### KNOWN INFRASTRUCTURE — packages/db: live Postgres integration tests (unchanged)

4 tests in `packages/db/src/__tests__/health-checks.test.ts` under the `health_checks live integration` describe block fail because no Postgres container is running at `localhost:5434` in this CI environment.

```
Error: connect ECONNREFUSED 127.0.0.1:5434
```

**Failing tests (all ECONNREFUSED)**:
- `inserts and retrieves a health_check row`
- `rejects a row with a service value exceeding 100 characters`
- `rejects a row with a status value exceeding 20 characters`
- `defaults checked_at to the current timestamp when not supplied`

These 4 failures are identical to Run 1 and are **infrastructure-only** — the schema, SQL, and Drizzle code are correct. These tests require `docker-compose up` with the Postgres service. Not a code defect.

---

## Detail: Passing Suites

### Foundation phase acceptance tests — 132/132 PASS

`tests/foundation/` — Vitest v4.1.5

| File | Tests | Result |
|---|---|---|
| fnd-01-monorepo.test.ts | ~50 | PASS |
| fnd-07-ci.test.ts | ~22 | PASS |
| fnd-08-observability.test.ts | ~17 | PASS |
| fnd-09-do-spec.test.ts | ~15 | PASS |
| fnd-10-compose.test.ts | ~28 | PASS |

### apps/api — 48/48 PASS

`apps/api/src/__tests__/` — Vitest v3.2.4

| File | Tests | Result |
|---|---|---|
| health.test.ts | 28 | PASS |
| echo.test.ts | 20 | PASS |

Note: unit tests pass because Vitest executes source via transpilation and does not invoke `tsc` type checking.

### apps/voice — 11/11 PASS

`apps/voice/src/__tests__/voice.test.ts` — Vitest v3.2.4, 10 s timeout

### apps/web — 20/20 PASS

`apps/web/src/__tests__/structure.test.ts` — Vitest v3.2.4

### packages/contracts — 20/20 PASS

`packages/contracts/src/__tests__/echo.test.ts` — Vitest v3.2.4

### packages/db — 15/19 PASS

15 schema/SQL tests pass; 4 live-DB tests fail (ECONNREFUSED, see above).

### Stub packages — SKIP (expected)

`packages/ai`, `packages/auth`, `packages/ui` — all echo `'No tests in stub package'` and exit 0 per convention.

---

## Typecheck Detail

| Package | Result | Notes |
|---|---|---|
| apps/api | **FAIL** | TS2322 at line 182 — `Type 'string' is not assignable to type 'number'` |
| apps/voice | PASS | |
| apps/web | PASS | |
| packages/contracts | PASS | |
| packages/db | PASS | |
| packages/ai | PASS | |
| packages/auth | PASS | |
| packages/ui | PASS | |

---

## Lint Detail

| Package | Result | Notes |
|---|---|---|
| apps/api | **FAIL** | `no-unused-vars` at line 182 — `'x' is assigned a value but never used` |
| apps/voice | PASS | |
| apps/web | PASS | |
| packages/contracts | PASS | |
| packages/db | PASS | |
| packages/ai | PASS | |
| packages/auth | PASS | |
| packages/ui | PASS | |

Note: all packages emit a Node.js warning about `MODULE_TYPELESS_PACKAGE_JSON` for the root `eslint.config.js` due to missing `"type": "module"` in root `package.json`. This is a non-fatal warning; lint still succeeds for passing packages.

---

## Build Detail

| Task | Result | Notes |
|---|---|---|
| apps/api | **FAIL** | TS2322 at line 182 prevents `tsc` from emitting |
| apps/voice | PASS | cached |
| apps/web | PASS | cached — Next.js production build successful (4 static pages) |
| packages/db | PASS | cached |

---

## E2E Tests

**Not run.** No `tests/e2e/` directory and no Playwright configuration exist. E2E infrastructure is not required for phase_foundation.

---

## Performance Baseline

**Not run.** No `tests/perf/` directory and no k6 scripts exist. Performance test infrastructure is not required for phase_foundation.

---

## Security Scan

`pnpm audit --audit-level=moderate` — **3 moderate vulnerabilities** (all in dev toolchain, not production code paths).

| CVE / Advisory | Package | Severity | Vulnerable Versions | Fixed In | Affected Path |
|---|---|---|---|---|---|
| GHSA-67mh-4wv8-2f99 | esbuild | moderate | <=0.24.2 | >=0.25.0 | vitest → vite → esbuild |
| GHSA-4w7w-66w2-5vf9 | vite | moderate | <=6.4.1 | >=6.4.2 | vitest → vite |
| (3rd moderate) | esbuild / vite (transitive) | moderate | — | — | dev toolchain |

All three moderate findings are in the `vitest` → `vite` → `esbuild` dev dependency chain. They are not reachable in production builds or at runtime. These match the findings documented in AUDIT-3 and the root `package.json` `pnpm.overrides` section from phase_foundation corrections.

No HIGH or CRITICAL vulnerabilities found.

---

## Comparison vs Run 1

| Check | Run 1 | Run 2 | Delta |
|---|---|---|---|
| Foundation phase tests | 132/132 PASS | 132/132 PASS | no change |
| apps/api unit tests | 48/48 PASS | 48/48 PASS | no change |
| apps/voice unit tests | 11/11 PASS | 11/11 PASS | no change |
| apps/web unit tests | 20/20 PASS | 20/20 PASS | no change |
| packages/contracts | 20/20 PASS | 20/20 PASS | no change |
| packages/db (schema) | 15/15 PASS | 15/15 PASS | no change |
| packages/db (live) | 4 FAIL (infra) | 4 FAIL (infra) | no change |
| typecheck | **8/8 PASS** | **7/8 FAIL** | **REGRESSION** |
| lint | **8/8 PASS** | **7/8 FAIL** | **REGRESSION** |
| build | **4/4 PASS** | **3/4 FAIL** | **REGRESSION** |
| security | 3 moderate | 3 moderate | no change |

**New regression introduced between Run 1 and Run 2**: `const x: number = "this is a string";` appended to `apps/api/src/app.ts` line 182 as a staged (uncommitted) working-tree change.
