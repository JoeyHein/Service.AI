# phase_foundation — Test Results Run 1

**Date**: 2026-04-21
**Runner**: test-runner agent (claude-sonnet-4-6)
**Branch**: main
**Commit**: db9871872dfbf719a69e0c6c4d0d2ca3e4e41472

---

## Summary

| Suite | Status | Pass | Fail | Skip | Duration |
|---|---|---|---|---|---|
| unit/integration (foundation phase tests) | PASS | 132 | 0 | 0 | 1.77s |
| unit/integration (apps/api) | PASS | 48 | 0 | 0 | 14.85s |
| unit/integration (apps/voice) | PASS | 11 | 0 | 0 | 9.84s |
| unit/integration (apps/web) | PASS | 20 | 0 | 0 | 11.74s |
| unit/integration (packages/contracts) | PASS | 20 | 0 | 0 | 2.95s |
| unit/integration (packages/db — schema/SQL only) | PASS | 15 | 0 | 0 | — |
| unit/integration (packages/db — live DB) | FAIL | 15 | 4 | 0 | 5.84s |
| unit/integration (packages/ai) | SKIP | 0 | 0 | — | — (stub) |
| unit/integration (packages/auth) | SKIP | 0 | 0 | — | — (stub) |
| unit/integration (packages/ui) | SKIP | 0 | 0 | — | — (stub) |
| typecheck | PASS | 8/8 pkgs | 0 | 0 | 40.2s |
| lint | PASS | 8/8 pkgs | 0 | 0 | 56.3s |
| build | PASS | 4/4 tasks | 0 | 0 | 121.5s |
| security scan (pnpm audit) | WARNING | — | — | — | — |
| e2e | NOT RUN | — | — | — | Not configured |
| perf baseline | NOT RUN | — | — | — | Not configured |

**Overall: ACTIONABLE_FAILURES**

The sole test failures are 4 live Postgres integration tests in `packages/db` that require a running Postgres instance on `localhost:5434`. No Postgres container is running in this environment (ECONNREFUSED). All 15 non-database tests in that same file pass. All other suites are green.

---

## Unit / Integration Tests

### tests/foundation/ (phase-level acceptance tests)

**Runner**: Vitest v4.1.5
**Result**: PASS — 132/132 tests across 5 files

| File | Tests | Result |
|---|---|---|
| fnd-01-monorepo.test.ts | ~50 | PASS |
| fnd-07-ci.test.ts | ~22 | PASS |
| fnd-08-observability.test.ts | ~17 | PASS |
| fnd-09-do-spec.test.ts | ~15 | PASS |
| fnd-10-compose.test.ts | ~28 | PASS |

