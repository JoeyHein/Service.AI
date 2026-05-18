# Lessons

Appended by the evolver after each phase. Every agent reads this at the start of every phase before doing anything else.

Format: each entry leads with the **rule**, then **Why:** (the observation that produced it) and **How to apply:** (when/where it kicks in).

---

## phase_foundation (2026-04-21)

### L-FND-01: Vitest must have an explicit `include` pattern in any package that compiles to `dist/`

**Why:** `packages/db/vitest.config.ts` had no `include` pattern, so Vitest matched both `src/**/*.test.ts` and compiled `dist/**/*.test.js`. The dist copies had `__dirname` pointing into `dist/src/__tests__/`, making migration path lookups fail with confusing errors unrelated to the actual code under test.

**How to apply:** Whenever you create or edit a `vitest.config.ts` in a package that has a `build` script (i.e., produces a `dist/` directory), add `include: ['src/**/*.test.ts']` and `exclude: ['dist/**', 'node_modules/**']` explicitly. Do not rely on Vitest's default include glob when a `dist/` directory may exist.

---

### L-FND-02: Stub packages must not declare `test: "vitest run"` unless vitest is installed

**Why:** `packages/ai`, `packages/auth`, and `packages/ui` were scaffolded with `"test": "vitest run"` in their `package.json` scripts but had no `vitest` devDependency. Running `pnpm -r test` failed on all three with a "command not found" error, blocking the test gate even though no real tests were missing.

**How to apply:** Stub packages that are not yet under test must use `"test": "echo 'No tests in stub package' && exit 0"` as their test script. Only replace this with `"vitest run"` at the same time you add `vitest` to devDependencies and write the first test file.

---

### L-FND-03: `@sentry/nextjs` requires `withSentryConfig` wrapper in `next.config.ts`

**Why:** `@sentry/nextjs@8` injects a webpack plugin and instrumentation at build time. Omitting the `withSentryConfig` wrapper caused the Next.js production build to exit 1 with a Sentry-related error, even when Sentry was otherwise unused.

**How to apply:** Any app using `@sentry/nextjs` must wrap its Next.js config with `withSentryConfig(nextConfig, { ... })`. When `SENTRY_AUTH_TOKEN` is absent (local dev), pass `sourcemaps: { disable: true }` and `silent: true` to prevent the build from failing on the missing token. Set `autoInstrumentAppDirectory: false` when using the App Router with manual instrumentation via `instrumentation.ts` to avoid conflicts with Pages Router imports.

---

### L-FND-04: ts-rest response type accessors require bracket notation, not bare literals

**Why:** `echoContract.echo.responses[200]` was written with a bare numeric literal `200` as a property key. TypeScript's strict mode under the ts-rest type system requires either `[200]` array-style bracket access or the string `'200'`, depending on how the contract is typed. The bare literal triggered a `TS7015` error in `pnpm -r typecheck`.

**How to apply:** When accessing ts-rest response schema maps by status code, always use bracket notation: `responses[200]` or `responses['200']`. Check the generated contract type to confirm which form the library expects before committing.

---

### L-FND-05: A ts-rest client `satisfies` tautology does not enforce type safety — make a real call

**Why:** `void (apiClient satisfies typeof apiClient)` was added to satisfy the gate criterion "a type error in the response shape causes a TypeScript compile error." It does not — it always passes because the expression trivially satisfies its own type. Only an actual call to a client method (e.g., `apiClient.echo({ body: { message: 'ping' } })`) with access to the typed response causes a compile error on shape drift.

**How to apply:** The gate criterion for ts-rest integration is not satisfied by `satisfies` checks. The consumer code must call a contract method and destructure a typed field from the response. Treat any `satisfies typeof X` on `X` itself as a no-op and remove it.

---

### L-FND-06: Shared logger must be imported and used by the framework — not just defined

**Why:** `apps/api/src/logger.ts` was created with the `@axiomhq/pino` transport but was never imported by `app.ts`. The app registered its own inline logger, making the Axiom transport dead code. The audit confirmed the logger was wired only after an explicit correction cycle.

