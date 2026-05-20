/**
 * Branch pricebook (post-corporate-hub-redesign).
 *
 *   GET    /api/v1/pricebook                    resolved view
 *   POST   /api/v1/pricebook/overrides          410 GONE
 *   DELETE /api/v1/pricebook/overrides/:id      410 GONE
 *
 * The "resolved view" is now the corporate-published catalog template's
 * items — pricebook_overrides was removed by migration 0016 and replaced
 * with the pricebook_suggestions workflow (managers propose, corporate
 * approves). The override endpoints stay as 410 GONE stubs so legacy
 * clients see a structured deprecation signal.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  branches,
  serviceCatalogTemplates,
  serviceItems,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

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
  effectivePrice: string;
}

async function resolveTargetBranch(
  db: Drizzle,
  scope: RequestScope,
  queryBranchId: string | null,
): Promise<
  | { ok: true; branchId: string }
  | { ok: false; code: string; message: string; status: number }
> {
  if (scope.type === 'branch') {
    if (queryBranchId && queryBranchId !== scope.branchId) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        message: 'Branch not in scope',
        status: 404,
      };
    }
    return { ok: true, branchId: scope.branchId };
  }
  if (!queryBranchId) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'branchId query param is required for corporate callers',
      status: 400,
    };
  }
  const rows = await db
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.id, queryBranchId));
  if (rows.length === 0) {
    return { ok: false, code: 'NOT_FOUND', message: 'Branch not found', status: 404 };
  }
  return { ok: true, branchId: queryBranchId };
}

// Route path kept as `/api/v1/pricebook` — CHR-06 deliberately left the
// public surface unchanged; the pricebook is corporate-owned (single
// shared catalog) so no per-branch segment is needed.
export function registerPricebookRoutes(app: FastifyInstance, db: Drizzle): void {
  app.get('/api/v1/pricebook', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const q = req.query as Record<string, string | undefined>;
    const queryBranchId = q['branchId']?.trim() || null;
    const target = await resolveTargetBranch(db, req.scope, queryBranchId);
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

      return itemRows.map<ResolvedRow>((i) => ({
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
        effectivePrice: i.basePrice,
      }));
    });

    return reply.code(200).send({
      ok: true,
      data: {
        branchId: target.branchId,
        rows,
      },
    });
  });

  app.post('/api/v1/pricebook/overrides', (_req, reply) =>
    reply.code(410).send({
      ok: false,
      error: {
        code: 'OVERRIDES_REMOVED',
        message:
          'pricebook_overrides was removed in the corporate hub redesign. Use pricebook_suggestions (manager proposes, corporate approves) instead.',
      },
    }),
  );

  app.delete('/api/v1/pricebook/overrides/:id', (_req, reply) =>
    reply.code(410).send({
      ok: false,
      error: {
        code: 'OVERRIDES_REMOVED',
        message:
          'pricebook_overrides was removed in the corporate hub redesign. Use pricebook_suggestions instead.',
      },
    }),
  );
}
