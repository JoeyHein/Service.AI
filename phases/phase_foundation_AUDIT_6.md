# phase_foundation Audit 6 — 2026-04-22

## Summary

The build is clean: `pnpm -r typecheck`, `pnpm -r lint`, and `pnpm -r build` all exit 0 across all 8 packages. 256 tests pass in the working tree (49 API + 24 web + 21 contracts + 19 DB + 11 voice + 132 foundation). However, three blockers from AUDIT_5 remain unfixed in the committed codebase: coverage tooling (`@vitest/coverage-v8`) is absent making the ≥80% coverage gate criterion structurally unverifiable; the graceful shutdown integration test does not exist; and `pnpm db:migrate` fails from the repository root with exit 254. The CORRECTION_2 changes adding regression tests are uncommitted working-tree modifications and do not address B1, B2, or B3 from AUDIT_5.

## Exit criteria check

### pnpm install — zero warnings
- Status: PASS
- Evidence: `pnpm install 2>&1 | grep -c "WARN"` returns `0`.

### pnpm -r typecheck exits 0, strict mode everywhere
- Status: PASS
- Evidence: `pnpm -r typecheck` exits 0 across all 8 packages. Working tree is clean of type errors; the staged index contains a deliberate type-error line (`const x: number = "this is a string"`) from AUDIT_5's hook test artifact — this is a repo hygiene issue (see M3) but does not affect the working tree typecheck result.

### pnpm -r lint exits 0
- Status: PASS
- Evidence: `pnpm -r lint` exits 0. Non-fatal deprecation warnings from Next.js ESLint do not affect exit code.

### pnpm -r build exits 0, all artifacts exist
- Status: PASS
- Evidence: `pnpm -r build` exits 0. Artifacts confirmed: `apps/api/dist/` (app.js, index.js, logger.js, sentry.js), `apps/voice/dist/` (app.js, index.js), `apps/web/.next/` (server, static, cache).

### Turborepo caching — second build FULL TURBO
- Status: PASS
- Evidence: Forced cold build: 4 successful, 0 cached, ~1m47s (WSL2 environment). Second run: `4 cached, 4 total, 10.219s >>> FULL TURBO`. Cache-hit criterion met.

### Pre-commit hook blocks lint/typecheck violations
- Status: PARTIAL
- Evidence: `.husky/pre-commit` runs `pnpm -r typecheck && pnpm -r lint`. Hook is active in this environment because AUDIT_5 ran `pnpm exec husky` which set `core.hooksPath = .husky/_` in the local `.git/config`. Root `package.json` has no `prepare` script — on a fresh `git clone && pnpm install`, Husky is never initialized. A developer cloning fresh has no pre-commit protection. See M2.

### pnpm db:migrate exits 0 and creates health_checks
- Status: FAIL
- Evidence:
  ```
  $ pnpm db:migrate
  ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "db:migrate" not found
  Exit: 254
  ```
  Root `package.json` scripts: `build`, `typecheck`, `lint`, `test`, `dev` — no `db:migrate`. `pnpm --filter @service-ai/db run db:migrate` works (exits 0, idempotent), but that is not the gate-specified command. This is B3 from AUDIT_5, unfixed.

### pnpm db:migrate:down reverts cleanly
- Status: PASS (via filter command)
- Evidence: `pnpm --filter @service-ai/db run db:migrate:down` exits 0.

### Migrations are SQL files, not drizzle-kit push
- Status: PASS
- Evidence: `packages/db/migrations/0001_health_checks.sql` and `0001_health_checks.down.sql` both exist with `CREATE TABLE IF NOT EXISTS` / `DROP TABLE IF EXISTS`.

### DB integration test (write + read-back via Drizzle)
- Status: PASS
- Evidence: `pnpm --filter @service-ai/db test` exits 0, 19/19 tests pass against a live Postgres instance.

### API boots on port 3001 within 10s
- Status: PASS
- Evidence: `pnpm --filter @service-ai/api test` passes 49 tests including the server bootstrap test.

### GET /healthz returns 200 / 503 when degraded
- Status: PASS
- Evidence: 29 health tests pass covering DB-down, Redis-down, both-down cases. HTTP 200 with `{ok:true, db:"up", redis:"up"}` and HTTP 503 for degraded states. Log lines confirm `reqId` on every request.

### Fastify plugins registered
- Status: PASS
- Evidence: `apps/api/src/app.ts` registers `@fastify/sensible`, `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit` (60 rpm), `@fastify/compress`.

### Structured JSON logs with reqId
- Status: PASS
- Evidence: Test output shows `"reqId":"..."` on every request log line. Example: `{"level":30,"time":...,"reqId":"5894d9ce-...","req":{"method":"GET","url":"/healthz",...},"msg":"incoming request"}`.

