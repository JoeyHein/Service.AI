/**
 * Pricebook suggestions (CHR-09).
 *
 * Replaces the franchise-era pricebook_overrides workflow with a
 * propose-and-approve loop:
 *
 *   POST   /api/v1/pricebook/suggestions                  — manager submits
 *   GET    /api/v1/pricebook/suggestions                  — branch reads own
 *   GET    /api/v1/corporate/pricebook/suggestions        — corporate review queue
 *   POST   /api/v1/corporate/pricebook/suggestions/:id/approve
 *   POST   /api/v1/corporate/pricebook/suggestions/:id/reject
 *
 * Auth pattern:
 *   - manager: can POST + GET (their own branch's suggestions only)
 *   - corporate_admin: can GET corporate queue + approve/reject
 *   - csr/tech/dispatcher: 404 NOT_FOUND on every suggestion endpoint
 *   - unauthenticated: 401
 *
 * v1 "approve" semantics: marks the row resolved. The pricebook itself
 * is corporate-owned and edited via the existing catalog UI; a separate
 * batch can apply approved suggestions in bulk later. The approval row
 * captures who/when/what for audit.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  branches,
  pricebookSuggestions,
  serviceItems,
  users,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireScope(
  req: FastifyRequest,
  reply: FastifyReply,
): RequestScope | null {
  if (req.scope === null) {
    reply.code(401).send({
      ok: false,
      error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
    });
    return null;
  }
  return req.scope;
}

function requireManager(
  req: FastifyRequest,
  reply: FastifyReply,
): Extract<RequestScope, { type: 'branch' }> | null {
  const scope = requireScope(req, reply);
  if (!scope) return null;
  if (scope.type !== 'branch' || scope.role !== 'manager') {
    reply.code(404).send({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
    return null;
  }
  return scope;
}

function requireCorporate(
  req: FastifyRequest,
  reply: FastifyReply,
): RequestScope | null {
  const scope = requireScope(req, reply);
  if (!scope) return null;
  if (scope.type !== 'corporate') {
    reply.code(404).send({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
    return null;
  }
  return scope;
}

const CreateBody = z
  .object({
    serviceItemId: z.string().regex(UUID_RE, 'serviceItemId must be a UUID'),
    suggestedPriceCents: z.number().int().min(0),
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict();

const ResolveBody = z
  .object({
    resolutionNote: z.string().min(1).max(2000).optional(),
  })
  .strict();

interface SuggestionRow {
  id: string;
  branchId: string;
  branchName: string | null;
  serviceItemId: string;
  serviceItemSku: string | null;
  serviceItemName: string | null;
  suggestedPriceCents: number;
  reason: string | null;
  status: string;
  suggestedByUserId: string;
  suggestedByName: string | null;
  resolvedByUserId: string | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
}

export function registerPricebookSuggestionsRoutes(
  app: FastifyInstance,
  db: Drizzle,
): void {
  // ----- POST /api/v1/pricebook/suggestions (manager only) -----
  app.post('/api/v1/pricebook/suggestions', async (req, reply) => {
    const scope = requireManager(req, reply);
    if (!scope) return;

    const parse = CreateBody.safeParse(req.body);
    if (!parse.success) {
      reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid body',
          details: parse.error.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        },
      });
      return;
    }

    const row = await withScope(db, scope, async (tx) => {
      // Verify the service item exists. Cross-tenant 404 if not.
      const found = await tx
        .select({ id: serviceItems.id })
        .from(serviceItems)
        .where(eq(serviceItems.id, parse.data.serviceItemId))
        .limit(1);
      if (found.length === 0) return null;

      const inserted = await tx
        .insert(pricebookSuggestions)
        .values({
          branchId: scope.branchId,
          serviceItemId: parse.data.serviceItemId,
          suggestedPriceCents: parse.data.suggestedPriceCents,
          reason: parse.data.reason ?? null,
          suggestedByUserId: scope.userId,
          status: 'pending',
        })
        .returning();
      return inserted[0] ?? null;
    });

    if (!row) {
      reply.code(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Service item not found' },
      });
      return;
    }

    reply.code(201).send({ ok: true, data: { id: row.id, status: row.status } });
  });

  // ----- GET /api/v1/pricebook/suggestions (branch sees own) -----
  app.get('/api/v1/pricebook/suggestions', async (req, reply) => {
    const scope = requireScope(req, reply);
    if (!scope) return;
    if (scope.type !== 'branch') {
      reply.code(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Not found' },
      });
      return;
    }

    const rows = await withScope(db, scope, (tx) =>
      tx
        .select({
          id: pricebookSuggestions.id,
          branchId: pricebookSuggestions.branchId,
          serviceItemId: pricebookSuggestions.serviceItemId,
          suggestedPriceCents: pricebookSuggestions.suggestedPriceCents,
          reason: pricebookSuggestions.reason,
          status: pricebookSuggestions.status,
          suggestedByUserId: pricebookSuggestions.suggestedByUserId,
          resolvedByUserId: pricebookSuggestions.resolvedByUserId,
          resolvedAt: pricebookSuggestions.resolvedAt,
          resolutionNote: pricebookSuggestions.resolutionNote,
          createdAt: pricebookSuggestions.createdAt,
          serviceItemSku: serviceItems.sku,
          serviceItemName: serviceItems.name,
        })
        .from(pricebookSuggestions)
        .leftJoin(
          serviceItems,
          eq(serviceItems.id, pricebookSuggestions.serviceItemId),
        )
        .where(eq(pricebookSuggestions.branchId, scope.branchId))
        .orderBy(desc(pricebookSuggestions.createdAt)),
    );

    reply.send({
      ok: true,
      data: {
        rows: rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
        })),
      },
    });
  });

  // ----- GET /api/v1/corporate/pricebook/suggestions (corporate review) -----
  app.get('/api/v1/corporate/pricebook/suggestions', async (req, reply) => {
    const scope = requireCorporate(req, reply);
    if (!scope) return;
    const q = req.query as Record<string, string | undefined>;
    const statusFilter = q['status']?.trim();

    const rows = await withScope(db, scope, (tx) => {
      const base = tx
        .select({
          id: pricebookSuggestions.id,
          branchId: pricebookSuggestions.branchId,
          branchName: branches.name,
          serviceItemId: pricebookSuggestions.serviceItemId,
          serviceItemSku: serviceItems.sku,
          serviceItemName: serviceItems.name,
          suggestedPriceCents: pricebookSuggestions.suggestedPriceCents,
          reason: pricebookSuggestions.reason,
          status: pricebookSuggestions.status,
          suggestedByUserId: pricebookSuggestions.suggestedByUserId,
          suggestedByName: users.name,
          resolvedByUserId: pricebookSuggestions.resolvedByUserId,
          resolvedAt: pricebookSuggestions.resolvedAt,
          resolutionNote: pricebookSuggestions.resolutionNote,
          createdAt: pricebookSuggestions.createdAt,
        })
        .from(pricebookSuggestions)
        .leftJoin(branches, eq(branches.id, pricebookSuggestions.branchId))
        .leftJoin(
          serviceItems,
          eq(serviceItems.id, pricebookSuggestions.serviceItemId),
        )
        .leftJoin(users, eq(users.id, pricebookSuggestions.suggestedByUserId));
      const query = statusFilter
        ? base.where(eq(pricebookSuggestions.status, statusFilter))
        : base;
      return query.orderBy(desc(pricebookSuggestions.createdAt));
    });

    const data: SuggestionRow[] = rows.map((r) => ({
      ...r,
      resolvedByName: null,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
    }));
    reply.send({ ok: true, data: { rows: data } });
  });

  // ----- POST /api/v1/corporate/pricebook/suggestions/:id/approve|reject -----
  for (const verb of ['approve', 'reject'] as const) {
    app.post<{ Params: { id: string } }>(
      `/api/v1/corporate/pricebook/suggestions/:id/${verb}`,
      async (req, reply) => {
        const scope = requireCorporate(req, reply);
        if (!scope) return;
        const id = req.params.id;
        if (!UUID_RE.test(id)) {
          reply.code(400).send({
            ok: false,
            error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
          });
          return;
        }
        const parse = ResolveBody.safeParse(req.body ?? {});
        if (!parse.success) {
          reply.code(400).send({
            ok: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid body',
              details: parse.error.errors.map((e) => ({
                path: e.path.join('.'),
                message: e.message,
              })),
            },
          });
          return;
        }
        const result = await withScope(db, scope, async (tx) => {
          const existing = await tx
            .select({ status: pricebookSuggestions.status })
            .from(pricebookSuggestions)
            .where(eq(pricebookSuggestions.id, id))
            .limit(1);
          if (existing.length === 0) return { kind: 'missing' as const };
          if (existing[0]!.status !== 'pending') {
            return {
              kind: 'conflict' as const,
              current: existing[0]!.status,
            };
          }
          const updated = await tx
            .update(pricebookSuggestions)
            .set({
              status: verb === 'approve' ? 'approved' : 'rejected',
              resolvedByUserId: scope.userId,
              resolvedAt: new Date(),
              resolutionNote: parse.data.resolutionNote ?? null,
            })
            .where(
              and(
                eq(pricebookSuggestions.id, id),
                eq(pricebookSuggestions.status, 'pending'),
              ),
            )
            .returning();
          return { kind: 'ok' as const, row: updated[0] };
        });
        if (result.kind === 'missing') {
          reply.code(404).send({
            ok: false,
            error: { code: 'NOT_FOUND', message: 'Suggestion not found' },
          });
          return;
        }
        if (result.kind === 'conflict') {
          reply.code(409).send({
            ok: false,
            error: {
              code: 'INVALID_TRANSITION',
              message: `Suggestion is already ${result.current}`,
            },
          });
          return;
        }
        reply.send({
          ok: true,
          data: {
            id: result.row?.id,
            status: result.row?.status,
            resolvedAt: result.row?.resolvedAt
              ? result.row.resolvedAt.toISOString()
              : null,
          },
        });
      },
    );
  }
}
