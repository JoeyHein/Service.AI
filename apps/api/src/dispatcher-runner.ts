/**
 * Dispatcher agent runner (TASK-DI-04).
 *
 * Wraps runAgentLoop with the dispatcher tools + scheduling
 * invariants. For every proposeAssignment the agent emits:
 *   1. Insert an ai_suggestions row (status=pending).
 *   2. If confidence >= threshold AND invariants pass, apply the
 *      assignment atomically + flip status to 'applied'.
 *   3. Otherwise leave as 'pending' for human review.
 *
 * Scheduling invariants (checked per-proposal before auto-apply):
 *   - Tech must not be double-booked in the proposed window
 *     across the franchisee's jobs.
 *   - When reasoning text contains a "requires:" clause like
 *     "requires: springs", the tech must carry that skill in
 *     tech_skills. (v1 heuristic — richer skill-matching lives
 *     on the job record in a future phase.)
 *   - Travel time from the tech's previous job's customer to
 *     the new job's customer must fit inside the gap before the
 *     proposed start (15-minute buffer baked in to be safe).
 *
 * Returns a structured summary the API handler forwards to the
 * caller + writes to ai_metrics.
 */

import { and, eq, gte, isNull, lt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  aiConversations,
  aiSuggestions,
  customers,
  franchisees,
  jobs,
  memberships,
  techSkills,
  withScope,
  type RequestScope,
  type ScopedTx,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import { runAgentLoop, type AIClient } from '@service-ai/ai';
import { dispatcherSystemPrompt } from '@service-ai/ai/prompts/dispatcher';
import {
  buildDispatcherToolSet,
  type ProposedAssignment,
} from './ai-tools/dispatcher-tools.js';
import {
  stubDistanceMatrixClient,
  type DistanceMatrixClient,
} from './distance-matrix.js';

type Drizzle = NodePgDatabase<typeof schema>;

const BUFFER_SECONDS = 15 * 60; // 15 minutes

export interface DispatcherRunnerDeps {
  db: Drizzle;
  ai: AIClient;
  distanceMatrix?: DistanceMatrixClient;
}

export interface DispatcherRunInput {
  scope: RequestScope;
  franchiseeId: string;
  /** Override threshold for this specific run. Defaults to the
   *  franchisee's ai_guardrails.dispatcherAutoApplyThreshold or
   *  0.8. */
  thresholdOverride?: number;
}

export interface DispatcherRunResult {
  conversationId: string;
  proposals: number;
  autoApplied: number;
  queued: number;
  suggestions: Array<{
    id: string;
    status: string;
    confidence: number;
    jobId: string;
    techUserId: string | null;
    rejectedInvariant?: string;
  }>;
}

function extractSkillFromReasoning(reasoning: string): string | null {
  const m = reasoning.match(/requires?:\s*([a-z0-9_-]+)/i);
  return m ? m[1]!.toLowerCase() : null;
}

async function invariantsPass(
  tx: ScopedTx,
  proposal: ProposedAssignment,
  franchiseeId: string,
  distanceMatrix: DistanceMatrixClient,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const start = new Date(proposal.scheduledStart);
  const end = proposal.scheduledEnd
    ? new Date(proposal.scheduledEnd)
    : new Date(start.getTime() + 60 * 60 * 1000); // default 1 hr

  // 1. No double-booking: any other job assigned to this tech whose
  // window overlaps [start, end).
  const overlapping = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.franchiseeId, franchiseeId),
        eq(jobs.assignedTechUserId, proposal.techUserId),
        isNull(jobs.deletedAt),
        lt(jobs.scheduledStart, end),
        gte(jobs.scheduledEnd, start),
      ),
    );
  if (overlapping.length > 0) {
    return { ok: false, reason: 'double_booked' };
  }

  // 2. Skill match when reasoning declares a required skill.
  const requiredSkill = extractSkillFromReasoning(proposal.reasoning);
  if (requiredSkill) {
    const hasSkill = await tx
      .select({ u: techSkills.userId })
      .from(techSkills)
      .where(
        and(
          eq(techSkills.userId, proposal.techUserId),
          eq(techSkills.franchiseeId, franchiseeId),
          eq(techSkills.skill, requiredSkill),
        ),
      );
    if (hasSkill.length === 0) {
      return { ok: false, reason: `missing_skill:${requiredSkill}` };
    }
  }

  // 3. Travel time fit: find the tech's most recent prior job on
  // the same day, compute travel from its customer to the
  // proposed customer, and verify it fits in the gap minus buffer.
  const dayStart = new Date(
    Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate(),
      0, 0, 0, 0,
    ),
  );
  const prior = await tx
    .select({
      id: jobs.id,
      scheduledEnd: jobs.scheduledEnd,
      custLat: customers.latitude,
      custLng: customers.longitude,
    })
    .from(jobs)
    .leftJoin(customers, eq(customers.id, jobs.customerId))
    .where(
      and(
        eq(jobs.franchiseeId, franchiseeId),
        eq(jobs.assignedTechUserId, proposal.techUserId),
        isNull(jobs.deletedAt),
        gte(jobs.scheduledStart, dayStart),
        lt(jobs.scheduledStart, start),
      ),
    )
    .orderBy(jobs.scheduledStart);
  const priorLast = prior[prior.length - 1];
  if (priorLast?.custLat && priorLast?.custLng && priorLast.scheduledEnd) {
    const targetCustRow = await tx
      .select({
        custLat: customers.latitude,
        custLng: customers.longitude,
      })
      .from(jobs)
      .leftJoin(customers, eq(customers.id, jobs.customerId))
      .where(eq(jobs.id, proposal.jobId));
    const tgt = targetCustRow[0];
    if (tgt?.custLat && tgt?.custLng) {
      const travel = await distanceMatrix.estimate(
        { lat: Number(priorLast.custLat), lng: Number(priorLast.custLng) },
        { lat: Number(tgt.custLat), lng: Number(tgt.custLng) },
      );
      const gap = Math.floor(
        (start.getTime() - priorLast.scheduledEnd.getTime()) / 1000,
      );
      if (gap < travel.durationSeconds + BUFFER_SECONDS) {
        return { ok: false, reason: 'travel_budget_exceeded' };
      }
    }
  }

  return { ok: true };
}