**How to apply:** When a logger module is created, the very next step is to verify it is actually imported and passed to the framework (e.g., `loggerInstance: logger` in Fastify). Treat a logger file with zero imports elsewhere in the app as a build defect. Add a test or audit assertion that checks for the import if the framework supports it.

---

### L-FND-07: Install `pino-pretty` as a devDependency whenever it is referenced in code

**Why:** `logger.ts` conditionally required `pino-pretty` for local dev pretty-printing, but the package was not in `devDependencies`. This caused a runtime crash in local dev when the module was missing.

**How to apply:** Search for any `require('pino-pretty')` or `import ... from 'pino-pretty'` in the codebase. If found, verify `pino-pretty` is in the closest `package.json` devDependencies. Same rule applies to any dev-only transport or formatter.

---

### L-FND-08: Pin transitive CVEs with `pnpm.overrides` in the root `package.json`

**Why:** `@sentry/nextjs` brought in `rollup@3.29.5` with a HIGH severity CVE. The fix was a one-line addition to `pnpm.overrides`: `"rollup": ">=3.30.0"`. Without this, `pnpm audit --audit-level=high` exited non-zero and blocked the gate.

**How to apply:** After every new major dependency is added, run `pnpm audit --audit-level=high`. If there are HIGH or CRITICAL findings in transitive deps, add a `pnpm.overrides` entry to pin to the patched version before committing. Confirm the override does not break the dependant package's peer requirements. Document the CVE ID in a comment next to the override.

---

### L-FND-09: Duplicate comment blocks violate the spirit of the "no commented-out code" rule

**Why:** During a correction cycle, `apps/api/src/app.ts` ended up with the same multi-line comment block repeated verbatim twice (lines 69-78 and 80-91). CLAUDE.md forbids commented-out code blocks; while these were not code they were redundant documentation that a reviewer could mistake for intentional structure.

**How to apply:** After any correction cycle that touches a comment-heavy file, scan for verbatim duplicate comment blocks. Delete the duplicate. Merge the unique information from both into a single, accurate block.

---

### L-FND-10: Next.js App Router requires `global-error.tsx` for Sentry to capture React render errors

**Why:** During build, Next.js emitted a warning: "It seems like you don't have a global error handler set up." Without `global-error.tsx`, React rendering errors that crash the root layout are not forwarded to Sentry, leaving a blind spot in error monitoring.

**How to apply:** Any Next.js App Router app using Sentry must include `src/app/global-error.tsx`. The file must be a Client Component (`'use client'`), render its own `<html>` and `<body>` tags (because it replaces the root layout), and call `Sentry.captureException(error)` in a `useEffect`. Add it during the same task that wires Sentry — do not defer it.

---

### L-FND-11: Docker Compose app services need healthcheck stanzas so `depends_on` and CI can use `condition: service_healthy`

**Why:** The `web`, `api`, and `voice` services had no `healthcheck:` block, so they always showed as "running" rather than "healthy" in `docker compose ps`. This prevented other services from using `condition: service_healthy` as a dependency condition.

**How to apply:** Every service that exposes an HTTP port must have a `healthcheck:` block using `wget` or `curl` against its health endpoint. Use `start_period` (20-30s) to accommodate slow startup. The infrastructure services (`postgres`, `redis`) correctly had healthchecks from day one — follow the same pattern for app services.

---

## Hypotheses for human review

_Changes the evolver considered but did not apply. Humans can promote these to rules or discard._

### H-FND-01: Per-app ESLint config for Next.js

The root `eslint.config.js` uses only `@typescript-eslint`. `apps/web` runs `next lint` which expects `eslint-config-next` to be installed and configured. This causes a "Next.js plugin was not detected" warning on every build. Wiring `eslint-config-next` requires adding it as a devDep to `apps/web` and either extending the root flat config or adding a local `eslint.config.js` in `apps/web`. This was not applied because flat config + `eslint-config-next` have a known compatibility gap in some versions and should be tested carefully before committing.

