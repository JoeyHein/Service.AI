/**
 * AIClient — the single narrow boundary between business code
 * and any LLM provider. The interface is intentionally minimal:
 * given a system prompt + message history + a tool schema, run a
 * single turn and return either an assistant text reply or a
 * tool_use request.
 *
 * Callers (the agent loop) handle the multi-turn orchestration —
 * this keeps tool execution policy, persistence, and guardrails
 * out of the provider adapter.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON-Schema-ish object; forwarded as-is to Anthropic. */
  inputSchema: Record<string, unknown>;
}

export interface AssistantTextTurn {
  role: 'assistant';
  kind: 'text';
  text: string;
  /** 0..1. Adapters populate this from their own proxy; the stub
   *  emits what the script says. */
  confidence: number;
  costUsd: number;
  provider: string;
  model: string;
}

export interface AssistantToolTurn {
  role: 'assistant';
  kind: 'tool_use';
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Assistant's optional surrounding prose — kept so the
   *  transcript preserves how the model led into the tool call. */
  text?: string;
  confidence: number;
  costUsd: number;
  provider: string;
  model: string;
}

export type AssistantTurn = AssistantTextTurn | AssistantToolTurn;

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface ToolResultMessage {
  role: 'tool_result';
  toolUseId: string;
  /** JSON-serialisable; forwarded as the string-ified tool
   *  response in the Anthropic payload. */
  result: unknown;
  isError?: boolean;
}

export type HistoryMessage = UserMessage | AssistantTurn | ToolResultMessage;

export interface AITurnInput {
  systemPrompt: string;
  history: HistoryMessage[];
  tools: ToolSchema[];
  /** Provider model override. Defaults to the adapter's choice. */
  model?: string;
}

export interface AIClient {
  turn(input: AITurnInput): Promise<AssistantTurn>;
}

// ---------------------------------------------------------------------------
// Stub
// ---------------------------------------------------------------------------

/**
 * Scripted stub AIClient used by tests. The script is a list of
 * assistant turns returned in order; the harness runs the loop
 * until it emits a `text` turn. When the script runs out, the
 * stub emits a terminal text turn so tests never hang.
 */
export function stubAIClient(opts: {
  script: AssistantTurn[];
  terminalText?: string;
}): AIClient {
  let idx = 0;
  return {
    async turn() {
      const next = opts.script[idx];
      idx += 1;
      if (next) return next;
      return {
        role: 'assistant',
        kind: 'text',
        text: opts.terminalText ?? 'Script exhausted.',
        confidence: 1,
        costUsd: 0,
        provider: 'stub',
        model: 'stub-1',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic adapter
// ---------------------------------------------------------------------------

interface AnthropicOpts {
  apiKey: string;
  defaultModel?: string;
}

/**
 * Real adapter wrapping @anthropic-ai/sdk. Maps our HistoryMessage
 * shape into Anthropic's expected role + content-block array, and
 * the provider's tool_use response back to AssistantTurn.
 *
 * Confidence: Anthropic does not emit a scalar, so we approximate
 * using a simple heuristic — 1.0 when a text reply is emitted, a
 * lower value when the model used a tool (tool use means it
 * wasn't confident enough to answer directly, so downstream
 * guardrails can gate). Tests override the stub's value directly.
 */
export function anthropicAIClient(opts: AnthropicOpts): AIClient {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const model = opts.defaultModel ?? 'claude-sonnet-4-6';
  return {
    async turn(input) {
      const messages = toAnthropicMessages(input.history);
      const resp = await client.messages.create({
        model: input.model ?? model,
        max_tokens: 1024,
        system: input.systemPrompt,
        tools: input.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Record<string, unknown> &
            { type: 'object' },
        })),
        messages,
      });
      const costUsd = estimateCostUsd(resp.usage);
      const blocks = resp.content;
      const toolBlock = blocks.find((b) => b.type === 'tool_use');
      const textBlock = blocks.find((b) => b.type === 'text');
      if (toolBlock && toolBlock.type === 'tool_use') {
        return {
          role: 'assistant',
          kind: 'tool_use',
          toolUseId: toolBlock.id,
          toolName: toolBlock.name,
          toolInput: toolBlock.input as Record<string, unknown>,
          text: textBlock && textBlock.type === 'text' ? textBlock.text : undefined,
          confidence: 0.75,
          costUsd,
          provider: 'anthropic',
          model: resp.model,
        };
      }
      return {
        role: 'assistant',
        kind: 'text',
        text:
          textBlock && textBlock.type === 'text'
            ? textBlock.text
            : '(no response)',
        confidence: 1,
        costUsd,
        provider: 'anthropic',
        model: resp.model,
      };
    },
  };
}

function toAnthropicMessages(
  history: HistoryMessage[],
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of history) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'tool_result') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolUseId,
            content: JSON.stringify(m.result),
            is_error: m.isError ?? false,
          },
        ],
      });
      continue;
    }
    // assistant: AssistantTurn (text or tool_use)
    if (m.kind === 'text') {
      out.push({ role: 'assistant', content: m.text });
    } else {
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      content.push({
        type: 'tool_use',
        id: m.toolUseId,
        name: m.toolName,
        input: m.toolInput,
      });
      out.push({ role: 'assistant', content });
    }
  }
  return out;
}

