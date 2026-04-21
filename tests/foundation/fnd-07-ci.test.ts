/**
 * TASK-FND-07: CI workflow acceptance tests
 *
 * These tests encode the acceptance criteria for the GitHub Actions CI
 * workflow that runs typecheck, lint, test, and build jobs on every push
 * and pull_request event.
 *
 * Every test MUST fail before the builder creates .github/workflows/ci.yml
 * and MUST pass once a correct workflow file is in place.
 *
 * Implementation note: the tests read the raw YAML text and check for the
 * presence of required keys and values. We deliberately avoid a full YAML
 * parse dependency — if YAML structural content is needed beyond presence
 * checks, the assertions use conservative string matching so that equivalent
 * but differently-formatted YAML still passes.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

/** Absolute path to the repository root. */
const ROOT = "/workspace";

/** Path to the CI workflow file relative to the repository root. */
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

/** Absolute path to the CI workflow file. */
const CI_WORKFLOW_ABS = join(ROOT, CI_WORKFLOW_PATH);

/**
 * Read the CI workflow file as a UTF-8 string.
 * Throws a descriptive error when the file does not exist so that test
 * failure messages point directly at the missing artifact.
 */
function readWorkflow(): string {
  if (!existsSync(CI_WORKFLOW_ABS)) {
    throw new Error(
      `CI workflow not found at ${CI_WORKFLOW_ABS}. ` +
        `The builder must create this file to satisfy TASK-FND-07.`,
    );
  }
  return readFileSync(CI_WORKFLOW_ABS, "utf-8");
}

// ---------------------------------------------------------------------------
// 1. File existence
// ---------------------------------------------------------------------------

