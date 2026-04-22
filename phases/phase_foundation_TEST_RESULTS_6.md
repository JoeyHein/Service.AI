# Test Results — phase_foundation — Run 6

**Date**: 2026-04-22
**Runner**: test-runner agent
**Git SHA**: 0e258b52f5be627127746a40d963a56fc8cba302

## Summary

| Suite | Status | Tests | Pass | Fail | Skip |
|---|---|---|---|---|---|
| build | PASS | — | — | — | — |
| typecheck | PASS | — | — | — | — |
| lint | PASS | — | — | — | — |
| unit/integration | FAIL | 138 | 120 | 16 | 4 (+ 2 path-only) |
| foundation acceptance | ERROR | — | — | — | — |
| security | PASS (--audit-level=high) | — | — | — | — |
| e2e | SKIP | — | — | — | — |
| perf | SKIP | — | — | — | — |

**Overall**: FAIL

---

## Build

Command: `pnpm run build` (turbo run build)
Exit code: 0

All 4 buildable packages hit cache. Full TURBO in 466ms.

```
Tasks:    4 successful, 4 total
Cached:    4 cached, 4 total
  Time:    466ms >>> FULL TURBO
```

Package outcomes:
- `@service-ai/db`: cache hit, tsc — PASS
- `@service-ai/api`: cache hit, tsc — PASS
- `@service-ai/voice`: cache hit, tsc — PASS
- `@service-ai/web`: cache hit, Next.js 15 production build — PASS

---

## Typecheck

Command: `pnpm run typecheck` (turbo run typecheck)
Exit code: 0

All 8 packages typechecked (full cache). 67ms total.

```
Tasks:    8 successful, 8 total
Cached:    8 cached, 8 total
  Time:    67ms >>> FULL TURBO
```

No type errors in any package.

---

## Lint

Command: `pnpm run lint` (turbo run lint)
Exit code: 0

All 8 packages linted (full cache). 60ms total.

```
Tasks:    8 successful, 8 total
Cached:    8 cached, 8 total
  Time:    60ms >>> FULL TURBO
```

No lint errors. Informational `MODULE_TYPELESS_PACKAGE_JSON` warning present in all 8 packages — unchanged from prior runs, not an error.

---

## Unit / Integration Tests

### packages/contracts

Vitest v3.2.4 | 1 test file

```
Test Files  1 failed (1)
     Tests  2 failed | 19 passed (21)
   Duration  439ms
```

**FAIL — 2 tests**: `TASK-FND-06 / contracts package / file existence`

```
× echo.ts source file exists at the expected path
× index.ts re-exports from echo.ts
```

Root cause: tests call `existsSync('/workspace/packages/contracts/src/echo.ts')` — a hardcoded Linux/Docker container path. On Windows the files exist at `C:\Users\jhein\servicetitan-clone\packages\contracts\src\echo.ts`. This is a test portability defect: the files exist, but the path assertion fails on Windows. All 19 functional tests (contract shape, Zod schema, route definitions) pass correctly.

### packages/db

Vitest v4.1.5 | 1 test file

```
Test Files  1 passed (1)
     Tests  15 passed | 4 skipped (19)
   Duration  540ms
```

15 static tests pass (schema shape, up/down migration SQL correctness). 4 live integration tests are correctly skipped — they guard with `checkPostgresReachable()` and emit `ctx.skip()` when Postgres is unreachable. No Docker services running in this environment.

### apps/api

Vitest v3.2.4 | 3 test files

```
Test Files  1 failed | 2 passed (3)
     Tests  14 failed | 41 passed (55)
   Duration  72.16s
```

**PASS** — `echo.test.ts` (20 tests), `shutdown.test.ts` (6 tests): all 26 pass.

**FAIL — 14 tests** in `health.test.ts`:

