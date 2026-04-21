/**
 * Unit tests for TASK-FND-06: ts-rest contracts + echo endpoint.
 *
 * These tests are written BEFORE the implementation exists (TDD red phase).
 * They encode the acceptance criteria for the contracts package:
 *   - Contract file exists at the expected path
 *   - `echoContract` is exported from echo.ts
 *   - Contract defines a POST route at /api/v1/echo
 *   - Input Zod schema accepts valid payloads and rejects invalid ones
 *   - Response schema describes the { ok: true, data: { echo: string } } envelope
 *
 * Import uses the .js extension (NodeNext module resolution) per project conventions.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Suite 1 — File existence
// ---------------------------------------------------------------------------

describe('TASK-FND-06 / contracts package / file existence', () => {
  it('echo.ts source file exists at the expected path', () => {
    // The builder must create this file. Until then this test fails (red).
    expect(
      existsSync('/workspace/packages/contracts/src/echo.ts'),
    ).toBe(true);
  });

  it('index.ts re-exports from echo.ts', () => {
    // packages/contracts/src/index.ts must exist (it already does) and
    // we will verify it exports echoContract after the dynamic import below.
    expect(
      existsSync('/workspace/packages/contracts/src/index.ts'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Contract exports and structure
// ---------------------------------------------------------------------------

describe('TASK-FND-06 / contracts package / echoContract export', () => {
  it('echoContract is exported from echo.ts', async () => {
    // Dynamic import — will throw MODULE_NOT_FOUND until the builder creates
    // packages/contracts/src/echo.ts, which is the intended failure mode.
    const mod = await import('../echo.js');
    expect(mod).toHaveProperty('echoContract');
    expect(mod.echoContract).not.toBeUndefined();
  });

  it('echoContract is also re-exported through the package index', async () => {
    const mod = await import('../index.js');
    expect(mod).toHaveProperty('echoContract');
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — ts-rest route definition
// ---------------------------------------------------------------------------

describe('TASK-FND-06 / contracts package / route definition', () => {
  it('echoContract has an "echo" key that defines a route', async () => {
    const { echoContract } = await import('../echo.js');
    // ts-rest contracts are plain objects keyed by route name.
    expect(echoContract).toHaveProperty('echo');
  });

  it('the echo route is defined with method POST', async () => {
    const { echoContract } = await import('../echo.js');
    expect(echoContract.echo.method).toBe('POST');
  });

  it('the echo route path is /api/v1/echo', async () => {
    const { echoContract } = await import('../echo.js');
    expect(echoContract.echo.path).toBe('/api/v1/echo');
  });

  it('the echo route declares a body schema', async () => {
    const { echoContract } = await import('../echo.js');
    // ts-rest attaches the Zod schema to .body
    expect(echoContract.echo).toHaveProperty('body');
    expect(typeof echoContract.echo.body).not.toBe('undefined');
  });

  it('the echo route declares a responses schema', async () => {
    const { echoContract } = await import('../echo.js');
    expect(echoContract.echo).toHaveProperty('responses');
    expect(typeof echoContract.echo.responses).not.toBe('undefined');
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Input schema validation
// ---------------------------------------------------------------------------

describe('TASK-FND-06 / contracts package / input schema', () => {
  it('body schema accepts { message: "hello" }', async () => {
    const { echoContract } = await import('../echo.js');
    const schema: z.ZodTypeAny = echoContract.echo.body;

    const result = schema.safeParse({ message: 'hello' });
    expect(result.success).toBe(true);
  });

  it('body schema accepts a long realistic message string', async () => {
    const { echoContract } = await import('../echo.js');
    const schema: z.ZodTypeAny = echoContract.echo.body;

    const result = schema.safeParse({
      message:
        'Garage door spring replacement requested for 4820 W Colfax Ave, Denver CO 80204 — customer Marion Alvarez',
    });
    expect(result.success).toBe(true);
  });

  it('body schema rejects {} (missing message field)', async () => {
    const { echoContract } = await import('../echo.js');
    const schema: z.ZodTypeAny = echoContract.echo.body;

    const result = schema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('body schema rejects { message: 123 } (wrong type — number instead of string)', async () => {
    const { echoContract } = await import('../echo.js');
    const schema: z.ZodTypeAny = echoContract.echo.body;

    const result = schema.safeParse({ message: 123 });
    expect(result.success).toBe(false);
  });

  it('body schema rejects { message: null }', async () => {
    const { echoContract } = await import('../echo.js');
    const schema: z.ZodTypeAny = echoContract.echo.body;

    const result = schema.safeParse({ message: null });
    expect(result.success).toBe(false);
  });

  it('body schema rejects an empty string message', async () => {
    // Empty string is not useful for an echo endpoint; convention is min 1 char.
    const { echoContract } = await import('../echo.js');
    const schema: z.ZodTypeAny = echoContract.echo.body;

    const result = schema.safeParse({ message: '' });
    // Either rejection or acceptance is acceptable here, but the test documents
    // what was decided. We assert rejection (min(1) is the expected choice).
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 5 — Response schema shape
// ---------------------------------------------------------------------------

describe('TASK-FND-06 / contracts package / response schema', () => {
  it('200 response schema is defined', async () => {
    const { echoContract } = await import('../echo.js');
    expect(echoContract.echo.responses).toHaveProperty([200]);
  });

  it('200 response schema accepts { ok: true, data: { echo: "hello" } }', async () => {
    const { echoContract } = await import('../echo.js');
    const responseSchema: z.ZodTypeAny = echoContract.echo.responses[200] as unknown as z.ZodTypeAny;

    const result = responseSchema.safeParse({
      ok: true,
      data: { echo: 'hello' },
    });
    expect(result.success).toBe(true);
  });

  it('200 response schema rejects a response missing the data.echo field', async () => {
    const { echoContract } = await import('../echo.js');
    const responseSchema: z.ZodTypeAny = echoContract.echo.responses[200] as unknown as z.ZodTypeAny;

    const result = responseSchema.safeParse({ ok: true, data: {} });
    expect(result.success).toBe(false);
  });

  it('200 response schema rejects a response where data.echo is not a string', async () => {
    const { echoContract } = await import('../echo.js');
    const responseSchema: z.ZodTypeAny = echoContract.echo.responses[200] as unknown as z.ZodTypeAny;

    const result = responseSchema.safeParse({
      ok: true,
      data: { echo: 42 },
    });
    expect(result.success).toBe(false);
  });

  it('200 response schema rejects a response where ok is false', async () => {
    // The 200 response must always carry ok: true; error cases use a different
    // status code in the contract.
    const { echoContract } = await import('../echo.js');
    const responseSchema: z.ZodTypeAny = echoContract.echo.responses[200] as unknown as z.ZodTypeAny;

    const result = responseSchema.safeParse({
      ok: false,
      data: { echo: 'hello' },
    });
    expect(result.success).toBe(false);
  });
});
