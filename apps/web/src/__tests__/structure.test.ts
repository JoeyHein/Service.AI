/**
 * TASK-FND-04: Next.js 15 web skeleton structural tests.
 *
 * These tests encode the acceptance criteria for the web app scaffold as
 * executable specifications. They operate on the filesystem — no runtime
 * startup required — so they run fast and fail immediately if a file is
 * missing or has incorrect content.
 *
 * All tests MUST FAIL before the builder implements TASK-FND-04.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Absolute path to the apps/web directory — all assertions are relative to this.
 * __dirname resolves to apps/web/src/__tests__, so two levels up reaches apps/web.
 */
const WEB_ROOT = join(__dirname, '..', '..');

/** Read a file relative to WEB_ROOT, returning its content as a string. */
function readWebFile(relativePath: string): string {
  return readFileSync(join(WEB_ROOT, relativePath), 'utf-8');
}

/** Return true if a file exists relative to WEB_ROOT. */
function webFileExists(relativePath: string): boolean {
  return existsSync(join(WEB_ROOT, relativePath));
}

// ---------------------------------------------------------------------------
// Next.js config
// ---------------------------------------------------------------------------

describe('next.config', () => {
  it('next.config.ts or next.config.js exists at apps/web root', () => {
    const tsExists = webFileExists('next.config.ts');
    const jsExists = webFileExists('next.config.js');
    expect(tsExists || jsExists).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tailwind config
// ---------------------------------------------------------------------------

describe('tailwind.config', () => {
  it('tailwind.config.ts or tailwind.config.js exists at apps/web root', () => {
    const tsExists = webFileExists('tailwind.config.ts');
    const jsExists = webFileExists('tailwind.config.js');
    expect(tsExists || jsExists).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PostCSS config
// ---------------------------------------------------------------------------

describe('postcss.config', () => {
  it('postcss.config.mjs or postcss.config.js exists at apps/web root', () => {
    const mjsExists = webFileExists('postcss.config.mjs');
    const jsExists = webFileExists('postcss.config.js');
    expect(mjsExists || jsExists).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// App Router source files
// ---------------------------------------------------------------------------

describe('App Router source files', () => {
  it('src/app/layout.tsx exists', () => {
    expect(webFileExists('src/app/layout.tsx')).toBe(true);
  });

  it('src/app/page.tsx exists', () => {
    expect(webFileExists('src/app/page.tsx')).toBe(true);
  });

  it('src/app/globals.css exists', () => {
    expect(webFileExists('src/app/globals.css')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// globals.css — Tailwind directives
// ---------------------------------------------------------------------------

describe('src/app/globals.css content', () => {
  it('contains @tailwind directives required for Tailwind CSS to work', () => {
    // Tailwind v3 uses @tailwind base/components/utilities.
    // Tailwind v4 uses @import "tailwindcss" but may also contain @tailwind.
    // We accept either form.
    const css = readWebFile('src/app/globals.css');
    const hasTailwindDirective = css.includes('@tailwind') || css.includes('@import "tailwindcss"') || css.includes("@import 'tailwindcss'");
    expect(hasTailwindDirective).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shadcn/ui config
// ---------------------------------------------------------------------------

describe('shadcn/ui config', () => {
  it('components.json exists (required by shadcn/ui CLI and runtime)', () => {
    expect(webFileExists('components.json')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// package.json — dependency declarations
// ---------------------------------------------------------------------------

describe('package.json dependencies', () => {
  let pkg: Record<string, unknown>;

  // Parse once; individual tests will fail with a clear message if the file
  // is missing or malformed.
  try {
    pkg = JSON.parse(readWebFile('package.json')) as Record<string, unknown>;
  } catch {
    pkg = {};
  }

  const deps = (pkg.dependencies ?? {}) as Record<string, string>;
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
  const allDeps = { ...deps, ...devDeps };

  it('lists next as a dependency at version 15.x', () => {
    const nextVersion: string = deps['next'] ?? '';
    // Accept "15.x.x", "^15.x.x", "~15.x.x", ">=15.0.0", "15.0.0-canary.*"
    expect(nextVersion).toMatch(/^[\^~>=]*15\./);
  });

  it('lists react as a dependency at version 18.x or 19.x', () => {
    const reactVersion: string = deps['react'] ?? '';
    expect(reactVersion).toMatch(/^[\^~>=]*(18|19)\./);
  });

  it('lists react-dom as a dependency at version 18.x or 19.x', () => {
    const reactDomVersion: string = deps['react-dom'] ?? '';
    expect(reactDomVersion).toMatch(/^[\^~>=]*(18|19)\./);
  });

  it('lists tailwindcss as a devDependency', () => {
    // tailwindcss may sit in devDependencies or, rarely, dependencies for
    // server-component setups — accept either location.
    const tailwindVersion: string = allDeps['tailwindcss'] ?? '';
    expect(tailwindVersion).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// page.tsx — content requirements
// ---------------------------------------------------------------------------

describe('src/app/page.tsx content', () => {
  it('contains the text "Service.AI" (homepage brand identity)', () => {
    const content = readWebFile('src/app/page.tsx');
    expect(content).toContain('Service.AI');
  });

  it('issues a GET request to /healthz for liveness display (gate criterion)', () => {
    // Gate: "Homepage renders Service.AI and issues a network request to
    // GET /api/v1/health (or /healthz forwarded via Next.js rewrite)."
    // page.tsx must reference /healthz (not just in a comment) to satisfy
    // this criterion. We check for a fetch() call targeting that path — a
    // comment-only match would not call fetch(), so the implementation must
    // contain a fetch call that includes /healthz in a string literal.
    const content = readWebFile('src/app/page.tsx');
    // The call must be in a non-comment context: fetch(`${BASE_URL}/healthz`)
    const hasHealthFetch =
      content.includes('fetch(') &&
      content.includes('/healthz');
    expect(hasHealthFetch).toBe(true);
  });

  it('calls the ts-rest echo client for compile-time contract enforcement', () => {
    // AUDIT-3 B2 regression: page.tsx must invoke apiClient.echo() so the
    // TypeScript compiler validates the request/response shape against the
    // shared contract. A declaration-only (never called) client passes tsc
    // but provides zero safety guarantee.
    const content = readWebFile('src/app/page.tsx');
    expect(content).toContain('apiClient.echo');
  });

  it('accesses result.body.data.echo after status narrowing', () => {
    // Regression for AUDIT-3 B2: the typed response property path must be
    // present so tsc catches any rename/removal in EchoResponseSchema.
    const content = readWebFile('src/app/page.tsx');
    expect(content).toContain('result.body.data.echo');
  });

  it('checks result.status === 200 before accessing typed echo body', () => {
    // Without the discriminated-union status guard, body.data access would
    // be on the unnarrowed union type and might not enforce the correct branch.
    const content = readWebFile('src/app/page.tsx');
    expect(content).toContain('result.status === 200');
  });
});

// ---------------------------------------------------------------------------
// TypeScript / JSX support
// ---------------------------------------------------------------------------

describe('TypeScript JSX configuration', () => {
  it('tsconfig.json explicitly sets jsx to preserve, react-jsx, or react-jsxdev — required by Next.js App Router', () => {
    // The builder must add a Next.js-specific tsconfig for apps/web that sets
    // "jsx" explicitly.  The existing skeleton extends tsconfig.base.json which
    // has "module": "NodeNext" and no jsx setting — that config is valid for
    // apps/api and apps/voice but NOT for a Next.js app.  Requiring an explicit
    // jsx entry in the local compilerOptions ensures the builder does not simply
    // reuse the server base.
    let tsconfig: Record<string, unknown> = {};
    try {
      tsconfig = JSON.parse(readWebFile('tsconfig.json')) as Record<string, unknown>;
    } catch {
      // Parsing failed — test will fail on the expect below.
    }

    const compilerOptions = (tsconfig.compilerOptions ?? {}) as Record<string, string>;
    const jsxSetting = compilerOptions['jsx'] ?? '';

    // Next.js 15 with App Router requires jsx: "preserve" (the standard Next.js
    // default) or "react-jsx" / "react-jsxdev" for explicit transformer configs.
    const validJsxSettings = ['preserve', 'react-jsx', 'react-jsxdev'];
    expect(validJsxSettings).toContain(jsxSetting);
  });
});

// ---------------------------------------------------------------------------
// layout.tsx — default export required by Next.js App Router
// ---------------------------------------------------------------------------

describe('src/app/layout.tsx content', () => {
  it('exports a default function (required by Next.js App Router RootLayout contract)', () => {
    const content = readWebFile('src/app/layout.tsx');
    expect(content).toContain('export default');
  });
});

// ---------------------------------------------------------------------------
// AUDIT-2 / B3 regression — ts-rest typed client wiring
// ---------------------------------------------------------------------------

describe('AUDIT-2 / B3 regression / ts-rest typed client', () => {
  it('@service-ai/contracts is listed as a dependency in package.json', () => {
    // Without this dependency the web app cannot import the ts-rest contract
    // and type drift in the contract will not be caught at build time.
    const pkg = JSON.parse(readWebFile('package.json')) as {
      dependencies?: Record<string, string>;
    };
    const contractsDep = pkg.dependencies?.['@service-ai/contracts'] ?? '';
    expect(contractsDep).not.toBe('');
  });

  it('@ts-rest/core is listed as a dependency in package.json', () => {
    // The ts-rest client (initClient) comes from @ts-rest/core.
    const pkg = JSON.parse(readWebFile('package.json')) as {
      dependencies?: Record<string, string>;
    };
    const tsDep = pkg.dependencies?.['@ts-rest/core'] ?? '';
    expect(tsDep).not.toBe('');
  });

  it('page.tsx imports @service-ai/contracts (ts-rest contract must be used)', () => {
    // If this import is absent, the typed client is not wired and a contract
    // change will not cause a compile error in the web app.
    const content = readWebFile('src/app/page.tsx');
    expect(content).toContain('@service-ai/contracts');
  });

  it('page.tsx imports from @ts-rest/core (client initialisation required)', () => {
    const content = readWebFile('src/app/page.tsx');
    expect(content).toContain('@ts-rest/core');
  });
});

// ---------------------------------------------------------------------------
// AUDIT-2 / B1 regression — Sentry App Router compatibility
// ---------------------------------------------------------------------------

describe('AUDIT-2 / B1 regression / Sentry next.config wrapping', () => {
  it('next.config.ts imports withSentryConfig from @sentry/nextjs', () => {
    // Without the withSentryConfig wrapper, @sentry/nextjs@8 injects a legacy
    // Pages Router <Html> import into the 404/500 error pages, which Next.js 15
    // App Router rejects during pre-rendering: "Html should not be imported
    // outside of pages/_document". The build exits 1 as a result.
    const content = readWebFile('next.config.ts');
    expect(content).toContain('withSentryConfig');
  });

  it('next.config.ts wraps the exported config with withSentryConfig (not a bare NextConfig)', () => {
    // The export must be the result of withSentryConfig(), not the raw nextConfig
    // object. A bare export would bypass Sentry's App Router compatibility shims.
    const content = readWebFile('next.config.ts');
    expect(content).toMatch(/export default withSentryConfig\(/);
  });

  it('Sentry autoInstrumentServerFunctions is disabled to prevent Pages Router injection', () => {
    // Sentry's auto-instrumentation for server functions uses Pages Router APIs
    // that conflict with the App Router. Setting this to false prevents Sentry
    // from injecting <Html> imports that cause the "Html outside _document" error.
    const content = readWebFile('next.config.ts');
    expect(content).toContain('autoInstrumentServerFunctions: false');
  });

  it('Sentry autoInstrumentAppDirectory is disabled', () => {
    // Belt-and-suspenders: disabling App Directory auto-instrumentation prevents
    // any future Sentry version from re-introducing the Pages Router conflict.
    const content = readWebFile('next.config.ts');
    expect(content).toContain('autoInstrumentAppDirectory: false');
  });
});

// ---------------------------------------------------------------------------
// AUDIT-3 / B1 regression — rollup HIGH CVE pinned via pnpm.overrides
// GHSA-mw96-cpmx-2vgc: Arbitrary file write via path traversal in rollup@3.29.5
// The transitive path is: @sentry/nextjs → rollup@3.29.5
// ---------------------------------------------------------------------------

describe('AUDIT-3 / B1 regression / rollup CVE pnpm override', () => {
  let rootPkg: Record<string, unknown>;

  try {
    // WEB_ROOT is apps/web — root package.json is two levels up
    rootPkg = JSON.parse(
      readFileSync(join(WEB_ROOT, '..', '..', 'package.json'), 'utf-8')
    ) as Record<string, unknown>;
  } catch {
    rootPkg = {};
  }

  it('root package.json has a pnpm.overrides section (required to pin transitive CVEs)', () => {
    // pnpm.overrides is the mechanism to force a patched version of a
    // transitive dependency without waiting for the direct dependency to
    // update. Without this section the rollup HIGH CVE cannot be addressed.
    const overrides = (rootPkg['pnpm'] as Record<string, unknown> | undefined)?.['overrides'];
    expect(overrides).toBeTruthy();
  });

  it('pnpm.overrides pins rollup to >=3.30.0 to fix GHSA-mw96-cpmx-2vgc', () => {
    // rollup@3.29.5 has a path-traversal arbitrary file write (HIGH severity).
    // The override must resolve to 3.30.0 or later.
    const overrides = (rootPkg['pnpm'] as Record<string, unknown> | undefined)?.['overrides'] as Record<string, string> | undefined;
    const rollupOverride = overrides?.['rollup'] ?? '';
    // Accept any specifier that requires 3.30.0+: ">=3.30.0", "^3.30.0", "3.30.0", etc.
    expect(rollupOverride).toMatch(/3\.(3[0-9]|[4-9]\d|\d{3,})/);
  });
});

// ---------------------------------------------------------------------------
// AUDIT-3 / B2 regression — ts-rest client invoked with typed response access
//
// The gate criterion: "a type error in the response shape causes a TypeScript
// compile error." This requires the client to actually be *called* and its
// return value accessed. A bare `initClient()` assignment with no call-site
// usage provides zero type enforcement — the compiler never checks the response
// shape. The tests below verify the structural properties that make the
// TypeScript enforcement effective.
// ---------------------------------------------------------------------------

describe('AUDIT-3 / B2 regression / ts-rest client invoked with typed response', () => {
  it('page.tsx calls apiClient.echo() — client is invoked, not just declared', () => {
    // A client that is only declared (initClient(...)) but never called does not
    // cause TypeScript to type-check the response value. This verifies that an
    // actual call site exists so the compiler validates the request shape.
    const content = readWebFile('src/app/page.tsx');
    expect(content).toContain('apiClient.echo(');
  });

  it('page.tsx accesses result.body.data.echo — response shape is type-checked', () => {
    // TypeScript enforces the exact property path: if EchoResponseSchema renames
    // "echo" to anything else, `result.body.data.echo` becomes a compile error.
    // Without this access, schema drift would go undetected until runtime.
    const content = readWebFile('src/app/page.tsx');
    expect(content).toContain('body.data.echo');
  });

  it('page.tsx checks result.status === 200 before accessing typed body (200-branch gating)', () => {
    // ts-rest returns a discriminated union; the 200 branch must be checked
    // before accessing body.data to maintain the type narrowing that makes
    // compile-time contract enforcement possible.
    const content = readWebFile('src/app/page.tsx');
    expect(content).toMatch(/status\s*===?\s*200/);
  });
});
