import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

import { grokAIClient } from './client.js';
import type { HistoryMessage } from './client.js';

beforeEach(() => createMock.mockReset());

describe('grokAIClient', () => {
  it('maps a text completion to a text turn', async () => {
    createMock.mockResolvedValue({
      model: 'grok-2-latest',
      choices: [{ message: { content: 'How can I help?', tool_calls: undefined } }],
    });
    const turn = await grokAIClient({ apiKey: 'xai' }).turn({
      systemPrompt: 'sys',
      history: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    expect(turn.kind).toBe('text');
    if (turn.kind === 'text') {
      expect(turn.text).toBe('How can I help?');
      expect(turn.provider).toBe('xai');
    }
  });

  it('maps a tool_call to a tool_use turn with parsed input', async () => {
    createMock.mockResolvedValue({
      model: 'grok-2-latest',
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: 'tc_1', type: 'function', function: { name: 'bookJob', arguments: '{"slot":"9am"}' } },
            ],
          },
        },
      ],
    });
    const turn = await grokAIClient({ apiKey: 'xai' }).turn({
      systemPrompt: 'sys',
      history: [{ role: 'user', content: 'book me in' }],
      tools: [{ name: 'bookJob', description: 'b', inputSchema: { type: 'object' } }],
    });
    expect(turn.kind).toBe('tool_use');
    if (turn.kind === 'tool_use') {
      expect(turn.toolName).toBe('bookJob');
      expect(turn.toolUseId).toBe('tc_1');
      expect(turn.toolInput).toEqual({ slot: '9am' });
    }
  });

  it('translates history (tool_use + tool_result) into OpenAI message shape', async () => {
    createMock.mockResolvedValue({
      model: 'grok-2-latest',
      choices: [{ message: { content: 'done' } }],
    });
    const history: HistoryMessage[] = [
      { role: 'user', content: 'schedule it' },
      {
        role: 'assistant',
        kind: 'tool_use',
        toolUseId: 'tc_9',
        toolName: 'bookJob',
        toolInput: { slot: '10am' },
        confidence: 0.75,
        costUsd: 0,
        provider: 'xai',
        model: 'grok-2-latest',
      },
      { role: 'tool_result', toolUseId: 'tc_9', result: { ok: true } },
    ];
    await grokAIClient({ apiKey: 'xai' }).turn({ systemPrompt: 'sys', history, tools: [] });

    const sent = createMock.mock.calls[0]![0] as {
      messages: Array<{ role: string; tool_call_id?: string; tool_calls?: unknown[] }>;
    };
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(sent.messages[1]).toEqual({ role: 'user', content: 'schedule it' });
    expect(sent.messages[2]!.role).toBe('assistant');
    expect(sent.messages[2]!.tool_calls).toHaveLength(1);
    expect(sent.messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'tc_9',
      content: JSON.stringify({ ok: true }),
    });
  });
});
