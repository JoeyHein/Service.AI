/**
 * Tech assistant API (TASK-TA-05).
 *
 *   POST /api/v1/jobs/:id/photo-quote       run the photoQuote pipeline
 *   POST /api/v1/jobs/:id/notes-to-invoice  run the notesToInvoice pipeline
 *   POST /api/v1/ai/feedback                record accept/override
 *
 * Role policy: tech / dispatcher / franchisee_owner only; CSR →
 * 403. Admins (platform / franchisor) must be impersonating.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  aiFeedback,
  jobs,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { AIClient } from '@service-ai/ai';
import type { VisionClient } from './vision.js';
import {
  techPhotoQuote,
  techNotesToInvoice,
} from './ai-tech-assistant.js';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TechAssistantRouteDeps {
  ai: AIClient;
  vision: VisionClient;
}

const ASSISTANT_ROLES = new Set([
  'tech',
  'dispatcher',
  'location_manager',
  'franchisee_owner',
]);

function canUseAssistant(scope: RequestScope): boolean {
  if (scope.type === 'platform' || scope.type === 'franchisor') return true;
  if (scope.type === 'franchisee' && ASSISTANT_ROLES.has(scope.role))
    return true;
  return false;
}

const PhotoQuoteBody = z.object({
  imageRef: z.string().min(1).max(500),
  description: z.string().max(1000).optional(),
});

const NotesBody = z.object({
  notes: z.string().min(1).max(5000),
});

const FeedbackBody = z.object({
  conversationId: z.string().uuid().optional(),
  kind: z.enum(['accept', 'override']),
  subjectKind: z.enum([
    'photo_quote_item',
    'notes_invoice_draft',
    'dispatcher_assignment',
  ]),
  subjectRef: z.record(z.unknown()),
});

export function registerTechAssistantRoutes(
  app: FastifyInstance,
  db: Drizzle,
  deps: TechAssistantRouteDeps,
): void {
  // ----- POST /jobs/:id/photo-quote -----------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/jobs/:id/photo-quote',
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
      if (!canUseAssistant(req.scope)) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Assistant access required' },
        });
      }
      const parsed = PhotoQuoteBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;
      if (scope.type !== 'franchisee') {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Impersonate a franchisee to run photoQuote',
          },
        });
      }
      // Scope check on the job — defence in depth over RLS.
      const ownRows = await withScope(db, scope, (tx) =>
        tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(eq(jobs.id, req.params.id)),
      );
      if (ownRows.length === 0) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Job not found' },
        });
      }
      const result = await techPhotoQuote(
        { db, ai: deps.ai, vision: deps.vision },
        {
          scope,
          franchiseeId: scope.franchiseeId,
          jobId: req.params.id,
          imageRef: parsed.data.imageRef,
          description: parsed.data.description,
        },
      );
      if (!result) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Job not found' },
        });
      }
      return reply.code(200).send({ ok: true, data: result });
    },
  );

  // ----- POST /jobs/:id/notes-to-invoice ------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/jobs/:id/notes-to-invoice',
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
      if (!canUseAssistant(req.scope)) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Assistant access required' },
        });
      }
      const parsed = NotesBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;
      if (scope.type !== 'franchisee') {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Impersonate a franchisee to run notesToInvoice',
          },
        });
      }
      const ownRows = await withScope(db, scope, (tx) =>
        tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(eq(jobs.id, req.params.id)),
      );
      if (ownRows.length === 0) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Job not found' },
        });
      }
      const result = await techNotesToInvoice(
        { db, ai: deps.ai, vision: deps.vision },
        {
          scope,
          franchiseeId: scope.franchiseeId,
          jobId: req.params.id,
          notes: parsed.data.notes,
        },
      );
      if (!result) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Job not found' },
        });
      }
      return reply.code(200).send({ ok: true, data: result });
    },
  );

  // ----- POST /ai/feedback --------------------------------------------------
  app.post('/api/v1/ai/feedback', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    if (!canUseAssistant(req.scope)) {
      return reply.code(403).send({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Assistant access required' },
      });
    }
    const parsed = FeedbackBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }
    const scope = req.scope;
    if (scope.type !== 'franchisee') {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Impersonate a franchisee to record feedback',
        },
      });
    }
    const inserted = await withScope(db, scope, (tx) =>
      tx
        .insert(aiFeedback)
        .values({
          franchiseeId: scope.franchiseeId,
          conversationId: parsed.data.conversationId ?? null,
          kind: parsed.data.kind,
          subjectKind: parsed.data.subjectKind,
          subjectRef: parsed.data.subjectRef,
          actorUserId: req.userId ?? null,
        })
        .returning(),
    );
    return reply.code(201).send({ ok: true, data: inserted[0] });
  });
}
