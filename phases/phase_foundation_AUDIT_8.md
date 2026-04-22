# Audit: phase_foundation — Cycle 8

**Audited at:** 2026-04-22
**Commit:** 0e258b52f5be627127746a40d963a56fc8cba302 (HEAD)
**Auditor:** Claude (adversarial)

## Context

AUDIT-7 identified blockers B1-B4 and majors M1-M3. CORRECTION-4 (`f11920e`) claims to resolve all of them. This cycle independently verifies those claims on the committed codebase. Every check was run live — no trust extended to prior audit results or the corrector's self-reported test output.

---

## Summary

CORRECTION-4 fixed B3 (root `db:migrate` script), B4 (DB live-integration tests now skip when Postgres is unreachable), M3 (Husky `prepare` script added), and M1 (homepage now calls `fetch(.../healthz)` and the structure test verifies runtime behavior). However, B1 (coverage fails) and B4's root cause were incompletely addressed: the `apps/api` happy-path tests also require live infrastructure and have no skip guards — `pnpm turbo test --force` exits non-zero with 14 failures in `apps/api` and 2 failures in `packages/contracts`. Turbo's caching masks both failures when running `pnpm turbo test` (without `--force`), producing a false "all pass" result. The coverage gate is also broken for `packages/contracts`.

---

## Gate Criteria

### `pnpm install` — zero warnings
**Status: PASS**
`pnpm install 2>&1 | grep -c "WARN"` → 0

---

### `pnpm -r typecheck` — exits 0, strict mode
**Status: PASS**
`pnpm turbo typecheck` → `8 successful, 8 cached, FULL TURBO`. No type errors.

---

### `pnpm -r lint` — exits 0
**Status: PASS**
`pnpm turbo lint` → `8 successful`. No lint errors.

---

### `pnpm -r build` — exits 0; artifacts exist
**Status: PASS**
`apps/web/.next/`, `apps/api/dist/`, `apps/voice/dist/` all exist. Cached build runs in 33ms.

---

### Turborepo caching — second build "FULL TURBO"
**Status: PASS**
`pnpm build --force && pnpm build` — second run: `4 cached, 4 total >>> FULL TURBO`.

---

### Pre-commit hook blocks lint/typecheck violations
**Status: PASS**
`"prepare": "husky"` added to root `package.json`. After `pnpm install`, `git config core.hooksPath` = `.husky/_` and `.husky/_/pre-commit` chains into `.husky/pre-commit` which runs `pnpm -r typecheck && pnpm -r lint`. Hook is active on this machine after install. M3 from AUDIT-7 is resolved.

Note: `.husky/pre-commit` sources the deprecated `_/husky.sh` shim, which prints a deprecation warning but does not block the commit. Cosmetically noisy but functionally correct for v9.

---

### `pnpm db:migrate` — exits 0 against Postgres
**Status: FAIL (environment — not a code defect, but WARN)**
Root `package.json` now has `"db:migrate": "pnpm --filter @service-ai/db run db:migrate"` (B3 from AUDIT-7 is fixed). The underlying command `psql $DATABASE_URL -f migrations/0001_health_checks.sql` fails on this machine because `psql` is not in PATH. This is a Windows dev machine without Postgres CLI tools installed — not a code defect. The fix is environment-level, not code-level. In the Docker container and CI, this would pass. Recording as WARN, not blocker.

---

### Migrations stored as SQL files; reversible
**Status: PASS**
`packages/db/migrations/0001_health_checks.sql` (CREATE TABLE IF NOT EXISTS) and `0001_health_checks.down.sql` (DROP TABLE IF EXISTS) both exist and are correct.

---

### DB integration test — writes and reads back via Drizzle ORM
**Status: PASS (infrastructure-dependent)**
`pnpm --filter @service-ai/db test` → `15 passed | 4 skipped (19)`. Live integration tests now properly skip when Postgres is unreachable via `ctx.skip()` in `beforeEach`. B4 from AUDIT-7 is resolved for this package.

---

### API boots on port 3001 within 10s; `/healthz` returns `{ok:true}`
**Status: PASS (with infrastructure caveat)**
Live verification: `node apps/api/dist/index.js` → responds within 4s. Without DB/Redis: returns `{"ok":false,"db":"down","redis":"down"}` (HTTP 503) as expected. With DB/Redis available (CI/Docker): would return `{"ok":true,"db":"up","redis":"up"}` (HTTP 200).

---

### `GET /healthz` returns 200/503; integration tests pass
**Status: FAIL — BLOCKER B1 (new)**