```
TASK-FND-03 / GET /healthz — happy path (6 fails)
  × returns HTTP 200 when DB and Redis are both reachable
  × returns Content-Type application/json
  × response body contains ok: true
  × response body contains db: "up"
  × response body contains redis: "up"
  × response body has exactly the three expected keys (ok, db, redis)

TASK-FND-03 / GET /healthz — DB unreachable (4 fails)
  × returns HTTP 503 when the DB health check throws
  × response body contains db: "down" when DB throws
  × response body contains ok: false when DB throws
  × still includes redis status in the body when DB is down

TASK-FND-03 / structured logging and request ID (2 fails)
  × includes a request-id header in every response
  × request-id changes between requests (unique per request)

TASK-FND-03 / security headers via @fastify/helmet (2 fails)
  × sets X-Content-Type-Options: nosniff header
  × sets X-Frame-Options or Content-Security-Policy header (helmet active)
```

Root cause: unlike `packages/db`, the API health tests have no skip guard for infrastructure unavailability. The "happy path" suite creates `buildApp()` with real Postgres and Redis dependencies — both are unreachable (ECONNREFUSED), causing the healthz endpoint to return 503 instead of 200. The "DB unreachable" suite injects a mock DB but uses a real Redis client — Redis is also unreachable. The 14-failure set cascades from the first app.inject() call in each group timing out waiting for connection resolution (~10s each), so total duration was 72s. This is a missing skip-guard defect in the test suite, not a production code defect.

### apps/web

Vitest v3.2.4 | 1 test file

```
Test Files  1 passed (1)
     Tests  32 passed (32)
   Duration  1.10s
```

All 32 structure tests pass.

### apps/voice

Vitest v3.2.4 | 1 test file

```
Test Files  1 passed (1)
     Tests  11 passed (11)
   Duration  1.20s
```

All 11 tests pass (healthz, WebSocket handshake, ping/pong, latency, concurrent clients).

### packages/auth, packages/ai, packages/ui

Stub packages — no tests.

```
No tests in stub package   (exit 0 for all three)
```

### Overall unit/integration count

| Package | Pass | Fail | Skip |
|---|---|---|---|
| packages/contracts | 19 | 2 | 0 |
| packages/db | 15 | 0 | 4 |
| apps/api | 41 | 14 | 0 |
| apps/web | 32 | 0 | 0 |
| apps/voice | 11 | 0 | 0 |
| **Total** | **118** | **16** | **4** |

---

## Foundation Acceptance Tests

Command: `tests/foundation/node_modules/.bin/vitest run`
Exit code: 1 (Startup Error — never ran)

```
⎯⎯⎯⎯⎯⎯⎯ Startup Error ⎯⎯⎯⎯⎯⎯⎯
Error: Cannot find native binding.
Cause: Cannot find module '@rolldown/binding-win32-x64-msvc'
```

Root cause: `rolldown@1.0.0-rc.16` (a transitive dependency pulled in by `vitest@4.1.5`) requires platform-specific native binaries. The `@rolldown/binding-win32-x64-msvc` optional dependency was not installed into the `tests/foundation` package's local `node_modules` tree. This is a `pnpm install` issue specific to the `tests/foundation` sub-package — the root workspace resolves rolldown correctly but the nested install in `tests/foundation/` did not populate the Windows native binding.

No foundation acceptance tests executed. Files affected: `fnd-01-monorepo.test.ts`, `fnd-07-ci.test.ts`, `fnd-08-observability.test.ts`, `fnd-09-do-spec.test.ts`, `fnd-10-compose.test.ts`.

Fix: run `pnpm install` (or reinstall) inside `tests/foundation/` to pull the Windows-platform optional dependency.

---

## Security Scan

Command: `pnpm audit --audit-level=high`
Exit code: 0 (gate passes — no high or critical vulnerabilities)

Full audit (`pnpm audit`) exits with code 1 (moderate violations present):

```
3 vulnerabilities found
Severity: 3 moderate
```

