/**
 * Jobs CRUD + status transitions (TASK-CJ-03).
 *
 *   POST   /api/v1/jobs                  create (customer must be in scope)
 *   GET    /api/v1/jobs                  list (filters + pagination)
 *   GET    /api/v1/jobs/:id              read
 *   PATCH  /api/v1/jobs/:id              partial update (non-status fields)
 *   POST   /api/v1/jobs/:id/transition   body { toStatus, reason? }
 *
 * Transitions run the update + job_status_log insert in a single
 * transaction so status and log never drift. Invalid transitions
 * return 409 INVALID_TRANSITION.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  customers,
  jobs,
  jobStatusLog,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import { canTransition, type JobStatus } from './job-status-machine.js';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const StatusEnum = z.enum([
  'unassigned',
  'scheduled',
  'en_route',
  'arrived',
  'in_progress',
  'completed',
  'canceled',
]);

const CreateSchema = z.object({
  customerId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().nullable().optional(),
  scheduledStart: z.string().datetime().nullable().optional(),
  scheduledEnd: z.string().datetime().nullable().optional(),
  assignedTechUserId: z.string().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
});

const UpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  scheduledStart: z.string().datetime().nullable().optional(),
  scheduledEnd: z.string().datetime().nullable().optional(),
  assignedTechUserId: z.string().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
});

const TransitionSchema = z.object({
  toStatus: StatusEnum,
  reason: z.string().max(500).nullable().optional(),
});

function scopedFranchiseeId(scope: RequestScope): string | null {
  if (scope.type === 'platform' || scope.type === 'franchisor') return null;
  return scope.franchiseeId;
}

function inScopeByFranchisee(scope: RequestScope, franchiseeId: string): boolean {
  if (scope.type === 'platform') return true;
  if (scope.type === 'franchisor') return false; // resolved separately via franchisees table
  return scope.franchiseeId === franchiseeId;
}

export function registerJobRoutes(app: FastifyInstance, db: Drizzle): void {
  // -------------------------------------------------------------------------
  // POST /api/v1/jobs — create
  // -------------------------------------------------------------------------
  app.post('/api/v1/jobs', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }
    const scope = req.scope;

    // Validate the customer belongs to a franchisee the caller can act in.
    const custRows = await db
      .select({
        id: customers.id,
        franchiseeId: customers.franchiseeId,
        deletedAt: customers.deletedAt,
      })
      .from(customers)
      .where(eq(customers.id, parsed.data.customerId));
    const cust = custRows[0];
    if (!cust || cust.deletedAt !== null) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'INVALID_TARGET', message: 'customerId does not exist' },
      });
    }
    if (scope.type === 'franchisee' && cust.franchiseeId !== scope.franchiseeId) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'INVALID_TARGET',
          message: 'customerId is outside your franchisee scope',
        },
      });
    }
    if (scope.type === 'franchisor') {
      const feRows = await db
        .select({ franchisorId: schema.franchisees.franchisorId })
        .from(schema.franchisees)
        .where(eq(schema.franchisees.id, cust.franchiseeId));
      if (feRows[0]?.franchisorId !== scope.franchisorId) {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'INVALID_TARGET',
            message: 'customerId is outside your franchisor',
          },
        });
      }
    }

    const inserted = await db
      .insert(jobs)
      .values({
        franchiseeId: cust.franchiseeId,
        locationId: parsed.data.locationId ?? null,
        customerId: parsed.data.customerId,
        status: 'unassigned',
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        scheduledStart: parsed.data.scheduledStart
          ? new Date(parsed.data.scheduledStart)
          : null,
        scheduledEnd: parsed.data.scheduledEnd
          ? new Date(parsed.data.scheduledEnd)
          : null,
        assignedTechUserId: parsed.data.assignedTechUserId ?? null,
        createdByUserId: req.userId,
      })
      .returning();
    return reply.code(201).send({ ok: true, data: inserted[0]! });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/jobs — list with filters
  // -------------------------------------------------------------------------
  app.get('/api/v1/jobs', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    const q = req.query as Record<string, string | undefined>;
    const status = q['status'] ? StatusEnum.safeParse(q['status']) : null;
    if (status && !status.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'invalid status' },
      });
    }
    const customerId = q['customerId']?.trim() || null;
    const assignedTechUserId = q['assignedTechUserId']?.trim() || null;
    const limit = Math.min(Math.max(parseInt(q['limit'] ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(q['offset'] ?? '0', 10) || 0, 0);

    const { rows, total } = await withScope(db, scope, async (tx) => {
      const conditions: unknown[] = [isNull(jobs.deletedAt)];
      const scopeFe = scopedFranchiseeId(scope);
      if (scopeFe) conditions.push(eq(jobs.franchiseeId, scopeFe));
      if (status && status.success) conditions.push(eq(jobs.status, status.data));
      if (customerId) conditions.push(eq(jobs.customerId, customerId));
      if (assignedTechUserId)
        conditions.push(eq(jobs.assignedTechUserId, assignedTechUserId));
      const where = and(...(conditions as Parameters<typeof and>));
      const rows = await tx
        .select()
        .from(jobs)
        .where(where)
        .orderBy(desc(jobs.createdAt))
        .limit(limit)
        .offset(offset);
      const countRows = await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(jobs)
        .where(where);
      return { rows, total: countRows[0]?.c ?? 0 };
    });

    return reply.code(200).send({
      ok: true,
      data: { rows, total, limit, offset },
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/jobs/:id
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/v1/jobs/:id', async (req, reply) => {
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
    const row = await withScope(db, scope, async (tx) => {
      const rows = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, req.params.id), isNull(jobs.deletedAt)));
      const r = rows[0];
      if (!r) return null;
      const scopeFe = scopedFranchiseeId(scope);
      if (scopeFe && r.franchiseeId !== scopeFe) return null;
      if (scope.type === 'franchisor') {
        const feRows = await tx
          .select({ franchisorId: schema.franchisees.franchisorId })
          .from(schema.franchisees)
          .where(eq(schema.franchisees.id, r.franchiseeId));
        if (feRows[0]?.franchisorId !== scope.franchisorId) return null;
      }
      return r;
    });
    if (!row) {
      return reply.code(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Job not found' },
      });
    }
    return reply.code(200).send({ ok: true, data: row });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v1/jobs/:id — non-status updates only
  // -------------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>('/api/v1/jobs/:id', async (req, reply) => {
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
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }
    const scope = req.scope;
    const result = await withScope(db, scope, async (tx) => {
      const rows = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, req.params.id), isNull(jobs.deletedAt)));
      const row = rows[0];
      if (!row) return null;
      if (!inScopeByFranchisee(scope, row.franchiseeId) && scope.type !== 'franchisor') {
        return null;
      }
      if (scope.type === 'franchisor') {
        const feRows = await tx
          .select({ franchisorId: schema.franchisees.franchisorId })
          .from(schema.franchisees)
          .where(eq(schema.franchisees.id, row.franchiseeId));
        if (feRows[0]?.franchisorId !== scope.franchisorId) return null;
      }
      const values: Record<string, unknown> = { updatedAt: new Date() };
      const d = parsed.data;
      if (d.title !== undefined) values.title = d.title;
      if (d.description !== undefined) values.description = d.description;
      if (d.scheduledStart !== undefined)
        values.scheduledStart = d.scheduledStart ? new Date(d.scheduledStart) : null;
      if (d.scheduledEnd !== undefined)
        values.scheduledEnd = d.scheduledEnd ? new Date(d.scheduledEnd) : null;
      if (d.assignedTechUserId !== undefined) values.assignedTechUserId = d.assignedTechUserId;
      if (d.locationId !== undefined) values.locationId = d.locationId;
      const next = await tx
        .update(jobs)
        .set(values)
        .where(eq(jobs.id, req.params.id))
        .returning();
      return next[0]!;
    });
    if (!result) {
      return reply.code(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Job not found' },
      });
    }
    return reply.code(200).send({ ok: true, data: result });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/jobs/:id/transition
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/jobs/:id/transition',
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
      const parsed = TransitionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;
      const outcome = await withScope(db, scope, async (tx) => {
        const rows = await tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.id, req.params.id), isNull(jobs.deletedAt)));
        const row = rows[0];
        if (!row) return { kind: 'not_found' as const };
        if (!inScopeByFranchisee(scope, row.franchiseeId) && scope.type !== 'franchisor') {
          return { kind: 'not_found' as const };
        }
        if (scope.type === 'franchisor') {
          const feRows = await tx
            .select({ franchisorId: schema.franchisees.franchisorId })
            .from(schema.franchisees)
            .where(eq(schema.franchisees.id, row.franchiseeId));
          if (feRows[0]?.franchisorId !== scope.franchisorId) {
            return { kind: 'not_found' as const };
          }
        }
        const from = row.status as JobStatus;
        const to = parsed.data.toStatus;
        if (!canTransition(from, to)) {
          return { kind: 'invalid_transition' as const, from, to };
        }
        // Compose lifecycle timestamps so the jobs row reflects
        // "arrived at" / "completed at" without a separate write.
        const values: Record<string, unknown> = {
          status: to,
          updatedAt: new Date(),
        };
        if (to === 'arrived' && !row.actualStart) values.actualStart = new Date();
        if (to === 'completed' || to === 'canceled') values.actualEnd = new Date();

        const updated = await tx
          .update(jobs)
          .set(values)
          .where(eq(jobs.id, req.params.id))
          .returning();
        await tx.insert(jobStatusLog).values({
          jobId: req.params.id,
          franchiseeId: row.franchiseeId,
          fromStatus: from,
          toStatus: to,
          actorUserId: req.userId,
          reason: parsed.data.reason ?? null,
        });
        return { kind: 'ok' as const, row: updated[0]! };
      });

      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Job not found' },
        });
      }
      if (outcome.kind === 'invalid_transition') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'INVALID_TRANSITION',
            message: `cannot move from ${outcome.from} to ${outcome.to}`,
          },
        });
      }
      return reply.code(200).send({ ok: true, data: outcome.row });
    },
  );
}