**Recommended action:** In the next phase that modifies the web app, add `eslint-config-next` to `apps/web/devDependencies`, create `apps/web/eslint.config.js` that extends both `@typescript-eslint` and `next/core-web-vitals`, and confirm `pnpm --filter web lint` exits 0 before merging.

---

## phase_supplier_quote_bridge (2026-05-17)

### L-SQB-01: Cost is never trusted from the client

**Why:** Early SQB-07 drafts allowed the route to accept a client-side
`unitCostCents` on the price body. A manager could in principle forge
a higher cost to inflate their commission preview (the manager UI
shows `cost × margin% → price`; the bigger the cost, the bigger the
commission base). The fix is structural: the route re-fetches cost
from the SupplierProvider on every `/price` call and ignores any
cost field on the body.

**How to apply:** Any time a route accepts a number from the client
that feeds an internal calculation, ask "what stops the client from
overstating this?" If the answer involves human review, it's not
enough. Re-derive the number server-side from a trusted source on
every call. Covered by `live-quote-routes.test.ts::cost-forgery
integration test`.

---

### L-SQB-02: A line override of 0% is a real choice, not a missing field

**Why:** Initial `resolveSellingPrice` used `if (lineOverridePct)` to
test for an override. `0` is falsy in JS — a manager setting "sell at
cost" was silently falling through to the category default. Caught
by the property-based bounds test that exercised `percent: 0`.

**How to apply:** When a numeric option's lower bound is meaningful
(0%, 0 cents, 0 quantity), use `Number.isFinite(x) && x !== null` or
explicit `x === null || x === undefined` checks. Never use truthiness
to detect "present." This rule kicks in for every margin / discount /
override field across the platform.

---

### L-SQB-03: Idempotency requires both an in-process lock AND a DB UNIQUE constraint

**Why:** SQB-05's first draft of `commit_external_quote` only used
the DB UNIQUE on `external_quote_id`. The 10× concurrent test passed
in single-process SQLite but would have failed under multi-worker
Gunicorn because each worker had its own connection — the UNIQUE
race produced one BC document, but two workers both believed they had
"won" and called BC `add_quote_line` twice (creating a quote with
4 lines instead of 2). The fix layers a per-key threading.Lock inside
the function. The UNIQUE constraint is the cross-process correctness
layer; the in-process lock makes the same-process race deterministic.

**How to apply:** For any idempotent write that fans out to a real
upstream (BC, Stripe, Twilio): UNIQUE in the DB AND a per-key
in-process lock. The DB is the source of truth for "did this commit
succeed"; the lock is the source of truth for "am I the one running
the upstream right now." Both are required.

---

### L-SQB-04: Don't recurse to retry — loop

**Why:** SQB-05's IntegrityError retry path called `commit_external_quote`
recursively. The function holds a `threading.Lock` (non-reentrant);
the recursive call deadlocked the second-process race. Caught by the
10× concurrent test. Fix: loop within the function, never recurse.

**How to apply:** Mutex-holding code never recurses into itself. Loop
or use a non-mutex retry strategy (e.g., exponential backoff outside
the critical section). Applies anywhere `threading.Lock` /
`asyncio.Lock` / `Mutex` appears.

---

### L-SQB-05: ToolResult isn't a discriminated union — use optional chaining

**Why:** `@service-ai/ai`'s `ToolResult` is `{ ok: boolean; data?: T;
error?: {...} }` rather than `{ ok: true; data: T } | { ok: false;
error: {...} }`. TypeScript can't narrow on `ok` because both fields
are optional on the merged shape. Tests doing `if (res.ok) return;
expect(res.error.code).toBe('X')` fail strict typecheck — `res.error`
is `possibly undefined`.

**How to apply:** Until the type is refactored to a true
discriminated union, every consumer test uses optional chaining:
`expect(res.error?.code).toBe('X')`. Flagged in
`packages/ai/src/tools/types.ts` for a future cleanup.

---

## Overrides (human-added)

_Rules the evolver must never regress. Format: `- <date> — <override> — <reason>`_