`pnpm --filter @service-ai/api test` exits 1 with **14 failures** in `health.test.ts`:

The "happy path" suite (Suite 2) creates a `buildApp()` with NO overrides — this constructs a real `pg.Pool` and `ioredis` client. Without running infrastructure, `redis.ping()` inside the `/healthz` handler hangs for 10+ seconds (ioredis reconnection backoff) and exceeds the 5s test timeout.

The "DB unreachable" suite (Suite 3) mocks `db.query` but still creates a real `ioredis` client — it times out waiting for the ioredis connection while the mock DB throws immediately.

Failing tests:
- Suite 2 (happy path): 6 tests — expect 200, timeout instead
- Suite 3 (DB unreachable): 4 tests — expect specific 503 response, timeout
- Suite 6 (request-id): 2 tests
- Suite 7 (security headers): 2 tests

All 14 fail with: `Error: Test timed out in 5000ms.`

The DB package (B4 in AUDIT-7) was fixed by adding `ctx.skip()` guards in `beforeEach`. The API package was NOT fixed the same way. The corrector's claim of "138/138 tests pass" was true only in the Docker container where Redis and Postgres are accessible on `127.0.0.1`.

Evidence: `pnpm --filter @service-ai/api test` (no cache):
```
Test Files  1 failed | 2 passed (3)
     Tests  14 failed | 41 passed (55)
```

---

### `pnpm -r test` exits 0 — OVERALL
**Status: FAIL — BLOCKER B2 (new)**

Running `pnpm turbo test --force` (bypassing cache) exits non-zero with failures in two packages:

1. **`@service-ai/api`**: 14 failures (detailed above in B1)
2. **`@service-ai/contracts`**: 2 failures — `existsSync('/workspace/packages/contracts/src/echo.ts')` and `existsSync('/workspace/packages/contracts/src/index.ts')` return false. These paths are **hardcoded to the Docker build container's `/workspace/` mount point**. The files exist at `packages/contracts/src/echo.ts` but not at the absolute `/workspace/` path.

The gate criterion explicitly states: "`pnpm -r test` exits 0." It does not.

Critical aggravating factor: **Turbo caching masks these failures.** `pnpm turbo test` (without `--force`) shows all packages as "cache hit, replaying logs" — it replays the previously-passing results from the Docker container run and exits 0, hiding both sets of failures. This false-positive behavior makes the gate criterion appear to pass when it does not.

Evidence: `pnpm turbo test --force` (cache bypassed):
```
@service-ai/contracts:test:  FAIL  src/__tests__/echo.test.ts > TASK-FND-06 / contracts package / file existence > echo.ts source file exists at the expected path
@service-ai/contracts:test:  FAIL  src/__tests__/echo.test.ts > TASK-FND-06 / contracts package / file existence > index.ts re-exports from echo.ts
@service-ai/contracts:test:      Tests  2 failed | 19 passed (21)
 ERROR  run failed: command  exited (1)
```

---

### Code coverage ≥ 80% on foundation paths
**Status: FAIL — BLOCKER B3 (new)**

`pnpm turbo coverage` exits non-zero. `@service-ai/contracts#coverage` fails because the same 2 hardcoded-path tests that fail in `pnpm test --force` also fail when `vitest run --coverage` is invoked directly (coverage does not benefit from Turbo cache).

When tests fail, `vitest run --coverage` exits 1 — the coverage report is never emitted. The 80% threshold for `packages/contracts` cannot be verified.

`@service-ai/api#coverage` also fails: 15 failures (the 14 from `pnpm test` plus 1 additional: the `shutdown.test.ts` "in-flight" test fails under v8 coverage instrumentation due to timing overhead increasing connection attempt windows). API coverage cannot be verified.

`packages/db` coverage: PASS at 100%.

Evidence: `pnpm turbo coverage`:
```
@service-ai/contracts:coverage:  Test Files  1 failed (1)
@service-ai/contracts:coverage:       Tests  2 failed | 19 passed (21)
ERROR  @service-ai/contracts#coverage: command exited (1)
Failed:    @service-ai/contracts#coverage
```

---

### Fastify plugins registered
**Status: PASS**
`apps/api/src/app.ts` lines 108-112 register all five: `sensible`, `helmet`, `cors`, `rateLimit`, `compress`. Live verified via curl: `x-content-type-options: nosniff` header present.

---

### Structured JSON logs; `reqId` in every request log
**Status: PASS**
Live log: `{"level":30,"reqId":"a397e617-...","req":{"method":"GET","url":"/healthz",...},"msg":"incoming request"}` — correct.

---

