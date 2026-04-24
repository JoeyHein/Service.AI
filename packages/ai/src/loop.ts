/**
 * Agent tool-use loop.
 *
 * Drives a multi-turn conversation with the AIClient:
 *   1. Ask for an assistant turn.
 *   2. If text → terminal, return.
 *   3. If tool_use → execute the tool, feed the result back, loop.
 *
 * Bounded by `maxSteps` so a misbehaving model can't run forever.
 * Emits a structured transcript the caller persists to
 * `ai_messages`.
 *
 * Guardrail integration: between turns the loop checks the
 * assistant's reported confidence against the context's
 * `guardrails.confidenceThreshold`. If a tool call lands below
 * threshold AND the tool is in the gated list, the loop short-
 * circuits to `transferToHuman` instead of executing the tool.
 */

import type { AIClient, AssistantTurn, HistoryMessage, ToolSchema } from './client.js';
import type { Tool, ToolContext, ToolResult } from './tools/types.js';

export interface RunAgentLoopInput {
  ai: AIClient;
  systemPrompt: string;
  initialUserMessage?: string;
  tools: Record<string, Tool>;
  ctx: ToolContext;
  maxSteps?: number;
  /** Names of tools that are gated on confidence. If the
   *  assistant emits one of these below threshold, the loop
   *  substitutes `transferToHuman` instead. */
  gatedTools?: string[];
  /** Name of the transfer tool. Required if `gatedTools` is
   *  non-empty. */
  transferToolName?: string;
}

export interface AgentTranscriptEntry {
  role: 'assistant' | 'tool';
  turn?: AssistantTurn;
  tool?: {
    name: string;
    input: Record<string, unknown>;
    result: ToolResult;
  };
}

export interface RunAgentLoopOutput {
  transcript: AgentTranscriptEntry[];
  finalText: string;
  /** Final outcome for book-keeping. */
  outcome: 'completed' | 'transferred' | 'max_steps' | 'error';
  /** Total cost across every turn. */
  totalCostUsd: number;
}

const DEFAULT_MAX_STEPS = 12;

export async function runAgentLoop(
  input: RunAgentLoopInput,
): Promise<RunAgentLoopOutput> {
  const {
    ai,
    systemPrompt,
    tools,
    ctx,
    initialUserMessage,
    gatedTools = [],
    transferToolName = 'transferToHuman',
    maxSteps = DEFAULT_MAX_STEPS,
  } = input;

  const schemas: ToolSchema[] = Object.values(tools).map((t) => t.schema);
  const history: HistoryMessage[] = [];
  if (initialUserMessage) {
    history.push({ role: 'user', content: initialUserMessage });
  }
  const transcript: AgentTranscriptEntry[] = [];
  let totalCostUsd = 0;
  let outcome: RunAgentLoopOutput['outcome'] = 'completed';

  for (let step = 0; step < maxSteps; step++) {
    const turn = await ai.turn({
      systemPrompt,
      history,
      tools: schemas,
    });
    totalCostUsd += turn.costUsd;
    history.push(turn);
    transcript.push({ role: 'assistant', turn });

    if (turn.kind === 'text') {
      return { transcript, finalText: turn.text, outcome, totalCostUsd };
    }

    // tool_use
    let toolName = turn.toolName;
    let toolInput = turn.toolInput;
    // Guardrail: if a gated tool fires below the confidence
    // threshold, redirect to transferToHuman.
    if (
      gatedTools.includes(toolName) &&
      turn.confidence < ctx.guardrails.confidenceThreshold &&
      ctx.guardrails.transferOnLowConfidence &&
      tools[transferToolName]
    ) {
      toolName = transferToolName;
      toolInput = {
        reason: `confidence ${turn.confidence.toFixed(2)} below threshold ${ctx.guardrails.confidenceThreshold.toFixed(2)} for ${turn.toolName}`,
        priority: 'normal',
      };
    }

    const tool = tools[toolName];
    if (!tool) {
      const result: ToolResult = {
        ok: false,
        error: {
          code: 'UNKNOWN_TOOL',
          message: `Tool "${toolName}" not available`,
        },
      };
      transcript.push({
        role: 'tool',
        tool: { name: toolName, input: toolInput, result },
      });
      history.push({
        role: 'tool_result',
        toolUseId: turn.toolUseId,
        result,
        isError: true,
      });
      continue;
    }

    const invocationCtx: ToolContext = {
      ...ctx,
      invocation: { confidence: turn.confidence },
    };
    let result: ToolResult;
    try {
      result = await tool.execute(toolInput, invocationCtx);
    } catch (err) {
      result = {
        ok: false,
        error: {
          code: 'TOOL_THROWN',
          message: err instanceof Error ? err.message : 'unknown error',
        },
      };
    }
    transcript.push({
      role: 'tool',
      tool: { name: toolName, input: toolInput, result },
    });
    history.push({
      role: 'tool_result',
      toolUseId: turn.toolUseId,
      result,
      isError: !result.ok,
    });

    if (toolName === transferToolName && result.ok) {
      outcome = 'transferred';
      return {
        transcript,
        finalText:
          (result.data as { message?: string } | undefined)?.message ??
          'Transferring you to a human dispatcher now.',
        outcome,
        totalCostUsd,
      };
    }
  }

  outcome = 'max_steps';
  return {
    transcript,
    finalText: 'I need to loop you in with a human. One moment.',
    outcome,
    totalCostUsd,
  };
}
