/**
 * AI suggestion queue endpoints (TASK-DI-05).
 *
 *   POST /api/v1/dispatch/suggest                   trigger a run
 *   GET  /api/v1/dispatch/suggestions?status=...    list
 *   POST /api/v1/dispatch/suggestions/:id/approve   apply
 *   POST /api/v1/dispatch/suggestions/:id/reject    reject
 *
 * Role policy: platform_admin + franchisor_admin + franchisee
 * role in { franchisee_owner, location_manager, dispatcher } may
 * touch any of these. Tech + CSR → 403.
 */

import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  aiSuggestions,
  jobs,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { AIClient } from '@service-ai/ai';
import { runDispatcher } from './dispatcher-runner.js';
import type { DistanceMatrixClient } from './distance-matrix.js';
import { computeDailyAiMetrics } from './dispatcher-metrics.js';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SuggestionRoutesDeps {
  ai: AIClient;
  distanceMatrix?: DistanceMatrixClient;
}

const DISPATCH_ROLES = new Set([
  'franchisee_owner',
  'location_manager',
  'dispatcher',
]);

function canDispatch(scope: RequestScope): boolean {
  if (scope.type === 'platform') return true;
  if (scope.type === 'franchisor') return true;
  if (scope.type === 'franchisee' && DISPATCH_ROLES.has(scope.role)) return true;
  return false;
}

function scopedFranchiseeId(scope: RequestScope): string | null {
  if (scope.type === 'platform' || scope.type === 'franchisor') return null;
  return scope.franchiseeId;
}

const StatusFilter = z.enum([
  'pending',
  'approved',
  'rejected',
  'applied',
  'expired',
]);

