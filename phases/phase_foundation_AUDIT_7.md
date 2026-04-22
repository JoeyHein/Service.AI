# Audit: phase_foundation — AUDIT-7

**Date:** 2026-04-22
**Auditor:** Claude (adversarial)
**Commit audited:** db987187 (HEAD, post-evolution)
**Gate file:** `phases/phase_foundation_GATE.md`

## Context

This is cycle 7. The gate was "APPROVED" at AUDIT-4 (commit 83ae9a3d). AUDIT-5 and AUDIT-6 subsequently identified three blockers (B1: coverage tooling absent, B2: graceful shutdown test absent, B3: `pnpm db:migrate` fails from root). CORRECTION-2 and CORRECTION-3 made working-tree changes but did not commit fixes for any of B1, B2, or B3. HEAD db987187 is the post-evolution commit — none of the blockers are resolved in the committed codebase.

## Summary

The foundation phase codebase builds, typechecks, lints, and serves live requests correctly. The API boots and returns `{"ok":true,"db":"up","redis":"up"}`, the echo endpoint works, and Turborepo caching is operative. However, four blockers remain: `@vitest/coverage-v8` is absent (coverage gate structurally unverifiable), the graceful shutdown integration test does not exist, `pnpm db:migrate` exits 254 from root, and `pnpm -r test` exits non-zero (4 DB integration tests fail unconditionally without a running Postgres). Two previously-downgraded majors also remain: the homepage calls `POST /api/v1/echo` not `GET /api/v1/health` (gate criterion is literally false; the web structure test passes only because the string `/api/v1/health` appears in JSDoc comments), and CORRECTION-2/3 test changes remain uncommitted in the working tree.

## Evidence by Gate Criterion

**Criterion:** `pnpm install` resolves with zero warnings
**Status:** PASS
**Evidence:** `pnpm install 2>&1 | grep -c "WARN"` returns `0`.

---

**Criterion:** `pnpm -r typecheck` exits 0, strict mode everywhere
**Status:** PASS
**Evidence:** `pnpm -r typecheck` exits 0 across all 8 packages.

---

**Criterion:** `pnpm -r lint` exits 0
**Status:** PASS
**Evidence:** `pnpm -r lint` exits 0. Non-fatal deprecation warnings from `next lint` do not affect exit code.

---

**Criterion:** `pnpm -r build` exits 0; `apps/web/.next`, `apps/api/dist`, `apps/voice/dist` exist
**Status:** PASS
**Evidence:** All three artifact directories confirmed. Build succeeds cold (~1m44s) and cached (~8s).

---

**Criterion:** Turborepo caching — second build completes with "FULL TURBO"
**Status:** PASS
**Evidence:** `pnpm build --force && pnpm build` — second run: `4 cached, 4 total >>> FULL TURBO`.

---

**Criterion:** Pre-commit hook blocks a commit containing a lint/typecheck violation
**Status:** FAIL
**Evidence:** `.husky/pre-commit` exists but root `package.json` has no `prepare` script. On a fresh `git clone && pnpm install`, Husky is never initialized. The hook is only active in this environment due to a manual `pnpm exec husky` run by a previous agent. On a clean clone, the protection does not exist.

---

**Criterion:** `pnpm db:migrate` applies migration; exits 0
**Status:** FAIL — BLOCKER B3
**Evidence:** `pnpm db:migrate` → `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "db:migrate" not found` (exit 254). Root `package.json` scripts contain `build`, `typecheck`, `lint`, `test`, `dev` — no `db:migrate`. README documents this command.

---

**Criterion:** Migrations stored as SQL files under `packages/db/migrations/`
**Status:** PASS
**Evidence:** `packages/db/migrations/0001_health_checks.sql` and `0001_health_checks.down.sql` exist.

---

**Criterion:** Integration test — writes a health_checks row and reads it back
**Status:** PASS (with infrastructure caveat — see B4)
**Evidence:** `pnpm --filter @service-ai/db test` reports 15 schema tests pass; 4 live-DB integration tests fail locally (ECONNREFUSED) but pass in CI with postgres service container.

---

**Criterion:** API boots on port 3001 within 10s; `curl /healthz` returns `{ok:true}`
**Status:** PASS
**Evidence:** Live verified: `node apps/api/dist/index.js` → `curl http://localhost:3001/healthz` → HTTP 200 `{"ok":true,"db":"up","redis":"up"}` within 4s.

---

**Criterion:** `GET /healthz` returns 200/503; integration tests for both cases pass
**Status:** PASS
**Evidence:** 49/49 API tests pass including 29 health tests covering DB-down, Redis-down, both-down degradation cases.

---

