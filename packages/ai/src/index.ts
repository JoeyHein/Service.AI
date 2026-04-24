/**
 * @service-ai/ai public API.
 *
 * Five primitives:
 *   - `AIClient` interface + concrete stub/anthropic impls
 *   - `runAgentLoop(...)` which drives the multi-turn tool-use
 *     conversation with guardrail checks between turns
 *   - `Tool` interface that tool modules conform to
 *   - `AsrClient` / `TtsClient` adapter interfaces + stubs
 *   - `CallOrchestrator` — framework-agnostic per-call driver
 *     that wires ASR → agent loop → TTS → DB persistence
 */
export * from './client.js';
export * from './loop.js';
export * from './tools/types.js';
export * from './asr.js';
export * from './tts.js';
export * from './call-context.js';
export * from './call-orchestrator.js';
