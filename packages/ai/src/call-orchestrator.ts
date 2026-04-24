/**
 * Per-call orchestrator (TASK-CV-05).
 *
 * Glues ASR → agent loop → TTS → call_sessions persistence.
 * Exposed as a class so the WS handler just instantiates it,
 * calls `start`, and forwards Twilio Media Streams frames.
 *
 * The orchestrator is deliberately framework-agnostic — it knows
 * nothing about Fastify or WS. The WS route pushes µ-law frames
 * into `pushAudio` and listens on `onTtsFrame` for outbound
 * audio. This keeps the loop testable without a real WebSocket.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import {
  aiConversations,
  aiMessages,
  callSessions,
} from '@service-ai/db';
import type * as schema from '@service-ai/db';
import {
  runAgentLoop,
  type AIClient,
  type Tool,
  type ToolContext,
  type AgentTranscriptEntry,
} from '@service-ai/ai';
import { csrSystemPrompt } from '@service-ai/ai/prompts/csr';
import type { AsrClient, AsrEvent } from './asr.js';
import type { TtsClient } from './tts.js';
import type { ResolvedCallTenant } from './call-context.js';

type Drizzle = NodePgDatabase<typeof schema>;

export interface OrchestratorOpts {
  db: Drizzle;
  ai: AIClient;
  asr: AsrClient;
  tts: TtsClient;
  buildTools: (opts: {
    conversationId: string;
    tenant: ResolvedCallTenant;
  }) => Record<string, Tool>;
  gatedTools?: string[];
  /** Twilio CallSid. */
  callSid: string;
  tenant: ResolvedCallTenant;
  fromE164: string;
  toE164: string;
  /** Optional deterministic ASR script key — forwards to the ASR
   *  stub so tests can reproduce full conversations by id. */
  audioId?: string;
  /** Called for each outbound µ-law frame. The WS handler sends
   *  these back to Twilio via the Media Streams `media` event. */
  onTtsFrame?: (frame: Buffer) => void;
  /** Called when the agent's final TTS finishes — the WS handler
   *  closes the Twilio stream. */
  onComplete?: (outcome: OrchestratorResult) => void;
}

export interface OrchestratorResult {
  callSessionId: string;
  conversationId: string;
  outcome: 'booked' | 'transferred' | 'abandoned' | 'none';
  transcript: AgentTranscriptEntry[];
  totalCostUsd: number;
}

/**
 * The state machine we want:
 *   1. On construct: insert ai_conversations + call_sessions rows.
 *   2. On start(): open the ASR session, register the final-transcript
 *      callback that runs one agent turn.
 *   3. Agent emits text → speak it through TTS → pushAudio back out.
 *   4. Agent emits tool_use → loop handles it → cycle continues.
 *   5. On stop(): close ASR, flush DB, fire onComplete.
 *
 * For phase 9 we use a simplified "turn per final transcript"
 * model — each final transcript from the ASR = one user message
 * fed into runAgentLoop. A real barge-in / interruption model
 * lands with phase_ai_dispatcher (phase 10). Phase 9's happy
 * path: caller speaks, agent replies, rinse/repeat.
 */
export class CallOrchestrator {
  private opts: OrchestratorOpts;
  private conversationId: string | null = null;
  private callSessionId: string | null = null;
  private outcome: OrchestratorResult['outcome'] = 'none';
  private transcript: AgentTranscriptEntry[] = [];
  private totalCostUsd = 0;
  private stopped = false;
  private active: Promise<unknown> | null = null;

