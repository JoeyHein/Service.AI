# Audit: phase_foundation — Cycle 9

**Audited at:** 2026-04-22
**Commit:** 78f54d8 (feat(foundation): CORRECTION-5 resolve AUDIT-8 blockers B1-B2 + majors M2-M3)
**Auditor:** adversarial-auditor
**Prior corrections applied:** CORRECTION-1 through CORRECTION-5

---

## Context

CORRECTION-5 claimed to resolve AUDIT-8 blockers B1 (API tests timeout without infrastructure), B2 (contracts hardcoded `/workspace/` paths), B3 (coverage fails), and majors M2 (shutdown test flaky under coverage) and M3 (seed commands exit 254). This cycle independently verifies those claims and conducts a fresh adversarial sweep of the full phase gate.

Every check was run live on the developer machine (Windows 11, Git Bash). No trust extended to prior audit results.

---

## Summary

CORRECTION-5 correctly resolved its stated targets: tests now pass without infrastructure on a bare host, coverage is clean, and seed commands work. `pnpm turbo test --force` exits 0 with 138 tests across 8 packages (0 cached). Both `@service-ai/api` and `@service-ai/contracts` coverage reach 100%.

However, two pre-existing defects that were masked or unverified in prior cycles are now confirmed blockers:

1. **`pnpm -r build` exits 1 on Windows.** The web build script `NODE_ENV=production next build` is Unix-only syntax. On this machine (Windows 11, pnpm using cmd.exe for package scripts), it fails with `'NODE_ENV' is not recognized as an internal or external command`. This has existed since at least the gate approval commit but was verified exclusively via Turbo cache hits in every prior audit (AUDIT-8 recorded "Cached build runs in 33ms" — a cached replay, not a live run). `pnpm --filter @service-ai/web build` exits 1. `pnpm -r build` exits 1. The gate criterion is not met.

2. **`Sentry.setupFastifyErrorHandler(app)` is not called in `apps/api`.** The gate criterion requires "An uncaught error thrown in `apps/api` creates a Sentry event with request context." Without Fastify error handler registration, unhandled route errors are not captured with request context. `apps/api/src/app.ts` imports `./sentry.js` on line 11 but never calls `setupFastifyErrorHandler`. This was acknowledged as OPEN-4 in CORRECTION-5 but not fixed.

---

## BLOCKERS (must fix before PASS)

### B1. `pnpm -r build` exits 1 on Windows — gate criterion unmet

**File:** `apps/web/package.json:8`

**Evidence (live run):**
```
apps/web build$ NODE_ENV=production next build
apps/web build: 'NODE_ENV' is not recognized as an internal or external command,
apps/web build: operable program or batch file.
apps/web build: Failed
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @service-ai/web@0.0.1 build: `NODE_ENV=production next build`
Exit status 1
```

`NODE_ENV=production next build` is POSIX shell inline env var syntax. On Windows, pnpm invokes package scripts via cmd.exe, which does not support this syntax. Every prior audit that marked this criterion as PASS ran `pnpm turbo build` (Turbo cache hit, 33ms) instead of `pnpm -r build` — masking the failure. Running `pnpm -r build` or `pnpm --filter @service-ai/web build` directly exits 1.

**Gate criterion:** "`pnpm -r build` exits 0, producing deployable artifacts for web, api, and voice."

**Risk:** No developer on Windows (the documented dev machine in `CLAUDE.md`) can build the project. Any CI runner on Windows would also fail. `apps/web/.next/` does not exist after a clean clone + build attempt on this machine.

**Fix:** Remove the redundant `NODE_ENV=production` prefix. Next.js automatically sets `NODE_ENV=production` during `next build`. Change `apps/web/package.json:8` from:
```json
"build": "NODE_ENV=production next build"
```
to:
```json
"build": "next build"
```
Alternatively, add `cross-env` as a devDependency and prefix with `cross-env NODE_ENV=production next build` for explicit cross-platform behavior.

---

### B2. `Sentry.setupFastifyErrorHandler(app)` not called — API error capture gate criterion unmet

**File:** `apps/api/src/app.ts` (line 11 only), `apps/api/src/sentry.ts`