### Graceful shutdown integration test (B2 from AUDIT-7)
**Status: PASS (test exists)**
`apps/api/src/__tests__/shutdown.test.ts` exists with 6 tests covering SIGTERM handler registration (static text scan of `index.ts`) and `app.close()` behavioral drain. Tests pass in `pnpm test` mode.

Note: the shutdown test uses `readFileSync(INDEX_TS, 'utf-8')` string scanning to assert the SIGTERM handler exists — this is a code-quality concern (it would pass even if the handler were dead code), but it passes the gate criterion as written. This is a known weakness in test design but not a blocker for this phase.

---

### Web app boots; homepage renders "Service.AI" + health request
**Status: PASS**
`apps/web/src/app/page.tsx` calls `fetch(`${BASE_URL}/healthz`, { cache: 'no-store' })` (M1 from AUDIT-7 resolved). Structure test verifies both `fetch(` and `/healthz` are present as runtime calls, not just comments. 32/32 web tests pass.

---

### ts-rest contracts — echo.ts exists, POST /api/v1/echo works
**Status: PASS (echo endpoint) / FAIL (contracts test portability)**
Live: `curl -X POST http://localhost:3001/api/v1/echo -d '{"message":"hello"}'` → `{"ok":true,"data":{"echo":"hello"}}` (HTTP 200).
`curl -X POST http://localhost:3001/api/v1/echo -d '{}'` → `{"ok":false,"error":{"code":"VALIDATION_ERROR",...}}` (HTTP 400).
Contracts package functional tests (19/21) pass. But 2 file-existence tests fail on non-Docker environments (hardcoded paths).

---

### Voice service boots, WebSocket echo
**Status: PASS**
`node apps/voice/dist/index.js` → `curl http://localhost:8080/healthz` → `{"ok":true}` (HTTP 200). 11/11 voice tests pass.

---

### CI workflow — 4 jobs, push+PR triggers, pnpm cache
**Status: PASS**
`.github/workflows/ci.yml` has all four jobs (typecheck, lint, test, build), `on: push: branches: ['**']` and `on: pull_request`, postgres:16 and redis:7 service containers in the test job, `cache: 'pnpm'` in all steps.

---

### No secrets committed; `pnpm audit --audit-level=high` exits 0
**Status: PASS**
`pnpm audit --audit-level=high` → `3 moderate vulnerabilities` — no HIGH or CRITICAL. Rollup CVE still pinned via `pnpm.overrides`. `.env` is in `.gitignore`.

---

### `.do/app.yaml` — 3 services, managed Postgres + Redis
**Status: PASS**
File defines web, api, voice services and two managed databases (Postgres, Redis).

---

### Docker Compose — 5 containers (healthy) within 60s
**Status: PASS (structural)**
`docker-compose.yml` defines `web`, `api`, `voice`, `postgres`, `redis` services (plus a `builder` service for the AI agent pipeline). All app services (`web`, `api`, `voice`) now have `healthcheck:` stanzas (L-FND-11 resolved). Port mapping is correct: web:3000, api:3001, voice:8080, postgres:5434, redis:6381. Docker Compose not started for this audit — structural review only.

---

### README rollback procedure
**Status: PASS**
`grep -i "rollback" README.md` matches `## Rollback Procedure` heading.

---

### `docs/ARCHITECTURE.md` — topology + dependency graph + local vs DO parity
**Status: PASS**
Section 2a ("Package dependency graph") added in CORRECTION-4 with explicit directed edges for all workspace packages. Section 2b covers local vs DO parity. All three required elements present. W6 from AUDIT-7 resolved.

---

## BLOCKERS (must fix before gate)

### B1. `apps/api` happy-path tests fail without infrastructure — no skip guards
**File:** `apps/api/src/__tests__/health.test.ts:66-133`
**Evidence:** `pnpm --filter @service-ai/api test` exits 1 with 14 failures. The "happy path" suite calls `createTestApp()` with no overrides, creating real pg.Pool + ioredis clients. When neither Postgres nor Redis is running, `redis.ping()` triggers an ioredis reconnection loop lasting 10+ seconds, exceeding the 5s test timeout. Failures: `Error: Test timed out in 5000ms` on lines 77, 86, 95, 105, 115, 125 (happy path) and lines 163, 172, 182, 192 (DB-mock + real Redis) and lines 332, 347, 381, 390 (logging/headers — also affected by ioredis timeout).
**Risk:** Gate criterion "`pnpm -r test` exits 0" is not met. Any developer running the test suite without Docker Compose sees 14 failures. CI would pass (postgres/redis service containers provided), but the test is not reproducible locally and cannot be verified without infrastructure.
**Fix direction:** Apply the same pattern used in `packages/db`: add `let redisReachable = false` + `checkRedisReachable()` in `beforeAll`, then `ctx.skip()` in `beforeEach` for the happy-path and mixed-mock suites. Alternatively, make the happy-path suite use fully-mocked clients (the mock injection mechanism already exists in `buildApp(opts)`) — this is actually the cleaner fix since "happy path" should mean "all dependencies report healthy" which is best expressed via a mock `{ query: async () => {} }` and `{ ping: async () => 'PONG' }`.

