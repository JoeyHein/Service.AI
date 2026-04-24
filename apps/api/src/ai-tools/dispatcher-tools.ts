/**
 * Concrete dispatcher agent tool implementations (TASK-DI-03).
 *
 * Each tool runs against the scoped Drizzle db. Tenant scope is
 * enforced at the tool boundary — cross-franchisee arguments
 * return INVALID_TARGET (never throw) so the agent loop feeds
 * the failure back as a tool_result.
 */

import { and, eq, gte, isNull, lt, desc } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  customers,
  jobs,
  memberships,
  techSkills,
  users,
  type ScopedTx,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { Tool, ToolResult } from '@service-ai/ai';
import type { DistanceMatrixClient, LatLng } from '../distance-matrix.js';

type Drizzle = NodePgDatabase<typeof schema>;

export interface DispatcherToolDeps {
  db: Drizzle;
  runScoped: <T>(fn: (tx: ScopedTx) => Promise<T>) => Promise<T>;
  distanceMatrix: DistanceMatrixClient;
  /** Captured by proposeAssignment so the runner can consume it
   *  without parsing the agent transcript after the fact. */
  captured: {
    proposals: ProposedAssignment[];
  };
}

export interface ProposedAssignment {
  jobId: string;
  techUserId: string;
  scheduledStart: string;
  scheduledEnd?: string | null;
  reasoning: string;
  confidence: number;
  /** Set by the runner when a dispatcher override is applied. */
  status?: 'pending' | 'applied';
}

function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}
function err(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message } };
}

// ---------------------------------------------------------------------------
// listUnassignedJobs
// ---------------------------------------------------------------------------

export function listUnassignedJobsTool(deps: DispatcherToolDeps): Tool<{
  limit?: number;
}> {
  return {
    schema: {
      name: 'listUnassignedJobs',
      description:
        'List unassigned + not-deleted jobs for the franchisee. Includes customer location when set. Results are ordered by scheduled_start (nulls last).',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', minimum: 1, maximum: 200 },
        },
      },
    },
    async execute(input, ctx) {
      const limit = Math.min(Math.max(input.limit ?? 20, 1), 200);
      const rows = await deps.runScoped(async (tx) => {
        return tx
          .select({
            id: jobs.id,
            title: jobs.title,
            description: jobs.description,
            customerId: jobs.customerId,
            scheduledStart: jobs.scheduledStart,
            scheduledEnd: jobs.scheduledEnd,
            customerName: customers.name,
            customerLat: customers.latitude,
            customerLng: customers.longitude,
          })
          .from(jobs)
          .leftJoin(customers, eq(customers.id, jobs.customerId))
          .where(
            and(
              eq(jobs.franchiseeId, ctx.franchiseeId),
              eq(jobs.status, 'unassigned'),
              isNull(jobs.deletedAt),
            ),
          )
          .limit(limit);
      });
      return ok({
        jobs: rows.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          customerId: r.customerId,
          customerName: r.customerName,
          latitude: r.customerLat == null ? null : Number(r.customerLat),
          longitude: r.customerLng == null ? null : Number(r.customerLng),
          scheduledStart: r.scheduledStart,
          scheduledEnd: r.scheduledEnd,
        })),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// listTechs
// ---------------------------------------------------------------------------

export function listTechsTool(deps: DispatcherToolDeps): Tool<{
  skill?: string;
}> {
  return {
    schema: {
      name: 'listTechs',
      description:
        'List active tech memberships for the franchisee. If `skill` is provided, filters to techs who carry that skill.',
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string' },
        },
      },
    },
    async execute(input, ctx) {
      const rows = await deps.runScoped(async (tx) => {
        const base = await tx
          .select({
            userId: memberships.userId,
            name: users.name,
            email: users.email,
          })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.scopeType, 'franchisee'),
              eq(memberships.scopeId, ctx.franchiseeId),
              eq(memberships.role, 'tech'),
              isNull(memberships.deletedAt),
            ),
          );
        if (!input.skill) return base;
        const skilled = await tx
          .select({ userId: techSkills.userId })
          .from(techSkills)
          .where(
            and(
              eq(techSkills.franchiseeId, ctx.franchiseeId),
              eq(techSkills.skill, input.skill),
            ),
          );
        const ids = new Set(skilled.map((s) => s.userId));
        return base.filter((t) => ids.has(t.userId));
      });
      return ok({ techs: rows });
    },
  };
}

// ---------------------------------------------------------------------------
// getTechCurrentLoad
// ---------------------------------------------------------------------------

