/**
 * Franchisee pricebook + overrides (TASK-PB-03).
 *
 *   GET    /api/v1/pricebook                    resolved view
 *   POST   /api/v1/pricebook/overrides          upsert override
 *                                               (floor ≤ price ≤ ceiling)
 *   DELETE /api/v1/pricebook/overrides/:id      soft-delete
 *
 * The "resolved view" merges the franchisor's currently-published
 * template's items with the caller's active overrides. Platform
 * admins can pass ?franchiseeId=... to peek as a specific franchisee;
 * franchisor admins can do the same but only within their franchisor.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  franchisees,
  pricebookOverrides,
  serviceCatalogTemplates,
  serviceItems,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CreateOverrideSchema = z.object({
  serviceItemId: z.string().uuid(),
  overridePrice: z.number().nonnegative(),
  note: z.string().max(500).nullable().optional(),
});

interface ResolvedRow {
  serviceItemId: string;
  templateId: string;
  sku: string;
  name: string;
  description: string | null;
  category: string;
  unit: string;
  basePrice: string;
  floorPrice: string | null;
  ceilingPrice: string | null;
  overrideId: string | null;
  overridePrice: string | null;
  effectivePrice: string;
  overridden: boolean;
}

async function resolveTargetFranchisee(
  db: Drizzle,
  scope: RequestScope,
  queryFranchiseeId: string | null,
): Promise<
  | { ok: true; franchiseeId: string; franchisorId: string }
  | { ok: false; code: string; message: string; status: number }
> {
  if (scope.type === 'franchisee') {
    if (queryFranchiseeId && queryFranchiseeId !== scope.franchiseeId) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: 'Franchisee not in scope',
        status: 404,
      };
    }
    return {
      ok: true,
      franchiseeId: scope.franchiseeId,
      franchisorId: scope.franchisorId,
    };
  }
  // platform / franchisor admin — must provide a franchiseeId to resolve.
  if (!queryFranchiseeId) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'franchiseeId query param is required for admin callers',
      status: 400,
    };
  }
  const rows = await db
    .select({ franchisorId: franchisees.franchisorId })
    .from(franchisees)
    .where(eq(franchisees.id, queryFranchiseeId));
  if (rows.length === 0) {
    return { ok: false, code: 'NOT_FOUND', message: 'Franchisee not found', status: 404 };
  }
  if (scope.type === 'franchisor' && rows[0]!.franchisorId !== scope.franchisorId) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'Franchisee not in scope',
      status: 404,
    };
  }
  return {
    ok: true,
    franchiseeId: queryFranchiseeId,
    franchisorId: rows[0]!.franchisorId,
  };
}

export function registerPricebookRoutes(app: FastifyInstance, db: Drizzle): void {
  // -------------------------------------------------------------------------
  // GET /api/v1/pricebook
  // -------------------------------------------------------------------------
  app.get('/api/v1/pricebook', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const q = req.query as Record<string, string | undefined>;
    const queryFranchiseeId = q['franchiseeId']?.trim() || null;
    const target = await resolveTargetFranchisee(db, req.scope, queryFranchiseeId);
    if (!target.ok) {
      return reply.code(target.status).send({
        ok: false,
        error: { code: target.code, message: target.message },
      });
    }

    const scope = req.scope;
    const rows = await withScope(db, scope, async (tx) => {
      const templateRows = await tx
        .select({ id: serviceCatalogTemplates.id })
        .from(serviceCatalogTemplates)
        .where(
          and(
            eq(serviceCatalogTemplates.franchisorId, target.franchisorId),
            eq(serviceCatalogTemplates.status, 'published'),
            isNull(serviceCatalogTemplates.deletedAt),
          ),
        );
      if (templateRows.length === 0) return [] as ResolvedRow[];
      const templateId = templateRows[0]!.id;

      const itemRows = await tx
        .select()
        .from(serviceItems)
        .where(
          and(
            eq(serviceItems.templateId, templateId),
            isNull(serviceItems.deletedAt),
          ),
        )
        .orderBy(asc(serviceItems.sortOrder), asc(serviceItems.name));

      const itemIds = itemRows.map((r) => r.id);
      const overrides = itemIds.length
        ? await tx
            .select()
            .from(pricebookOverrides)
            .where(
              and(
                eq(pricebookOverrides.franchiseeId, target.franchiseeId),
                inArray(pricebookOverrides.serviceItemId, itemIds),
                isNull(pricebookOverrides.deletedAt),
              ),
            )
        : [];
      const byItem = new Map<string, (typeof overrides)[number]>();
      for (const o of overrides) byItem.set(o.serviceItemId, o);

      return itemRows.map<ResolvedRow>((i) => {
        const o = byItem.get(i.id) ?? null;
        return {
          serviceItemId: i.id,
          templateId: i.templateId,
          sku: i.sku,
          name: i.name,
          description: i.description,
          category: i.category,
          unit: i.unit,
          basePrice: i.basePrice,
          floorPrice: i.floorPrice,
          ceilingPrice: i.ceilingPrice,
          overrideId: o?.id ?? null,
          overridePrice: o?.overridePrice ?? null,
          effectivePrice: o ? o.overridePrice : i.basePrice,
          overridden: o !== null,
        };
      });
    });

    return reply.code(200).send({
      ok: true,
      data: {
        franchiseeId: target.franchiseeId,
        franchisorId: target.franchisorId,
        rows,
      },
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/pricebook/overrides
  // -------------------------------------------------------------------------
  app.post('/api/v1/pricebook/overrides', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const parsed = CreateOverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }
    const q = req.query as Record<string, string | undefined>;
    const target = await resolveTargetFranchisee(
      db,
      req.scope,
      q['franchiseeId']?.trim() || null,
    );
    if (!target.ok) {
      return reply.code(target.status).send({
        ok: false,
        error: { code: target.code, message: target.message },
      });
    }
    const scope = req.scope;

    // Load the item + validate it belongs to the target's franchisor and
    // is in a published template. Bounds-check the override price.
    const itemRows = await db
      .select({
        id: serviceItems.id,
        franchisorId: serviceItems.franchisorId,
        templateId: serviceItems.templateId,
        basePrice: serviceItems.basePrice,
        floorPrice: serviceItems.floorPrice,
        ceilingPrice: serviceItems.ceilingPrice,
        status: serviceCatalogTemplates.status,
      })
      .from(serviceItems)
      .innerJoin(
        serviceCatalogTemplates,
        eq(serviceCatalogTemplates.id, serviceItems.templateId),
      )
      .where(
        and(
          eq(serviceItems.id, parsed.data.serviceItemId),
          isNull(serviceItems.deletedAt),
        ),
      );
    const item = itemRows[0];
    if (!item) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'INVALID_TARGET', message: 'Service item not found' },
      });
    }
    if (item.franchisorId !== target.franchisorId) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'INVALID_TARGET',
          message: 'Service item belongs to a different franchisor',
        },
      });
    }
    if (item.status !== 'published') {
      return reply.code(409).send({
        ok: false,
        error: {
          code: 'TEMPLATE_NOT_PUBLISHED',
          message: 'Overrides can only be set on items in a published template',
        },
      });
    }
    const floor = item.floorPrice == null ? null : Number(item.floorPrice);
    const ceiling = item.ceilingPrice == null ? null : Number(item.ceilingPrice);
    const attempted = parsed.data.overridePrice;
    if (floor !== null && attempted < floor) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'PRICE_OUT_OF_BOUNDS',
          message: `${attempted} is below floor ${floor}`,
        },
      });
    }
    if (ceiling !== null && attempted > ceiling) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'PRICE_OUT_OF_BOUNDS',
          message: `${attempted} is above ceiling ${ceiling}`,
        },
      });
    }

    // Upsert: at most one active (franchisee, item) override.
    const result = await withScope(db, scope, async (tx) => {
      const existing = await tx
        .select()
        .from(pricebookOverrides)
        .where(
          and(
            eq(pricebookOverrides.franchiseeId, target.franchiseeId),
            eq(pricebookOverrides.serviceItemId, parsed.data.serviceItemId),
            isNull(pricebookOverrides.deletedAt),
          ),
        );
      if (existing.length > 0) {
        const next = await tx
          .update(pricebookOverrides)
          .set({
            overridePrice: String(attempted),
            note: parsed.data.note ?? null,
            updatedAt: new Date(),
          })
          .where(eq(pricebookOverrides.id, existing[0]!.id))
          .returning();
        return { kind: 'updated' as const, row: next[0]! };
      }
      const inserted = await tx
        .insert(pricebookOverrides)
        .values({
          franchiseeId: target.franchiseeId,
          franchisorId: target.franchisorId,
          serviceItemId: parsed.data.serviceItemId,
          overridePrice: String(attempted),
          note: parsed.data.note ?? null,
          createdByUserId: req.userId,
        })
        .returning();
      return { kind: 'created' as const, row: inserted[0]! };
    });

    return reply
      .code(result.kind === 'created' ? 201 : 200)
      .send({ ok: true, data: result.row });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/pricebook/overrides/:id
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/api/v1/pricebook/overrides/:id',
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
        const rows = await tx
          .select({
            id: pricebookOverrides.id,
            franchiseeId: pricebookOverrides.franchiseeId,
            franchisorId: pricebookOverrides.franchisorId,
            deletedAt: pricebookOverrides.deletedAt,
          })
          .from(pricebookOverrides)
          .where(eq(pricebookOverrides.id, req.params.id));
        const r = rows[0];
        if (!r) return { kind: 'not_found' as const };
        const inScope =
          scope.type === 'platform' ||
          (scope.type === 'franchisor' && r.franchisorId === scope.franchisorId) ||
          (scope.type === 'franchisee' && r.franchiseeId === scope.franchiseeId);
        if (!inScope) return { kind: 'not_found' as const };
        if (r.deletedAt !== null) return { kind: 'already' as const };
        await tx
          .update(pricebookOverrides)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(pricebookOverrides.id, req.params.id));
        return { kind: 'ok' as const };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Override not found' },
        });
      }
      return reply.code(200).send({
        ok: true,
        data: {
          deleted: outcome.kind === 'ok',
          alreadyDeleted: outcome.kind === 'already',
        },
      });
    },
  );
}
// Touch `sql` so TS doesn't complain about an unused import if we
// end up not needing it after a later refactor.
void sql;
