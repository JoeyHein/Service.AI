# Tech Debt

Items deferred from phase audits as MINOR. Curated and prioritized by the evolver.

Format:
```
- [priority] <id> · <phase added> · <short title>
  - What: <one-line description>
  - Where: <file or module>
  - Why deferred: <reason>
```

---

## phase_foundation

- [LOW] TD-FND-01 · phase_foundation · Next.js ESLint plugin not wired
  - What: `apps/web` uses `next lint` but `eslint-config-next` is not installed; Next.js-specific rules (no-html-link-for-pages, no-sync-scripts, etc.) are not enforced. Build emits "The Next.js plugin was not detected in your ESLint configuration."
  - Where: `apps/web/package.json`, root `eslint.config.js`
  - Why deferred: Flat config + `eslint-config-next` has a version compatibility gap that needs testing. Fix during the next phase that touches the web app. Add `eslint-config-next` to `apps/web/devDependencies` and create `apps/web/eslint.config.js` extending `next/core-web-vitals`. See H-FND-01 in `docs/LESSONS.md`.

- [LOW] TD-FND-02 · phase_foundation · W1: Web structure test passes on comment text
  - What: `apps/web/src/__tests__/structure.test.ts` has a test named "references the GET /api/v1/health endpoint" that passes because `page.tsx` contains the string `api/v1/health` in a JSDoc comment, not in executable code. The actual network call is to `POST /api/v1/echo`.
  - Where: `apps/web/src/__tests__/structure.test.ts:164-172`
  - Why deferred: Deliberate architectural trade-off — the ts-rest echo call is the contract-enforcement mechanism. The test name is misleading but fixing it requires either adding a real health poll or renaming the test to describe what it actually asserts.

- [LOW] TD-FND-03 · phase_foundation · W6: ARCHITECTURE.md lacks explicit package dependency graph
  - What: `docs/ARCHITECTURE.md` implies the dependency graph through a directory tree but does not render it explicitly. Gate criterion asked for an "explicit dependency graph."
  - Where: `docs/ARCHITECTURE.md` Section 2
  - Why deferred: Information is present implicitly; the gap is presentational. Add a dedicated ASCII or Mermaid graph in the next architecture-touching phase.