  constructor(opts: OrchestratorOpts) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    // Create conversation + call_session rows.
    const convRows = await this.opts.db
      .insert(aiConversations)
      .values({
        franchiseeId: this.opts.tenant.franchiseeId,
        capability: 'csr.voice',
      })
      .returning();
    this.conversationId = convRows[0]!.id;
    const csRows = await this.opts.db
      .insert(callSessions)
      .values({
        franchiseeId: this.opts.tenant.franchiseeId,
        conversationId: this.conversationId,
        twilioCallSid: this.opts.callSid,
        fromE164: this.opts.fromE164,
        toE164: this.opts.toE164,
        direction: 'inbound',
        status: 'in_progress',
      })
      .returning();
    this.callSessionId = csRows[0]!.id;
  }

  /**
   * Drive the call deterministically: for each final transcript
   * from the ASR, run one agent turn and speak its reply. Returns
   * when the agent signals completion (text turn) or the ASR
   * script is exhausted.
   */
  async run(): Promise<OrchestratorResult> {
    if (!this.conversationId || !this.callSessionId) {
      throw new Error('CallOrchestrator.run() before start()');
    }
    const session = await this.opts.asr.open({ audioId: this.opts.audioId });
    const finals: string[] = [];
    session.onEvent((e: AsrEvent) => {
      if (e.kind === 'final') finals.push(e.text);
    });
    // Tests push audio synchronously; production streams over WS.
    // Either way, we pull `finals` out and call the agent.
    // One-shot greet: open with a greeting first, so test
    // assertions on the first message are well-defined.
    const tools = this.opts.buildTools({
      conversationId: this.conversationId,
      tenant: this.opts.tenant,
    });
    const ctx: ToolContext = {
      franchiseeId: this.opts.tenant.franchiseeId,
      userId: null,
      guardrails: this.opts.tenant.guardrails,
      invocation: { confidence: 1 },
    };
    const systemPrompt = csrSystemPrompt({
      brandName: this.opts.tenant.franchiseeName,
    });

    // Aggregate the full call into a single agent session. The
    // initial user message concatenates every final transcript
    // the ASR surfaced. Phase 10 switches to a turn-per-utterance
    // pump; phase 9's test is "give the agent everything and
    // watch it book" which is enough to verify the plumbing.
    const initial = finals.join(' ').trim();
    const result = await runAgentLoop({
      ai: this.opts.ai,
      systemPrompt,
      initialUserMessage: initial || 'Hello',
      tools,
      ctx,
      gatedTools: this.opts.gatedTools,
      transferToolName: 'transferToHuman',
    });
    this.transcript = result.transcript;
    this.totalCostUsd = result.totalCostUsd;
    // Map outcome.
    const loggedOutcome = result.transcript
      .filter((t) => t.role === 'tool' && t.tool?.name === 'logCallSummary')
      .map((t) => t.tool!.input.outcome as string)
      .pop();
    if (result.outcome === 'transferred') this.outcome = 'transferred';
    else if (loggedOutcome === 'booked') this.outcome = 'booked';
    else if (loggedOutcome === 'transferred') this.outcome = 'transferred';
    else this.outcome = 'none';

    // Persist transcript as ai_messages rows. Collapse the entries
    // into shape the schema accepts — assistant turns become one
    // row, tool calls become one `tool` row.
    for (const entry of result.transcript) {
      if (entry.role === 'assistant' && entry.turn) {
        await this.opts.db.insert(aiMessages).values({
          conversationId: this.conversationId,
          franchiseeId: this.opts.tenant.franchiseeId,
          role: 'assistant',
          content:
            entry.turn.kind === 'text'
              ? { text: entry.turn.text }
              : {
                  text: entry.turn.text ?? null,
                  toolUseId: entry.turn.toolUseId,
                },
          toolName: entry.turn.kind === 'tool_use' ? entry.turn.toolName : null,
          toolInput:
            entry.turn.kind === 'tool_use' ? entry.turn.toolInput : null,
          confidence: String(entry.turn.confidence),
          costUsd: entry.turn.costUsd.toFixed(6),
          provider: entry.turn.provider,
          model: entry.turn.model,
        });
      } else if (entry.role === 'tool' && entry.tool) {
        await this.opts.db.insert(aiMessages).values({
          conversationId: this.conversationId,
          franchiseeId: this.opts.tenant.franchiseeId,
          role: 'tool',
          content: { ok: entry.tool.result.ok },
          toolName: entry.tool.name,
          toolInput: entry.tool.input,
          toolOutput: entry.tool.result.data ?? entry.tool.result.error ?? null,
        });
      }
    }

    // Speak the final text through TTS.
    if (this.opts.onTtsFrame) {
      const stream = this.opts.tts.speak({ text: result.finalText });
      for await (const frame of stream.chunks) {
        if (this.stopped) break;
        this.opts.onTtsFrame(frame);
      }
      await stream.done;
    }

    // Close call_session.
    await this.opts.db
      .update(callSessions)
      .set({
        status: this.outcome === 'transferred' ? 'transferred' : 'completed',
        outcome: this.outcome,
        endedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(callSessions.id, this.callSessionId));
    await this.opts.db
      .update(aiConversations)
      .set({ endedAt: new Date(), updatedAt: new Date() })
      .where(eq(aiConversations.id, this.conversationId));

    await session.close();

    const final: OrchestratorResult = {
      callSessionId: this.callSessionId,
      conversationId: this.conversationId,
      outcome: this.outcome,
      transcript: this.transcript,
      totalCostUsd: this.totalCostUsd,
    };
    this.opts.onComplete?.(final);
    return final;
  }

  /** Called by the WS handler for each inbound Twilio media frame. */
  pushAudio(frame: Buffer): void {
    // The orchestrator doesn't expose the ASR session directly —
    // the WS handler uses the `asr` adapter it passed in to keep
    // one pipe per call. This method is a façade for a future
    // barge-in pump.
    void frame;
  }

  stop(): void {
    this.stopped = true;
    void this.active;
  }
}