### Graceful shutdown integration test
- Status: FAIL
- Evidence: `grep -rn "SIGTERM|graceful|shutdown|drain" /workspace/apps/api/src/__tests__/` returns empty. The SIGTERM handler exists at `apps/api/src/index.ts:18-25` but no integration test spawns the server, sends SIGTERM while a request is in-flight, and asserts the process exits 0. Gate criterion: "Integration test sends SIGTERM while a slow request is in-flight; process exits 0 after request completes." This is B2 from AUDIT_5, unfixed.

### Web boots on port 3000 within 15s
- Status: PASS
- Evidence: Build artifact at `apps/web/.next/` confirmed. 4 static pages prerendered.

### Homepage renders "Service.AI" and issues GET /api/v1/health
- Status: FAIL
- Evidence: `page.tsx` renders "Service.AI" ✓. The page calls `apiClient.echo({ body: { message: 'ping' } })` (POST /api/v1/echo) — not GET /api/v1/health. The test at `apps/web/src/__tests__/structure.test.ts:164` passes because `content.includes('/api/v1/health')` matches JSDoc comment text at lines 7 and 19 of `page.tsx`. No executable code path contains a health endpoint call. Verified with `node -e`: only lines 7 and 19 (both `/** ... */` comment blocks) match. This is M1 from AUDIT_5, unfixed.

### Tailwind styles apply; shadcn importable without errors
- Status: PASS
- Evidence: `pnpm --filter @service-ai/web build` exits 0 with no Tailwind/shadcn errors.

### Web build produces .next
- Status: PASS
- Evidence: `apps/web/.next/` confirmed.

### Voice boots on port 8080; WebSocket handshake; echo ping→pong
- Status: PASS
- Evidence: 11/11 voice tests pass including WebSocket echo test.

### ts-rest contracts exist with Zod schemas
- Status: PASS
- Evidence: `packages/contracts/src/echo.ts` defines `EchoInputSchema`, `EchoResponseSchema`, `echoContract`. 21/21 contract tests pass.

### POST /api/v1/echo returns {ok:true,data:{echo:<input>}}
- Status: PASS
- Evidence: 20 echo tests pass covering happy path, 400 on invalid input, envelope shape.

### Web uses ts-rest typed client; type error causes compile failure
- Status: PASS
- Evidence: `page.tsx` uses `initClient(echoContract, {...})`. TypeScript enforces contract shape at compile time.

### CI workflow: 4 jobs, triggers, pnpm caching
- Status: PASS
- Evidence: `.github/workflows/ci.yml` has `on: push` and `on: pull_request`. Four jobs: `typecheck`, `lint`, `test`, `build`. All use `cache: 'pnpm'`. Test job spins up Postgres 16 and Redis 7 services.

### All CI checks pass on clean clone of main
- Status: CANNOT VERIFY
- Evidence: No GitHub Actions access. Code passes local verifications.

### Observability (Axiom/Sentry)
- Status: PARTIAL
- Evidence: `apps/api/src/logger.ts` conditionally activates `@axiomhq/pino` when `AXIOM_TOKEN` set. `apps/api/src/sentry.ts` conditionally initializes Sentry when `SENTRY_DSN` set. `apps/web/src/app/global-error.tsx` exists as Client Component calling `Sentry.captureException`. Logger is correctly imported in `app.ts`. Log redaction paths for `req.headers.authorization` and `req.headers.cookie` configured but Fastify's default pino serializer does not include headers in the log object — redaction paths never match in practice (see m6).

### Secrets not in code; pnpm audit exits 0
- Status: PASS
- Evidence: `pnpm audit --audit-level=high` exits 0 (3 moderate CVEs only). `pnpm.overrides` pins rollup. No secrets in source files. `.env` in `.gitignore`.

### .do/app.yaml — 3 services, 2 managed databases
- Status: PASS
- Evidence: File defines web, api, voice services and Postgres 16 + Redis 7 managed databases.

### Docker Compose — 5 services
- Status: PASS (structural)
- Evidence: `docker-compose.yml` defines web, api, voice, postgres, redis with healthcheck stanzas. Live compose-up test not performed.

### Test coverage ≥ 80% on packages/db, contracts, /healthz, /echo
- Status: FAIL
- Evidence:
  ```
  $ pnpm --filter @service-ai/api exec vitest run --coverage
  MISSING DEPENDENCY  Cannot find dependency '@vitest/coverage-v8'
  Exit code 1
  ```
  `@vitest/coverage-v8` is not installed in any workspace package. No `coverage` script exists anywhere. The ≥80% coverage gate criterion is structurally unverifiable. This is B1 from AUDIT_5, unfixed.