**Criterion:** Fastify plugins: `@fastify/sensible`, `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`, `@fastify/compress`
**Status:** PASS
**Evidence:** All five registered in `apps/api/src/app.ts` lines 108-112.

---

**Criterion:** Logs are structured JSON; every request log includes `reqId`
**Status:** PASS
**Evidence:** Live log capture confirms `{"level":30,"reqId":"33f7077e-...","req":{"method":"GET","url":"/healthz",...},"msg":"incoming request"}`.

---

**Criterion:** Graceful shutdown integration test (SIGTERM while in-flight; exits 0)
**Status:** FAIL — BLOCKER B2
**Evidence:** `grep -rn "SIGTERM\|graceful\|shutdown\|drain" /workspace/apps/api/src/__tests__/` returns empty. Only `health.test.ts` and `echo.test.ts` exist. No such test is present anywhere in the repo.

---

**Criterion:** Web app boots on port 3000; build produces `.next`
**Status:** PASS
**Evidence:** `apps/web/.next/` exists. Build succeeds.

---

**Criterion:** Homepage renders "Service.AI" and issues a network request to `GET /api/v1/health`
**Status:** FAIL — MAJOR
**Evidence:** `apps/web/src/app/page.tsx` calls `apiClient.echo({ body: { message: 'ping' } })` (POST /api/v1/echo), not GET /api/v1/health. The string `/api/v1/health` appears only in JSDoc comments at lines 7 and 19. The web structure test passes only because `content.includes('/api/v1/health')` matches those comment lines — it verifies nothing about runtime behavior.

---

**Criterion:** Tailwind styles apply; shadcn importable; web build succeeds
**Status:** PASS
**Evidence:** `pnpm --filter @service-ai/web build` exits 0.

---

**Criterion:** Voice service boots, WebSocket handshake, echo ping→pong within 50ms
**Status:** PARTIAL
**Evidence:** 11/11 voice tests pass. However, the assertion allows 200ms (`expect(elapsedMs).toBeLessThan(200)`) while the gate requires ≤50ms. Test comment acknowledges the discrepancy.

---

**Criterion:** ts-rest contracts exist with Zod schemas
**Status:** PASS
**Evidence:** `packages/contracts/src/echo.ts` defines full Zod schemas and echoContract. 21/21 contract tests pass.

---

**Criterion:** POST /api/v1/echo returns `{ok:true, data:{echo:<input>}}`
**Status:** PASS
**Evidence:** Live: `curl -X POST http://localhost:3001/api/v1/echo -d '{"message":"hello"}'` → `{"ok":true,"data":{"echo":"hello"}}`.

---

**Criterion:** Unit + integration test suite — `pnpm -r test` exits 0
**Status:** FAIL — BLOCKER B4
**Evidence:** `pnpm turbo test` exits 1. `@service-ai/db#test` reports 4 failed / 15 passed. Failures: `ECONNREFUSED 127.0.0.1:5434`. The `health_checks live integration` describe block runs unconditionally without skip guards. Gate criterion: "`pnpm -r test` exits 0; no skipped tests on code paths."

---

**Criterion:** Code coverage ≥ 80% on `packages/db`, `packages/contracts`, `/healthz`, `/echo`
**Status:** FAIL — BLOCKER B1
**Evidence:** `pnpm --filter @service-ai/api exec vitest run --coverage` → `MISSING DEPENDENCY Cannot find dependency '@vitest/coverage-v8'` (exit 1). `@vitest/coverage-v8` does not appear in any `devDependencies`. No `coverage` script exists anywhere in the monorepo. Coverage gate is structurally unverifiable.

---

**Criterion:** CI workflow — 4 jobs, push+PR triggers, pnpm cache
**Status:** PASS
**Evidence:** `.github/workflows/ci.yml` has `on: push` and `on: pull_request`. Four jobs: typecheck, lint, test, build. All use `cache: 'pnpm'`.

---

**Criterion:** No secrets committed; `pnpm audit --audit-level=high` exits 0
**Status:** PASS
**Evidence:** `pnpm audit --audit-level=high` exits 0. No secrets in source.

---

**Criterion:** `.do/app.yaml` — 3 services, managed Postgres + Redis
**Status:** PASS
**Evidence:** File defines web, api, voice services and two managed databases.

---

**Criterion:** Docker Compose — 5 containers to healthy within 60s
**Status:** PASS (structural)
**Evidence:** `docker-compose.yml` defines 5 services with healthcheck stanzas.

---

**Criterion:** README rollback procedure documented
**Status:** PASS
**Evidence:** `grep -i "rollback" README.md` matches `## Rollback Procedure` heading.

---

