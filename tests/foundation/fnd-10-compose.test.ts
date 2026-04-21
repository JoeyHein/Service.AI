/**
 * TASK-FND-10: Docker Compose dev parity acceptance tests
 *
 * These tests encode the acceptance criteria for the updated docker-compose.yml
 * that runs web + api + voice + postgres + redis together for full-stack local
 * development with hot reload via volume mounts.
 *
 * All tests read the raw YAML text from the file and use string checks so that
 * the test suite has no dependency beyond Node's built-in `fs` module. Tests
 * for services that do NOT yet exist in the compose file (web, api, voice) MUST
 * fail in the red phase and MUST pass once the builder adds those services.
 *
 * Acceptance criteria covered:
 *  - All five services are declared (web, api, voice, postgres, redis)
 *  - Ports are mapped exactly as specified: 3000, 3001, 8080, 5434, 6381
 *  - Hot-reload volume mounts exist for each app service
 *  - api has DATABASE_URL + REDIS_URL so services can reach each other
 *  - All services share a common network for service-name resolution
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";

/** Absolute path to the docker-compose.yml under test. */
const COMPOSE_PATH = "/workspace/docker-compose.yml";

/**
 * Read docker-compose.yml once and cache the result so every test works from
 * the same snapshot. Throws a descriptive error when the file is absent so
 * that every test fails with a clear message rather than a cryptic TypeError.
 */
function readCompose(): string {
  if (!existsSync(COMPOSE_PATH)) {
    throw new Error(
      `docker-compose.yml not found at ${COMPOSE_PATH}. ` +
        "The file must exist at the repository root.",
    );
  }
  return readFileSync(COMPOSE_PATH, "utf-8");
}

// ---------------------------------------------------------------------------
// Group 1 — Services exist
// ---------------------------------------------------------------------------

describe("Group 1 — Services exist", () => {
  it("docker-compose.yml contains a 'web' service", () => {
    const content = readCompose();
    // The service key appears as a top-level YAML mapping key under `services:`.
    // We match a line that starts with optional whitespace followed by "web:"
    // which is the canonical YAML form for a service named "web".
    expect(content).toMatch(/^\s{2}web:/m);
  });

  it("docker-compose.yml contains an 'api' service", () => {
    const content = readCompose();
    expect(content).toMatch(/^\s{2}api:/m);
  });

  it("docker-compose.yml contains a 'voice' service", () => {
    const content = readCompose();
    expect(content).toMatch(/^\s{2}voice:/m);
  });

  it("docker-compose.yml contains a 'postgres' service (already present)", () => {
    const content = readCompose();
    expect(content).toMatch(/^\s{2}postgres:/m);
  });

  it("docker-compose.yml contains a 'redis' service (already present)", () => {
    const content = readCompose();
    expect(content).toMatch(/^\s{2}redis:/m);
  });
});

// ---------------------------------------------------------------------------
// Group 2 — Port mappings
// ---------------------------------------------------------------------------

describe("Group 2 — Port mappings", () => {
  it("web service exposes host port 3000 mapped to container port 3000", () => {
    const content = readCompose();
    // Accept quoted ("3000:3000") and unquoted (3000:3000) forms.
    expect(content).toMatch(/["']?3000:3000["']?/);
  });

  it("api service exposes host port 3001 mapped to container port 3001", () => {
    const content = readCompose();
    expect(content).toMatch(/["']?3001:3001["']?/);
  });

  it("voice service exposes host port 8080 mapped to container port 8080", () => {
    const content = readCompose();
    expect(content).toMatch(/["']?8080:8080["']?/);
  });

  it("postgres uses host port 5434 mapped to container port 5432 (non-default to avoid collisions)", () => {
    const content = readCompose();
    // This mapping already exists in the current compose file; the test
    // confirms it is preserved after the builder's update.
    expect(content).toMatch(/["']?5434:5432["']?/);
  });

  it("redis uses host port 6381 mapped to container port 6379 (non-default to avoid collisions)", () => {
    const content = readCompose();
    // This mapping already exists in the current compose file; the test
    // confirms it is preserved after the builder's update.
    expect(content).toMatch(/["']?6381:6379["']?/);
  });
});

// ---------------------------------------------------------------------------
// Group 3 — Volume mounts for hot reload
// ---------------------------------------------------------------------------

describe("Group 3 — Volume mounts for hot reload", () => {
  it("web service has a volume mount for its source directory (./apps/web)", () => {
    const content = readCompose();
    // The volume source must include the apps/web path so that file-system
    // events trigger hot reload inside the container.
    expect(content).toMatch(/\.\/apps\/web/);
  });

  it("api service has a volume mount for its source directory (./apps/api)", () => {
    const content = readCompose();
    expect(content).toMatch(/\.\/apps\/api/);
  });

  it("voice service has a volume mount for its source directory (./apps/voice)", () => {
    const content = readCompose();
    expect(content).toMatch(/\.\/apps\/voice/);
  });
});

// ---------------------------------------------------------------------------
// Group 4 — Environment variables and networking
// ---------------------------------------------------------------------------

describe("Group 4 — Environment and networking", () => {
  it("api service declares a DATABASE_URL environment variable", () => {
    const content = readCompose();
    // DATABASE_URL must appear somewhere in the file. Because it is scoped to
    // the api service in practice, we simply verify the key is present — a
    // more structural check would require a YAML parser.
    expect(content).toMatch(/DATABASE_URL/);
  });

  it("api service declares a REDIS_URL environment variable", () => {
    const content = readCompose();
    expect(content).toMatch(/REDIS_URL/);
  });

  it("all services share a common Docker network so they can reach each other by service name", () => {
    const content = readCompose();
    // The existing compose already defines a `networks:` top-level key and
    // the `build-net` network. We verify both are still present after the
    // builder adds the new services.
    expect(content).toMatch(/^networks:/m);
    expect(content).toMatch(/build-net/);
  });

  it("web service is connected to the shared network", () => {
    const content = readCompose();
    // The web service block must reference the shared network. We verify that
    // "build-net" appears in the file at least twice: once in the top-level
    // networks declaration and once (or more) inside a service block.
    const occurrences = (content.match(/build-net/g) ?? []).length;
    // Current compose: builder, postgres, redis each reference it (3 times) +
    // the network declaration itself. After the update: web, api, voice add 3
    // more references — total must exceed the existing 4 baseline.
    expect(occurrences).toBeGreaterThan(4);
  });
});
