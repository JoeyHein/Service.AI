/**
 * Unit tests for runAgentLoop (TASK-CV-02).
 */

import { describe, expect, it } from 'vitest';
import { stubAIClient, type AssistantTurn } from './client.js';
import { runAgentLoop } from './loop.js';
import type { Tool, ToolContext } from './tools/types.js';

const ctx: ToolContext = {
  franchiseeId: 'fe-1',
  userId: null,
  guardrails: {
    confidenceThreshold: 0.8,
    undoWindowSeconds: 900,
    transferOnLowConfidence: true,
  },
  invocation: { confidence: 1 },
};

const lookupTool: Tool = {
  schema: {
    name: 'lookupCustomer',
    description: 'Look up by phone',
    inputSchema: { type: 'object', properties: { phone: { type: 'string' } } },
  },
  async execute(input) {
    return {
      ok: true,
      data: { phone: (input as { phone?: string }).phone, customerId: 'cust-1' },
    };
  },
};

const bookTool: Tool = {
  schema: {
    name: 'bookJob',
    description: 'Book a job',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
  },
  async execute(input) {
    return { ok: true, data: { jobId: 'job-1', title: (input as { title?: string }).title } };
  },
};

const transferTool: Tool = {
  schema: {
    name: 'transferToHuman',
    description: 'Hand off to a human dispatcher',
    inputSchema: { type: 'object', properties: { reason: { type: 'string' } } },
  },
  async execute(input) {
    return {
      ok: true,
      data: {
        message: 'Transferring now.',
        reason: (input as { reason?: string }).reason,
      },
    };
  },
};

const toolUse = (
  name: string,
  input: Record<string, unknown>,
  confidence = 0.9,
): AssistantTurn => ({
  role: 'assistant',
  kind: 'tool_use',
  toolUseId: `tu_${name}`,
  toolName: name,
  toolInput: input,
  confidence,
  costUsd: 0.001,
  provider: 'stub',
  model: 'stub-1',
});

const text = (text: string): AssistantTurn => ({
  role: 'assistant',
  kind: 'text',
  text,
  confidence: 1,
  costUsd: 0.0005,
  provider: 'stub',
  model: 'stub-1',
});

describe('CV-02 / runAgentLoop', () => {
  it('terminates on first text turn (no tools)', async () => {
    const ai = stubAIClient({ script: [text('Hello!')] });
    const out = await runAgentLoop({
      ai,
      systemPrompt: 'be brief',
      tools: {},
      ctx,
    });
    expect(out.finalText).toBe('Hello!');
    expect(out.outcome).toBe('completed');
    expect(out.transcript).toHaveLength(1);
  });

  it('threads a tool call through + feeds result back', async () => {
    const ai = stubAIClient({
      script: [
        toolUse('lookupCustomer', { phone: '+15555550000' }),
        text('Got it. Hi cust-1.'),
      ],
    });
    const out = await runAgentLoop({
      ai,
      systemPrompt: 's',
      tools: { lookupCustomer: lookupTool },
      ctx,
    });
    expect(out.finalText).toBe('Got it. Hi cust-1.');
    // 2 assistant + 1 tool = 3 transcript entries
    expect(out.transcript.filter((t) => t.role === 'tool')).toHaveLength(1);
    expect(out.transcript.find((t) => t.role === 'tool')!.tool!.name).toBe(
      'lookupCustomer',
    );
  });

  it('redirects a gated tool below threshold to transferToHuman', async () => {
    const ai = stubAIClient({
      script: [
        toolUse('bookJob', { title: 'risky' }, 0.4), // below 0.8 threshold
      ],
    });
    const out = await runAgentLoop({
      ai,
      systemPrompt: 's',
      tools: { bookJob: bookTool, transferToHuman: transferTool },
      ctx,
      gatedTools: ['bookJob'],
    });
    expect(out.outcome).toBe('transferred');
    const toolEntry = out.transcript.find((t) => t.role === 'tool')!;
    expect(toolEntry.tool!.name).toBe('transferToHuman');
    expect(String(toolEntry.tool!.input.reason)).toContain('bookJob');
  });

  it('does NOT redirect a non-gated tool below threshold', async () => {
    const ai = stubAIClient({
      script: [
        toolUse('lookupCustomer', { phone: '+1' }, 0.3),
        text('Thanks!'),
      ],
    });
    const out = await runAgentLoop({
      ai,
      systemPrompt: 's',
      tools: { lookupCustomer: lookupTool, transferToHuman: transferTool },
      ctx,
      gatedTools: ['bookJob'], // only bookJob is gated
    });
    expect(out.outcome).toBe('completed');
    const tools = out.transcript.filter((t) => t.role === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool!.name).toBe('lookupCustomer');
  });

  it('records UNKNOWN_TOOL when the model invents a tool name', async () => {
    const ai = stubAIClient({
      script: [
        toolUse('hackTheGibson', {}),
        text('Sorry, that tool is not available.'),
      ],
    });
    const out = await runAgentLoop({
      ai,
      systemPrompt: 's',
      tools: {},
      ctx,
    });
    const tool = out.transcript.find((t) => t.role === 'tool')!;
    expect(tool.tool!.result.ok).toBe(false);
    expect(tool.tool!.result.error?.code).toBe('UNKNOWN_TOOL');
  });

  it('caps iterations with maxSteps', async () => {
    const ai = stubAIClient({
      // Each script entry is a tool_use with no terminal text, so
      // the loop would run forever without maxSteps.
      script: Array.from({ length: 10 }, () =>
        toolUse('lookupCustomer', { phone: '+1' }),
      ),
    });
    const out = await runAgentLoop({
      ai,
      systemPrompt: 's',
      tools: { lookupCustomer: lookupTool },
      ctx,
      maxSteps: 3,
    });
    expect(out.outcome).toBe('max_steps');
  });

  it('accumulates costUsd across turns', async () => {
    const ai = stubAIClient({
      script: [toolUse('lookupCustomer', { phone: '+1' }), text('OK')],
    });
    const out = await runAgentLoop({
      ai,
      systemPrompt: 's',
      tools: { lookupCustomer: lookupTool },
      ctx,
    });
    // 0.001 + 0.0005 = 0.0015
    expect(out.totalCostUsd).toBeCloseTo(0.0015, 4);
  });
});