**Evidence (live grep):**
```
$ grep -n "setupFastifyErrorHandler\|Sentry" apps/api/src/app.ts
11:import './sentry.js';
# No other matches — setupFastifyErrorHandler is never called
```

`sentry.ts` calls `Sentry.init()` when `SENTRY_DSN` is present and exports the `Sentry` object. `app.ts` imports `./sentry.js` at line 11 (which runs `Sentry.init()` as a side effect), but never calls `Sentry.setupFastifyErrorHandler(app)`. Without this registration, `@sentry/node`'s Fastify integration is not active — unhandled errors in route handlers are not automatically captured with request context (URL, method, request ID).

**Gate criterion:** "An uncaught error thrown in `apps/api` creates a Sentry event with request context (URL, method, request ID)."

This gap was acknowledged as OPEN-4 in CORRECTION-5 but explicitly not fixed. The gate waiver in the GATE approval notes covers "W3 (missing Sentry global-error.js handler)" for the *web* app; the API Fastify integration is a separate, unresolved gap.

**Risk:** Production API errors will not create Sentry events with full request context. Debugging incidents will rely on pino logs alone. The gate criterion is structurally unmet regardless of whether `SENTRY_DSN` is set.

**Fix:** In `apps/api/src/sentry.ts`, export a `setupFastify` helper:
```ts
export function setupFastify(app: FastifyInstance): void {
  if (sentryDsn) {
    Sentry.setupFastifyErrorHandler(app);
  }
}
```
Then call `setupFastify(app)` in `apps/api/src/app.ts` after plugin registration, before returning `app`.

---

## MAJORS (serious issues, not blocking this phase)

### M1. Voice echo latency test asserts `< 200ms`; gate requires `≤ 50ms`

**File:** `apps/voice/src/__tests__/voice.test.ts:199,203`

**Evidence:**
```ts
it('echo round-trip completes in under 200ms (generous bound for CI environments)', async () => {
  // The acceptance criterion says 50ms in production; we allow 200ms in test
  expect(elapsedMs).toBeLessThan(200);
```

The gate criterion states: "Echo test: client sends `"ping"` and receives `"pong"` within 50ms." The test explicitly acknowledges the gate says 50ms but asserts 200ms instead. This has been a carried minor since AUDIT-7. Promoting to major because the test, as written, deliberately does not test the gate criterion, and latency regressions up to 199ms would go undetected.

**Fix:** Change `toBeLessThan(200)` to `toBeLessThan(50)`. If the local test environment genuinely cannot hit 50ms, use `toBeLessThan(50)` with a comment explaining it passes on CI (where it should pass) and investigate the local environment, rather than weakening the assertion.

### M2. `/healthz` response blocks for 10+ seconds when Redis is unreachable

**File:** `apps/api/src/app.ts` (healthz handler)

**Evidence (live measurement without Redis):**
```
$ node apps/api/dist/index.js &
$ time curl http://localhost:3001/healthz
{"ok":false,"db":"down","redis":"down"}
real    0m10.7s
```

The `/healthz` handler calls `redis.ping()`. With `lazyConnect: true`, the first call triggers ioredis's reconnection backoff (~10s before giving up). Load balancer health probes typically have a 5–10s timeout — a Redis outage causes the health endpoint itself to exceed the probe timeout, triggering false-positive service restarts.

**Fix:** Wrap the `redis.ping()` call in `Promise.race()` with a 500ms timeout, or configure ioredis with `connectTimeout: 500, maxRetriesPerRequest: 1` for the health-check client.

### M3. Docker Compose `web` depends on `api` without `condition: service_healthy`

**File:** `docker-compose.yml`

**Evidence:** `web` service's `depends_on` uses default `condition: service_started` for `api`. All other dependency chains in the file use `condition: service_healthy`. The `api` service has a `healthcheck:` stanza; `web` starts when `api` has started, not when it has passed its healthcheck.

**Fix:** Change to `depends_on: api: condition: service_healthy`.

---

## MINORS (fix in a subsequent phase)

### m1. Root `package.json` missing `"type": "module"` — ES module warning on every lint run