### B2. `packages/contracts` tests fail on non-Docker environments — hardcoded `/workspace/` path
**File:** `packages/contracts/src/__tests__/echo.test.ts:27,35`
**Evidence:** `pnpm --filter @service-ai/contracts test` exits 1 with 2 failures:
```
FAIL echo.ts source file exists at the expected path
AssertionError: expected false to be true
  > existsSync('/workspace/packages/contracts/src/echo.ts')
```
The path `/workspace/packages/contracts/src/echo.ts` exists only in the Docker build container. On this Windows machine, the file is at `C:\Users\jhein\servicetitan-clone\packages\contracts\src\echo.ts`. `pnpm turbo test` hides this by replaying a stale Turbo cache hit from when the test ran in the Docker container.
**Risk:** Any developer running `pnpm test` (or `pnpm turbo test --force`) outside the Docker container gets false failures. The Turbo cache creates a false-positive "all tests pass" on fresh runs that haven't rebuilt the cache — this masks real regressions.
**Fix direction:** Replace `existsSync('/workspace/packages/contracts/src/echo.ts')` with a path relative to `__dirname`, e.g.:
```ts
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
existsSync(resolve(PKG_ROOT, 'src/echo.ts'))
```

### B3. `pnpm turbo coverage` fails — coverage gate is unverifiable for two packages
**File:** `packages/contracts/src/__tests__/echo.test.ts:27,35` + `apps/api/src/__tests__/health.test.ts`
**Evidence:** `pnpm turbo coverage` exits 1. `@service-ai/contracts#coverage` fails because the 2 hardcoded-path tests fail and vitest exits non-zero before emitting the coverage report. `@service-ai/api#coverage` fails with 15 failures (14 from health.test.ts + 1 from shutdown.test.ts under v8 instrumentation timing pressure).
**Risk:** The gate criterion "Code coverage ≥ 80% on foundation packages and foundation routes" cannot be verified for either `packages/contracts` or `apps/api`.
**Fix direction:** Fix B1 and B2 first. After those are resolved, re-run `pnpm turbo coverage` to confirm thresholds are met. The shutdown test timing issue under coverage should be addressed by adding sufficient tolerance or restructuring to avoid reliance on exact wall-clock timing in the presence of instrumentation overhead.

---

## MAJOR (must fix before gate, 3+ fails the phase)

### M1. Turbo cache masks test failures — false "all pass" from `pnpm turbo test`
**File:** `turbo.json` + `.turbo/` local cache
**Evidence:** `pnpm turbo test` (without `--force`) reports `8 cached, 8 total >>> FULL TURBO` and exits 0, replaying a stale Docker-container cache hit for `@service-ai/contracts#test` and `@service-ai/api#test`. Running `pnpm turbo test --force` reveals 14 API failures and 2 contracts failures. The gate's own verification command (`pnpm -r test`) would show failures, but the corrector ran inside Docker where they pass — and the cached results persist.
**Risk:** Every future audit cycle that trusts `pnpm turbo test` exit code without `--force` will silently accept broken tests. This is a systemic verification gap.
**Fix direction:** Fixing B1 and B2 ensures tests genuinely pass everywhere. Additionally, the gate verification should explicitly specify `pnpm turbo test --force` or `pnpm -r test` (which uses `pnpm exec` not turbo and bypasses the cache) to avoid the cache-masking problem.

### M2. Shutdown test is flaky under v8 coverage instrumentation
**File:** `apps/api/src/__tests__/shutdown.test.ts:95-131`
**Evidence:** `pnpm --filter @service-ai/api test` → `shutdown.test.ts: 6 passed`. `pnpm --filter @service-ai/api coverage` → `shutdown.test.ts: 1 failed` (the in-flight request test). The test uses `setTimeout(r, 150)` as a DB stub delay and `setTimeout(r, 10)` to allow the request a head-start before `app.close()`. Under v8 instrumentation overhead, the 10ms head-start is insufficient and `app.close()` may complete before the request starts.
**Risk:** A test that passes under `test` but fails under `coverage` is a flaky test. It silently lowers confidence in coverage results and may cause intermittent CI failures.
**Fix direction:** Increase the head-start delay from 10ms to 50-100ms, or use a deterministic signal (e.g., a shared event emitter) instead of a timing assumption. The DB stub delay of 150ms should remain sufficiently longer than the head-start.

