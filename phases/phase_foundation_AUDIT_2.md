# Audit: phase_foundation — Run 2

**Verdict:** FAIL
**Blockers:** 4
**Date:** 2026-04-21
**Commit:** 8acbbaf6f3806c8df2a9a57213ac551a9c38dc0a

---

## What changed since Audit 1

The fix commit `8acbbaf6` addressed three of the six prior blockers:

- B3 fixed: `packages/db/vitest.config.ts` now excludes `dist/**` — DB tests pass (19/19).
- B4 fixed: `packages/ai`, `packages/auth`, `packages/ui` test scripts changed to `echo` — `pnpm -r test` exits 0.
- B5 partially mitigated: `logger.ts` is still not imported by `app.ts`, so the pino-pretty crash is not currently triggered. But `pino-pretty` is still absent from `apps/api/package.json`. The code that crashes is live in source; any future refactor that wires the logger will hit it.

Three blockers from Audit 1 remain unfixed: B1 (web build), B2 (typecheck), B6 (web ts-rest client). One new finding is elevated to BLOCKER status (logger.ts orphan + pino-pretty — the Axiom observability integration is dead on arrival).

---

## Blockers (must fix before gate)

### B1. Web production build fails — `pnpm -r build` exits 1

**File:** `apps/web/package.json`, `apps/web/next.config.ts`

**Evidence:**
```
apps/web build: Error: <Html> should not be imported outside of pages/_document.
apps/web build: Error occurred prerendering page "/404"
apps/web build: Export encountered an error on /_error: /404, exiting the build.
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @service-ai/web@0.0.1 build: `next build`
Exit status 1
```
Reproduced directly: `pnpm -r build` exits 1 every run. `apps/web/.next/export-detail.json` confirms `"success": false`. The `.next` directory is a stale partial artifact — the build never completes successfully.

Root cause: `@sentry/nextjs@8.55.1` injects a legacy Pages Router `<Html>` import into the 404/500 error pages that conflicts with Next.js 15 App Router during pre-rendering.

`next.config.ts` is an empty config object — `withSentryConfig` wrapper is not applied, which is required for Sentry's App Router support.

**Risk:** Gate requires: "`pnpm -r build` exits 0; `apps/web/.next` exists after build." CI build job will fail. Web cannot be deployed to DO App Platform. This gate criterion is definitionally violated.

**Fix direction:** Wrap `nextConfig` with `withSentryConfig()` from `@sentry/nextjs` in `next.config.ts`, and add a `sentry.client.config.ts` + `sentry.server.config.ts` per Sentry's App Router setup. Alternatively, add a pnpm override for rollup to `>=3.30.0` to fix the concurrent vulnerability, and update to a Sentry version with App Router support.

---

### B2. TypeScript typecheck fails — `pnpm -r typecheck` exits 2

**File:** `packages/contracts/src/__tests__/echo.test.ts:161`

**Evidence:**
```
packages/contracts typecheck: src/__tests__/echo.test.ts(161,56):
  error TS2345: Argument of type 'number' is not assignable to
  parameter of type 'string | (string | number)[]'.
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @service-ai/contracts@0.0.1 typecheck: `tsc --noEmit`
Exit status 2
```
Reproduced: `cd /workspace/packages/contracts && pnpm typecheck` exits 2.

The expression `echoContract.echo.responses[200]` at line 161 uses a plain numeric literal `200` as an index. ts-rest's `AppRoute.responses` type is typed as `Record<string | (string | number)[], ZodTypeAny>` — the `number` literal is not directly assignable as a key type in this context.

**Risk:** Gate requires: "`pnpm -r typecheck` exits 0." Pre-commit hook runs `pnpm -r typecheck` and would block all commits once triggered. CI typecheck job will fail on every push.

**Fix direction:** Cast the access: `(echoContract.echo.responses as Record<number, z.ZodTypeAny>)[200]`, or use `200 as unknown as keyof typeof echoContract.echo.responses`.

---

### B3. Web app does not use the ts-rest typed client

**File:** `apps/web/package.json`, `apps/web/src/app/page.tsx`

