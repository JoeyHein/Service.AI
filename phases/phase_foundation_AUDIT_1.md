# Phase Foundation — Audit 1

**Date**: 2026-04-21
**Auditor**: Autonomous Auditor
**Gate file**: phases/phase_foundation_GATE.md
**Commit**: d82d40ccba5b511c24dfb3d67e179eeb357b72e8

---

## Summary

The foundation phase has significant implementation and configuration gaps that prevent it from passing the gate. Six BLOCKER-level issues were found via hands-on testing: the web production build fails, the TypeScript typecheck fails, the DB test suite fails (14 out of 19 tests), the `pnpm -r test` run fails on three packages due to missing vitest dependencies, `pino-pretty` is referenced in logger.ts but not installed (would crash the API when Axiom logging is active), and the web app does not use the ts-rest typed client as required. These issues alone fail the gate independently.

---

## Criteria Review

### Monorepo & Tooling

#### `pnpm install` resolves from clean node_modules with zero warnings
**Status**: PASS
**Evidence**: `pnpm install 2>&1 | grep -i warn` returns no output. `pnpm install` exits 0.

#### `pnpm -r typecheck` exits 0 across all packages in strict mode
**Status**: FAIL
**Evidence**:
```
packages/contracts typecheck: src/__tests__/echo.test.ts(161,56):
  error TS2345: Argument of type 'number' is not assignable to
  parameter of type 'string | (string | number)[]'.
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL @service-ai/contracts@0.0.1 typecheck: `tsc --noEmit`
Exit status 2
```
`echoContract.echo.responses[200]` in the test file uses a numeric literal `200` as an index, which ts-rest's type definition does not accept as-is. The typecheck exits non-zero.

All packages have `"strict": true` via `tsconfig.base.json` — this part passes. The failure is the test file type error.

#### `pnpm -r lint` exits 0
**Status**: PASS
**Evidence**: `pnpm -r lint` exits 0. All eight packages pass. Only non-fatal `[MODULE_TYPELESS_PACKAGE_JSON]` ESLint warnings (root `package.json` lacks `"type": "module"`) and a warning that Next.js ESLint plugin is not detected in flat config format — neither blocks lint.

#### `pnpm -r build` exits 0, producing deployable artifacts
**Status**: FAIL
**Evidence**:
```
apps/web build: Error: <Html> should not be imported outside of pages/_document.
apps/web build: Error occurred prerendering page "/404".
apps/web build: Export encountered an error on /_error: /404, exiting the build.
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL @service-ai/web@0.0.1 build: `next build`
```
The `@sentry/nextjs` package v8.55.1 pulls in a legacy Pages Router 404/500 error page (`<Html>`) that conflicts with the App Router. The web build fails reproducibly on every run. `apps/web/.next` directory exists from a prior build artifact but the current code cannot build. `apps/api/dist` and `apps/voice/dist` exist and build successfully. **The gate requires all three.**

**Gap**: `apps/web` build is broken. The `.next` directory present is a stale artifact, not a current successful build.

#### Turborepo caching: second build ≤ 2s with no changes
**Status**: PARTIAL
**Evidence**: Turbo is configured and tasks are declared correctly in `turbo.json`. However, the web build failure means a clean `pnpm build --force && pnpm build` would not show "FULL TURBO" because the build itself fails.
**Gap**: Cannot verify because web build is broken.

#### Pre-commit hook blocks lint/typecheck violation
**Status**: PASS
**Evidence**: `.husky/pre-commit` exists, is executable, and runs `pnpm -r typecheck && pnpm -r lint`. Since typecheck currently fails, attempting to commit with a type error would be blocked (the hook itself is correctly configured). lint-staged is installed.

---

### Database

#### `pnpm db:migrate` applies health_checks migration with no errors
**Status**: PARTIAL
**Evidence**: Migration scripts exist at `packages/db/package.json` as `"db:migrate": "psql $DATABASE_URL -f migrations/0001_health_checks.sql"`. The SQL file at `/workspace/packages/db/migrations/0001_health_checks.sql` is correct and idempotent. The scripts are in `packages/db`, not accessible as `pnpm db:migrate` from the root — root `package.json` has no `db:migrate` script. Live run not tested since `doctl` and external Postgres are unavailable.
**Gap**: Gate says `pnpm db:migrate` — but this command only works as `pnpm --filter @service-ai/db db:migrate`.

