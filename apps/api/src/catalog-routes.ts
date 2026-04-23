/**
 * HQ catalog editor (TASK-PB-02).
 *
 *   POST   /api/v1/catalog/templates                 create (draft)
 *   GET    /api/v1/catalog/templates                 list visible
 *   GET    /api/v1/catalog/templates/:id             read
 *   PATCH  /api/v1/catalog/templates/:id             update (draft only)
 *   POST   /api/v1/catalog/templates/:id/publish     atomic flip +
 *                                                   archives the
 *                                                   previous published
 *                                                   template for the
 *                                                   franchisor
 *   POST   /api/v1/catalog/templates/:id/archive     archive any status
 *   POST   /api/v1/catalog/templates/:id/items       create item (draft)
 *   GET    /api/v1/catalog/templates/:id/items       list items
 *   PATCH  /api/v1/catalog/templates/:id/items/:iid  update item
 *   DELETE /api/v1/catalog/templates/:id/items/:iid  delete item
 *
 * Writes require franchisor_admin OR platform_admin. Franchisee-scoped
 * callers get 403 CATALOG_READONLY — deliberately NOT 404 because they
 * CAN read published items via /api/v1/pricebook, so the template
 * surface is just a write-path you don't have.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  serviceCatalogTemplates,
  serviceItems,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CreateTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  notes: z.string().max(2000).nullable().optional(),
  /**
   * Required for platform_admin (they must pick a franchisor).
   * Ignored for franchisor_admin — derived from their scope.
   */
  franchisorId: z.string().uuid().nullable().optional(),
});

const UpdateTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const CreateItemSchema = z.object({
  sku: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  category: z.string().min(1).max(80),
  unit: z.string().min(1).max(40),
  basePrice: z.number().nonnegative(),
  floorPrice: z.number().nonnegative().nullable().optional(),
  ceilingPrice: z.number().nonnegative().nullable().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});

const UpdateItemSchema = CreateItemSchema.partial();

function requireAdmin(
  scope: RequestScope,
): { ok: true; franchisorIdForWrites: string | null } | { ok: false; code: string } {
  if (scope.type === 'platform') return { ok: true, franchisorIdForWrites: null };
  if (scope.type === 'franchisor')
    return { ok: true, franchisorIdForWrites: scope.franchisorId };
  return { ok: false, code: 'CATALOG_READONLY' };
}