**GHSA-67mh-4wv8-2f99** — esbuild `<=0.24.2` cross-origin dev-server requests
- Paths: vitest/vite toolchain (19 dependency paths); also `drizzle-kit > @esbuild-kit/esm-loader > esbuild@0.18.20`
- Patched at: `esbuild >=0.25.0`
- Severity: moderate; dev-only, no production exposure

**GHSA-4w7w-66w2-5vf9** — Vite `<=6.4.1` path traversal in optimized deps `.map` handling
- Paths: vitest/vite toolchain (18 dependency paths)
- Patched at: `vite >=6.4.2`
- Severity: moderate; dev-only, no production exposure

The third counted instance is a duplicate path for GHSA-67mh-4wv8-2f99 via `drizzle-kit`. All are dev/test toolchain transitive deps with no production artifact exposure. `--audit-level=high` gate: **PASS**.

---

## E2E

Not run — `tests/e2e/` directory does not exist for this phase.

---

## Performance Baseline

Not run — `tests/perf/` directory does not exist for this phase.

---

## Failures Detail

### BLOCKER-1: `packages/contracts` — hardcoded `/workspace/` path in 2 tests

File: `packages/contracts/src/__tests__/echo.test.ts` lines 27, 35

Tests call `existsSync('/workspace/packages/contracts/src/echo.ts')` and `existsSync('/workspace/packages/contracts/src/index.ts')`. These are Docker-container-absolute paths that fail on the developer's Windows machine. The files exist at the correct relative locations; the assertions are false only because of the hardcoded prefix.

Fix: replace hardcoded paths with `resolve(__dirname, '..', 'echo.ts')` and `resolve(__dirname, '..', 'index.ts')`.

### BLOCKER-2: `apps/api` — 14 tests in `health.test.ts` fail without live infrastructure

The happy-path suite (6 tests) and the structured-logging/security-headers suites (4 tests) call `buildApp()` with real Postgres and Redis dependencies. No skip guard exists. When Postgres and Redis are unavailable (ECONNREFUSED), `buildApp()` still boots but the healthz endpoint returns 503 for all requests, causing assertion failures and long timeouts (~10s per test for Redis connection resolution).

The DB-unreachable suite (4 tests) injects a mock DB but still instantiates a real Redis client — Redis is also unreachable, so the response body differs from expectations.

Fix options (any one resolves the blockers):
1. Add a Redis skip guard similar to `packages/db`'s `checkPostgresReachable()`.
2. Accept a `redis` override in `buildApp()` alongside the existing `db` override and inject mock Redis in tests.
3. Start Docker services (`docker compose up -d`) before running the full suite.

### BLOCKER-3: `tests/foundation` — Startup Error, 0 tests executed

`rolldown@1.0.0-rc.16` native binding `@rolldown/binding-win32-x64-msvc` missing from `tests/foundation/node_modules`. None of the 5 foundation acceptance test files ran.

Fix: `cd tests/foundation && pnpm install` to reinstall with correct platform bindings.

---

## Notes

1. **All build, typecheck, lint artifacts** are correct and cached. No regressions in compiled outputs.
2. **apps/voice** and **apps/web** tests are clean. No regressions.
3. **packages/db** skip behavior is correct and intentional — the 4 live integration tests require Docker Postgres.
4. **Test run duration anomaly**: `apps/api` health.test.ts took 72s (vs ~20s in prior passing runs). This is because the Redis ECONNREFUSED causes each inject() call to wait for a connection attempt before returning, multiplying across 14 failing tests.
5. **Prior run comparison**: TEST_RESULTS_5 showed 138/138 passing. The regressions in this run are environment-state failures (no Docker services), not code regressions. The contracts path failure may have been masked in prior runs if they were executed inside Docker or on Linux.

## Verdict

FAIL

Blockers: 3
- BLOCKER-1: contracts path portability (2 test failures)
- BLOCKER-2: API health tests missing infrastructure skip guard (14 test failures)
- BLOCKER-3: foundation acceptance suite startup error (0/5 files executed)