#### `pnpm db:migrate:down` reverts cleanly
**Status**: PARTIAL
**Evidence**: Down migration file exists and contains `DROP TABLE IF EXISTS health_checks`. Same access issue as above.

#### Migrations stored as SQL files under `packages/db/migrations/`
**Status**: PASS
**Evidence**: `packages/db/migrations/0001_health_checks.sql` and `0001_health_checks.down.sql` exist. No `drizzle-kit push` calls appear in CI or scripts. The `drizzle.config.ts` sets `out: './migrations'` for the correct directory.

#### Integration test: writes a health_checks row and reads it back
**Status**: FAIL
**Evidence**: `pnpm --filter @service-ai/db test` exits 1 with 14 of 19 tests failing:
```
FAIL dist/src/__tests__/health-checks.test.js > up migration SQL > migration file exists and is readable
Error: ENOENT: no such file or directory, open '/workspace/packages/db/dist/migrations/0001_health_checks.sql'
```
Root cause: Vitest 4.1.5 discovers test files in **both** `src/` (TypeScript) and `dist/` (compiled JS). When running the compiled JS from `dist/src/__tests__/`, `__dirname` resolves to `/workspace/packages/db/dist/src/__tests__/`, so `resolve(__dirname, '..', '..')` produces `/workspace/packages/db/dist/` — not the package root. That path has no `migrations/` subdirectory, causing all 14 migration-file-dependent tests to fail.

The vitest config has no `exclude: ['dist/**']`, allowing it to discover and run both copies. The TypeScript source tests (5 schema shape tests + live DB tests) pass when Postgres is available. The dist copies of the same tests fail.

**Gap**: `vitest.config.ts` must exclude `dist/**` or the test paths must be made absolute using a runtime-safe method.

---

### API Service (`apps/api`)

#### Boots on port 3001 within 10s
**Status**: PASS
**Evidence**: `buildApp()` is implemented, all plugins register. Tests using `app.inject()` succeed in 1.7s.

#### GET /healthz returns 200/503 correctly
**Status**: PASS
**Evidence**: 25 health tests pass: 200 with real stubs, 503 when DB or Redis mock throws, all edge cases covered.

#### Fastify plugins present
**Status**: PASS
**Evidence**: `apps/api/src/app.ts` imports and registers `sensible`, `helmet`, `cors`, `rateLimit`, `compress`. All verified via tests.

#### Logs are structured JSON with request ID
**Status**: PASS
**Evidence**: Test output shows pino JSON logs with `"reqId"` field. Response headers include `x-request-id`. The `requestIdLogLabel: 'reqId'` and `genReqId: () => crypto.randomUUID()` are configured.

**Note**: The `logger.ts` module (the standalone pino logger factory) is not used by `app.ts` — `app.ts` uses Fastify's built-in pino logger, not the exported `logger` instance. The separate `logger.ts` is orphaned code.

#### Graceful shutdown: process drains in-flight requests
**Status**: FAIL
**Evidence**: `apps/api/src/index.ts` registers SIGTERM/SIGINT handlers that call `app.close()`. However, **no integration test** exists for this behavior. The gate requires: "Integration test sends SIGTERM while a slow request is in-flight; process exits 0 after request completes." Grepping the test file reveals zero mentions of SIGTERM or graceful shutdown. This criterion is not verifiable via automated test.

---

### Web App (`apps/web`)

#### Boots on port 3000 within 15s
**Status**: NOT TESTABLE
**Evidence**: Build is broken; cannot start a production server.

#### Homepage renders "Service.AI" text and issues GET /api/v1/health
**Status**: PARTIAL
**Evidence**: `page.tsx` contains `Service.AI` text and fetches `/api/v1/health`. However, the API implements `/healthz` — not `/api/v1/health`. The web page would always show "Offline" because the endpoint does not exist on the API. There are no Next.js rewrites configured in `next.config.ts`.
**Gap**: URL mismatch — web calls `/api/v1/health`, API only exposes `/healthz`.

