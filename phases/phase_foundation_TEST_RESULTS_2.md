# Test Results — phase_foundation — Run 2 (re-issued post CORRECTION-5)

**Date**: 2026-04-22
**Runner**: test-runner agent (claude-sonnet-4-6)
**Branch**: main
**Commit**: 78f54d8 (feat(foundation): CORRECTION-5 resolve AUDIT-8 blockers B1-B2 + majors M2-M3)

> This file supersedes the earlier Run 2 entry. The previous Run 2 was executed against a pre-CORRECTION-5 state and showed a regression in apps/api. This run reflects the current HEAD after all five corrections have been applied.

---

# Summary (current state — post CORRECTION-5)

| Suite | Status | Tests | Passed | Failed | Skipped | Duration |
|---|---|---|---|---|---|---|
| Build | FAIL | — | 3/4 pkgs | 1 (web, Windows only) | — | ~400ms |
| Typecheck | PASS | — | 8/8 pkgs | 0 | — | 3.4s |
| Lint | PASS | — | 8/8 pkgs | 0 | — | 1.5s |
| Unit/Integration | PASS | 138 | 134 | 0 | 4 | ~5s |
| Foundation acceptance | FAIL | 132 | 3 | 129 | — | 539ms |
| E2E | SKIP | — | — | — | — | — |
| Performance | SKIP | — | — | — | — | — |
| Security | PASS (high) | — | — | — | — | — |

**Overall: FAIL**

Active failure categories:
1. `apps/web` build script: `NODE_ENV=production next build` (POSIX env-var syntax fails on Windows cmd.exe)
2. Foundation acceptance suite: `ROOT = "/workspace"` hardcoded Linux/Docker path — all 129 failures are path-resolution mismatches on Windows
3. 4 intentional skips in `packages/db` (live Postgres integration, no Docker running — correct behavior)

---

## Build

Command: `pnpm build` (turbo run build)
Exit code: 1

```
@service-ai/api:build:   tsc — PASS
@service-ai/db:build:    tsc — PASS
@service-ai/voice:build: tsc (cache hit) — PASS
@service-ai/web:build:   'NODE_ENV' is not recognized as an internal or external command — FAIL
Tasks: 1 successful, 4 total
Failed: @service-ai/web#build
```

Root cause: `apps/web/package.json` build script is `"build": "NODE_ENV=production next build"`. On Windows cmd.exe, inline env-var assignment is not valid. CI (ubuntu-latest) is unaffected. Turbo caches the web build result, so `pnpm test` still passes because turbo.json test task does not depend on web's build.

Fix: add `cross-env` devDependency; change build script to `"cross-env NODE_ENV=production next build"`.

---

## Typecheck

Command: `pnpm typecheck` (turbo run typecheck)
Exit code: 0

```
Tasks: 8 successful, 8 total
Time: 3.404s
```

All 8 packages type-check cleanly. No type errors.

---

## Lint

Command: `pnpm lint` (turbo run lint)
Exit code: 0

```
Tasks: 8 successful, 8 total
Time: 1.532s
```

No lint errors. Informational `MODULE_TYPELESS_PACKAGE_JSON` warning present in all packages (unchanged from prior runs — not an error).

---

## Unit / Integration Tests

Command: `pnpm test` (turbo run test)
Exit code: 0

```
Tasks: 8 successful, 8 total
Time: 3.117s
```

### packages/contracts

Vitest v3.2.4

```
Test Files  1 passed (1)
     Tests  21 passed (21)
  Duration  943ms
```

CORRECTION-5 fixed path portability: tests now use `resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')` as PKG_ROOT. All 21 tests pass (was 2 failing in Run 6).

### packages/db

Vitest v4.1.5

```
Test Files  1 passed (1)
     Tests  15 passed | 4 skipped (19)
  Duration  1.28s
```

15 static schema/migration tests pass. 4 live integration tests skip via `checkPostgresReachable()` guard. Correct and intentional.

### apps/api

Vitest v3.2.4

```
Test Files  3 passed (3)
     Tests  55 passed (55)
  Duration  1.53s
```

Full regression fixed. CORRECTION-5 added `redis` override parameter to `buildApp()` so tests inject mockRedis alongside mockDb. All 29 health.test.ts tests pass (was 14 failing in Run 6). Duration: 1.53s (was 72s due to connection timeouts).

### apps/web

Vitest v3.2.4

```
Test Files  1 passed (1)
     Tests  32 passed (32)
  Duration  1.22s
```

### apps/voice

Vitest v3.2.4 (cache hit)

```
Test Files  1 passed (1)
     Tests  11 passed (11)
```

### packages/auth, packages/ai, packages/ui

Stub packages — `echo 'No tests in stub package'` — exit 0.

### Aggregate

| Package | Pass | Fail | Skip |
|---|---|---|---|
| packages/contracts | 21 | 0 | 0 |
| packages/db | 15 | 0 | 4 |
| apps/api | 55 | 0 | 0 |
| apps/web | 32 | 0 | 0 |
| apps/voice | 11 | 0 | 0 |
| **Total** | **134** | **0** | **4** |

---

## Foundation Acceptance Tests

Command: `tests/foundation/node_modules/.bin/vitest run`

The `rolldown@1.0.0-rc.16` Windows native binding was missing (lockfile pinned Linux-only `@rolldown/binding-linux-x64-gnu`). Fixed this session by running `pnpm add @rolldown/binding-win32-x64-msvc --save-dev` inside `tests/foundation/`. Suite now runs but all test files use `ROOT = "/workspace"`.

