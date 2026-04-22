# phase_foundation — Test Results Run 3

**Date**: 2026-04-22
**Runner**: test-runner agent (claude-sonnet-4-6)
**Branch**: main
**Commit**: db987187 + staged/working-tree changes from CORRECTION_1 and CORRECTION_2

---

## Summary

| Suite | Status | Pass | Fail | Skip | Duration |
|---|---|---|---|---|---|
| unit/integration (tests/foundation) | PASS | 132 | 0 | 0 | 1.85s |
| unit/integration (apps/api) | PASS | 49 | 0 | 0 | 17.26s |
| unit/integration (apps/voice) | PASS | 11 | 0 | 0 | 13.09s |
| unit/integration (apps/web) | PASS | 24 | 0 | 0 | 9.86s |
| unit/integration (packages/contracts) | PASS | 21 | 0 | 0 | 4.01s |
| unit/integration (packages/db) | PASS | 19 | 0 | 0 | 5.50s |
| unit/integration (packages/ai) | SKIP | — | — | — | stub |
| unit/integration (packages/auth) | SKIP | — | — | — | stub |
| unit/integration (packages/ui) | SKIP | — | — | — | stub |
| typecheck | PASS | 8/8 pkgs | 0 | 0 | 40.14s |
| lint | PASS | 8/8 pkgs | 0 | 0 | 50.63s |
| build | PASS | 4/4 tasks | 0 | 0 | 2m 8s |
| security scan (`pnpm audit --audit-level=high`) | PASS | — | 0 high/critical | — | — |
| e2e | NOT RUN | — | — | — | Not configured |
| perf baseline | NOT RUN | — | — | — | Not configured |

**Overall result: PASS** — All 256 tests pass across unit, integration, and acceptance suites. Typecheck, lint, and build are clean. No high or critical CVEs.

---

## Detail: Unit / Integration Tests

### Foundation phase acceptance tests — 132/132 PASS

`tests/foundation/` — Vitest v4.1.5

| File | Tests | Status |
|---|---|---|
| fnd-01-monorepo.test.ts | 67 | PASS |
| fnd-07-ci.test.ts | 22 | PASS |
| fnd-08-observability.test.ts | 11 | PASS |
| fnd-09-do-spec.test.ts | 15 | PASS |
| fnd-10-compose.test.ts | 17 | PASS |

Coverage includes: monorepo structure, pnpm-workspace, turbo pipeline, tsconfig strict mode, workspace package.json names, Husky pre-commit hooks, GitHub Actions CI job definitions (typecheck/lint/test/build), pnpm caching, Axiom/Sentry SDK dependencies, env-var guards, pino redact config, DigitalOcean app spec, README rollback section, docker-compose service topology (5 services, port mappings, volumes, shared network).

### apps/api — 49/49 PASS

`apps/api/src/__tests__/` — Vitest v3.2.4

| File | Tests | Status |
|---|---|---|
| health.test.ts | 29 | PASS |
| echo.test.ts | 20 | PASS |

`health.test.ts` covers: application bootstrap, GET /healthz happy path (200), DB unreachable (503), Redis unreachable (503), both unreachable (503), structured pino JSON logging, X-Request-ID header echoing, Helmet security headers, CORS preflight (204), unknown route 404, and a regression test confirming `pino-pretty` is in devDependencies and logger wiring imports are active.

`echo.test.ts` covers: POST /api/v1/echo happy path, roundtrip fidelity, 400 on invalid input, response envelope shape, edge cases.

### apps/voice — 11/11 PASS

`apps/voice/src/__tests__/voice.test.ts` — Vitest v3.2.4 (10 s per-test timeout)

Covers: GET /healthz 200, WebSocket upgrade handshake for `/call`, structured pino JSON logging, server listening startup.

### apps/web — 24/24 PASS

`apps/web/src/__tests__/structure.test.ts` — Vitest v3.2.4

Covers: Next.js 15 app directory structure, App Router layout/page files, Tailwind directives, shadcn/ui presence, package.json dependency declarations, JSX TypeScript configuration, `next.config.ts` Sentry `withSentryConfig` wrapper, `src/app/global-error.tsx` Client Component existence (React render error capture), ts-rest `initClient` wiring, `apiClient.echo` type-safe call present.