/**
 * Apply a proposal: mark the suggestion 'applied' + update the
 * underlying job. Runs inside the caller's transaction.
 */
async function applyProposal(
  tx: ScopedTx,
  suggestionId: string,
  proposal: ProposedAssignment,
  actorUserId: string | null,
): Promise<void> {
  const now = new Date();
  await tx
    .update(jobs)
    .set({
      assignedTechUserId: proposal.techUserId,
      scheduledStart: new Date(proposal.scheduledStart),
      scheduledEnd: proposal.scheduledEnd
        ? new Date(proposal.scheduledEnd)
        : null,
      status: 'scheduled',
      updatedAt: now,
    })
    .where(eq(jobs.id, proposal.jobId));
  await tx
    .update(aiSuggestions)
    .set({
      status: 'applied',
      decidedAt: now,
      decidedByUserId: actorUserId,
      updatedAt: now,
    })
    .where(eq(aiSuggestions.id, suggestionId));
}

export async function runDispatcher(
  deps: DispatcherRunnerDeps,
  input: DispatcherRunInput,
): Promise<DispatcherRunResult> {
  const distanceMatrix = deps.distanceMatrix ?? stubDistanceMatrixClient;
  const captured: ProposedAssignment[] = [];

  // 1. Create the conversation row + resolve the franchisee's
  // guardrails.
  const { franchisee, conversationId } = await withScope(
    deps.db,
    input.scope,
    async (tx) => {
      const feRows = await tx
        .select()
        .from(franchisees)
        .where(eq(franchisees.id, input.franchiseeId));
      if (!feRows[0]) {
        throw new Error(`Franchisee ${input.franchiseeId} not found`);
      }
      const conv = await tx
        .insert(aiConversations)
        .values({
          franchiseeId: input.franchiseeId,
          capability: 'dispatcher',
        })
        .returning();
      return { franchisee: feRows[0], conversationId: conv[0]!.id };
    },
  );

  const guardrails = (franchisee.aiGuardrails ?? {}) as {
    dispatcherAutoApplyThreshold?: number;
  };
  const threshold =
    input.thresholdOverride ?? guardrails.dispatcherAutoApplyThreshold ?? 0.8;

  // 2. Run the agent loop.
  const toolDeps = {
    db: deps.db,
    distanceMatrix,
    captured: { proposals: captured },
    async runScoped<T>(fn: (tx: ScopedTx) => Promise<T>) {
      return withScope(deps.db, input.scope, fn);
    },
  };
  const tools = buildDispatcherToolSet(toolDeps);

  await runAgentLoop({
    ai: deps.ai,
    systemPrompt: dispatcherSystemPrompt({
      brandName: 'Service.AI',
      franchiseeName: franchisee.name,
    }),
    initialUserMessage:
      'Start: list unassigned jobs, then propose assignments.',
    tools,
    ctx: {
      franchiseeId: input.franchiseeId,
      userId: input.scope.userId,
      guardrails: {
        confidenceThreshold: threshold,
        undoWindowSeconds: 900,
        transferOnLowConfidence: false,
      },
      invocation: { confidence: 1 },
    },
    maxSteps: 40,
  });

  // 3. Persist + decide per proposal.
  const outcomes: DispatcherRunResult['suggestions'] = [];
  let autoApplied = 0;
  let queued = 0;

  for (const proposal of captured) {
    const persisted = await withScope(deps.db, input.scope, async (tx) => {
      const inv = await invariantsPass(
        tx,
        proposal,
        input.franchiseeId,
        distanceMatrix,
      );
      const shouldAutoApply =
        inv.ok && proposal.confidence >= threshold;
      const status = shouldAutoApply ? 'applied' : 'pending';
      const row = await tx
        .insert(aiSuggestions)
        .values({
          franchiseeId: input.franchiseeId,
          conversationId,
          kind: 'assignment',
          subjectJobId: proposal.jobId,
          proposedTechUserId: proposal.techUserId,
          proposedScheduledStart: new Date(proposal.scheduledStart),
          proposedScheduledEnd: proposal.scheduledEnd
            ? new Date(proposal.scheduledEnd)
            : null,
          reasoning: proposal.reasoning,
          confidence: proposal.confidence.toFixed(4),
          status,
        })
        .returning();
      if (shouldAutoApply) {
        await applyProposal(tx, row[0]!.id, proposal, null);
      }
      return {
        id: row[0]!.id,
        status: shouldAutoApply ? 'applied' : 'pending',
        rejectedInvariant: inv.ok ? undefined : inv.reason,
      };
    });
    outcomes.push({
      id: persisted.id,
      status: persisted.status,
      confidence: proposal.confidence,
      jobId: proposal.jobId,
      techUserId: proposal.techUserId,
      rejectedInvariant: persisted.rejectedInvariant,
    });
    if (persisted.status === 'applied') autoApplied += 1;
    else queued += 1;
  }

  // 4. Close out the conversation.
  await withScope(deps.db, input.scope, async (tx) => {
    await tx
      .update(aiConversations)
      .set({ endedAt: new Date(), updatedAt: new Date() })
      .where(eq(aiConversations.id, conversationId));
  });

  // Touch untouched imports so eslint doesn't flag them later.
  void memberships;

  return {
    conversationId,
    proposals: captured.length,
    autoApplied,
    queued,
    suggestions: outcomes,
  };
}
