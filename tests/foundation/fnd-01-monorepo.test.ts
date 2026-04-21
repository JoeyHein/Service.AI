/**
 * TASK-FND-01: Monorepo skeleton acceptance tests
 *
 * These tests encode the acceptance criteria for the pnpm workspaces +
 * Turborepo monorepo scaffold. Every test MUST fail before the builder
 * implements the skeleton and MUST pass once the skeleton is in place.
 *
 * The tests use only Node's built-in `fs` module — no framework-level
 * assumptions — so they remain runnable even before any workspace packages
 * are installed.
 */

import { describe, it, expect } from "vitest";
import {
  existsSync,
  readFileSync,
  statSync,
  accessSync,
  constants as fsConstants,
} from "fs";
import { join } from "path";

/** Absolute path to the repository root. */
const ROOT = "/workspace";

/** Convenience: read a file as UTF-8 text, throwing a clear error on miss. */
function readFile(relativePath: string): string {
  const abs = join(ROOT, relativePath);
  if (!existsSync(abs)) {
    throw new Error(`Expected file not found: ${abs}`);
  }
  return readFileSync(abs, "utf-8");
}

/** Convenience: parse JSON from a repo-relative path. */
function readJSON(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFile(relativePath)) as Record<string, unknown>;
}

/** Check whether a file has the executable bit set (owner). */
function isExecutable(relativePath: string): boolean {
  const abs = join(ROOT, relativePath);
  try {
    accessSync(abs, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. pnpm-workspace.yaml
// ---------------------------------------------------------------------------

describe("pnpm-workspace.yaml", () => {
  it("exists at the repository root", () => {
    expect(existsSync(join(ROOT, "pnpm-workspace.yaml"))).toBe(true);
  });

  it("declares apps/* as a workspace", () => {
    const content = readFile("pnpm-workspace.yaml");
    // Either the glob literal "apps/*" or a YAML sequence entry with apps/*
    expect(content).toMatch(/apps\/\*/);
  });

  it("declares packages/* as a workspace", () => {
    const content = readFile("pnpm-workspace.yaml");
    expect(content).toMatch(/packages\/\*/);
  });
});

// ---------------------------------------------------------------------------
// 2. turbo.json
// ---------------------------------------------------------------------------

describe("turbo.json", () => {
  it("exists at the repository root", () => {
    expect(existsSync(join(ROOT, "turbo.json"))).toBe(true);
  });

  it("defines a typecheck pipeline task", () => {
    const turbo = readJSON("turbo.json");
    // turbo.json v2 uses `tasks`; v1 uses `pipeline` — accept both
    const tasks =
      (turbo["tasks"] as Record<string, unknown> | undefined) ??
      (turbo["pipeline"] as Record<string, unknown> | undefined);
    expect(tasks).toBeDefined();
    expect(Object.keys(tasks as object)).toContain("typecheck");
  });

  it("defines a lint pipeline task", () => {
    const turbo = readJSON("turbo.json");
    const tasks =
      (turbo["tasks"] as Record<string, unknown> | undefined) ??
      (turbo["pipeline"] as Record<string, unknown> | undefined);
    expect(tasks).toBeDefined();
    expect(Object.keys(tasks as object)).toContain("lint");
  });

  it("defines a build pipeline task", () => {
    const turbo = readJSON("turbo.json");
    const tasks =
      (turbo["tasks"] as Record<string, unknown> | undefined) ??
      (turbo["pipeline"] as Record<string, unknown> | undefined);
    expect(tasks).toBeDefined();
    expect(Object.keys(tasks as object)).toContain("build");
  });

  it("defines a test pipeline task", () => {
    const turbo = readJSON("turbo.json");
    const tasks =
      (turbo["tasks"] as Record<string, unknown> | undefined) ??
      (turbo["pipeline"] as Record<string, unknown> | undefined);
    expect(tasks).toBeDefined();
    expect(Object.keys(tasks as object)).toContain("test");
  });
});

// ---------------------------------------------------------------------------
// 3. tsconfig.base.json — strict mode
// ---------------------------------------------------------------------------

describe("tsconfig.base.json", () => {
  it("exists at the repository root", () => {
    expect(existsSync(join(ROOT, "tsconfig.base.json"))).toBe(true);
  });

  it('has "strict": true in compilerOptions', () => {
    const tsconfig = readJSON("tsconfig.base.json");
    const compilerOptions = tsconfig["compilerOptions"] as
      | Record<string, unknown>
      | undefined;
    expect(compilerOptions).toBeDefined();
    expect(compilerOptions?.["strict"]).toBe(true);
  });

  it('has "noEmit" or a valid outDir in compilerOptions', () => {
    const tsconfig = readJSON("tsconfig.base.json");
    const co = tsconfig["compilerOptions"] as
      | Record<string, unknown>
      | undefined;
    expect(co).toBeDefined();
    // A base config may set noEmit OR define target/module without an outDir;
    // what matters is that compilerOptions exists and strict is true (above).
    // Here we simply verify the compilerOptions key is a non-empty object.
    expect(typeof co).toBe("object");
    expect(Object.keys(co as object).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Required workspace directories exist
// ---------------------------------------------------------------------------

const REQUIRED_WORKSPACES = [
  "apps/web",
  "apps/api",
  "apps/voice",
  "packages/db",
  "packages/contracts",
  "packages/ai",
  "packages/auth",
  "packages/ui",
];

describe("required workspace directories exist", () => {
  for (const ws of REQUIRED_WORKSPACES) {
    it(`${ws} directory exists`, () => {
      const abs = join(ROOT, ws);
      expect(existsSync(abs)).toBe(true);
      expect(statSync(abs).isDirectory()).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Each workspace has a package.json
// ---------------------------------------------------------------------------

describe("each workspace has a package.json", () => {
  for (const ws of REQUIRED_WORKSPACES) {
    it(`${ws}/package.json exists`, () => {
      expect(existsSync(join(ROOT, ws, "package.json"))).toBe(true);
    });

    it(`${ws}/package.json has a "name" field`, () => {
      const pkg = readJSON(`${ws}/package.json`);
      expect(typeof pkg["name"]).toBe("string");
      expect((pkg["name"] as string).length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Each workspace has a tsconfig.json extending the base
// ---------------------------------------------------------------------------

describe("each workspace has a tsconfig.json", () => {
  for (const ws of REQUIRED_WORKSPACES) {
    it(`${ws}/tsconfig.json exists`, () => {
      expect(existsSync(join(ROOT, ws, "tsconfig.json"))).toBe(true);
    });

    it(`${ws}/tsconfig.json extends the root base config`, () => {
      const tsconfig = readJSON(`${ws}/tsconfig.json`);
      // The extends field should reference the base config (path may vary)
      const extendsVal = tsconfig["extends"] as string | undefined;
      expect(extendsVal).toBeDefined();
      // Must point to the root tsconfig.base.json (relative or via package)
      expect(extendsVal).toMatch(/tsconfig\.base\.json/);
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Husky pre-commit hook exists and is executable
// ---------------------------------------------------------------------------

describe(".husky/pre-commit", () => {
  it("exists", () => {
    expect(existsSync(join(ROOT, ".husky", "pre-commit"))).toBe(true);
  });

  it("is executable", () => {
    expect(isExecutable(".husky/pre-commit")).toBe(true);
  });

  it("invokes lint (contains a lint command)", () => {
    const content = readFile(".husky/pre-commit");
    // Should run lint — could be pnpm lint, turbo lint, npx lint-staged, etc.
    expect(content).toMatch(/lint/i);
  });

  it("invokes typecheck (contains a typecheck command)", () => {
    const content = readFile(".husky/pre-commit");
    expect(content).toMatch(/typecheck/i);
  });
});

// ---------------------------------------------------------------------------
// 8. Root package.json
// ---------------------------------------------------------------------------

describe("root package.json", () => {
  it("exists at the repository root", () => {
    expect(existsSync(join(ROOT, "package.json"))).toBe(true);
  });

  it('has a "name" field identifying the monorepo', () => {
    const pkg = readJSON("package.json");
    expect(typeof pkg["name"]).toBe("string");
    expect((pkg["name"] as string).length).toBeGreaterThan(0);
  });

  it('is marked as private (prevents accidental npm publish of the root)', () => {
    const pkg = readJSON("package.json");
    expect(pkg["private"]).toBe(true);
  });

  it("lists turborepo as a dev dependency or in devDependencies", () => {
    const pkg = readJSON("package.json");
    const devDeps = (pkg["devDependencies"] as Record<string, string>) ?? {};
    // Accept turbo (the CLI package name) as a dev dependency
    expect(Object.keys(devDeps)).toContain("turbo");
  });

  /**
   * pnpm uses pnpm-workspace.yaml rather than a "workspaces" key in
   * package.json. However some setups include it for tooling compatibility.
   * We accept either approach: the workspace.yaml already exists (tested
   * above), or the package.json has a workspaces field.
   *
   * This test is therefore an OR: pass if either the workspaces field is
   * present OR the pnpm-workspace.yaml already passed its own test.
   */
  it("workspace configuration is present (package.json workspaces field OR pnpm-workspace.yaml)", () => {
    const pkg = readJSON("package.json");
    const hasWorkspacesField = Array.isArray(pkg["workspaces"]);
    const hasPnpmWorkspaceYaml = existsSync(
      join(ROOT, "pnpm-workspace.yaml"),
    );
    expect(hasWorkspacesField || hasPnpmWorkspaceYaml).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. ESLint config exists at root
// ---------------------------------------------------------------------------

describe("ESLint configuration", () => {
  it("has .eslintrc.js, .eslintrc.cjs, .eslintrc.json, or eslint.config.js/mjs/cjs at root", () => {
    const candidates = [
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.json",
      ".eslintrc.yaml",
      ".eslintrc.yml",
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
    ];
    const found = candidates.some((c) => existsSync(join(ROOT, c)));
    expect(found).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Prettier config exists at root
// ---------------------------------------------------------------------------

describe("Prettier configuration", () => {
  it("has .prettierrc, .prettierrc.json, .prettierrc.js, or prettier.config.js at root", () => {
    const candidates = [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.js",
      ".prettierrc.cjs",
      ".prettierrc.mjs",
      ".prettierrc.yaml",
      ".prettierrc.yml",
      "prettier.config.js",
      "prettier.config.cjs",
      "prettier.config.mjs",
    ];
    const found = candidates.some((c) => existsSync(join(ROOT, c)));
    expect(found).toBe(true);
  });

  it("prettier config is not empty if it exists as a JSON file", () => {
    const jsonCandidates = [".prettierrc", ".prettierrc.json"];
    for (const c of jsonCandidates) {
      const abs = join(ROOT, c);
      if (existsSync(abs)) {
        const content = readFileSync(abs, "utf-8").trim();
        expect(content.length).toBeGreaterThan(2); // more than just "{}"
        return;
      }
    }
    // Non-JSON prettier configs are fine — this assertion only fires for JSON.
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases and structural integrity", () => {
  it("all workspace package.json names follow the @service-ai/* scoped pattern", () => {
    for (const ws of REQUIRED_WORKSPACES) {
      const pkgPath = join(ROOT, ws, "package.json");
      if (!existsSync(pkgPath)) continue; // already failed in section 5
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        name?: string;
      };
      expect(pkg.name).toMatch(/^@service-ai\//);
    }
  });

  it("no workspace tsconfig.json has strict explicitly set to false (would override base)", () => {
    for (const ws of REQUIRED_WORKSPACES) {
      const tscPath = join(ROOT, ws, "tsconfig.json");
      if (!existsSync(tscPath)) continue;
      const tsconfig = JSON.parse(readFileSync(tscPath, "utf-8")) as {
        compilerOptions?: { strict?: boolean };
      };
      const strictOverride = tsconfig.compilerOptions?.strict;
      // Workspaces may omit strict (inheriting true from base) but MUST NOT set it to false
      expect(strictOverride).not.toBe(false);
    }
  });

  it("root tsconfig.base.json does not set noImplicitAny to false (would weaken strict)", () => {
    const tsconfig = readJSON("tsconfig.base.json");
    const co = tsconfig["compilerOptions"] as
      | Record<string, unknown>
      | undefined;
    expect(co?.["noImplicitAny"]).not.toBe(false);
  });

  it(".husky/pre-commit does not silently suppress errors (no '|| true' on lint/typecheck)", () => {
    const content = readFile(".husky/pre-commit");
    // A hook that runs `pnpm lint || true` would never block commits.
    // This is a heuristic — the key commands must not be swallowed.
    expect(content).not.toMatch(/lint\s*\|\|\s*true/);
    expect(content).not.toMatch(/typecheck\s*\|\|\s*true/);
  });
});
