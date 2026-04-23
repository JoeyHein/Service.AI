/**
 * Assignment endpoints + EventBus publication (TASK-DB-02).
 *
 *   POST /api/v1/jobs/:id/assign    body { assignedTechUserId,
 *                                        scheduledStart?, scheduledEnd? }
 *   POST /api/v1/jobs/:id/unassign  no body
 *
 * On assign, if the job was `unassigned` it also transitions to
 * `scheduled` and writes a job_status_log row — the assignment +
 * transition happen in one transaction so state can't drift.
 *
 * Publishes `job.assigned` (and `job.transitioned` when the side-
 * effect fires) events via the injected EventBus. Event payloads
 * carry ids only; recipients fetch details via /api/v1/jobs/:id which
 * is already scope-filtered.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  jobs,
  jobStatusLog,
  memberships,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { EventBus } from './event-bus.js';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AssignSchema = z.object({
  assignedTechUserId: z.string().min(1),
  scheduledStart: z.string().datetime().nullable().optional(),
  scheduledEnd: z.string().datetime().nullable().optional(),
});

function scopedFranchiseeId(scope: RequestScope): string | null {
  if (scope.type === 'platform' || scope.type === 'franchisor') return null;
  return scope.franchiseeId;
}

export function registerAssignmentRoutes(
  app: FastifyInstance,
  db: Drizzle,
  bus: EventBus,
): void {
  app.post<{ Params: { id: string } }>(
    '/api/v1/jobs/:id/assign',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const parsed = AssignSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;
      const outcome = await withScope(db, scope, async (tx) => {
        const jobRows = await tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.id, req.params.id), isNull(jobs.deletedAt)));
        const job = jobRows[0];
        if (!job) return { kind: 'not_found' as const };
        const feScope = scopedFranchiseeId(scope);
        if (feScope && job.franchiseeId !== feScope)
          return { kind: 'not_found' as const };
        if (scope.type === 'franchisor') {
          const feRows = await tx
            .select({ franchisorId: schema.franchisees.franchisorId })
            .from(schema.franchisees)
            .where(eq(schema.franchisees.id, job.franchiseeId));
          if (feRows[0]?.franchisorId !== scope.franchisorId)
            return { kind: 'not_found' as const };
        }

        // Validate the tech belongs to this job's franchisee and has the
        // 'tech' role. Check against the memberships table rather than
        // users because a user can have multiple memberships, and we
        // only care about the one in this franchisee.
        const techRows = await tx
          .select({
            userId: memberships.userId,
            role: memberships.role,
          })
          .from(memberships)
          .where(
            and(
              eq(memberships.userId, parsed.data.assignedTechUserId),
              eq(memberships.franchiseeId, job.franchiseeId),
              isNull(memberships.deletedAt),
            ),
          );
        const techMembership = techRows.find((r) => r.role === 'tech');
        if (!techMembership) {
          return { kind: 'invalid_tech' as const };
        }

        const becomingScheduled = job.status === 'unassigned';
        const now = new Date();
        const values: Record<string, unknown> = {
          assignedTechUserId: parsed.data.assignedTechUserId,
          updatedAt: now,
        };
        if (parsed.data.scheduledStart !== undefined)
          values.scheduledStart = parsed.data.scheduledStart
            ? new Date(parsed.data.scheduledStart)
            : null;
        if (parsed.data.scheduledEnd !== undefined)
          values.scheduledEnd = parsed.data.scheduledEnd
            ? new Date(parsed.data.scheduledEnd)
            : null;
        if (becomingScheduled) values.status = 'scheduled';
        const updated = await tx
          .update(jobs)
          .set(values)
          .where(eq(jobs.id, req.params.id))
          .returning();
        if (becomingScheduled) {
          await tx.insert(jobStatusLog).values({
            jobId: req.params.id,
            franchiseeId: job.franchiseeId,
            fromStatus: 'unassigned',
            toStatus: 'scheduled',
            actorUserId: req.userId,
            reason: 'auto-transition on assign',
          });
        }

        return {
          kind: 'ok' as const,
          row: updated[0]!,
          becameScheduled: becomingScheduled,
        };
      });

      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Job not found' },
        });
      }
      if (outcome.kind === 'invalid_tech') {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'INVALID_TARGET',
            message: 'assignedTechUserId is not a tech in this franchisee',
          },
        });
      }

      const row = outcome.row;
      bus.publish({
        type: 'job.assigned',
        franchiseeId: row.franchiseeId,
        franchisorId: '', // filled by caller context; SSE re-joins if needed
        jobId: row.id,
        assignedTechUserId: row.assignedTechUserId,
        actorUserId: req.userId,
        at: new Date().toISOString(),
      });
      if (outcome.becameScheduled) {
        bus.publish({
          type: 'job.transitioned',
          franchiseeId: row.franchiseeId,
          franchisorId: '',
          jobId: row.id,
          fromStatus: 'unassigned',
          toStatus: 'scheduled',
          actorUserId: req.userId,
          at: new Date().toISOString(),
        });
      }
      return reply.code(200).send({ ok: true, data: row });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/jobs/:id/unassign',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const scope = req.scope;
      const outcome = await withScope(db, scope, async (tx) => {
        const jobRows = await tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.id, req.params.id), isNull(jobs.deletedAt)));
        const job = jobRows[0];
        if (!job) return { kind: 'not_found' as const };
        const feScope = scopedFranchiseeId(scope);
        if (feScope && job.franchiseeId !== feScope)
          return { kind: 'not_found' as const };
        if (scope.type === 'franchisor') {
          const feRows = await tx
            .select({ franchisorId: schema.franchisees.franchisorId })
            .from(schema.franchisees)
            .where(eq(schema.franchisees.id, job.franchiseeId));
          if (feRows[0]?.franchisorId !== scope.franchisorId)
            return { kind: 'not_found' as const };
        }
        const now = new Date();
        const values: Record<string, unknown> = {
          assignedTechUserId: null,
          updatedAt: now,
        };
        const revertToUnassigned =
          job.status === 'scheduled' &&
          job.scheduledStart === null &&
          job.scheduledEnd === null;
        if (revertToUnassigned) values.status = 'unassigned';
        const updated = await tx
          .update(jobs)
          .set(values)
          .where(eq(jobs.id, req.params.id))
          .returning();
        if (revertToUnassigned) {
          await tx.insert(jobStatusLog).values({
            jobId: req.params.id,
            franchiseeId: job.franchiseeId,
            fromStatus: 'scheduled',
            toStatus: 'unassigned',
            actorUserId: req.userId,
            reason: 'auto-transition on unassign',
          });
        }
        return {
          kind: 'ok' as const,
          row: updated[0]!,
          reverted: revertToUnassigned,
        };
      });

      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Job not found' },
        });
      }

      const row = outcome.row;
      bus.publish({
        type: 'job.unassigned',
        franchiseeId: row.franchiseeId,
        franchisorId: '',
        jobId: row.id,
        actorUserId: req.userId,
        at: new Date().toISOString(),
      });
      if (outcome.reverted) {
        bus.publish({
          type: 'job.transitioned',
          franchiseeId: row.franchiseeId,
          franchisorId: '',
          jobId: row.id,
          fromStatus: 'scheduled',
          toStatus: 'unassigned',
          actorUserId: req.userId,
          at: new Date().toISOString(),
        });
      }
      return reply.code(200).send({ ok: true, data: row });
    },
  );
}