### M3. `pnpm seed` and `pnpm seed:reset` documented in README but exit 254
**File:** `README.md:56-59`, `package.json`
**Evidence:** `pnpm seed` → `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "seed" not found` (exit 254). Neither `seed` nor `seed:reset` appears in root `package.json` scripts. The README documents them as operational commands.
**Risk:** Any developer following the README to set up a fresh environment will hit immediate failures at the seed step.
**Fix direction:** Either add the missing root scripts (`"seed": "pnpm --filter @service-ai/db run seed"`) or remove the commands from the README until they exist.

---

## MINOR (fix in next phase)

### m1. Voice echo latency test asserts `< 200ms` rather than gate-required ≤ 50ms
**File:** `apps/voice/src/__tests__/*.test.ts:203`
**Evidence:** `expect(elapsedMs).toBeLessThan(200)` with comment: "The acceptance criterion says 50ms in production; we allow 200ms in test environments."
**Risk:** The gate criterion is not met by the test as written. This was a carried minor from AUDIT-7.

### m2. Docker Compose `web` depends on `api` without `condition: service_healthy`
**File:** `docker-compose.yml:77-78`
**Evidence:** `depends_on: - api` uses default `condition: service_started`. The `api` service has a `healthcheck:` stanza but the `web` service doesn't wait for it to pass.
**Risk:** `web` may start before `api` is ready to accept connections, causing startup failures in slow environments.

### m3. `.husky/pre-commit` sources deprecated `_/husky.sh` shim
**File:** `.husky/pre-commit:2`
**Evidence:** Line 2: `. "$(dirname -- "$0")/_/husky.sh"` — this prints a deprecation warning on every commit but does not block execution. Will fail in Husky v10.
**Risk:** Harmless now, breaking in the next major Husky upgrade.

### m4. `packages/contracts` echo test file-existence checks are environment-specific
**File:** `packages/contracts/src/__tests__/echo.test.ts:27,35`
**Evidence:** (Same as BLOCKER B2 — catalogued as minor here for the record that even if the functional tests are fixed to be path-portable, the issue traces to test design that assumes Docker container paths.)

---

## POSITIVE OBSERVATIONS

- B3 from AUDIT-7 (`pnpm db:migrate` from root) is fixed — `package.json` now has the forwarding script.
- B4 from AUDIT-7 (DB live integration tests fail without Postgres) is fixed — `packages/db` now uses `ctx.skip()` correctly.
- M1 from AUDIT-7 (homepage calls real `/healthz`) is fixed — `page.tsx` uses `fetch()` and the structure test now verifies runtime behavior, not comment text.
- M3 from AUDIT-7 (Husky not installed on fresh clone) is fixed — `"prepare": "husky"` in root `package.json` correctly sets up the hook on `pnpm install`.
- B2 from AUDIT-7 (graceful shutdown test missing) is fixed — `shutdown.test.ts` exists with 6 tests covering SIGTERM handler registration and `app.close()` drain.
- W6 from AUDIT-7 (ARCHITECTURE.md missing package dependency graph) is fixed — Section 2a now has explicit directed edges.
- API echo endpoint is functionally correct: `{"ok":true,"data":{"echo":"hello"}}` on valid input, `{"ok":false,"error":{"code":"VALIDATION_ERROR",...}}` on invalid input.
- Security headers verified live: `x-content-type-options: nosniff`, `x-frame-options`, `content-security-policy` all present.
- `global-error.tsx` properly implemented with `'use client'`, Sentry integration, and its own `<html><body>` wrapper.

---

## Verdict
FAIL

Three blockers remain in the committed codebase. The root cause is that CORRECTION-4 was verified exclusively inside the Docker build container (where Postgres and Redis are available at localhost), then committed without verifying that the tests also pass on a bare host machine. The contracts hardcoded `/workspace/` paths and the API happy-path tests without infrastructure skip guards both work in Docker but fail everywhere else. Turbo caching compounded the problem by replaying the Docker-passing results on subsequent `pnpm turbo test` runs, hiding the regressions. `pnpm -r test` (or `pnpm turbo test --force`) exits non-zero with 16 failures across two packages.