### packages/contracts — 21/21 PASS

`packages/contracts/src/__tests__/echo.test.ts` — Vitest v3.2.4

Covers: file existence, `echoContract` export, ts-rest route definition shape, Zod input/response schema validation, numeric key casting correctness (regression test for AUDIT-2 fix).

### packages/db — 19/19 PASS

`packages/db/src/__tests__/health-checks.test.ts` — Vitest v4.1.5

| Group | Tests | Status |
|---|---|---|
| Schema shape (Drizzle column definitions) | 5 | PASS |
| Up-migration SQL structure | 7 | PASS |
| Down-migration SQL | 3 | PASS |
| Live Postgres integration (localhost:5434) | 4 | PASS |

All 4 live integration tests pass this run — Postgres is reachable at `localhost:5434` in the current environment. Tests exercise insert, read, constraint violations (>100 char service, >20 char status), and `checked_at` timestamp defaulting.

### Stub packages — SKIP (expected)

`packages/ai`, `packages/auth`, `packages/ui` — echo `'No tests in stub package'` and exit 0 per convention.

---

## Typecheck

`pnpm typecheck` — Turborepo (8 packages)

| Package | Result | Notes |
|---|---|---|
| apps/api | PASS | 3 fresh — 0 errors |
| apps/web | PASS | 1 fresh — 0 errors |
| apps/voice | PASS | cached |
| packages/contracts | PASS | 1 fresh — 0 errors |
| packages/db | PASS | cached |
| packages/ai | PASS | cached |
| packages/auth | PASS | cached |
| packages/ui | PASS | cached |

**8/8 packages pass.** The `Type 'string' is not assignable to type 'number'` regression (line 182 in `apps/api/src/app.ts`) that blocked Run 2 has been removed.

---

## Lint

`pnpm lint` — Turborepo (8 packages)

| Package | Result | Notes |
|---|---|---|
| apps/api | PASS | 0 errors |
| apps/web | PASS | 0 errors; `next lint` deprecation warning (cosmetic) |
| apps/voice | PASS | cached |
| packages/contracts | PASS | 0 errors |
| packages/db | PASS | cached |
| packages/ai | PASS | cached |
| packages/auth | PASS | cached |
| packages/ui | PASS | cached |

**8/8 packages pass.** The `@typescript-eslint/no-unused-vars` violation from the regression line that blocked Run 2 is gone.

Non-fatal warnings (present in all runs, unchanged):
- All packages: `MODULE_TYPELESS_PACKAGE_JSON` — root `package.json` lacks `"type": "module"`. Cosmetic; lint succeeds.
- `apps/web`: `next lint` CLI deprecated in Next.js 15. Cosmetic; lint succeeds.
- `apps/web`: Next.js ESLint plugin not detected in `eslint.config.js`. Cosmetic; no errors emitted.

---

## Build

`pnpm build` — Turborepo (4 compilable targets)

| Task | Result | Notes |
|---|---|---|
| apps/api | PASS | fresh `tsc` — emits to `dist/` |
| apps/web | PASS | fresh Next.js 15.5.15 production build — 4 static pages, 103 kB first-load JS |
| apps/voice | PASS | cached `tsc` |
| packages/db | PASS | cached `tsc` |

**4/4 build tasks pass.** Next.js build generates: `/` (300 B) and `/_not-found` (301 B) static pages with 46 kB + 54.4 kB shared chunks.

---

## E2E Tests

**Not run.** No `tests/e2e/` directory and no Playwright configuration exist. E2E infrastructure is not required for phase_foundation.

---

## Performance Baseline

**Not run.** No `tests/perf/` directory and no k6 scripts exist. Performance test infrastructure is not required for phase_foundation.

---

## Security Scan

`pnpm audit --audit-level=high` — **PASS** (exit 0). No HIGH or CRITICAL vulnerabilities.

`pnpm audit` (full) — **3 moderate vulnerabilities**, all in dev toolchain.