function estimateCostUsd(
  usage: Anthropic.Usage | null | undefined,
): number {
  if (!usage) return 0;
  // Rough Sonnet 4.6 pricing (dollars per million tokens).
  const inputPer1M = 3;
  const outputPer1M = 15;
  return (
    ((usage.input_tokens ?? 0) * inputPer1M +
      (usage.output_tokens ?? 0) * outputPer1M) /
    1_000_000
  );
}

/**
 * Env-driven resolver. Falls back to stub when ANTHROPIC_API_KEY
 * is missing so boot never depends on AI credentials. Tests
 * always construct `stubAIClient({ script })` directly.
 */
// ---------------------------------------------------------------------------
// Grok adapter (xAI) — VP-03. xAI is OpenAI-compatible, so we wrap the
// `openai` SDK pointed at api.x.ai/v1. Same AIClient contract as Anthropic.
// ---------------------------------------------------------------------------

interface GrokOpts {
  apiKey: string;
  defaultModel?: string;
  baseURL?: string;
}

export function grokAIClient(opts: GrokOpts): AIClient {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL ?? 'https://api.x.ai/v1',
  });
  const model = opts.defaultModel ?? 'grok-2-latest';
  return {
    async turn(input) {
      const messages = toOpenAIMessages(input.systemPrompt, input.history);
      const resp = await client.chat.completions.create({
        model: input.model ?? model,
        max_tokens: 1024,
        messages,
        tools: input.tools.map((t) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema as Record<string, unknown>,
          },
        })),
      });
      const choice = resp.choices[0];
      const msg = choice?.message;
      const toolCall = msg?.tool_calls?.[0];
      if (toolCall && toolCall.type === 'function') {
        let toolInput: Record<string, unknown> = {};
        try {
          toolInput = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          toolInput = {};
        }
        return {
          role: 'assistant',
          kind: 'tool_use',
          toolUseId: toolCall.id,
          toolName: toolCall.function.name,
          toolInput,
          text: msg?.content ?? undefined,
          confidence: 0.75,
          // xAI usage pricing differs from Anthropic; left at 0 until a
          // grok cost table is wired (the loop's budget guard still works
          // off the per-tool dollar caps, not this field).
          costUsd: 0,
          provider: 'xai',
          model: resp.model,
        };
      }
      return {
        role: 'assistant',
        kind: 'text',
        text: msg?.content ?? '(no response)',
        confidence: 1,
        costUsd: 0,
        provider: 'xai',
        model: resp.model,
      };
    },
  };
}

function toOpenAIMessages(
  systemPrompt: string,
  history: HistoryMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];
  for (const m of history) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'tool_result') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolUseId,
        content: typeof m.result === 'string' ? m.result : JSON.stringify(m.result),
      });
    } else if (m.kind === 'tool_use') {
      out.push({
        role: 'assistant',
        content: m.text ?? null,
        tool_calls: [
          {
            id: m.toolUseId,
            type: 'function',
            function: { name: m.toolName, arguments: JSON.stringify(m.toolInput) },
          },
        ],
      });
    } else {
      out.push({ role: 'assistant', content: m.text });
    }
  }
  return out;
}

export function resolveAIClient(): AIClient {
  // VP-03: opt into Grok via AI_PROVIDER=grok (default is Claude). Each is
  // gated on its own key; falls back to the stub when unconfigured (boot-safe).
  const provider = (process.env['AI_PROVIDER'] ?? 'claude').toLowerCase();
  if (provider === 'grok' || provider === 'xai') {
    const xaiKey = process.env['XAI_API_KEY'];
    if (xaiKey) return grokAIClient({ apiKey: xaiKey });
    return stubAIClient({ script: [] });
  }
  const key = process.env['ANTHROPIC_API_KEY'];
  if (!key) return stubAIClient({ script: [] });
  return anthropicAIClient({ apiKey: key });
}