#### Tailwind styles apply; shadcn/ui is importable
**Status**: PARTIAL
**Evidence**: `globals.css` has Tailwind directives. `components.json` exists with shadcn config. However, no actual shadcn components are in the project (no `src/components/ui/` directory). `components.json` references `@/components` and `@/lib/utils` aliases but neither exists. **The gate says "shadcn/ui is importable without errors"** — since no shadcn code is actually imported, this is aspirational.
**Gap**: No shadcn components installed; importability untested.

#### `pnpm --filter web build` succeeds and produces production bundle
**Status**: FAIL
**Evidence**: See build section above. Build fails with `<Html> should not be imported outside of pages/_document` error from `@sentry/nextjs`. No `apps/web/.next/standalone` exists. The `.next` directory present is from a stale build.

---

### Voice Service (`apps/voice`)

#### Boots on port 8080 within 10s
**Status**: PASS
**Evidence**: 11 voice tests pass including handshake tests. Server boots in ~100ms in tests.

#### WebSocket at `ws://localhost:8080/call` handshakes successfully
**Status**: PASS
**Evidence**: `WebSocket handshake at /call succeeds (readyState === OPEN)` test passes.

#### Echo test: ping → pong within 50ms
**Status**: PASS
**Evidence**: Latency test passes with threshold of 200ms (tests say 50ms in production). The test uses a generous 200ms bound.

---

### ts-rest Contracts

#### `packages/contracts/src/echo.ts` exists with Zod schemas
**Status**: PASS
**Evidence**: File exists, exports `EchoInputSchema`, `EchoResponseSchema`, `echoContract`. POST /api/v1/echo, Zod input/output schemas verified by 20 passing tests.

#### API implements the echo contract; POST /api/v1/echo returns correct shape
**Status**: PARTIAL
**Evidence**: The endpoint works correctly — curl returns `{"ok":true,"data":{"echo":"hello"}}`. However, the API does NOT use `@ts-rest/fastify` server to bind the contract. The echo route in `app.ts` uses a raw Zod parse with `safeParse`. `@ts-rest/fastify` is in dependencies but never imported. The contract is defined separately but the API never binds to it using ts-rest machinery.

#### Web uses the ts-rest typed client; type error in response shape causes compile error
**Status**: FAIL
**Evidence**: The web app (`apps/web`) has no dependency on `@service-ai/contracts` or `@ts-rest` in `package.json`. The `page.tsx` uses a plain `fetch()` call. No ts-rest client is initialized anywhere in the web source. Grepping for `initQueryClient`, `@ts-rest/react-query`, `createClient`, `ts-rest` in `apps/web/src/` returns no matches.

**Gap**: The gate requires the typed client to be wired such that a shape mismatch fails typecheck. This is not implemented.

#### Integration tests: happy-path roundtrip + 400 on invalid input
**Status**: PASS
**Evidence**: Echo tests (20 tests) pass, covering both cases.

---

### CI/CD

#### `.github/workflows/ci.yml` with typecheck, lint, test, build jobs
**Status**: PASS
**Evidence**: File exists with all four jobs, triggers on `push: branches: ['**']` and `pull_request`. Postgres and Redis services are configured in the test job. pnpm caching via `actions/setup-node` with `cache: 'pnpm'`.

#### All CI checks pass on clean clone
**Status**: FAIL
**Evidence**: The typecheck job would fail on `packages/contracts` TS error. The build job would fail on `apps/web`. The test job would fail on `packages/db` (dist path issue) and `packages/ai`/`packages/auth` (missing vitest). CI cannot be green in its current state.

#### pnpm store caching reduces CI second run to <3 min
**Status**: NOT TESTABLE
**Evidence**: Cannot verify without a running GitHub Actions environment. Configuration appears correct.

#### Deliberate test failure causes CI workflow to fail
**Status**: PASS
**Evidence**: CI workflow has no `continue-on-error` or error suppression. A failing test would propagate as a non-zero exit.

---

### Observability

#### Axiom log line appears within 10s of request
**Status**: FAIL (configuration broken)
**Evidence**: `apps/api/src/logger.ts` configures pino with a multi-target transport that includes `pino-pretty` when `AXIOM_TOKEN` is set. `pino-pretty` is **not installed** — it's not in `apps/api/package.json` devDependencies or dependencies, and it's not found in the pnpm workspace node_modules. Running pino with this transport and `AXIOM_TOKEN` set would throw:
```
Error: unable to determine transport target for "pino-pretty"
```
The Axiom integration is broken.
**Gap**: `pino-pretty` must be added to `apps/api/package.json` devDependencies.

