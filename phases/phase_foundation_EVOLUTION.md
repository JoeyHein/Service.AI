# Evolution: after phase_foundation

## Patterns observed

- **Vitest ran compiled dist/ test files (4 correction cycles lost):** `packages/db/vitest.config.ts` had no `include` pattern. Vitest matched both `src/**/*.test.ts` and `dist/**/*.test.js`. The dist copies had `__dirname` pointing into `dist/src/__tests__/`, making migration path lookups fail with confusing path errors. This consumed the most debugging time in the phase.

- **Stub packages declared `vitest run` without vitest installed (1 correction cycle):** Three packages (`ai`, `auth`, `ui`) had `"test": "vitest run"` with no `vitest` devDependency, causing `pnpm -r test` to fail on them with "command not found."

- **Sentry/Next.js integration required `withSentryConfig` wrapper that was missing (1 correction cycle):** `@sentry/nextjs@8` injects a webpack plugin at build time. Without `withSentryConfig`, the production build exited 1. The fix also required setting `autoInstrumentAppDirectory: false` to avoid App Router / Pages Router conflicts.

- **ts-rest numeric key accessor caused typecheck failure (1 correction cycle):** `responses[200]` with a bare integer literal violated the ts-rest type system under strict mode.

- **ts-rest client `satisfies` tautology did not enforce contract shape (1 correction cycle):** A `void (apiClient satisfies typeof apiClient)` expression was accepted by the auditor in cycle 1 before being correctly rejected in cycle 2. The gate criterion requires an actual typed call.

- **Logger module created but never imported (1 correction cycle):** `logger.ts` with Axiom transport was written but `app.ts` used its own inline logger. The wiring was done only after an explicit audit finding.

- **pino-pretty missing from devDependencies (1 correction cycle):** Referenced in logger.ts but not installed, causing a local dev crash.

- **rollup HIGH CVE from transitive dependency (1 correction cycle):** `@sentry/nextjs` brought in `rollup@3.29.5` with a HIGH CVE. Fixed with `pnpm.overrides`.

- **Duplicate comment block introduced during correction (not caught by builder):** A copy-paste during a correction cycle left the same multi-line comment block twice in `app.ts`. This was a W2 warning in Audit 4, fixed during evolution.

## Changes applied

### CLAUDE.md

Added three new subsections under "Required patterns":

- **Testing infrastructure:** Vitest `include`/`exclude` requirements for packages with `dist/`; stub package test script pattern.
- **Observability wiring:** Logger files must be immediately wired into the framework; Next.js App Router + Sentry requires `global-error.tsx`.
- **Security:** Audit after every major dependency addition; use `pnpm.overrides` for transitive CVEs.

### docs/LESSONS.md

Added 11 rules (L-FND-01 through L-FND-11) covering each incident above with Why and How to apply. Added 1 hypothesis (H-FND-01) for ESLint / next lint wiring that was not applied due to version compatibility risk.

### docs/TECH_DEBT.md

Added 3 deferred items from AUDIT-4 warnings:
- TD-FND-01: Next.js ESLint plugin not wired (LOW priority)
- TD-FND-02: Web structure test passes on comment text (LOW priority)
- TD-FND-03: ARCHITECTURE.md lacks explicit package dependency graph (LOW priority)

### Code fixes (W2, W3, W4 from AUDIT-4)

- **W2 fixed:** Removed duplicate comment block from `apps/api/src/app.ts`. Merged the unique content from both copies into a single accurate block.
- **W3 fixed:** Created `apps/web/src/app/global-error.tsx` — Next.js App Router root error boundary with Sentry capture. Eliminates the build warning about missing global error handler.
- **W4 fixed:** Added `healthcheck:` stanzas to `web`, `api`, and `voice` services in `docker-compose.yml`. Each uses `wget` against the service's health endpoint with `start_period` to accommodate slow startup.

### W5 not fixed (deferred)

`eslint-config-next` not wired. Flat config + `eslint-config-next` has known compatibility risks. Documented in `docs/TECH_DEBT.md` as TD-FND-01 and in `docs/LESSONS.md` as H-FND-01.

## Reinforcement

These things were done well and should persist:

- **Real DB integration tests:** Four distinct cases against live Postgres (happy path, two varchar overflows, timestamp default). This is the right pattern — do not mock what can be tested against real infra in the test container.
- **Health endpoint test coverage:** The `/healthz` tests cover both 200 (all up) and 503 (db down, redis down, both down) with nine sub-cases. This is exemplary.
- **Axiom transport gating on env var:** `logger.ts` correctly disables the Axiom transport when `AXIOM_TOKEN` is absent, making the logger a no-op in local dev without errors. This pattern must be applied to every external service integration.
- **Pre-commit hook via Husky:** Typecheck + lint run on commit. Never bypass. This prevented several broken states from being committed.
- **Turborepo output globs:** `dist/**` and `.next/**` (with `!.next/cache/**`) are correct. Caching works as intended.
- **rollup override pattern:** `pnpm.overrides` is the correct tool for pinning transitive CVEs. The one-line fix is clean and does not affect bundle output.

## Recommendations for next phase

- **Verify vitest configs early.** Every new package added in the next phase should have `include` and `exclude` set before any tests are written.
- **Wire observability before writing business logic.** Axiom and Sentry wiring should be the first thing verified in `pnpm -r test` output, not discovered at audit time.
- **Run `pnpm audit --audit-level=high` as the last step before submitting to audit.** The rollup CVE would have been caught before the first audit cycle.
- **When ts-rest contracts are extended, add a shape-drift typecheck test.** The tautology mistake shows that contract enforcement must be verified with an actual type-failing example, not a structural assertion.