| Advisory | Package | Severity | Vulnerable | Fixed In | Path |
|---|---|---|---|---|---|
| GHSA-67mh-4wv8-2f99 | esbuild | moderate | <=0.24.2 | >=0.25.0 | vitest → vite → esbuild |
| GHSA-4w7w-66w2-5vf9 | vite | moderate | <=6.4.1 | >=6.4.2 | vitest → vite |
| (3rd moderate) | vite/esbuild (transitive) | moderate | — | — | dev toolchain |

All three moderate findings are in the `vitest` → `vite` → `esbuild` dev-dependency chain. Not reachable in production builds or at runtime. Documented in AUDIT-3; `pnpm.overrides` pins `rollup` to `>=3.30.0` (existing CVE from prior cycle). No action required for gate passage.

---

## Comparison vs Run 2

| Check | Run 2 | Run 3 | Delta |
|---|---|---|---|
| Foundation acceptance tests | 132/132 PASS | 132/132 PASS | no change |
| apps/api unit tests | 48/48 PASS | **49/49 PASS** | +1 (logger regression test) |
| apps/voice unit tests | 11/11 PASS | 11/11 PASS | no change |
| apps/web unit tests | 20/20 PASS | **24/24 PASS** | +4 (Sentry/ts-rest client tests) |
| packages/contracts | 20/20 PASS | **21/21 PASS** | +1 (numeric key casting regression test) |
| packages/db (schema/SQL) | 15/15 PASS | 15/15 PASS | no change |
| packages/db (live DB) | 4/4 **FAIL** (ECONNREFUSED) | **4/4 PASS** | Postgres available this run |
| typecheck | **7/8 FAIL** (apps/api TS2322) | **8/8 PASS** | regression removed |
| lint | **7/8 FAIL** (apps/api no-unused-vars) | **8/8 PASS** | regression removed |
| build | **3/4 FAIL** (apps/api tsc) | **4/4 PASS** | regression removed |
| security (high/critical) | 0 | 0 | no change |
| **Total tests** | **236 pass, 4 fail** | **256 pass, 0 fail** | **+20 tests, 0 failures** |

### Root causes resolved between Run 2 and Run 3

1. **Regression removed** — `const x: number = "this is a string";` (apps/api/src/app.ts:182) removed by CORRECTION_2. Unblocks typecheck, lint, and build for `apps/api`.
2. **Logger wiring regression test added** — `apps/api/src/__tests__/health.test.ts` gained 1 test asserting `pino-pretty` in devDependencies and loggerInstance import is wired (CORRECTION_2 fix for AUDIT-2 logger issue).
3. **Sentry + ts-rest client tests added** — `apps/web/src/__tests__/structure.test.ts` gained 4 tests for `withSentryConfig` wrapper, `global-error.tsx`, `initClient` wiring, `apiClient.echo` call (CORRECTION_2 fixes B1/B3).
4. **Numeric key casting regression test added** — `packages/contracts/src/__tests__/echo.test.ts` gained 1 test (CORRECTION_2 fix B2).
5. **Postgres available** — 4 live-DB integration tests in `packages/db` that previously failed with `ECONNREFUSED` now pass; Postgres container accessible at `localhost:5434` in this run environment.

---

## Observations

1. **256/256 tests pass with zero failures.** This is the first clean run across all suites.
2. **Vitest version split** (`v3.2.4` in apps/packages vs `v4.1.5` in `tests/foundation` and `packages/db`) is unchanged and functional. Both resolve correctly. Not a gate blocker.
3. **Coverage tooling absent.** `@vitest/coverage-v8` is not installed and no `coverage` script exists. The ≥80% line coverage gate criterion (identified as BLOCKER-1 in AUDIT-5) cannot be measured. This was a known open item entering CORRECTION_2 and is carried forward — if it remains a gate criterion it must be addressed before final gate approval.
4. **Graceful-shutdown test absent.** No test exercises SIGTERM + in-flight request draining (AUDIT-5 BLOCKER-2). Carried forward from CORRECTION_2.
5. **`pnpm db:migrate` from root** still untested in this run (AUDIT-5 BLOCKER-3) — requires a live DB and is an ops concern, not a test-runner concern.
6. **Live-DB tests pass this run** but depend on ambient infrastructure. CI will need the Postgres service started before `pnpm -r test` for these to be stable.