**Evidence:**
- `apps/web/package.json` has no dependency on `@service-ai/contracts`, `@ts-rest/core`, or `@ts-rest/react-query`.
- `apps/web/src/app/page.tsx` uses a plain `fetch()` call to `/api/v1/health` (not even the correct endpoint — the API exposes `/healthz`).
- `grep -rn "ts-rest|@ts-rest|initClient|createClient|contracts" /workspace/apps/web/src/` returns zero matches in production code.

**Risk:** Gate criterion states: "Web uses the ts-rest typed client; a type error in the response shape causes a TypeScript compile error." This cannot be verified because the client is not wired. The gate criterion is structurally unmet — changing the contract schema would cause zero TypeScript errors in the web app. Also, `page.tsx` calls `/api/v1/health` but the API only exposes `/healthz`, so the homepage will always show "Offline" in a running environment.

**Fix direction:** Add `@service-ai/contracts` workspace dependency and `@ts-rest/core` (or `@ts-rest/react-query`) to `apps/web/package.json`. Replace the `fetch()` call in `page.tsx` with a ts-rest client instance. Fix the endpoint URL to `/healthz` or add `/api/v1/health` to the API and the contract.

---

### B4. Axiom integration is dead — `logger.ts` is orphaned; `pino-pretty` not installed

**File:** `apps/api/src/logger.ts:35`, `apps/api/src/app.ts:11`, `apps/api/package.json`

**Evidence:**
1. `apps/api/src/app.ts` does not import `logger.ts`. Line 11 imports `./sentry.js` only. Fastify is configured with its built-in logger (`{ level: 'info' }`) — the `@axiomhq/pino` transport in `logger.ts` is never activated. No logs reach Axiom regardless of whether `AXIOM_TOKEN` is set.

2. `logger.ts:35` specifies `{ target: 'pino-pretty', level: 'info' }` as a pino transport. `pino-pretty` is not in `apps/api/package.json` (confirmed: both `dependencies` and `devDependencies` were checked). It is not installed in node_modules:
   ```
   ls /workspace/node_modules/pino-pretty → NOT INSTALLED
   ```
   Any code path that invokes the `logger.ts` module with `AXIOM_TOKEN` set will throw:
   ```
   Error: unable to determine transport target for "pino-pretty"
   ```

**Risk:** Gate criterion: "A log line emitted by `apps/api` (via pino + `@axiomhq/pino`) appears in Axiom within 10s of the request." This is unreachable because the Axiom transport is in an unused module. The gate criterion is structurally unmet. Additionally, the `pino-pretty` missing dependency is a crash risk for any future wiring.