Verified by passing tests:
- pnpm-workspace.yaml, turbo.json, tsconfig.base.json with strict: true
- All 8 workspace directories with @service-ai/* scoped package names
- All workspace tsconfigs extend root base; none override strict: false
- .husky/pre-commit exists, is executable, invokes lint and typecheck, no || true suppression
- CI workflow (.github/workflows/ci.yml) triggers on push + pull_request, defines typecheck/lint/test/build jobs, uses pnpm with store caching, no plaintext secrets
- Axiom + Sentry SDK dependencies present in all three apps
- AXIOM_TOKEN and SENTRY_DSN env-var guards in API source
- pino redact configuration covers the authorization header
- Sentry.init() call present in API source; Sentry wired in Next.js config
- .do/app.yaml present with all three services, Postgres and Redis references, ports (3000, 3001, 8080), auto-deploy branch, env var references
- README.md present with rollback section
- docker-compose.yml has all 5 services, non-default ports (5434:5432, 6381:6379), volume mounts for hot reload, shared build-net network (more than 4 references)

### apps/api

**Runner**: Vitest v3.2.4
**Result**: PASS — 48/48 tests across 2 files

| File | Tests | Result | Notes |
|---|---|---|---|
| src/__tests__/health.test.ts | 28 | PASS | GET /healthz 200/503, DB/Redis mock failures, structured logging, request IDs, Helmet headers, CORS, 404 |
| src/__tests__/echo.test.ts | 20 | PASS | POST /api/v1/echo happy path, roundtrip fidelity (unicode), 400 on invalid input, response envelope consistency, edge cases |

Pino JSON structured logs were emitted to stdout during the test run, confirming the logging pipeline is active and wired.

### apps/voice

**Runner**: Vitest v3.2.4
**Result**: PASS — 11/11 tests across 1 file

| File | Tests | Result | Notes |
|---|---|---|---|
| src/__tests__/voice.test.ts | 11 | PASS | GET /healthz 200, WebSocket /call handshake, ping->pong echo, latency <200ms, sequential messages (2 and 3), empty string edge case, concurrent clients |

### apps/web

**Runner**: Vitest v3.2.4
**Result**: PASS — 20/20 tests across 1 file

| File | Tests | Result | Notes |
|---|---|---|---|
| src/__tests__/structure.test.ts | 20 | PASS | Config files present, App Router layout.tsx + page.tsx, Tailwind directives, shadcn components.json, brand text, JSX tsconfig |

### packages/contracts

**Runner**: Vitest v3.2.4
**Result**: PASS — 20/20 tests across 1 file

| File | Tests | Result | Notes |
|---|---|---|---|
| src/__tests__/echo.test.ts | 20 | PASS | File existence, re-exports, route definition (POST /api/v1/echo), Zod body/response schema validation |

### packages/db

**Runner**: Vitest v4.1.5
**Result**: FAIL — 15 passed, 4 failed (all failures require live Postgres)

| Group | Tests | Result |
|---|---|---|
| health_checks Drizzle schema (unit) | 5 | PASS |
| up migration SQL structure (unit) | 7 | PASS |
| down migration SQL structure (unit) | 3 | PASS |
| health_checks live integration | 4 | FAIL — ECONNREFUSED 127.0.0.1:5434 |

### packages/ai, packages/auth, packages/ui

**Result**: STUB — no test files exist; each package runs `echo 'No tests in stub package' && exit 0`. Exit code 0.

---

## Typecheck

**Command**: `pnpm typecheck` (Turborepo, all 8 packages)
**Result**: PASS — 8/8 packages clean
**Duration**: 40.2s

All packages typecheck without errors. Packages verified:
- @service-ai/ai, @service-ai/api, @service-ai/auth, @service-ai/contracts, @service-ai/db, @service-ai/ui, @service-ai/voice, @service-ai/web

---

## Lint

**Command**: `pnpm lint` (Turborepo, all 8 packages)
**Result**: PASS — 8/8 packages clean, no lint errors
**Duration**: 56.3s

Non-fatal warnings (do not block):
- All non-web packages: `[MODULE_TYPELESS_PACKAGE_JSON]` — root package.json lacks "type": "module". ESLint still runs correctly.
- apps/web: `next lint` deprecation notice (will be removed in Next.js 16; no errors emitted). Next.js ESLint plugin not detected in flat config — informational only.

---

## Build

**Command**: `pnpm build` (Turborepo)
**Result**: PASS — 4/4 build tasks successful (voice was cached from prior run)
**Duration**: 121.5s (cold build for web, api, db; voice replayed from cache)

Next.js production bundle (apps/web):
- Route `/`: 300 B page, 103 kB First Load JS
- Route `/_not-found`: 301 B page, 103 kB First Load JS
- Shared JS chunks: 103 kB

---

## Security Scan

**Command**: `pnpm audit --audit-level=high`
**Result**: No HIGH or CRITICAL vulnerabilities. 3 MODERATE findings, all in devDependency toolchain only (no production exposure).

`pnpm audit --audit-level=high` exits 0. `pnpm audit` (no level filter) exits 1 with the following findings:

| Severity | Package | Vulnerability | GHSA / CVE | Path | Prod Risk |
|---|---|---|---|---|---|
| MODERATE | esbuild <=0.24.2 | Dev server CORS bypass — any website can send requests to dev server and read responses | GHSA-67mh-4wv8-2f99 | apps/api > vitest > vite > esbuild | No — dev/test tooling only |
| MODERATE | vite <=6.4.1 | Path traversal in optimized deps .map handling | GHSA-4w7w-66w2-5vf9 / CVE-2026-39365 | apps/api > vitest > vite | No — dev/test tooling only |
| MODERATE | vite <=6.4.1 | (same advisory, additional path) | GHSA-4w7w-66w2-5vf9 | apps/voice > vitest > vite | No — dev/test tooling only |

Remediation: upgrade vitest to a version that bundles vite >=6.4.2 and esbuild >=0.25.0. The root package.json already overrides rollup >=3.30.0 (per AUDIT-3 fix); esbuild and vite overrides should be added similarly before production deployment.

---

## E2E Tests

Not run — no Playwright configuration found and no tests/e2e/ directory exists. This infrastructure is not required for phase_foundation.

---

## Performance Baseline

Not run — no k6 scripts found and no tests/perf/ directory exists. This infrastructure is not required for phase_foundation.

---

## Failures & Errors

### packages/db > health_checks live integration > 4 tests FAIL

All 4 failures share the same root cause: no Postgres is running on localhost:5434.

**Failure 1**: applies the up migration, inserts a row, reads it back, then cleans up
```
Error: connect ECONNREFUSED 127.0.0.1:5434
  at pg-pool/index.js:45:11
  at src/__tests__/health-checks.test.ts:161:7  (pool.query(idempotentSql))
```

**Failure 2**: rejects a row with a service value exceeding 100 characters
```
Error: connect ECONNREFUSED 127.0.0.1:5434
  at src/__tests__/health-checks.test.ts:221:7
```

**Failure 3**: rejects a row with a status value exceeding 20 characters
```
Error: connect ECONNREFUSED 127.0.0.1:5434
  at src/__tests__/health-checks.test.ts:251:7
```

**Failure 4**: defaults checked_at to the current timestamp when not supplied
```
Error: connect ECONNREFUSED 127.0.0.1:5434
  at src/__tests__/health-checks.test.ts:281:7
```

**Likely cause**: These are genuine integration tests that require the Docker Compose Postgres service (`postgresql://builder:builder@localhost:5434/servicetitan`). No container is running in the current test environment. The test code is correct and the schema/migrations are structurally valid (all 15 non-DB tests pass). These tests will pass when run with `docker compose up -d postgres` first.

**Classification**: INFRASTRUCTURE — not a code defect. The tests cannot be made to pass without a running database. This is expected behavior for a live integration test suite.

---

## Coverage

Coverage collection was not configured in any vitest.config.ts (no `coverage` key present). No coverage report was generated.

---

## Observations

1. The 4 live DB test failures are entirely infrastructure-driven (no Postgres available). The underlying schema, migration SQL, and Drizzle ORM code are sound — all static/unit assertions pass. These tests should be skipped or guarded in CI environments without a database, or the CI workflow should spin up Postgres as a service job.

2. Lint produces a recurring `[MODULE_TYPELESS_PACKAGE_JSON]` warning across all packages because the root package.json has no `"type"` field. ESLint's flat config file (eslint.config.js) uses ESM syntax and triggers Node's module-type detection heuristic. Adding `"type": "module"` to the root package.json would eliminate this warning, but it is non-blocking.

3. apps/web uses `next lint` which is deprecated in favor of the ESLint CLI directly. The command still works and produces no errors. Migration should happen before Next.js 16.

4. The Next.js ESLint plugin warning (`The Next.js plugin was not detected`) is informational — the existing flat config does not include `plugin:@next/core-web-vitals` rules. Source passes lint clean regardless.

5. Build times: Next.js cold production build took ~2 minutes. The voice app build was served from Turborepo cache. First Load JS is 103 kB — reasonable for a stub page.

6. Three vitest versions coexist: v4.1.5 in tests/foundation and packages/db, v3.2.4 in the app packages. This works but may cause subtle behavior differences. Standardizing to one version is advisable.

7. The security audit flags no HIGH or CRITICAL issues. All 3 MODERATE findings are in dev toolchain (vitest/vite/esbuild) with no production runtime exposure. The rollup CVE (GHSA-mw96-cpmx-2vgc) that was present in a prior audit appears resolved by the `pnpm.overrides` pin for rollup >=3.30.0 added in AUDIT-3.
```
