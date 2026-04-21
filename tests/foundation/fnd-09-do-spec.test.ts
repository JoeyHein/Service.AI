/**
 * TASK-FND-09: DigitalOcean App Platform spec + auto-deploy
 *
 * These tests encode the acceptance criteria for the .do/app.yaml spec file
 * and the rollback procedure documented in README.md. Every test MUST fail
 * before the builder creates the spec, and MUST pass once the spec and
 * README rollback section are in place.
 *
 * Tests are string-based on raw file content — no YAML parsing library is
 * required, which keeps the test runnable before any workspace deps are
 * installed.
 *
 * Acceptance criteria encoded here:
 * - .do/app.yaml exists and describes all three services (web, api, voice)
 * - The spec references managed Postgres and Redis
 * - The spec includes environment variable references
 * - The spec wires auto-deploy from a git branch (push to main)
 * - Each service's HTTP/WS port is declared
 * - README.md exists and contains a substantive rollback procedure section
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';

/** Absolute path to the repository root. */
const ROOT = '/workspace';

/** Absolute path to the DO app spec. */
const DO_SPEC_PATH = `${ROOT}/.do/app.yaml`;

/** Absolute path to README. */
const README_PATH = `${ROOT}/README.md`;

// ---------------------------------------------------------------------------
// Group 1 — .do/app.yaml exists and has required structure
// ---------------------------------------------------------------------------

