/**
 * ts-rest contract for the /api/v1/echo endpoint.
 *
 * The echo endpoint exists to validate the ts-rest contract layer end-to-end
 * during the foundation phase. It accepts a `message` string and returns it
 * unchanged, wrapped in the standard { ok, data } envelope.
 *
 * Edge cases:
 * - Empty strings are rejected (min(1)) — zero-length echoes have no utility.
 * - Non-string `message` values are rejected by the Zod schema.
 *
 * @module echo
 */

import { initContract } from '@ts-rest/core';
import { z } from 'zod';

const c = initContract();

/**
 * Zod schema validating the POST body for the echo endpoint.
 * Requires a non-empty string in the `message` field.
 */
export const EchoInputSchema = z.object({
  message: z.string().min(1),
});

/**
 * Zod schema for the 200 success response.
 * Enforces the standard { ok: true, data: { echo } } envelope.
 */
export const EchoResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    echo: z.string(),
  }),
});

/**
 * ts-rest router definition for the echo endpoint.
 *
 * Consumers import this contract to get fully-typed client and server
 * implementations without duplicating schema definitions.
 */
export const echoContract = c.router({
  echo: {
    method: 'POST',
    path: '/api/v1/echo',
    body: EchoInputSchema,
    responses: {
      200: EchoResponseSchema,
      400: z.object({
        ok: z.literal(false),
        error: z.object({
          code: z.string(),
          message: z.string(),
        }),
      }),
    },
    summary: 'Echo endpoint',
  },
});