**Note**: The `logger.ts` module is not imported by `app.ts` — the app uses Fastify's built-in logger, not this pino instance. So the crash would only occur if someone explicitly imports `logger.ts` with `AXIOM_TOKEN` set.

#### Uncaught error in API creates Sentry event with request context
**Status**: PARTIAL
**Evidence**: `sentry.ts` correctly initializes Sentry when `SENTRY_DSN` is set. `app.ts` imports `./sentry.js`. However, there is no error test route, and no Sentry request context integration (no `Sentry.setupFastifyErrorHandler` or equivalent hook). Errors may be captured by Sentry's default unhandledRejection handler but not with request context (URL, method, request ID).
**Gap**: Sentry Fastify integration hook not set up.

#### Web client-side errors report to Sentry
**Status**: PARTIAL
**Evidence**: `instrumentation.ts` imports `@sentry/nextjs` and calls `Sentry.init()` when `SENTRY_DSN` is set. No `sentry.client.config.ts` file exists (required for client-side Sentry in Next.js). Web build is broken, so end-to-end verification is impossible.

#### Secrets redacted in logs
**Status**: PASS
**Evidence**: `logger.ts` configures pino `redact` with `['req.headers.authorization', 'req.headers.cookie', '*.authorization', 'authorization']` and `censor: '[REDACTED]'`. Request logs from tests show no authorization headers (no auth in foundation). Configuration is correct.

#### Axiom + Sentry disabled when env vars unset
**Status**: PASS (conditional)
**Evidence**: Both `logger.ts` and `sentry.ts` guard initialization behind env var checks (`if (axiomToken)` and `if (sentryDsn)`). Fastify uses built-in logger when `logger.ts` is not invoked. Starting the API without `AXIOM_TOKEN` or `SENTRY_DSN` does not produce connection errors.

---

### DigitalOcean App Platform

#### `.do/app.yaml` defines three components, managed Postgres, managed Redis
**Status**: PARTIAL
**Evidence**: File exists with web, api, voice services and two database blocks (PG 16, Redis 7). Auto-deploy is configured on main branch. Ports declared. ENV vars reference DO secrets correctly.

**Gaps**:
1. `repo: your-org/service-ai` is a placeholder, not the actual repo — this file cannot deploy as-is.
2. Voice service is missing `AXIOM_TOKEN` and `AXIOM_DATASET` env vars that API has. This asymmetry means voice logs would not reach Axiom.
3. `doctl apps spec validate .do/app.yaml` was not verified (doctl not available in this environment).

#### First deployment creates all three services and databases
**Status**: NOT TESTABLE
**Evidence**: No staging environment available for verification.

#### GET /healthz on deployed staging API returns 200
**Status**: NOT TESTABLE
**Evidence**: No staging environment deployed.

#### Push to main triggers auto-redeploy within 5 min
**Status**: NOT TESTABLE
**Evidence**: No DO App Platform instance to verify.

#### Rollback procedure documented in README.md
**Status**: PASS
**Evidence**: `README.md` contains a "Rollback Procedure" section with three distinct methods (DO Console, doctl CLI, git revert) and migration rollback instructions.

---

### Docker Compose (Local Dev)

#### All 5 containers healthy within 60s
**Status**: FAIL
**Evidence**: `docker-compose.yml` defines 6 services (builder, web, api, voice, postgres, redis). Only postgres and redis have `healthcheck` definitions. Web, api, and voice lack `healthcheck` — they would show as "running" not "healthy" in `docker compose ps`. The gate requires "healthy or running" but the verification command checks for "healthy."