Exit code: 1

```
Test Files  5 failed (5)
     Tests  129 failed | 3 passed (132)
  Duration  539ms
```

Passing (3): all in `fnd-01-monorepo.test.ts` — the Prettier config non-empty check (skips when no JSON file found), the `@service-ai/*` scoped name check, and the no-strict-false override check. These pass because they iterate over workspace paths and continue on missing files.

All 129 failures share the same root cause: `const ROOT = "/workspace"` at the top of every test file resolves to `\workspace\` on Windows (a non-existent path). Every `existsSync()` and `readFile()` call fails.

The actual implementation artifacts all exist and are correct:
- `.github/workflows/ci.yml` — GHA workflow with typecheck/lint/test/build jobs, pnpm, caching, checkout
- `.do/app.yaml` — web/api/voice services, Postgres + Redis, ports 3000/3001/8080, branch deploy
- `docker-compose.yml` — web/api/voice/postgres/redis, port mappings 3000/3001/8080/5434/6381, volume mounts, DATABASE_URL/REDIS_URL, build-net network (occurrences > 4)
- `.husky/pre-commit` — runs `pnpm -r typecheck && pnpm -r lint`
- All workspace `tsconfig.json` files extend `../../tsconfig.base.json`
- `apps/api` package.json has `@axiomhq/pino` and `@sentry/node`; `apps/voice` has same; `apps/web` has `@sentry/nextjs`
- `apps/api/src/` contains `AXIOM_TOKEN` guard, `SENTRY_DSN` guard, `redact` config, `authorization` in redact list, `Sentry.init` call

Per-file failure counts:

| File | Failed | Passed | Root cause |
|---|---|---|---|
| fnd-01-monorepo.test.ts | 64 | 3 | ROOT="/workspace" |
| fnd-07-ci.test.ts | 22 | 0 | ROOT="/workspace" |
| fnd-08-observability.test.ts | 11 | 0 | ROOT="/workspace" |
| fnd-09-do-spec.test.ts | 15 | 0 | ROOT="/workspace" |
| fnd-10-compose.test.ts | 17 | 0 | ROOT="/workspace" |

---

## E2E Tests

SKIP — `tests/e2e/` directory does not exist for this phase.

---

## Performance Baseline

SKIP — `tests/perf/` directory does not exist for this phase.

---

## Security Scan

`pnpm audit --audit-level=high`: exit code 0 — **PASS**, no high or critical vulnerabilities.

`pnpm audit` (all severities):

```
3 vulnerabilities found
Severity: 3 moderate
```

**GHSA-67mh-4wv8-2f99** — esbuild `<=0.24.2` cross-origin dev-server requests; patched at `>=0.25.0`; dev toolchain only (vitest/vite, drizzle-kit).

**GHSA-4w7w-66w2-5vf9** — Vite `<=6.4.1` path traversal in optimized deps; patched at `>=6.4.2`; dev toolchain only (vitest/vite).

Both are transitive dev-only dependencies with no production artifact exposure. Unchanged from Run 6.

Semgrep: SKIP — not installed.

---

## Failures

### F-1: apps/web build script — Windows-incompatible inline env-var syntax
- **File**: `apps/web/package.json`, `scripts.build`
- **Error**: `'NODE_ENV' is not recognized as an internal or external command, operable program or batch file.`
- **Severity**: major (blocks `pnpm build` on Windows; CI unaffected — ubuntu-latest)
- **Fix**: Install `cross-env` devDependency; change to `cross-env NODE_ENV=production next build`

### F-2: tests/foundation — ROOT="/workspace" hardcoded Linux path (129 test failures)
- **Files**: `tests/foundation/fnd-01-monorepo.test.ts:7`, `fnd-07-ci.test.ts:14`, `fnd-08-observability.test.ts:12`, `fnd-09-do-spec.test.ts:8`, `fnd-10-compose.test.ts:9`
- **Error**: `Error: Expected file not found: \workspace\<path>` for every file existence check
- **Severity**: major (all 5 foundation acceptance test files cannot run on native Windows)
- **Fix**: Replace `const ROOT = "/workspace"` in all 5 files with:
  ```typescript
  import { resolve, dirname } from "path";
  import { fileURLToPath } from "url";
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  ```
  This resolves to the actual repo root on any platform.

### F-3: tests/foundation — rolldown Windows binding absent from lockfile
- **File**: `tests/foundation/pnpm-lock.yaml`
- **Error**: `Cannot find module '@rolldown/binding-win32-x64-msvc'` (startup crash before any test runs)
- **Severity**: blocker on Windows (fixed this session by manually adding the binding; lockfile fix needed)
- **Fix**: Commit `tests/foundation/package.json` with `@rolldown/binding-win32-x64-msvc` as devDependency and regenerate lockfile. Alternatively pin vitest to `^3.x` (no rolldown dependency) to match the workspace packages.

---

## Verdict

ACTIONABLE_FAILURES

Unit/integration suite is fully green (134 pass, 0 fail, 4 intentional infrastructure skips). CORRECTION-5 successfully resolved BLOCKER-1 (contracts path) and BLOCKER-2 (API health test mock injection). Two test-infrastructure issues prevent a clean run on Windows: (1) web build script needs `cross-env`, (2) foundation acceptance suite has hardcoded `/workspace` Docker paths. Implementation artifacts for all foundation tasks appear correct; only the test runner configuration needs updating.

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