**File:** `package.json` (root)

**Evidence:** `pnpm -r lint` emits "Module type of file `.../eslint.config.js` is not specified and it doesn't parse as CommonJS. Reparsing as ES module..." across 7 packages. Lint exits 0 but the noise obscures real errors. Tracked as OPEN-6 in CORRECTION-5.

### m2. `.husky/pre-commit` sources deprecated `_/husky.sh` shim

**File:** `.husky/pre-commit:2`

**Evidence:** `. "$(dirname -- "$0")/_/husky.sh"` prints a deprecation warning on every commit. Harmless until Husky v10 removes the shim.

### m3. Echo API route uses raw Fastify handler, not `@ts-rest/fastify` server handler

**File:** `apps/api/src/app.ts:163`

**Evidence:** `app.post('/api/v1/echo', async (request, reply) => { ... })` — plain Fastify route, not wired through `@ts-rest/fastify`'s `initServer`. The contract in `packages/contracts` is not consumed server-side. Schema drift between contract and implementation is not caught at compile time. Tracked as OPEN-5 in CORRECTION-5.

### m4. `.do/app.yaml` references placeholder `your-org/service-ai` repository

**File:** `.do/app.yaml` (repo fields)

**Evidence:** `repo: your-org/service-ai` appears in all three service definitions. `doctl apps spec validate` may accept this but deployment would fail. Tracked as OPEN-2 in CORRECTION-5.

---

## POSITIVE OBSERVATIONS (CORRECTION-5 verified)

- **All 138 tests pass without infrastructure.** `pnpm turbo test --force` exits 0 (0 cached). The infrastructure-free mock injection pattern works cleanly for all API and contracts test suites. B1 and B2 from AUDIT-8 are genuinely fixed.
- **Coverage is 100%.** `pnpm --filter @service-ai/api coverage` exits 0 at 100% line/branch/function/statement for `app.ts`. `pnpm --filter @service-ai/contracts coverage` exits 0 at 100% for `echo.ts` and `index.ts`. B3 from AUDIT-8 is resolved.
- **Shutdown test no longer flaky under coverage.** The 80ms head-start delay before `app.close()` eliminates the timing race under v8 instrumentation. M2 from AUDIT-8 is resolved.
- **Seed commands work.** `pnpm seed` and `pnpm seed:reset` both exit 0 with informative stub messages. M3 from AUDIT-8 is resolved.
- **Contracts hardcoded path fixed.** `existsSync` in echo tests now uses `import.meta.url`-relative resolution — passes on any host, not just the Docker container. B2 from AUDIT-8 is resolved.
- **Structured logs confirmed.** JSON log lines with `reqId`, `level`, `method`, `url`, `statusCode` verified live against running server.
- **Security headers verified live.** `x-content-type-options: nosniff`, `x-frame-options`, `content-security-policy` all present on responses.
- **`global-error.tsx` correct.** `apps/web/src/app/global-error.tsx` is a Client Component, renders its own `<html><body>`, and calls `Sentry.captureException(error)`. Gate waiver W3 is resolved.
- **`pnpm audit --audit-level=high` exits 0.** No HIGH or CRITICAL vulnerabilities. Rollup CVE pinned via `pnpm.overrides`.

---

## Verdict: FAIL

Two blockers prevent this phase from passing the gate:

**B1** (`pnpm -r build` exits 1) is the most concrete defect: confirmed live with exact error output. The gate criterion is unambiguous — "`pnpm -r build` exits 0." Every prior audit marked this PASS by relying on a Turbo cache hit (33ms) rather than a live build invocation. The fix is a one-line change: remove `NODE_ENV=production` from `apps/web/package.json:8` (Next.js sets it automatically) or wrap with `cross-env`.

**B2** (`Sentry.setupFastifyErrorHandler` absent) means the explicit gate criterion for API error capture is structurally unmet. The implementation initializes Sentry but does not wire it into Fastify's error handling pipeline. CORRECTION-5 acknowledged this and did not fix it. The gate waiver for W3 does not cover this gap.

Both fixes are narrow, well-defined, and independently verifiable. No architectural decisions are required.