### Zero BLOCKER findings in final audit
- Status: FAIL
- Evidence: This audit finds B1, B2, B3 — all carried over unfixed from AUDIT_5.

## Blockers

### B1. Coverage tooling completely absent — criterion structurally unverifiable
- **Location:** All `vitest.config.ts` files; root `package.json`
- **Evidence:** `@vitest/coverage-v8` not in any package's devDependencies. `pnpm --filter @service-ai/api exec vitest run --coverage` exits 1. No `coverage` script in any `package.json`. Gate criterion requires ≥80% line coverage for `packages/db`, `packages/contracts`, `/healthz`, `/echo` paths.
- **Carried from:** AUDIT_5 B1 — not addressed in CORRECTION_2.
- **Fix:** Add `@vitest/coverage-v8` to devDependencies in `packages/db`, `packages/contracts`, and `apps/api`. Add `coverage` key to each `vitest.config.ts`. Add root `db:migrate` and coverage scripts. Then verify actual ≥80% line coverage.

### B2. Graceful shutdown integration test does not exist
- **Location:** `apps/api/src/__tests__/` (no file covers SIGTERM behavior)
- **Evidence:** `grep -rn "SIGTERM|graceful|shutdown|drain" /workspace/apps/api/src/__tests__/` returns empty. Handler at `apps/api/src/index.ts:18-25` is untested.
- **Carried from:** AUDIT_5 B2 — not addressed in CORRECTION_2.
- **Fix:** Add integration test to `apps/api/src/__tests__/health.test.ts` that spawns the API as a child process, fires a slow request, sends SIGTERM, and asserts both request completion and process exit code 0.

### B3. `pnpm db:migrate` fails from repository root — exit 254
- **Location:** `/workspace/package.json` (missing script)
- **Evidence:** `pnpm db:migrate` → `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "db:migrate" not found`. Root `package.json` has no `db:migrate` script. README documents it as the migration command.
- **Carried from:** AUDIT_5 B3 — not addressed in CORRECTION_2.
- **Fix:** Add `"db:migrate": "pnpm --filter @service-ai/db run db:migrate"` and `"db:migrate:down": "pnpm --filter @service-ai/db run db:migrate:down"` to root `package.json` scripts.

## Non-blocking observations

### M1. Homepage calls POST /api/v1/echo — test passes on JSDoc comment text
Gate says homepage issues GET /api/v1/health. The page calls POST /api/v1/echo. The structure test passes because `content.includes('/api/v1/health')` matches JSDoc comments only. Carried from AUDIT_5 M1, AUDIT_4 W1. Previously accepted as non-blocking by gate reviewer; documenting for completeness.

### M2. Husky `prepare` script missing — pre-commit hooks inactive on fresh clones
Root `package.json` has no `prepare` script. Pre-commit hook only works in this environment due to a persistent side effect from AUDIT_5. Fresh clones have no protection. Carried from AUDIT_5 M2.

### M3. Staging index contains deliberate type error
`git diff --staged -- apps/api/src/app.ts` shows `+const x: number = "this is a string"` staged (added back from AUDIT_5 hook test). Working tree is clean. A `git commit` without `-a` would commit a broken `app.ts`. Fix: `git restore --staged apps/api/src/app.ts`.

### m1. CORRECTION_2 test additions are uncommitted working-tree changes
Three test files modified by CORRECTION_2 (`apps/api/src/__tests__/health.test.ts`, `apps/web/src/__tests__/structure.test.ts`, `packages/contracts/src/__tests__/echo.test.ts`) are not committed. Tests pass locally but are not in repository history.

### m2. Voice echo latency test allows 200ms; gate requires 50ms
`apps/voice/src/__tests__/voice.test.ts:199` asserts `expect(elapsedMs).toBeLessThan(200)`. Gate says ≤50ms.

### m3. Husky pre-commit uses deprecated v8 shebang syntax
`.husky/pre-commit` uses the deprecated Husky v8 source format. Husky warns it will fail in v10.

### m4. Log redaction practically never exercised
Redact paths for `req.headers.authorization` and `req.headers.cookie` are configured but Fastify's default pino serializer does not include headers in the log object, so the redaction never fires. No test verifies `[REDACTED]` output.

### m5. ARCHITECTURE.md lacks explicit package dependency graph
Gate criterion specifies a "package dependency graph." Current content has prose only, no labeled ASCII or diagram showing `web → contracts`, `api → db + contracts + auth`, etc.

### m6. README documents non-functional commands
`pnpm seed` and `pnpm seed:reset` documented in README but fail with exit 254.

## Verdict: FAIL