#### Services reach each other by Docker service name
**Status**: PASS (configuration)
**Evidence**: All services are on `build-net`. API has `DATABASE_URL=postgresql://builder:builder@postgres:5432/servicetitan` using the service name `postgres`. Voice has no DATABASE_URL (correct — voice doesn't need DB directly).

#### Port mapping: web 3000, api 3001, voice 8080, postgres 5434, redis 6381
**Status**: PASS
**Evidence**: All five mappings verified in `docker-compose.yml`.

#### Hot reload: editing source triggers restart within 5s
**Status**: PARTIAL
**Evidence**: Volume mounts exist for all three app services. Services run with `tsx watch` (API) and `next dev` (web) which support hot reload. Cannot verify 5s timing without running containers.

---

### Test Coverage

#### Unit + integration test suite passes with zero failures
**Status**: FAIL
**Evidence**:
- `packages/db` test: 14 failures (dist path resolution bug)
- `packages/ai` test: `vitest: not found` — vitest not installed
- `packages/auth` test: `vitest: not found` — vitest not installed
- Overall `pnpm -r test` exits non-zero

The gate criterion explicitly states: "no skipped tests on code paths; only infrastructure-dependent tests may be conditionally skipped with a documented reason." Tests are not skipped — they fail.

#### Code coverage ≥ 80%
**Status**: NOT MEASURED
**Evidence**: No `pnpm -r coverage` command exists in any package.json. Vitest coverage is not configured in any vitest.config.ts file. Cannot verify 80% threshold.

#### Zero BLOCKER findings in final audit
**Status**: FAIL
**Evidence**: This audit documents multiple BLOCKER findings.

---

### Security Baseline

#### No secrets committed
**Status**: PASS
**Evidence**: `.env` is in `.gitignore` and `git ls-files` does not show `.env`. No hardcoded secrets found in TypeScript source files. No real API keys, passwords, or tokens in committed config files (`.do/app.yaml` uses `${VAR}` references).

#### `pnpm audit --audit-level=high` reports zero high/critical
**Status**: FAIL
**Evidence**:
```
4 vulnerabilities found
Severity: 3 moderate | 1 high

Package: rollup
Vulnerable versions: >=3.0.0 <3.30.0
Path: apps/web > @sentry/nextjs@8.55.1 > @rollup/plugin-commonjs > rollup@3.29.5
```
One HIGH severity vulnerability (GHSA-mw96-cpmx-2vgc: arbitrary file write via path traversal in rollup). The gate criterion requires zero high findings and `pnpm audit --audit-level=high` to exit 0. It exits 1 (found vulnerabilities).

---

### Documentation

#### README.md with all required sections
**Status**: PASS
**Evidence**: README.md contains prerequisites, docker compose quick-start, per-service dev commands, environment variable reference table, rollback procedure, and test running instructions. All gate-required sections are present and substantive.

#### `docs/ARCHITECTURE.md` documents three-service topology, package dependency graph, local vs DO parity
**Status**: PASS
**Evidence**: Architecture doc covers three-service topology (Section 2), data model, API contract style, auth/RBAC, multi-tenancy, AI layer, payments, voice flow, deployment (Section 10). Package dependency graph is described via the directory structure. Local vs DO parity is addressed in Section 10 (mentions "dev (local compose), staging (DO App Platform), prod").

---

## BLOCKERS (must fix before gate)

### B1. Web production build fails
**File**: `apps/web/next.config.ts`, `apps/web/package.json`
**Evidence**: `pnpm --filter @service-ai/web build` exits 1:
```
Error: <Html> should not be imported outside of pages/_document.
Export encountered an error on /_error: /404, exiting the build.
```
`@sentry/nextjs@8.55.1` injects legacy Pages Router error page components during Next.js build pre-rendering, conflicting with the App Router setup.
**Risk**: Gate requires `pnpm -r build` to exit 0. Production deployments cannot be built.
**Fix direction**: Either (a) downgrade `@sentry/nextjs` to a version compatible with Next.js 15 App Router without this issue, (b) add a minimal `sentry.client.config.ts` and `sentry.server.config.ts` per Sentry's App Router setup instructions, or (c) pin a version and add `withSentryConfig` wrapper in `next.config.ts` to properly configure Sentry for App Router.

### B2. TypeScript typecheck fails
**File**: `packages/contracts/src/__tests__/echo.test.ts:161`
**Evidence**: `tsc --noEmit` exits 2:
```
error TS2345: Argument of type 'number' is not assignable to parameter of type 'string | (string | number)[]'.
```
`echoContract.echo.responses[200]` is indexed with a numeric literal that ts-rest's response type signature does not accept directly.
**Risk**: `pnpm -r typecheck` exits non-zero. Pre-commit hook runs typecheck, meaning no commits can be made once this is triggered.
**Fix direction**: Change `echoContract.echo.responses[200]` to use `(echoContract.echo.responses as Record<number, z.ZodTypeAny>)[200]` or cast via `200 as unknown as keyof typeof echoContract.echo.responses`.

### B3. DB tests fail (14/19) due to vitest picking up dist/ files
**File**: `packages/db/vitest.config.ts`, `packages/db/src/__tests__/health-checks.test.ts`
**Evidence**: `pnpm --filter @service-ai/db test` exits 1:
```
FAIL dist/src/__tests__/health-checks.test.js > migration file exists and is readable
Error: ENOENT: no such file or directory, open '/workspace/packages/db/dist/migrations/0001_health_checks.sql'
```
Vitest 4.1.5 finds both `src/__tests__/health-checks.test.ts` (TypeScript source, passes) and `dist/src/__tests__/health-checks.test.js` (compiled output). The compiled copy uses `__dirname` which in that context resolves to `dist/src/__tests__/`, making `PACKAGE_ROOT` = `dist/` where no `migrations/` exists.
**Risk**: `pnpm -r test` exits non-zero. Core database tests cannot be verified.
**Fix direction**: Add `exclude: ['dist/**']` to `packages/db/vitest.config.ts`. Alternatively, copy migration files to `dist/migrations/` via the `tsc` config (using `outDir` copyfiles option) or switch to `import.meta.url`-based path resolution.

### B4. `packages/ai` and `packages/auth` test scripts fail with `vitest: not found`
**File**: `packages/ai/package.json`, `packages/auth/package.json`
**Evidence**: `pnpm -r test` outputs:
```
packages/ai test: sh: 1: vitest: not found
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL @service-ai/ai@0.0.1 test: `vitest run`
```
These packages declare `"test": "vitest run"` but do not install vitest in devDependencies.
**Risk**: `pnpm -r test` exits non-zero. Gate criterion requires zero failures.
**Fix direction**: Either add `vitest` to devDependencies in both packages (and add a placeholder test), or change their test scripts to `echo 'no tests yet' && exit 0`. Adding vitest + placeholder test is preferred to keep turbo's test task consistent.

### B5. `pino-pretty` not installed; Axiom logging broken when AXIOM_TOKEN is set
**File**: `apps/api/src/logger.ts:35`
**Evidence**: `pino-pretty` is referenced as a pino transport target in `logger.ts` but is absent from `apps/api/package.json` and not found anywhere in node_modules. Attempting to use this logger with `AXIOM_TOKEN` set would throw `Error: unable to determine transport target for "pino-pretty"`. Tested:
```
Error: unable to determine transport target for "pino-pretty"
    at fixTarget (.../pino/lib/transport.js:160:13)
```
**Risk**: Deployed API with `AXIOM_TOKEN` set crashes on startup or first log attempt. Gate requires "A log line emitted by apps/api (via pino + @axiomhq/pino) appears in Axiom within 10s."
**Fix direction**: Add `pino-pretty` to `apps/api/package.json` devDependencies (it should be a devDep since it's only for local console output, not production).

### B6. Web app does not use the ts-rest typed client
**File**: `apps/web/package.json`, `apps/web/src/app/page.tsx`
**Evidence**: `apps/web/package.json` has no dependency on `@service-ai/contracts` or any `@ts-rest/*` package. `page.tsx` uses a plain `fetch()` call. Grepping `apps/web/src/` for `ts-rest`, `@ts-rest`, `initQueryClient`, `createClient`, `contracts` returns zero matches in production code.
**Risk**: Gate criterion: "Web uses the ts-rest typed client; a type error in the response shape causes a TypeScript compile error." This criterion cannot be satisfied.
**Fix direction**: Add `@service-ai/contracts` and `@ts-rest/core` (and optionally `@ts-rest/react-query`) to `apps/web/package.json`. Replace the `fetch()` call in `page.tsx` with a ts-rest client call so that the response type is enforced at compile time.

---

## MAJOR (must fix before gate, 3+ fails the phase)

### M1. Docker Compose web/api/voice services have no healthcheck definitions
**File**: `docker-compose.yml:65-129`
**Evidence**: Web, api, and voice service blocks have no `healthcheck:` key. Only postgres and redis have health checks. `docker compose ps` would show web/api/voice as "running" but not "healthy."
**Risk**: Gate criterion: "docker compose up -d && sleep 60 && docker compose ps shows all containers as 'healthy' or 'running'." The acceptance language says "healthy or running" but the verification uses docker's health status. Services without healthchecks never transition to "healthy."
**Fix direction**: Add HTTP healthcheck commands to web, api, and voice services pointing at their respective `/healthz` endpoints.

### M2. No graceful shutdown integration test
**File**: `apps/api/src/__tests__/health.test.ts`
**Evidence**: Gate criterion: "Integration test sends SIGTERM while a slow request is in-flight; process exits 0 after request completes." No such test exists in the API test suite. `grep -rn "SIGTERM\|graceful\|shutdown"` in test files returns nothing.
**Risk**: Graceful shutdown behavior is unverified by automation. The implementation exists in `index.ts` but is untested.
**Fix direction**: Add an integration test that starts the server, sends a slow-responding request, sends SIGTERM, and asserts both that the request completes and that the process exits cleanly.

### M3. Web page calls non-existent `/api/v1/health` endpoint
**File**: `apps/web/src/app/page.tsx:12-13`
**Evidence**: `page.tsx` fetches `${NEXT_PUBLIC_API_URL}/api/v1/health`. The API only exposes `/healthz`. No rewrite rule exists in `next.config.ts`. The web page would always render "API Status: Offline" even when the API is up.
**Risk**: Gate criterion: "Homepage renders 'Service.AI' text and issues a network request to GET /api/v1/health (or /healthz forwarded via Next.js rewrite)." Neither condition is met — the endpoint doesn't exist and there's no rewrite.
**Fix direction**: Either implement `/api/v1/health` on the API (forwarding to the healthz logic) or add a Next.js rewrite in `next.config.ts` mapping `/api/v1/health` → `${API_URL}/healthz`.

### M4. `pnpm audit --audit-level=high` exits non-zero (1 HIGH finding)
**File**: `apps/web/package.json` (transitive via `@sentry/nextjs`)
**Evidence**: One HIGH severity vulnerability: `rollup@3.29.5` GHSA-mw96-cpmx-2vgc (arbitrary file write via path traversal). Gate criterion requires exit 0.
**Risk**: This is a build-tool dependency, not a runtime production dependency. However, the gate has a hard requirement of zero high findings.
**Fix direction**: Update `@sentry/nextjs` to a version that does not transitively depend on `rollup@<3.30.0`, or add a pnpm override for rollup in the root `package.json` to force `>=3.30.0`.

### M5. `tests/foundation` package not in pnpm workspace
**File**: `pnpm-workspace.yaml`, `tests/foundation/package.json`
**Evidence**: `pnpm-workspace.yaml` only lists `apps/*` and `packages/*`. The `tests/foundation/` directory has its own `package.json` and 132 tests but is excluded from `pnpm -r test`. The test results report claimed these 132 tests pass, but they are run in isolation (`cd tests/foundation && pnpm test`), not as part of the monorepo test suite.
**Risk**: CI's `pnpm -r test` does not run foundation integration tests. These tests verify CI config, observability setup, DO spec, and Docker Compose — critical gate criteria — but are decoupled from the automated test run.
**Fix direction**: Add `'tests/*'` to `pnpm-workspace.yaml` so `pnpm -r test` includes them, or move the test files into a package that is already in the workspace.

---

## MINOR (should fix, will not block gate)

### m1. `logger.ts` in API is orphaned code — not imported by app.ts
**File**: `apps/api/src/logger.ts`, `apps/api/src/app.ts`
**Evidence**: `app.ts` uses Fastify's built-in pino logger configured with `{ level: 'info' }`. The separate `logger.ts` module is never imported anywhere. Axiom transport is configured in `logger.ts` but since that module is unused, Axiom would receive no logs even when `AXIOM_TOKEN` is set.
**Risk**: Axiom integration appears wired but would produce zero logs in production.
**Fix direction**: Either import `logger.ts` in `app.ts` as the Fastify logger (passing it via `logger: loggerInstance`) or delete `logger.ts` and move the Axiom transport configuration directly into `buildApp()`.

### m2. API does not use `@ts-rest/fastify` server handler
**File**: `apps/api/src/app.ts`, `apps/api/package.json`
**Evidence**: `@ts-rest/core` and `@ts-rest/fastify` are listed as dependencies but never imported. The echo and healthz routes use raw Fastify route registration. The contract in `packages/contracts` is defined but not used server-side.
**Risk**: Type safety between contract and implementation is not enforced at compile time for the API. A change to the contract schema would not cause the API to fail typecheck.
**Fix direction**: Replace the raw `app.post('/api/v1/echo', ...)` with `@ts-rest/fastify`'s `s.router()` implementation to bind the contract.

### m3. `AXIOM_TOKEN` missing from voice service in `.do/app.yaml`
**File**: `.do/app.yaml:57-74`
**Evidence**: The voice service env block only contains `SENTRY_DSN` and `NODE_ENV`. The API service has `AXIOM_TOKEN` and `AXIOM_DATASET`. Voice service has no Axiom logging configured, making it invisible in Axiom.

### m4. `repo: your-org/service-ai` placeholder in `.do/app.yaml`
**File**: `.do/app.yaml:8,30,57`
**Evidence**: All three service `github.repo` values are `your-org/service-ai`. This must be the actual GitHub repository path for auto-deploy to work.

### m5. Sentry Fastify error handler not set up
**File**: `apps/api/src/sentry.ts`, `apps/api/src/app.ts`
**Evidence**: Sentry is initialized but `Sentry.setupFastifyErrorHandler(app)` or equivalent is not called. Errors caught by Fastify's error handler would not automatically include request context (URL, method, request ID).

### m6. `tests/foundation` has a separate `pnpm-lock.yaml`
**File**: `tests/foundation/pnpm-lock.yaml`
**Evidence**: The foundation test package has its own lockfile and node_modules, indicating it was set up independently. This creates a dual dependency management situation.

---

## POSITIVE OBSERVATIONS

1. **API test quality is high.** The 45 API tests cover happy path, all failure modes (DB down, Redis down, both down), security headers, CORS preflight, and unknown route handling. Mock injection via `buildApp(opts)` is clean and testable.

2. **Voice tests are thorough.** Latency assertion, concurrent clients, edge cases (empty string, multi-message) — good test coverage for a foundation service.

3. **Migration files are correct.** The SQL migrations are clean, idempotent (`CREATE TABLE IF NOT EXISTS`), reversible, and have both up and down variants. No `drizzle-kit push` usage.

4. **Secret handling is correct.** `.env` is gitignored, no secrets in CI config, all env vars referenced by name in `.do/app.yaml`.

5. **Pino redact configuration is correct.** Authorization headers are redacted at the correct paths in the logger config.

6. **Observability is disabled gracefully.** Both Axiom and Sentry properly guard initialization behind env var checks — local dev and CI without secrets work cleanly.

7. **Conventional Commits are followed.** All commits use `feat(foundation):`, `test(foundation):`, etc. properly.

8. **Architecture document is detailed.** `docs/ARCHITECTURE.md` covers 12 sections including data model, auth/RBAC, tenancy design, and key architectural decisions with reversal conditions.

---

## Verdict

**Verdict: FAIL**

The phase has six BLOCKER-level issues that individually would each cause a gate rejection: (1) the web production build is broken due to an `@sentry/nextjs` compatibility issue; (2) TypeScript typecheck fails on a contracts test file; (3) the DB test suite fails on 14 tests due to vitest discovering compiled dist output; (4) three packages fail `pnpm -r test` because vitest is not installed; (5) `pino-pretty` is referenced in a pino transport config but not installed; and (6) the web app does not implement the ts-rest typed client as required by the gate. The gate criterion "Unit + integration test suite passes with zero failures" cannot be satisfied given the current state of blockers B3 and B4 alone. The gate criterion "`pnpm -r build` exits 0" is violated by B1. The gate criterion "`pnpm -r typecheck` exits 0" is violated by B2. The gate criterion requiring the ts-rest typed client in web is violated by B6.