export function registerSuggestionRoutes(
  app: FastifyInstance,
  db: Drizzle,
  deps: SuggestionRoutesDeps,
): void {
  // ----- POST /api/v1/dispatch/suggest --------------------------------------
  app.post('/api/v1/dispatch/suggest', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    if (!canDispatch(scope)) {
      return reply.code(403).send({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Dispatch permission required' },
      });
    }
    if (scope.type !== 'franchisee') {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Impersonate a franchisee to trigger a dispatcher run',
        },
      });
    }
    const result = await runDispatcher(
      { db, ai: deps.ai, distanceMatrix: deps.distanceMatrix },
      { scope, franchiseeId: scope.franchiseeId },
    );
    return reply.code(201).send({ ok: true, data: result });
  });

  // ----- GET /api/v1/dispatch/suggestions -----------------------------------
  app.get('/api/v1/dispatch/suggestions', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    if (!canDispatch(scope)) {
      return reply.code(403).send({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Dispatch permission required' },
      });
    }
    const q = req.query as Record<string, string | undefined>;
    const statusParsed = q['status']
      ? StatusFilter.safeParse(q['status'])
      : null;
    if (statusParsed && !statusParsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'invalid status' },
      });
    }
    const feScope = scopedFranchiseeId(scope);
    const rows = await withScope(db, scope, (tx) => {
      const conditions: unknown[] = [];
      if (feScope) conditions.push(eq(aiSuggestions.franchiseeId, feScope));
      if (statusParsed && statusParsed.success)
        conditions.push(eq(aiSuggestions.status, statusParsed.data));
      const where =
        conditions.length > 0
          ? and(...(conditions as Parameters<typeof and>))
          : undefined;
      const base = tx
        .select()
        .from(aiSuggestions)
        .orderBy(desc(aiSuggestions.createdAt));
      return where ? base.where(where) : base;
    });
    return reply.code(200).send({ ok: true, data: { rows } });
  });

  // ----- POST /api/v1/dispatch/suggestions/:id/approve ----------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/dispatch/suggestions/:id/approve',
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
      if (!canDispatch(scope)) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Dispatch permission required' },
        });
      }
      const userId = req.userId;
      const feScope = scopedFranchiseeId(scope);
      const outcome = await withScope(db, scope, async (tx) => {
        const rows = await tx
          .select()
          .from(aiSuggestions)
          .where(eq(aiSuggestions.id, req.params.id));
        const sugg = rows[0];
        if (!sugg) return { kind: 'not_found' as const };
        if (feScope && sugg.franchiseeId !== feScope)
          return { kind: 'not_found' as const };
        if (
          scope.type === 'franchisor' &&
          sugg.franchiseeId !== null
        ) {
          // Re-verify via the franchisees table so a franchisor
          // admin cannot approve a sibling franchisor's row.
          const feRows = await tx
            .select({ franchisorId: schema.franchisees.franchisorId })
            .from(schema.franchisees)
            .where(eq(schema.franchisees.id, sugg.franchiseeId));
          if (feRows[0]?.franchisorId !== scope.franchisorId)
            return { kind: 'not_found' as const };
        }
        if (sugg.status !== 'pending')
          return {
            kind: 'bad_state' as const,
            status: sugg.status,
          };
        // Re-verify the job is still unassigned — otherwise the
        // suggestion is stale.
        const jobRows = await tx
          .select()
          .from(jobs)
          .where(eq(jobs.id, sugg.subjectJobId));
        const job = jobRows[0];
        if (!job) return { kind: 'not_found' as const };
        if (
          job.status !== 'unassigned' &&
          job.assignedTechUserId !== null
        ) {
          return { kind: 'stale' as const };
        }

        const now = new Date();
        await tx
          .update(jobs)
          .set({
            assignedTechUserId: sugg.proposedTechUserId,
            scheduledStart: sugg.proposedScheduledStart,
            scheduledEnd: sugg.proposedScheduledEnd,
            status: 'scheduled',
            updatedAt: now,
          })
          .where(eq(jobs.id, sugg.subjectJobId));
        const updated = await tx
          .update(aiSuggestions)
          .set({
            status: 'applied',
            decidedAt: now,
            decidedByUserId: userId ?? null,
            updatedAt: now,
          })
          .where(eq(aiSuggestions.id, sugg.id))
          .returning();
        return { kind: 'ok' as const, suggestion: updated[0]! };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Suggestion not found' },
        });
      }
      if (outcome.kind === 'bad_state') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'SUGGESTION_NOT_PENDING',
            message: `Suggestion is already ${outcome.status}`,
          },
        });
      }
      if (outcome.kind === 'stale') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'STALE_SUGGESTION',
            message: 'Underlying job has already been assigned',
          },
        });
      }
      return reply.code(200).send({ ok: true, data: outcome.suggestion });
    },
  );

  // ----- POST /api/v1/dispatch/suggestions/:id/reject -----------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/dispatch/suggestions/:id/reject',
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
      if (!canDispatch(scope)) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Dispatch permission required' },
        });
      }
      const userId = req.userId;
      const feScope = scopedFranchiseeId(scope);
      const outcome = await withScope(db, scope, async (tx) => {
        const rows = await tx
          .select()
          .from(aiSuggestions)
          .where(eq(aiSuggestions.id, req.params.id));
        const sugg = rows[0];
        if (!sugg) return { kind: 'not_found' as const };
        if (feScope && sugg.franchiseeId !== feScope)
          return { kind: 'not_found' as const };
        if (scope.type === 'franchisor') {
          const feRows = await tx
            .select({ franchisorId: schema.franchisees.franchisorId })
            .from(schema.franchisees)
            .where(eq(schema.franchisees.id, sugg.franchiseeId));
          if (feRows[0]?.franchisorId !== scope.franchisorId)
            return { kind: 'not_found' as const };
        }
        if (sugg.status !== 'pending')
          return { kind: 'bad_state' as const, status: sugg.status };
        const now = new Date();
        const updated = await tx
          .update(aiSuggestions)
          .set({
            status: 'rejected',
            decidedAt: now,
            decidedByUserId: userId ?? null,
            updatedAt: now,
          })
          .where(eq(aiSuggestions.id, sugg.id))
          .returning();
        return { kind: 'ok' as const, suggestion: updated[0]! };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Suggestion not found' },
        });
      }
      if (outcome.kind === 'bad_state') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'SUGGESTION_NOT_PENDING',
            message: `Suggestion is already ${outcome.status}`,
          },
        });
      }
      // Keep the unused-import smoother so `and` stays imported when
      // later rule changes need it.
      void and;
      return reply.code(200).send({ ok: true, data: outcome.suggestion });
    },
  );

  // ----- GET /api/v1/dispatch/metrics?date=YYYY-MM-DD ----------------------
  app.get('/api/v1/dispatch/metrics', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    if (!canDispatch(scope)) {
      return reply.code(403).send({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Dispatch permission required' },
      });
    }
    if (scope.type !== 'franchisee') {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Impersonate a franchisee to read metrics',
        },
      });
    }
    const q = req.query as Record<string, string | undefined>;
    const raw = q['date'] ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'date must be YYYY-MM-DD',
        },
      });
    }
    const date = new Date(`${raw}T00:00:00Z`);
    const result = await withScope(db, scope, (tx) =>
      computeDailyAiMetrics({
        tx,
        franchiseeId: scope.franchiseeId,
        date,
      }),
    );
    return reply.code(200).send({ ok: true, data: result });
  });
}