describe('Group 1 — .do/app.yaml exists and has required structure', () => {
  it('.do/app.yaml exists at /workspace/.do/app.yaml', () => {
    expect(existsSync(DO_SPEC_PATH)).toBe(true);
  });

  it('file contains a name: field identifying the app', () => {
    if (!existsSync(DO_SPEC_PATH)) {
      // Surface a clear failure message rather than a read error.
      expect.fail('.do/app.yaml does not exist — cannot check for name: field');
    }
    const content = readFileSync(DO_SPEC_PATH, 'utf-8');
    expect(content).toMatch(/\bname:/);
  });

  it('file contains a web component (string "web")', () => {
    if (!existsSync(DO_SPEC_PATH)) {
      expect.fail('.do/app.yaml does not exist — cannot check for web component');
    }
    const content = readFileSync(DO_SPEC_PATH, 'utf-8');
    // Accept "web" appearing as a service name, key, or value anywhere in the spec.
    expect(content).toMatch(/\bweb\b/);
  });

  it('file contains an api component (string "api")', () => {
    if (!existsSync(DO_SPEC_PATH)) {
      expect.fail('.do/app.yaml does not exist — cannot check for api component');
    }
    const content = readFileSync(DO_SPEC_PATH, 'utf-8');
    expect(content).toMatch(/\bapi\b/);
  });

  it('file contains a voice component (string "voice")', () => {
    if (!existsSync(DO_SPEC_PATH)) {
      expect.fail('.do/app.yaml does not exist — cannot check for voice component');
    }
    const content = readFileSync(DO_SPEC_PATH, 'utf-8');
    expect(content).toMatch(/\bvoice\b/);
  });

  it('file contains a managed database reference for Postgres (contains "postgres" or "database")', () => {
    if (!existsSync(DO_SPEC_PATH)) {
      expect.fail('.do/app.yaml does not exist — cannot check for Postgres reference');
    }
    const content = readFileSync(DO_SPEC_PATH, 'utf-8').toLowerCase();
    const hasPostgres = content.includes('postgres');
    const hasDatabase = content.includes('database');
    expect(hasPostgres || hasDatabase).toBe(true);
  });

  it('file contains a managed Redis reference (contains "redis")', () => {
    if (!existsSync(DO_SPEC_PATH)) {
      expect.fail('.do/app.yaml does not exist — cannot check for Redis reference');
    }
    const content = readFileSync(DO_SPEC_PATH, 'utf-8').toLowerCase();
    expect(content).toContain('redis');
  });

  it('file contains environment variable references (envs:, env_vars:, or ${ interpolation)', () => {
    if (!existsSync(DO_SPEC_PATH)) {
      expect.fail('.do/app.yaml does not exist — cannot check for env var references');
    }
    const content = readFileSync(DO_SPEC_PATH, 'utf-8');
    const hasEnvs = content.includes('envs:');
    const hasEnvVars = content.includes('env_vars:');
    const hasInterpolation = content.includes('${');
    expect(hasEnvs || hasEnvVars || hasInterpolation).toBe(true);
  });

  it('file references a git branch for auto-deploy (contains "branch:" or "github:")', () => {
    if (!existsSync(DO_SPEC_PATH)) {
      expect.fail('.do/app.yaml does not exist — cannot check for auto-deploy branch reference');
    }
    const content = readFileSync(DO_SPEC_PATH, 'utf-8');
    const hasBranch = content.includes('branch:');
    const hasGithub = content.includes('github:');
    expect(hasBranch || hasGithub).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — README.md rollback procedure
// ---------------------------------------------------------------------------

describe('Group 2 — README.md rollback procedure', () => {
  it('README.md exists at /workspace/README.md', () => {
    expect(existsSync(README_PATH)).toBe(true);
  });

  it('README.md contains a rollback section (case-insensitive match for "rollback")', () => {
    if (!existsSync(README_PATH)) {
      expect.fail('README.md does not exist — cannot check for rollback section');
    }
    const content = readFileSync(README_PATH, 'utf-8');
    expect(content.toLowerCase()).toContain('rollback');
  });

  it('README.md has meaningful rollback content (at least 100 characters total in the file)', () => {
    if (!existsSync(README_PATH)) {
      expect.fail('README.md does not exist — cannot check content length');
    }
    const content = readFileSync(README_PATH, 'utf-8');
    // The file must be long enough to contain a real rollback procedure, not
    // just a heading with the word "rollback" and nothing else.
    expect(content.length).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — App spec covers all three services with correct ports
// ---------------------------------------------------------------------------

describe('Group 3 — App spec covers all three services with correct ports', () => {
  it('yaml mentions port 3000 for the web service', () => {
    if (!existsSync(DO_SPEC_PATH)) {
      expect.fail('.do/app.yaml does not exist — cannot check web port');
    }
    const content = readFileSync(DO_SPEC_PATH, 'utf-8');
    // Accept a literal "3000" anywhere in the file — builders may express
    // the port as http_port, internal_ports, or as a routing rule.
    const hasPort3000 = content.includes('3000');
    // Also accept any explicit "web" service with an http_port declaration.
    const hasWebHttpPort = /\bweb\b[\s\S]*?http_port/.test(content);
    expect(hasPort3000 || hasWebHttpPort).toBe(true);
  });

  it('yaml mentions port 3001 for the api service', () => {
    if (!existsSync(DO_SPEC_PATH)) {
      expect.fail('.do/app.yaml does not exist — cannot check api port');
    }
    const content = readFileSync(DO_SPEC_PATH, 'utf-8');
    const hasPort3001 = content.includes('3001');
    const hasApiHttpPort = /\bapi\b[\s\S]*?http_port/.test(content);
    expect(hasPort3001 || hasApiHttpPort).toBe(true);
  });

  it('yaml mentions port 8080 for the voice service, or includes a websocket reference', () => {
    if (!existsSync(DO_SPEC_PATH)) {
      expect.fail('.do/app.yaml does not exist — cannot check voice port');
    }
    const content = readFileSync(DO_SPEC_PATH, 'utf-8');
    const hasPort8080 = content.includes('8080');
    const hasWs = content.toLowerCase().includes('websocket') || content.toLowerCase().includes('ws:');
    const hasVoiceHttpPort = /\bvoice\b[\s\S]*?http_port/.test(content);
    expect(hasPort8080 || hasWs || hasVoiceHttpPort).toBe(true);
  });
});
