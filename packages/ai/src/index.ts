/**
 * @service-ai/ai public API.
 *
 * Three primitives:
 *   - `AIClient` interface + concrete stub/anthropic impls
 *   - `runAgentLoop(...)` which drives the multi-turn tool-use
 *     conversation with guardrail checks between turns
 *   - `Tool` interface that tool modules conform to
 */
export * from './client.js';
export * from './loop.js';
export * from './tools/types.js';