**Fix direction:** (1) Import `logger.ts` in `app.ts` and pass the logger instance to Fastify via the `loggerInstance` option, or merge the Axiom transport config directly into `buildApp()`. (2) Add `pino-pretty` to `apps/api/package.json` devDependencies (it's for local human-readable output, not production).

---

## Warnings (should fix but not blocking)

### W1. `pnpm audit --audit-level=high` exits 1 — one HIGH severity vulnerability

**Evidence:**
```
rollup@3.29.5 — GHSA-mw96-cpmx-2vgc: Arbitrary file write via path traversal
Path: apps/web > @sentry/nextjs@8.55.1 > @rollup/plugin-commonjs > rollup@3.29.5
4 vulnerabilities found — Severity: 3 moderate | 1 high
Exit code: 1
```
Gate criterion: "`pnpm audit --audit-level=high` exits 0; count = 0." It exits 1. The vulnerability is a build-tool transitive dep, not a runtime risk, but the gate is a hard criterion.

**Fix direction:** Add pnpm overrides in root `package.json` to force `rollup` to `>=3.30.0`.

### W2. `tests/foundation/` package is not in the pnpm workspace

**Evidence:** `pnpm-workspace.yaml` lists `apps/*` and `packages/*` only. `tests/foundation/` has its own `package.json`, `pnpm-lock.yaml`, and `node_modules`. Running `pnpm -r test` does not include the 132 foundation integration tests. They can only be run manually via `cd tests/foundation && pnpm test`.

**Risk:** The CI workflow (`pnpm -r test`) misses 132 tests that verify CI config, observability wiring, DO spec, and Docker Compose. These tests are fully decoupled from the automated test run.

**Fix direction:** Add `'tests/*'` to `pnpm-workspace.yaml`.

### W3. Docker Compose app services have no `healthcheck` definitions

**Evidence:** Only `postgres` and `redis` services have `healthcheck:` stanzas. `web`, `api`, and `voice` containers have no healthcheck configured — they will never transition to "healthy" status in `docker compose ps`. Gate verification command: "docker compose ps shows all containers as 'healthy' or 'running'" — without healthchecks, these three show as "running" only, which the gate text accepts but the verification method may not.

**Fix direction:** Add HTTP curl-based healthcheck stanzas to `web`, `api`, and `voice` service blocks.

### W4. Graceful shutdown has no integration test

**Evidence:** `apps/api/src/index.ts` registers SIGTERM/SIGINT handlers but `grep -rn "SIGTERM|graceful|shutdown"` in `apps/api/src/__tests__/` returns zero matches. Gate criterion: "Integration test sends SIGTERM while a slow request is in-flight; process exits 0 after request completes." Not tested.

### W5. API does not use `@ts-rest/fastify` server handler

**Evidence:** `@ts-rest/fastify` is in `apps/api/package.json` dependencies but is never imported. The echo route uses raw Fastify + Zod without binding to the contract. Changes to the contract schema will not cause the API's TypeScript compile to fail.

### W6. Sentry Fastify error handler not registered

**Evidence:** `app.ts` imports `./sentry.js` (which initializes the Sentry SDK) but never calls `Sentry.setupFastifyErrorHandler(app)`. Gate criterion: "An uncaught error thrown in `apps/api` creates a Sentry event with request context (URL, method, request ID)." Request context will not be attached to Sentry events.

### W7. `.do/app.yaml` uses placeholder GitHub repo

**Evidence:** All three services have `repo: your-org/service-ai`. This prevents auto-deploy from working and means `doctl apps spec validate` would fail against a real DO instance.

---

## Verified criteria (passing)

- `pnpm install` exits 0 with no warnings.
- `pnpm -r lint` exits 0 (warnings only, no errors).
- `pnpm -r test` exits 0 — 111 tests pass across 5 packages (45 API, 20 contracts, 19 DB, 16 web, 11 voice). Note: `tests/foundation`'s 132 tests are NOT included in this run.
- DB tests pass 19/19 (vitest dist exclusion fixed).
- `packages/ai`, `packages/auth`, `packages/ui` test scripts no longer cause `pnpm -r test` to fail.
- All packages have `"strict": true` via `tsconfig.base.json`.
- Fastify plugins registered: `sensible`, `helmet`, `cors`, `rate-limit`, `compress` — all present in `app.ts`.
- Structured JSON logs with `reqId` field — confirmed via test output.
- Voice service: WebSocket at `/call` handshakes correctly, echo ping→pong latency test passes.
- `packages/contracts/src/echo.ts` exists with `EchoInputSchema`, `EchoResponseSchema`, and `echoContract`.
- `POST /api/v1/echo` returns correct `{ok:true, data:{echo}}` shape.
- Migrations stored as SQL files in `packages/db/migrations/` — no `drizzle-kit push` usage.
- `.github/workflows/ci.yml` exists with typecheck/lint/test/build jobs, triggers on push+PR.
- Axiom and Sentry disabled gracefully when env vars unset.
- No secrets committed; `.env` is gitignored.
- `README.md` contains prerequisites, docker compose quick-start, per-service commands, env vars, rollback procedure, test instructions.
- `docs/ARCHITECTURE.md` covers three-service topology, package structure, local vs DO parity.
- Pre-commit hook is executable and runs typecheck+lint.
- Port mappings in `docker-compose.yml` match spec (3000, 3001, 8080, 5434, 6381).
- Pino redact configuration covers authorization headers and cookies.

---

## Verdict

FAIL. Four blockers remain after one fix cycle.

B1 (web build broken) and B2 (typecheck failure) are both individually sufficient to fail the gate independently — they directly violate named BLOCKER gate criteria. B3 (web ts-rest client not wired) is a gate requirement that has never been implemented, not a regression. B4 (Axiom transport orphaned, pino-pretty missing) means the observability gate criterion "a log line appears in Axiom within 10s" is impossible to satisfy as currently wired.

The fix commit `8acbbaf6` made progress on three of the six prior blockers. The three remaining high-value fixes — web build, typecheck, and ts-rest client — were not touched. Given that four blockers remain and two of them (B1, B2) are CI-breaking, the gate must be rejected.
