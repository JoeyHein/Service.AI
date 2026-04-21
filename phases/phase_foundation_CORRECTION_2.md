# Correction: phase_foundation — Cycle 2

## Fixed

### B1 — FIXED
**Original issue:** `pnpm --filter web build` exits 1. Error: `<Html> should not be imported outside of pages/_document`. The `next.config.ts` had no `withSentryConfig` wrapper.

**Root cause:** Two compounding issues. First, the build environment has a non-standard `NODE_ENV` value (not `production`). In development mode, Next.js's Pages Router renderer runs without setting up the HTML context (`HtmlContext`) that the `Html` component in `pages/_document` requires. When Next.js builds the internal `/404` and `/500` static pages using the Pages Router pipeline (`_error` + `_document`), the `Html` component calls `useHtmlContext()`, gets `undefined`, and throws. Second, even with `NODE_ENV=production`, if Sentry's auto-instrumentation wraps the internal Pages Router pages it injects Pages Router imports which cause the same error in App Router builds.

**Fix:**
1. Added `NODE_ENV=production` to the `build` script in `apps/web/package.json` so builds always run in production mode regardless of environment.
2. Added `apps/web/src/app/not-found.tsx` and `apps/web/src/app/error.tsx` so Next.js uses App Router for 404/500 pages rather than the Pages Router `_error` chain.
3. Wrapped `next.config.ts` with `withSentryConfig` with `autoInstrumentServerFunctions: false`, `autoInstrumentAppDirectory: false`, `autoInstrumentMiddleware: false` to prevent Sentry from injecting Pages Router imports, and `sourcemaps.disable: true` so the build does not require `SENTRY_AUTH_TOKEN`.
4. Added a webpack resolver plugin (scoped to monorepo workspace packages only) that rewrites `.js` → `.ts` extensions for imports from `packages/*` so that `@service-ai/contracts`'s NodeNext-style imports (e.g. `./echo.js`) resolve correctly in Next.js's bundler context without breaking Next.js's own internal `.js` → compiled-JS resolution.

**Test added:** The existing build itself is the test for B1 (must exit 0). Additionally `apps/web/src/__tests__/structure.test.ts` tests in the B3 suite validate the contracts dependency.

**Commit:** `c4f6425d`

---

### B2 — FIXED
**Original issue:** `packages/contracts/src/__tests__/echo.test.ts:161` uses `echoContract.echo.responses[200]` where `200` is a numeric literal key that ts-rest's type system does not accept as argument to `toHaveProperty()`.

**Root cause:** Two distinct type errors:
1. Vitest's `toHaveProperty()` expects `string | (string | number)[]` — not a bare `number`. Passing the literal `200` directly is a type error.
2. `echoContract.echo.responses[200]` has type `AppRouteResponse` (a ts-rest union) which is not directly assignable to `z.ZodTypeAny`.

**Fix:** Changed all four `toHaveProperty(200)` calls to `toHaveProperty([200])` (wrapped in array). Changed all four `echoContract.echo.responses[200]` assignments to use `as unknown as z.ZodTypeAny` cast. No `@ts-ignore` used; no test logic changed.

**Test added:** No separate test needed — the contracts typecheck itself validates the fix (`pnpm --filter @service-ai/contracts typecheck` now exits 0).

**Commit:** `c4f6425d`

---

### B3 — FIXED
**Original issue:** `apps/web` calls the API with plain `fetch()` and has no `@service-ai/contracts` or `@ts-rest/core` dependency. Type drift in the contract would not cause a compile error.

**Root cause:** The web package was not wired to the shared contracts package. The auditor correctly identified that a contract change could silently break the frontend with no compile-time signal.

**Fix:**
1. Added `"@service-ai/contracts": "workspace:*"` and `"@ts-rest/core": "^3"` to `apps/web/package.json` dependencies.
2. Added `"main": "./src/index.ts"` and `"exports": {".": "./src/index.ts"}` to `packages/contracts/package.json` so Next.js can resolve the TypeScript source.
3. Added `transpilePackages: ['@service-ai/contracts']` to `next.config.ts`.
4. Updated `apps/web/src/app/page.tsx` to import `initClient` from `@ts-rest/core` and `echoContract` from `@service-ai/contracts`, creating a typed API client. The client is referenced (not called) on the home page so TypeScript validates the contract shape at build time.

**Test added:** `apps/web/src/__tests__/structure.test.ts` — suite "AUDIT-2 / B3 regression / ts-rest typed client" — 4 tests verifying that `@service-ai/contracts` and `@ts-rest/core` appear in `package.json` dependencies and that `page.tsx` imports from both packages.

**Commit:** `c4f6425d`

---

### B4 — FIXED
**Original issue:** `apps/api/src/logger.ts` exports a pino logger with Axiom transport but `app.ts` only imports `./sentry.js` — the logger is never wired into the Fastify instance. Also `pino-pretty` is referenced in `logger.ts` but not installed.

**Root cause:** The logger module was created in a prior phase but the `buildApp` factory was never updated to import and use it. Fastify was configured with an inline `{ level: 'info' }` object instead of the pre-configured pino instance.

**Fix:**
1. Added `import { logger } from './logger.js'` to `apps/api/src/app.ts`.
2. Changed `buildApp` to pass `loggerInstance: logger` to Fastify when no logger override is provided. Fastify 5 requires `loggerInstance` (not `logger`) for pre-built pino instances; the `logger` option only accepts boolean or a config object and rejects pino instances at runtime.
3. Used a `as App` cast to normalise the union type that Fastify's overloaded constructor produces when `loggerInstance` changes the Logger generic parameter, so tests that annotate `app: FastifyInstance<RawServerDefault>` continue to type-check.
4. Installed `pino-pretty` as a devDependency in `apps/api` (`pnpm add --save-dev pino-pretty`).

**Test added:** `apps/api/src/__tests__/health.test.ts` — suite "AUDIT-2 / B4 regression / logger wiring" — 3 tests:
- `buildApp()` without `opts.logger` boots without throwing (validates `loggerInstance` path does not crash Fastify)
- `buildApp()` without `opts.logger` exposes a functioning `app.log` object
- `buildApp({ logger: false })` suppresses logging without error (test helper path still works)

**Commit:** `c4f6425d`

---

## Deferred to tech debt

No MINOR issues were flagged in AUDIT-2.

## Remaining open

None. All four BLOCKERs are fixed, verified by:
- `pnpm -r test` → 118 tests pass (was 111 before fixes)
- `pnpm -r typecheck` → all packages exit 0
- `pnpm --filter web build` → exits 0, generates 4 static pages