describe("TASK-FND-07: .github/workflows/ci.yml existence", () => {
  it("the workflow file exists at .github/workflows/ci.yml", () => {
    expect(existsSync(CI_WORKFLOW_ABS)).toBe(true);
  });

  it("the workflow file is non-empty", () => {
    const content = readWorkflow();
    expect(content.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Valid YAML indicator
// ---------------------------------------------------------------------------

describe("TASK-FND-07: workflow file is valid YAML", () => {
  it("contains the GitHub Actions 'on:' or \"'on':\" trigger key (confirms it is GHA YAML)", () => {
    const content = readWorkflow();
    // GitHub Actions uses `on:` or the quoted form `'on':` to avoid YAML's
    // boolean interpretation of bare `on`. Either form is valid.
    const hasOnKey = /^\s*on\s*:/m.test(content) || /^\s*'on'\s*:/m.test(content);
    expect(hasOnKey).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Trigger: push
// ---------------------------------------------------------------------------

describe("TASK-FND-07: workflow triggers", () => {
  it("triggers on push events", () => {
    const content = readWorkflow();
    // The push trigger must appear under the `on:` section.
    // It may be written as `push:` on its own line or `on: [push, pull_request]`.
    expect(content).toMatch(/\bpush\b/);
  });

  it("triggers on pull_request events", () => {
    const content = readWorkflow();
    expect(content).toMatch(/\bpull_request\b/);
  });
});

// ---------------------------------------------------------------------------
// 4. Required jobs
// ---------------------------------------------------------------------------

describe("TASK-FND-07: required CI jobs", () => {
  it("defines a 'typecheck' job", () => {
    const content = readWorkflow();
    // Job names appear as YAML keys inside the `jobs:` map.
    expect(content).toMatch(/\btypecheck\s*:/);
  });

  it("defines a 'lint' job", () => {
    const content = readWorkflow();
    expect(content).toMatch(/\blint\s*:/);
  });

  it("defines a 'test' job", () => {
    const content = readWorkflow();
    expect(content).toMatch(/\btest\s*:/);
  });

  it("defines a 'build' job", () => {
    const content = readWorkflow();
    expect(content).toMatch(/\bbuild\s*:/);
  });
});

// ---------------------------------------------------------------------------
// 5. pnpm usage
// ---------------------------------------------------------------------------

describe("TASK-FND-07: pnpm is used for dependency installation", () => {
  it("references pnpm in the workflow (install step uses pnpm)", () => {
    const content = readWorkflow();
    expect(content).toMatch(/\bpnpm\b/);
  });

  it("uses a pnpm install or ci action step (not npm install)", () => {
    const content = readWorkflow();
    // Should call `pnpm install` or configure pnpm via the setup-node action
    // or a dedicated pnpm action — any of these indicate correct tooling.
    const usesPnpmInstall = /pnpm\s+install/.test(content);
    const usesPnpmAction = /pnpm\/action-setup/.test(content);
    expect(usesPnpmInstall || usesPnpmAction).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. pnpm store caching
// ---------------------------------------------------------------------------

describe("TASK-FND-07: pnpm store caching is configured", () => {
  it("includes a cache configuration step or option referencing pnpm", () => {
    const content = readWorkflow();
    // Caching can be configured via:
    //   - actions/cache with a pnpm store path
    //   - setup-node's cache: 'pnpm' option
    //   - pnpm/action-setup with run_install that leverages a cache
    // We check for the string `cache` appearing near `pnpm` in the file.
    const hasCacheKeyword = /\bcache\b/.test(content);
    const hasPnpmKeyword = /\bpnpm\b/.test(content);
    expect(hasCacheKeyword && hasPnpmKeyword).toBe(true);
  });

  it("references the pnpm store directory or pnpm cache key for caching", () => {
    const content = readWorkflow();
    // The pnpm store path is typically ~/.local/share/pnpm/store or similar,
    // or the setup-node action uses `cache: 'pnpm'` shorthand. Either a
    // literal store path or the shorthand `cache: 'pnpm'` must appear.
    const hasStorePath = /pnpm.*store|store.*pnpm/.test(content);
    const hasCachePnpmOption = /cache\s*:\s*['"]?pnpm['"]?/.test(content);
    expect(hasStorePath || hasCachePnpmOption).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Node.js setup
// ---------------------------------------------------------------------------

describe("TASK-FND-07: Node.js runtime is configured", () => {
  it("references Node.js setup (actions/setup-node or node-version)", () => {
    const content = readWorkflow();
    // Either the action name or the `node-version` input key confirms Node setup.
    const hasSetupNode = /actions\/setup-node/.test(content);
    const hasNodeVersion = /node-version/.test(content) || /node\b/.test(content);
    expect(hasSetupNode || hasNodeVersion).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Job run commands
// ---------------------------------------------------------------------------

describe("TASK-FND-07: job run commands match project conventions", () => {
  it("the test job runs pnpm test (pnpm -r test or pnpm test)", () => {
    const content = readWorkflow();
    // Accept: `pnpm test`, `pnpm -r test`, `pnpm run test`, `pnpm --filter ...`,
    // or `turbo run test` (which pnpm delegates to in the monorepo).
    const runsPnpmTest =
      /pnpm\s+(-r\s+|run\s+)?test\b/.test(content) ||
      /pnpm\s+--filter.*test\b/.test(content) ||
      /turbo\s+run\s+test\b/.test(content);
    expect(runsPnpmTest).toBe(true);
  });

  it("the build job runs pnpm build (pnpm -r build or pnpm build)", () => {
    const content = readWorkflow();
    const runsPnpmBuild =
      /pnpm\s+(-r\s+|run\s+)?build\b/.test(content) ||
      /pnpm\s+--filter.*build\b/.test(content) ||
      /turbo\s+run\s+build\b/.test(content);
    expect(runsPnpmBuild).toBe(true);
  });

  it("the typecheck job runs pnpm typecheck (pnpm -r typecheck or pnpm typecheck)", () => {
    const content = readWorkflow();
    const runsPnpmTypecheck =
      /pnpm\s+(-r\s+|run\s+)?typecheck\b/.test(content) ||
      /pnpm\s+--filter.*typecheck\b/.test(content) ||
      /turbo\s+run\s+typecheck\b/.test(content);
    expect(runsPnpmTypecheck).toBe(true);
  });

  it("the lint job runs pnpm lint (pnpm -r lint or pnpm lint)", () => {
    const content = readWorkflow();
    const runsPnpmLint =
      /pnpm\s+(-r\s+|run\s+)?lint\b/.test(content) ||
      /pnpm\s+--filter.*lint\b/.test(content) ||
      /turbo\s+run\s+lint\b/.test(content);
    expect(runsPnpmLint).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Edge cases
// ---------------------------------------------------------------------------

describe("TASK-FND-07: edge cases and structural integrity", () => {
  it("the workflow does not suppress step failures with '|| true' on critical commands", () => {
    const content = readWorkflow();
    // Any of the four key commands silenced with `|| true` would mean the
    // workflow can green while the project is broken — forbidden per CLAUDE.md.
    expect(content).not.toMatch(/typecheck.*\|\|\s*true/);
    expect(content).not.toMatch(/pnpm\s+lint.*\|\|\s*true/);
    expect(content).not.toMatch(/pnpm.*test.*\|\|\s*true/);
    expect(content).not.toMatch(/pnpm.*build.*\|\|\s*true/);
  });

  it("the workflow file does not contain plaintext secrets or API keys", () => {
    const content = readWorkflow();
    // Secrets must be referenced via ${{ secrets.NAME }}, never inlined.
    // Heuristic: look for patterns that look like raw keys.
    expect(content).not.toMatch(/AKIA[0-9A-Z]{16}/); // AWS key prefix
    expect(content).not.toMatch(/sk-[a-zA-Z0-9]{20,}/); // generic secret-key prefix
    // Secrets must be expressed as ${{ secrets.* }}
    // If there are secret-looking env vars they must use the secrets context.
    const hasInlinePassword = /password\s*=\s*["'][^$][^"']{4,}["']/i.test(content);
    expect(hasInlinePassword).toBe(false);
  });

  it("checkout step is present (workflow checks out the repository)", () => {
    const content = readWorkflow();
    expect(content).toMatch(/actions\/checkout/);
  });

  it("push trigger covers all branches (not restricted to a single named branch)", () => {
    const content = readWorkflow();
    // If there is a branches filter under push, it should not restrict to only
    // `main` (the task requires CI on push to *any* branch).
    // Acceptable: no branches filter at all, or a wildcard pattern like '**' or '*'.
    // Not acceptable: `branches: [main]` with no other patterns.
    const pushBranchesOnlyMain = /push\s*:\s*\n\s+branches\s*:\s*\n\s+-\s+main\s*\n(?!\s+-)/m.test(content);
    expect(pushBranchesOnlyMain).toBe(false);
  });
});
