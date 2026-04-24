/**
 * Tool interface shared between the router and concrete tool
 * implementations. Every tool is a pure wrapper around a
 * side-effecting operation (DB query, API call, etc.) with:
 *   - a `schema` describing arguments for the model
 *   - an `execute` function called by the agent loop
 *   - a small `confidence` helper for callers that want to gate
 *     on risk
 *
 * A tool implementation MUST enforce scope — the `ToolContext`
 * always carries the franchisee id + user id, and the tool
 * rejects (via its return value, never by throwing) whenever an
 * argument would cross tenants.
 */

import type { ToolSchema } from '../client.js';

export interface ToolContext {
  franchiseeId: string;
  /** The user or agent identifier that owns the execution — used
   *  for audit rows on side-effectful tools. */
  userId: string | null;
  /** Per-call guardrail config (confidence threshold, undo
   *  window, etc.) so tools can refuse low-risk actions when the
   *  loop is operating under stricter rules. */
  guardrails: {
    confidenceThreshold: number;
    undoWindowSeconds: number;
    transferOnLowConfidence: boolean;
  };
  /** Narrowed AssistantTurn metadata from the turn that emitted
   *  this tool call. Used by `confidence`-gated tools. */
  invocation: {
    confidence: number;
  };
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export interface Tool<Args = Record<string, unknown>> {
  schema: ToolSchema;
  execute(input: Args, ctx: ToolContext): Promise<ToolResult>;
}
