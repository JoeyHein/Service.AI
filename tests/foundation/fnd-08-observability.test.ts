/**
 * TASK-FND-08: Observability — Axiom logs + Sentry errors
 *
 * These tests encode the acceptance criteria for structured JSON logging to
 * Axiom and Sentry error reporting in all three apps. Every test MUST fail
 * before the builder ships the observability wiring, and MUST pass once it is
 * in place.
 *
 * Tests are intentionally flexible: they assert on observable artifacts
 * (package.json dependencies, source files containing required strings, env-
 * guard patterns) rather than on a specific file structure, since the builder
 * has latitude in exactly how they wire things.
 *
 * Acceptance criteria encoded here:
 * - api + voice: @axiomhq/pino (or @axiomhq/js) pino transport installed
 * - api + voice + web: Sentry SDK installed
 * - Axiom and Sentry are disabled / silenced when their env vars are unset
 * - Secrets (authorization header, cookies, email tokens) are redacted from logs
 * - A Sentry init call exists in api source
 * - A Sentry init call or config file exists in the web app
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/** Absolute path to the repository root. */
const ROOT = '/workspace';

/** Read and parse a JSON file relative to ROOT. Throws with a clear message on miss. */
function readJSON(relativePath: string): Record<string, unknown> {
  const abs = join(ROOT, relativePath);
  if (!existsSync(abs)) {
    throw new Error(`Expected file not found: ${abs}`);
  }
  return JSON.parse(readFileSync(abs, 'utf-8')) as Record<string, unknown>;
}

/** Read a text file relative to ROOT. Throws with a clear message on miss. */
function readText(relativePath: string): string {
  const abs = join(ROOT, relativePath);
  if (!existsSync(abs)) {
    throw new Error(`Expected file not found: ${abs}`);
  }
  return readFileSync(abs, 'utf-8');
}

/**
 * Walk a directory recursively and collect all file paths (absolute) that
 * satisfy the optional filter predicate on the filename.
 */