export function getTechCurrentLoadTool(deps: DispatcherToolDeps): Tool<{
  techUserId: string;
  /** Date boundary (YYYY-MM-DD) in UTC; defaults to today UTC. */
  date?: string;
}> {
  return {
    schema: {
      name: 'getTechCurrentLoad',
      description:
        'Return the tech\'s current load for the given date: count of scheduled + in_progress jobs and the most recent job\'s end time + location.',
      inputSchema: {
        type: 'object',
        required: ['techUserId'],
        properties: {
          techUserId: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
        },
      },
    },
    async execute(input, ctx) {
      // Validate the tech belongs to the franchisee.
      const okTech = await deps.runScoped(async (tx) => {
        const rows = await tx
          .select()
          .from(memberships)
          .where(
            and(
              eq(memberships.userId, input.techUserId),
              eq(memberships.scopeType, 'franchisee'),
              eq(memberships.scopeId, ctx.franchiseeId),
              eq(memberships.role, 'tech'),
              isNull(memberships.deletedAt),
            ),
          );
        return rows.length > 0;
      });
      if (!okTech)
        return err('INVALID_TARGET', 'Tech not found in this franchisee');

      const day = input.date ? new Date(`${input.date}T00:00:00Z`) : new Date();
      const dayStart = new Date(
        Date.UTC(
          day.getUTCFullYear(),
          day.getUTCMonth(),
          day.getUTCDate(),
          0, 0, 0, 0,
        ),
      );
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

      const rows = await deps.runScoped(async (tx) => {
        return tx
          .select({
            id: jobs.id,
            status: jobs.status,
            scheduledStart: jobs.scheduledStart,
            scheduledEnd: jobs.scheduledEnd,
            customerLat: customers.latitude,
            customerLng: customers.longitude,
          })
          .from(jobs)
          .leftJoin(customers, eq(customers.id, jobs.customerId))
          .where(
            and(
              eq(jobs.franchiseeId, ctx.franchiseeId),
              eq(jobs.assignedTechUserId, input.techUserId),
              gte(jobs.scheduledStart, dayStart),
              lt(jobs.scheduledStart, dayEnd),
              isNull(jobs.deletedAt),
            ),
          )
          .orderBy(desc(jobs.scheduledStart));
      });
      const activeCount = rows.filter(
        (r) => r.status === 'scheduled' || r.status === 'in_progress',
      ).length;
      const last = rows[0];
      return ok({
        activeCount,
        jobs: rows.length,
        lastEndAt: last?.scheduledEnd ?? null,
        lastLat: last?.customerLat == null ? null : Number(last.customerLat),
        lastLng: last?.customerLng == null ? null : Number(last.customerLng),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// computeTravelTime
// ---------------------------------------------------------------------------

export function computeTravelTimeTool(deps: DispatcherToolDeps): Tool<{
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
}> {
  return {
    schema: {
      name: 'computeTravelTime',
      description:
        'Compute driving travel time + distance between two lat/lng pairs.',
      inputSchema: {
        type: 'object',
        required: ['fromLat', 'fromLng', 'toLat', 'toLng'],
        properties: {
          fromLat: { type: 'number' },
          fromLng: { type: 'number' },
          toLat: { type: 'number' },
          toLng: { type: 'number' },
        },
      },
    },
    async execute(input) {
      const origin: LatLng = { lat: input.fromLat, lng: input.fromLng };
      const dest: LatLng = { lat: input.toLat, lng: input.toLng };
      const estimate = await deps.distanceMatrix.estimate(origin, dest);
      return ok(estimate);
    },
  };
}

// ---------------------------------------------------------------------------
// proposeAssignment (captured — no DB write)
// ---------------------------------------------------------------------------

export function proposeAssignmentTool(
  deps: DispatcherToolDeps,
): Tool<{
  jobId: string;
  techUserId: string;
  scheduledStart: string;
  scheduledEnd?: string;
  reasoning: string;
  confidence: number;
}> {
  return {
    schema: {
      name: 'proposeAssignment',
      description:
        'Propose assigning a job to a tech at a specific time. Does not write to the DB — the runner records the proposal and decides whether to auto-apply or queue for human review.',
      inputSchema: {
        type: 'object',
        required: ['jobId', 'techUserId', 'scheduledStart', 'reasoning', 'confidence'],
        properties: {
          jobId: { type: 'string' },
          techUserId: { type: 'string' },
          scheduledStart: { type: 'string' },
          scheduledEnd: { type: 'string' },
          reasoning: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    async execute(input, ctx) {
      // Validate that the job + tech belong to this franchisee so
      // the agent can't propose a cross-tenant assignment.
      const check = await deps.runScoped(async (tx) => {
        const jobRows = await tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.id, input.jobId),
              eq(jobs.franchiseeId, ctx.franchiseeId),
              isNull(jobs.deletedAt),
            ),
          );
        if (jobRows.length === 0) return 'bad_job' as const;
        const techRows = await tx
          .select({ id: memberships.userId })
          .from(memberships)
          .where(
            and(
              eq(memberships.userId, input.techUserId),
              eq(memberships.scopeType, 'franchisee'),
              eq(memberships.scopeId, ctx.franchiseeId),
              eq(memberships.role, 'tech'),
              isNull(memberships.deletedAt),
            ),
          );
        if (techRows.length === 0) return 'bad_tech' as const;
        return 'ok' as const;
      });
      if (check === 'bad_job')
        return err('INVALID_TARGET', 'Job not found in this franchisee');
      if (check === 'bad_tech')
        return err('INVALID_TARGET', 'Tech not found in this franchisee');

      const proposal: ProposedAssignment = {
        jobId: input.jobId,
        techUserId: input.techUserId,
        scheduledStart: input.scheduledStart,
        scheduledEnd: input.scheduledEnd ?? null,
        reasoning: input.reasoning,
        confidence: input.confidence,
        status: 'pending',
      };
      deps.captured.proposals.push(proposal);
      return ok({ captured: true });
    },
  };
}

// ---------------------------------------------------------------------------
// applyAssignment (used by suggestion-approve endpoint, not the agent)
// ---------------------------------------------------------------------------

export function applyAssignmentTool(deps: DispatcherToolDeps): Tool<{
  jobId: string;
  techUserId: string;
  scheduledStart: string;
  scheduledEnd?: string;
}> {
  return {
    schema: {
      name: 'applyAssignment',
      description:
        'Immediately assign a tech to a job at a specific time. This writes to the DB. The dispatcher agent should prefer proposeAssignment; use applyAssignment only when acting as the runner.',
      inputSchema: {
        type: 'object',
        required: ['jobId', 'techUserId', 'scheduledStart'],
        properties: {
          jobId: { type: 'string' },
          techUserId: { type: 'string' },
          scheduledStart: { type: 'string' },
          scheduledEnd: { type: 'string' },
        },
      },
    },
    async execute(input, ctx) {
      const result = await deps.runScoped(async (tx) => {
        const jobRows = await tx
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.id, input.jobId),
              eq(jobs.franchiseeId, ctx.franchiseeId),
              isNull(jobs.deletedAt),
            ),
          );
        if (jobRows.length === 0) return 'bad_job' as const;
        const techRows = await tx
          .select()
          .from(memberships)
          .where(
            and(
              eq(memberships.userId, input.techUserId),
              eq(memberships.scopeType, 'franchisee'),
              eq(memberships.scopeId, ctx.franchiseeId),
              eq(memberships.role, 'tech'),
              isNull(memberships.deletedAt),
            ),
          );
        if (techRows.length === 0) return 'bad_tech' as const;
        const now = new Date();
        const updated = await tx
          .update(jobs)
          .set({
            assignedTechUserId: input.techUserId,
            scheduledStart: new Date(input.scheduledStart),
            scheduledEnd: input.scheduledEnd
              ? new Date(input.scheduledEnd)
              : null,
            status: 'scheduled',
            updatedAt: now,
          })
          .where(eq(jobs.id, input.jobId))
          .returning();
        return { kind: 'ok' as const, job: updated[0]! };
      });
      if (result === 'bad_job')
        return err('INVALID_TARGET', 'Job not found in this franchisee');
      if (result === 'bad_tech')
        return err('INVALID_TARGET', 'Tech not found in this franchisee');
      return ok({
        jobId: result.job.id,
        techUserId: result.job.assignedTechUserId,
        status: result.job.status,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Tool set builder
// ---------------------------------------------------------------------------

export function buildDispatcherToolSet(
  deps: DispatcherToolDeps,
): Record<string, Tool> {
  return {
    listUnassignedJobs: listUnassignedJobsTool(deps),
    listTechs: listTechsTool(deps),
    getTechCurrentLoad: getTechCurrentLoadTool(deps),
    computeTravelTime: computeTravelTimeTool(deps),
    proposeAssignment: proposeAssignmentTool(deps),
    applyAssignment: applyAssignmentTool(deps),
  };
}