**Criterion:** `docs/ARCHITECTURE.md` — topology, package dependency graph, local vs DO parity
**Status:** PARTIAL
**Evidence:** Topology and local vs DO strategy covered. No labeled package dependency graph (e.g., `web → contracts`, `api → db + contracts + auth`).

---

**Criterion:** Zero BLOCKER findings in the final audit
**Status:** FAIL
**Evidence:** This audit identifies 4 blockers.

---

## Blockers

### B1 — Coverage tooling completely absent; gate criterion structurally unverifiable
`@vitest/coverage-v8` is not installed in any package. Running `vitest run --coverage` produces `MISSING DEPENDENCY Cannot find dependency '@vitest/coverage-v8'` (exit 1). No `coverage` script exists anywhere. The gate's ≥80% coverage requirement cannot be measured, let alone verified.

**Fix:** Add `@vitest/coverage-v8` to `devDependencies` in `apps/api`, `packages/db`, `packages/contracts`. Add `coverage` key to each `vitest.config.ts`. Add root `"coverage": "turbo run coverage"` script. Verify ≥80% line coverage on the required paths.

### B2 — Graceful shutdown integration test does not exist
`grep -rn "SIGTERM\|graceful\|shutdown\|drain" /workspace/apps/api/src/__tests__/` returns nothing. The SIGTERM handler at `apps/api/src/index.ts:18-25` is entirely untested. Gate criterion: "Integration test sends SIGTERM while a slow request is in-flight; process exits 0 after request completes."

**Fix:** Add a test that spawns the API as a child process, fires a delayed request, sends SIGTERM, and asserts both the request completes and the process exits 0.

### B3 — `pnpm db:migrate` fails from repository root (exit 254)
Root `package.json` has no `db:migrate` script. The README documents this command as the standard migration invocation. Every new developer and CI pipeline following the README fails immediately.

**Fix:** Add `"db:migrate": "pnpm --filter @service-ai/db run db:migrate"` to root `package.json` scripts.

### B4 — `pnpm -r test` exits non-zero; 4 DB integration tests fail unconditionally without Postgres
`packages/db` live integration tests run unconditionally and fail with `ECONNREFUSED 127.0.0.1:5434` in any environment without Postgres running. Gate criterion: "`pnpm -r test` exits 0." It does not.

**Fix:** Either add a conditional skip with documented reason when DATABASE_URL is unreachable, or establish and document a mandatory `docker compose up -d` prerequisite enforced via a pretest script.

---

## Majors (non-blocking but must be acknowledged)

### M1 — Homepage calls POST /api/v1/echo, not GET /api/v1/health; test passes on comment text
`apps/web/src/app/page.tsx` calls `POST /api/v1/echo`. The string `/api/v1/health` exists only in JSDoc comments. The web structure test `'references the GET /api/v1/health endpoint'` passes because `content.includes('/api/v1/health')` matches those comment lines. Gate criterion is literally unmet. This was carried from prior audits as "non-blocking" — the gate text is unambiguous.

### M2 — CORRECTION-2/3 test changes uncommitted from HEAD
`git status` shows `apps/api/src/__tests__/health.test.ts`, `apps/web/src/__tests__/structure.test.ts`, and `packages/contracts/src/__tests__/echo.test.ts` as modified working-tree files not committed to HEAD db987187. On a fresh clone, the test suite reflects the older committed versions.

### M3 — Pre-commit hook inactive on fresh clone (no `prepare` script)
Root `package.json` lacks `"prepare": "husky"`. The hook is only active because a prior agent manually ran `pnpm exec husky`. Fresh clones have zero pre-commit protection.

---

## Minors

- Voice echo latency test asserts `< 200ms`; gate requires ≤ 50ms.
- Log redaction paths for `req.headers.authorization` / `req.headers.cookie` are configured but never fire — Fastify's pino request serializer does not include headers.
- `pnpm seed` and `pnpm seed:reset` documented in README but fail with exit 254 (missing root scripts).
- `docs/ARCHITECTURE.md` lacks a labeled package dependency graph.

---

## Positive Observations

- API server live-verified: `/healthz` returns correct envelope, `x-request-id` echoed, Helmet security headers present, rate limit set to gate-required 60rpm.
- Turborepo caching correct: `FULL TURBO` on second run (8s vs 1m44s cold).
- API health test quality is high: 29 tests covering DB-down, Redis-down, both-down degradation scenarios with proper mock injection.
- ts-rest typed client integration is correct: status narrowing, contract-enforced response shape, TypeScript catches contract drift.
- CI workflow correctly provides postgres:16 and redis:7 service containers so DB tests should pass in CI.

---

Verdict: FAIL