export function registerCatalogRoutes(app: FastifyInstance, db: Drizzle): void {
  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------
  app.post('/api/v1/catalog/templates', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const adm = requireAdmin(req.scope);
    if (!adm.ok) {
      return reply.code(403).send({
        ok: false,
        error: {
          code: 'CATALOG_READONLY',
          message: 'Only franchisor or platform admins may edit the catalog',
        },
      });
    }
    const parsed = CreateTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }
    const franchisorId = adm.franchisorIdForWrites ?? parsed.data.franchisorId;
    if (!franchisorId) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'platform admin must specify franchisorId',
        },
      });
    }
    const inserted = await db
      .insert(serviceCatalogTemplates)
      .values({
        franchisorId,
        name: parsed.data.name,
        slug: parsed.data.slug,
        notes: parsed.data.notes ?? null,
      })
      .returning();
    return reply.code(201).send({ ok: true, data: inserted[0]! });
  });

  app.get('/api/v1/catalog/templates', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    const rows = await withScope(db, scope, (tx) => {
      const base = tx
        .select()
        .from(serviceCatalogTemplates)
        .where(isNull(serviceCatalogTemplates.deletedAt))
        .orderBy(desc(serviceCatalogTemplates.createdAt));
      if (scope.type === 'platform') return base;
      if (scope.type === 'franchisor') {
        return tx
          .select()
          .from(serviceCatalogTemplates)
          .where(
            and(
              isNull(serviceCatalogTemplates.deletedAt),
              eq(serviceCatalogTemplates.franchisorId, scope.franchisorId),
            ),
          )
          .orderBy(desc(serviceCatalogTemplates.createdAt));
      }
      return tx
        .select()
        .from(serviceCatalogTemplates)
        .where(
          and(
            isNull(serviceCatalogTemplates.deletedAt),
            eq(serviceCatalogTemplates.franchisorId, scope.franchisorId),
          ),
        )
        .orderBy(desc(serviceCatalogTemplates.createdAt));
    });
    return reply.code(200).send({ ok: true, data: rows });
  });

  app.get<{ Params: { id: string } }>(
    '/api/v1/catalog/templates/:id',
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
      const row = await withScope(db, scope, async (tx) => {
        const rows = await tx
          .select()
          .from(serviceCatalogTemplates)
          .where(
            and(
              eq(serviceCatalogTemplates.id, req.params.id),
              isNull(serviceCatalogTemplates.deletedAt),
            ),
          );
        const r = rows[0];
        if (!r) return null;
        if (scope.type !== 'platform' && r.franchisorId !== scope.franchisorId) {
          return null;
        }
        return r;
      });
      if (!row) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Template not found' },
        });
      }
      return reply.code(200).send({ ok: true, data: row });
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/api/v1/catalog/templates/:id',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      const adm = requireAdmin(req.scope);
      if (!adm.ok) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'CATALOG_READONLY', message: 'Catalog is read-only for this role' },
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const parsed = UpdateTemplateSchema.safeParse(req.body);
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
          .from(serviceCatalogTemplates)
          .where(eq(serviceCatalogTemplates.id, req.params.id));
        const r = rows[0];
        if (!r || r.deletedAt !== null) return { kind: 'not_found' as const };
        if (scope.type === 'franchisor' && r.franchisorId !== scope.franchisorId)
          return { kind: 'not_found' as const };
        if (r.status !== 'draft') return { kind: 'not_editable' as const };
        const values: Record<string, unknown> = { updatedAt: new Date() };
        if (parsed.data.name !== undefined) values.name = parsed.data.name;
        if (parsed.data.slug !== undefined) values.slug = parsed.data.slug;
        if (parsed.data.notes !== undefined) values.notes = parsed.data.notes;
        const next = await tx
          .update(serviceCatalogTemplates)
          .set(values)
          .where(eq(serviceCatalogTemplates.id, req.params.id))
          .returning();
        return { kind: 'ok' as const, row: next[0]! };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Template not found' },
        });
      }
      if (outcome.kind === 'not_editable') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'TEMPLATE_NOT_EDITABLE',
            message: 'Only draft templates can be updated',
          },
        });
      }
      return reply.code(200).send({ ok: true, data: outcome.row });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/catalog/templates/:id/publish',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      const adm = requireAdmin(req.scope);
      if (!adm.ok) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'CATALOG_READONLY', message: 'Catalog is read-only for this role' },
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
          .select()
          .from(serviceCatalogTemplates)
          .where(eq(serviceCatalogTemplates.id, req.params.id));
        const r = rows[0];
        if (!r || r.deletedAt !== null) return { kind: 'not_found' as const };
        if (scope.type === 'franchisor' && r.franchisorId !== scope.franchisorId)
          return { kind: 'not_found' as const };
        if (r.status === 'archived') return { kind: 'archived' as const };
        const now = new Date();
        // Archive any currently-published templates on the same franchisor
        // first, so the invariant "at most one published per franchisor"
        // holds atomically.
        await tx
          .update(serviceCatalogTemplates)
          .set({ status: 'archived', archivedAt: now, updatedAt: now })
          .where(
            and(
              eq(serviceCatalogTemplates.franchisorId, r.franchisorId),
              eq(serviceCatalogTemplates.status, 'published'),
            ),
          );
        const next = await tx
          .update(serviceCatalogTemplates)
          .set({ status: 'published', publishedAt: now, updatedAt: now })
          .where(eq(serviceCatalogTemplates.id, req.params.id))
          .returning();
        return { kind: 'ok' as const, row: next[0]! };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Template not found' },
        });
      }
      if (outcome.kind === 'archived') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'TEMPLATE_ARCHIVED',
            message: 'Archived templates cannot be re-published',
          },
        });
      }
      return reply.code(200).send({ ok: true, data: outcome.row });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/catalog/templates/:id/archive',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      const adm = requireAdmin(req.scope);
      if (!adm.ok) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'CATALOG_READONLY', message: 'Catalog is read-only for this role' },
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
          .select()
          .from(serviceCatalogTemplates)
          .where(eq(serviceCatalogTemplates.id, req.params.id));
        const r = rows[0];
        if (!r || r.deletedAt !== null) return { kind: 'not_found' as const };
        if (scope.type === 'franchisor' && r.franchisorId !== scope.franchisorId)
          return { kind: 'not_found' as const };
        const now = new Date();
        const next = await tx
          .update(serviceCatalogTemplates)
          .set({ status: 'archived', archivedAt: now, updatedAt: now })
          .where(eq(serviceCatalogTemplates.id, req.params.id))
          .returning();
        return { kind: 'ok' as const, row: next[0]! };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Template not found' },
        });
      }
      return reply.code(200).send({ ok: true, data: outcome.row });
    },
  );

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/catalog/templates/:id/items',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      const adm = requireAdmin(req.scope);
      if (!adm.ok) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'CATALOG_READONLY', message: 'Catalog is read-only for this role' },
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const parsed = CreateItemSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      if (
        parsed.data.floorPrice != null &&
        parsed.data.ceilingPrice != null &&
        parsed.data.floorPrice > parsed.data.ceilingPrice
      ) {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'floorPrice must be ≤ ceilingPrice',
          },
        });
      }
      const scope = req.scope;
      const outcome = await withScope(db, scope, async (tx) => {
        const rows = await tx
          .select()
          .from(serviceCatalogTemplates)
          .where(eq(serviceCatalogTemplates.id, req.params.id));
        const t = rows[0];
        if (!t || t.deletedAt !== null) return { kind: 'not_found' as const };
        if (scope.type === 'franchisor' && t.franchisorId !== scope.franchisorId)
          return { kind: 'not_found' as const };
        if (t.status !== 'draft') return { kind: 'not_editable' as const };
        const inserted = await tx
          .insert(serviceItems)
          .values({
            templateId: t.id,
            franchisorId: t.franchisorId,
            sku: parsed.data.sku,
            name: parsed.data.name,
            description: parsed.data.description ?? null,
            category: parsed.data.category,
            unit: parsed.data.unit,
            basePrice: String(parsed.data.basePrice),
            floorPrice:
              parsed.data.floorPrice == null
                ? null
                : String(parsed.data.floorPrice),
            ceilingPrice:
              parsed.data.ceilingPrice == null
                ? null
                : String(parsed.data.ceilingPrice),
            sortOrder: parsed.data.sortOrder ?? 0,
          })
          .returning();
        return { kind: 'ok' as const, row: inserted[0]! };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Template not found' },
        });
      }
      if (outcome.kind === 'not_editable') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'TEMPLATE_NOT_EDITABLE',
            message: 'Items can only be added to draft templates',
          },
        });
      }
      return reply.code(201).send({ ok: true, data: outcome.row });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/catalog/templates/:id/items',
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
      const rows = await withScope(db, scope, async (tx) => {
        const tRows = await tx
          .select()
          .from(serviceCatalogTemplates)
          .where(eq(serviceCatalogTemplates.id, req.params.id));
        const t = tRows[0];
        if (!t || t.deletedAt !== null) return null;
        if (scope.type !== 'platform' && t.franchisorId !== scope.franchisorId) {
          return null;
        }
        return tx
          .select()
          .from(serviceItems)
          .where(
            and(
              eq(serviceItems.templateId, t.id),
              isNull(serviceItems.deletedAt),
            ),
          )
          .orderBy(asc(serviceItems.sortOrder), asc(serviceItems.name));
      });
      if (rows === null) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Template not found' },
        });
      }
      return reply.code(200).send({ ok: true, data: rows });
    },
  );

  app.patch<{ Params: { id: string; itemId: string } }>(
    '/api/v1/catalog/templates/:id/items/:itemId',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      const adm = requireAdmin(req.scope);
      if (!adm.ok) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'CATALOG_READONLY', message: 'Catalog is read-only for this role' },
        });
      }
      if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.itemId)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const parsed = UpdateItemSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;
      const outcome = await withScope(db, scope, async (tx) => {
        const tRows = await tx
          .select()
          .from(serviceCatalogTemplates)
          .where(eq(serviceCatalogTemplates.id, req.params.id));
        const t = tRows[0];
        if (!t || t.deletedAt !== null) return { kind: 'not_found' as const };
        if (scope.type === 'franchisor' && t.franchisorId !== scope.franchisorId)
          return { kind: 'not_found' as const };
        if (t.status !== 'draft') return { kind: 'not_editable' as const };
        const iRows = await tx
          .select()
          .from(serviceItems)
          .where(
            and(
              eq(serviceItems.id, req.params.itemId),
              eq(serviceItems.templateId, t.id),
              isNull(serviceItems.deletedAt),
            ),
          );
        if (iRows.length === 0) return { kind: 'not_found' as const };
        const values: Record<string, unknown> = { updatedAt: new Date() };
        const d = parsed.data;
        if (d.sku !== undefined) values.sku = d.sku;
        if (d.name !== undefined) values.name = d.name;
        if (d.description !== undefined) values.description = d.description;
        if (d.category !== undefined) values.category = d.category;
        if (d.unit !== undefined) values.unit = d.unit;
        if (d.basePrice !== undefined) values.basePrice = String(d.basePrice);
        if (d.floorPrice !== undefined)
          values.floorPrice = d.floorPrice == null ? null : String(d.floorPrice);
        if (d.ceilingPrice !== undefined)
          values.ceilingPrice =
            d.ceilingPrice == null ? null : String(d.ceilingPrice);
        if (d.sortOrder !== undefined) values.sortOrder = d.sortOrder;
        const next = await tx
          .update(serviceItems)
          .set(values)
          .where(eq(serviceItems.id, req.params.itemId))
          .returning();
        return { kind: 'ok' as const, row: next[0]! };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Item not found' },
        });
      }
      if (outcome.kind === 'not_editable') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'TEMPLATE_NOT_EDITABLE',
            message: 'Items can only be edited on draft templates',
          },
        });
      }
      return reply.code(200).send({ ok: true, data: outcome.row });
    },
  );

  app.delete<{ Params: { id: string; itemId: string } }>(
    '/api/v1/catalog/templates/:id/items/:itemId',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      const adm = requireAdmin(req.scope);
      if (!adm.ok) {
        return reply.code(403).send({
          ok: false,
          error: { code: 'CATALOG_READONLY', message: 'Catalog is read-only for this role' },
        });
      }
      if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.itemId)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const scope = req.scope;
      const outcome = await withScope(db, scope, async (tx) => {
        const tRows = await tx
          .select()
          .from(serviceCatalogTemplates)
          .where(eq(serviceCatalogTemplates.id, req.params.id));
        const t = tRows[0];
        if (!t || t.deletedAt !== null) return { kind: 'not_found' as const };
        if (scope.type === 'franchisor' && t.franchisorId !== scope.franchisorId)
          return { kind: 'not_found' as const };
        if (t.status !== 'draft') return { kind: 'not_editable' as const };
        const iRows = await tx
          .select({ id: serviceItems.id })
          .from(serviceItems)
          .where(
            and(
              eq(serviceItems.id, req.params.itemId),
              eq(serviceItems.templateId, t.id),
              isNull(serviceItems.deletedAt),
            ),
          );
        if (iRows.length === 0) return { kind: 'not_found' as const };
        await tx
          .update(serviceItems)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(serviceItems.id, req.params.itemId));
        return { kind: 'ok' as const };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Item not found' },
        });
      }
      if (outcome.kind === 'not_editable') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'TEMPLATE_NOT_EDITABLE',
            message: 'Items can only be deleted on draft templates',
          },
        });
      }
      return reply.code(200).send({ ok: true, data: { deleted: true } });
    },
  );
}
