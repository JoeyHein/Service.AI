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

  it('references the GET /api/v1/health endpoint (fetch or constant)', () => {
    const content = readWebFile('src/app/page.tsx');
    // The page must either contain a fetch call or reference the health path.
    // We look for the path segment to stay loose on implementation style
    // (fetch, axios, ts-rest client, etc.).
    const referencesHealthEndpoint =
      content.includes('/api/v1/health') ||
      content.includes("api/v1/health");
    expect(referencesHealthEndpoint).toBe(true);
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