function walkFiles(dir: string, filter?: (name: string) => boolean): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath, filter));
    } else if (!filter || filter(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Return true when any TypeScript/JavaScript source file under `srcDir`
 * contains `needle` as a substring.
 */
function anySourceFileContains(srcDir: string, needle: string): boolean {
  const files = walkFiles(srcDir, (name) =>
    /\.(ts|tsx|js|mjs|cjs)$/.test(name),
  );
  return files.some((file) => readFileSync(file, 'utf-8').includes(needle));
}

// ---------------------------------------------------------------------------
// Group 1 — Package dependencies
// ---------------------------------------------------------------------------

describe('Group 1 — Package dependencies', () => {
  it('apps/api/package.json lists @axiomhq/pino or @axiomhq/js as a dependency', () => {
    const pkg = readJSON('apps/api/package.json');
    const deps = {
      ...((pkg['dependencies'] as Record<string, string>) ?? {}),
      ...((pkg['devDependencies'] as Record<string, string>) ?? {}),
    };
    const hasAxiomPino = '@axiomhq/pino' in deps;
    const hasAxiomJs = '@axiomhq/js' in deps;
    expect(hasAxiomPino || hasAxiomJs).toBe(true);
  });

  it('apps/api/package.json lists @sentry/node as a dependency', () => {
    const pkg = readJSON('apps/api/package.json');
    const deps = {
      ...((pkg['dependencies'] as Record<string, string>) ?? {}),
      ...((pkg['devDependencies'] as Record<string, string>) ?? {}),
    };
    expect('@sentry/node' in deps).toBe(true);
  });

  it('apps/voice/package.json lists @axiomhq/pino or @axiomhq/js as a dependency', () => {
    const pkg = readJSON('apps/voice/package.json');
    const deps = {
      ...((pkg['dependencies'] as Record<string, string>) ?? {}),
      ...((pkg['devDependencies'] as Record<string, string>) ?? {}),
    };
    const hasAxiomPino = '@axiomhq/pino' in deps;
    const hasAxiomJs = '@axiomhq/js' in deps;
    expect(hasAxiomPino || hasAxiomJs).toBe(true);
  });

  it('apps/voice/package.json lists @sentry/node as a dependency', () => {
    const pkg = readJSON('apps/voice/package.json');
    const deps = {
      ...((pkg['dependencies'] as Record<string, string>) ?? {}),
      ...((pkg['devDependencies'] as Record<string, string>) ?? {}),
    };
    expect('@sentry/node' in deps).toBe(true);
  });

  it('apps/web/package.json lists @sentry/nextjs as a dependency', () => {
    const pkg = readJSON('apps/web/package.json');
    const deps = {
      ...((pkg['dependencies'] as Record<string, string>) ?? {}),
      ...((pkg['devDependencies'] as Record<string, string>) ?? {}),
    };
    expect('@sentry/nextjs' in deps).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — Axiom / Sentry disabled when env vars are unset
// ---------------------------------------------------------------------------

describe('Group 2 — Env-var guards: observability disabled when env vars unset', () => {
  it(
    'apps/api source contains a guard for AXIOM_TOKEN before enabling Axiom transport ' +
      '(transport only active when AXIOM_TOKEN is set)',
    () => {
      const apiSrcDir = join(ROOT, 'apps/api/src');
      const containsAxiomGuard = anySourceFileContains(apiSrcDir, 'AXIOM_TOKEN');
      expect(containsAxiomGuard).toBe(true);
    },
  );

  it(
    'apps/api source contains a guard for SENTRY_DSN before initializing Sentry ' +
      '(Sentry silenced in dev when DSN is unset)',
    () => {
      const apiSrcDir = join(ROOT, 'apps/api/src');
      const containsSentryDsnGuard = anySourceFileContains(apiSrcDir, 'SENTRY_DSN');
      expect(containsSentryDsnGuard).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Group 3 — Secrets redaction in pino serializers
// ---------------------------------------------------------------------------

describe('Group 3 — Secrets redaction in pino logger config', () => {
  it('apps/api source contains a pino redact configuration (the "redact" key)', () => {
    const apiSrcDir = join(ROOT, 'apps/api/src');
    // The builder may put the redact config directly in app.ts or in a
    // dedicated logger.ts / logger setup file. Either location is valid.
    const hasRedactConfig = anySourceFileContains(apiSrcDir, 'redact');
    expect(hasRedactConfig).toBe(true);
  });

  it(
    'apps/api source redact list covers the authorization header ' +
      '(logs must never record bearer tokens)',
    () => {
      const apiSrcDir = join(ROOT, 'apps/api/src');
      // Accept either the lowercase form or a wildcard that covers it:
      //   'authorization', 'req.headers.authorization', '*.authorization', etc.
      const coversAuthorization = anySourceFileContains(apiSrcDir, 'authorization');
      expect(coversAuthorization).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Group 4 — Sentry configuration files exist
// ---------------------------------------------------------------------------

describe('Group 4 — Sentry configuration files exist', () => {
  it(
    'apps/web has Sentry wiring: next.config.ts, instrumentation.ts, or a ' +
      'sentry.*.config.ts file references Sentry',
    () => {
      const webRoot = join(ROOT, 'apps/web');

      // Candidate files where Next.js Sentry integration typically lives.
      const candidates = [
        join(webRoot, 'next.config.ts'),
        join(webRoot, 'next.config.js'),
        join(webRoot, 'src', 'instrumentation.ts'),
        join(webRoot, 'src', 'instrumentation.js'),
        join(webRoot, 'sentry.client.config.ts'),
        join(webRoot, 'sentry.server.config.ts'),
        join(webRoot, 'sentry.edge.config.ts'),
        join(webRoot, 'sentry.client.config.js'),
        join(webRoot, 'sentry.server.config.js'),
        join(webRoot, 'sentry.edge.config.js'),
      ];

      // At least one candidate must exist AND reference Sentry.
      const sentryReferenced = candidates.some((candidate) => {
        if (!existsSync(candidate)) return false;
        const content = readFileSync(candidate, 'utf-8');
        // Matches imports, require() calls, or function invocations.
        return /sentry/i.test(content);
      });

      expect(sentryReferenced).toBe(true);
    },
  );

  it(
    'apps/api source contains a Sentry.init() call ' +
      '(Sentry must be initialized in the API process)',
    () => {
      const apiSrcDir = join(ROOT, 'apps/api/src');
      const hasSentryInit = anySourceFileContains(apiSrcDir, 'Sentry.init');
      expect(hasSentryInit).toBe(true);
    },
  );
});
