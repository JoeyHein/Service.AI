/**
 * Branch inventory (INV-02).
 *
 *   POST  /api/v1/inventory/items              create stocked item (manager+)
 *   GET   /api/v1/inventory/items              list (search/category/lowStock)
 *   GET   /api/v1/inventory/items/:id          item + recent movements
 *   PATCH /api/v1/inventory/items/:id          edit (manager+)
 *   POST  /api/v1/inventory/items/:id/adjust   receive/adjust/consume (manager+)
 *   GET   /api/v1/inventory/low-stock          reorder report
 *
 * Branch-scoped: branch users act within their branch; corporate admins must
 * pass `branchId` on create. Reads are open to any scope; writes are
 * manager / corporate_admin only. Cross-tenant probe → 404.
 *
 * Movements are the source of truth for history; `qty_on_hand` is the running
 * balance updated in the SAME transaction as each movement insert so state and
 * ledger cannot drift.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  inventoryItems,
  inventoryMovements,
  inventoryConsumptionExceptions,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function branchIdFromScope(scope: RequestScope): string | null {
  if (scope.type === 'corporate') return null;
  return scope.branchId;
}

/** Inventory writes are manager / corporate_admin only. */
function canWrite(scope: RequestScope): boolean {
  return scope.type === 'corporate' || scope.role === 'manager';
}

const CreateItemSchema = z
  .object({
    sku: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    category: z.string().max(100).nullable().optional(),
    unit: z.string().max(20).optional(),
    unitCostCents: z.number().int().min(0).optional(),
    qtyOnHand: z.number().min(0).optional(),
    reorderPoint: z.number().min(0).optional(),
    reorderQty: z.number().min(0).optional(),
    bin: z.string().max(60).nullable().optional(),
    branchId: z.string().uuid().optional(),
  })
  .strict();

const UpdateItemSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    category: z.string().max(100).nullable().optional(),
    unit: z.string().max(20).optional(),
    unitCostCents: z.number().int().min(0).optional(),
    reorderPoint: z.number().min(0).optional(),
    reorderQty: z.number().min(0).optional(),
    bin: z.string().max(60).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();

const AdjustSchema = z
  .object({
    deltaQty: z.number().refine((n) => n !== 0, 'deltaQty must be non-zero'),
    reason: z.enum(['receipt', 'adjustment', 'consumption']),
    note: z.string().max(500).optional(),
    unitCostCents: z.number().int().min(0).optional(),
  })
  .strict();

const ResolveExceptionSchema = z
  .object({
    itemId: z.string().uuid().optional(),
    create: z
      .object({
        sku: z.string().min(1).max(100),
        name: z.string().min(1).max(200),
        category: z.string().max(100).nullable().optional(),
        unit: z.string().max(20).optional(),
        unitCostCents: z.number().int().min(0).optional(),
        reorderPoint: z.number().min(0).optional(),
        reorderQty: z.number().min(0).optional(),
        bin: z.string().max(60).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((d) => (d.itemId ? !d.create : !!d.create), {
    message: 'Provide exactly one of itemId or create',
  });

function num(v: string | number): number {
  return typeof v === 'string' ? Number(v) : v;
}

export function registerInventoryRoutes(app: FastifyInstance, db: Drizzle): void {
  // POST /api/v1/inventory/items
  app.post('/api/v1/inventory/items', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
    }
    if (!canWrite(req.scope)) {
      return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: 'Manager role required' } });
    }
    const parsed = CreateItemSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const scope = req.scope;
    const d = parsed.data;

    let branchId: string;
    if (scope.type === 'corporate') {
      if (!d.branchId) {
        return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'corporate admins must specify branchId' } });
      }
      branchId = d.branchId;
    } else {
      branchId = scope.branchId;
    }

    const outcome = await withScope(db, scope, async (tx) => {
      const dupe = await tx
        .select({ id: inventoryItems.id })
        .from(inventoryItems)
        .where(and(eq(inventoryItems.branchId, branchId), eq(inventoryItems.sku, d.sku)))
        .limit(1);
      if (dupe[0]) return { kind: 'dupe' as const };
      const inserted = await tx
        .insert(inventoryItems)
        .values({
          branchId,
          sku: d.sku,
          name: d.name,
          category: d.category ?? null,
          unit: d.unit ?? 'each',
          unitCostCents: d.unitCostCents ?? 0,
          qtyOnHand: String(d.qtyOnHand ?? 0),
          reorderPoint: String(d.reorderPoint ?? 0),
          reorderQty: String(d.reorderQty ?? 0),
          bin: d.bin ?? null,
        })
        .returning();
      return { kind: 'ok' as const, row: inserted[0]! };
    });
    if (outcome.kind === 'dupe') {
      return reply.code(409).send({ ok: false, error: { code: 'DUPLICATE_SKU', message: 'That SKU is already stocked at this branch' } });
    }
    return reply.code(201).send({ ok: true, data: outcome.row });
  });

  // GET /api/v1/inventory/items
  app.get('/api/v1/inventory/items', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
    }
    const scope = req.scope;
    const q = req.query as Record<string, string | undefined>;
    const search = q['search']?.trim() || null;
    const category = q['category']?.trim() || null;
    const lowStock = q['lowStock'] === 'true';
    const limit = Math.min(Math.max(parseInt(q['limit'] ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(q['offset'] ?? '0', 10) || 0, 0);

    const { rows, total } = await withScope(db, scope, async (tx) => {
      const conditions: unknown[] = [];
      const scopeBranch = branchIdFromScope(scope);
      if (scopeBranch) conditions.push(eq(inventoryItems.branchId, scopeBranch));
      if (category) conditions.push(eq(inventoryItems.category, category));
      if (search) {
        const like = `%${search}%`;
        conditions.push(or(ilike(inventoryItems.sku, like), ilike(inventoryItems.name, like)));
      }
      if (lowStock) {
        conditions.push(eq(inventoryItems.active, true));
        conditions.push(
          sql`${inventoryItems.qtyOnHand} - ${inventoryItems.qtyReserved} <= ${inventoryItems.reorderPoint}`,
        );
      }
      const where = conditions.length > 0 ? and(...(conditions as Parameters<typeof and>)) : undefined;
      const rows = await tx
        .select()
        .from(inventoryItems)
        .where(where)
        .orderBy(desc(inventoryItems.updatedAt))
        .limit(limit)
        .offset(offset);
      const countRows = await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(inventoryItems)
        .where(where);
      return { rows, total: countRows[0]?.c ?? 0 };
    });
    return reply.code(200).send({ ok: true, data: { rows, total, limit, offset } });
  });

  // GET /api/v1/inventory/low-stock
  app.get('/api/v1/inventory/low-stock', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
    }
    const scope = req.scope;
    const rows = await withScope(db, scope, async (tx) => {
      const conditions: unknown[] = [
        eq(inventoryItems.active, true),
        sql`${inventoryItems.qtyOnHand} - ${inventoryItems.qtyReserved} <= ${inventoryItems.reorderPoint}`,
      ];
      const scopeBranch = branchIdFromScope(scope);
      if (scopeBranch) conditions.push(eq(inventoryItems.branchId, scopeBranch));
      return tx
        .select()
        .from(inventoryItems)
        .where(and(...(conditions as Parameters<typeof and>)))
        .orderBy(desc(inventoryItems.updatedAt));
    });
    return reply.code(200).send({ ok: true, data: { rows } });
  });

  // GET /api/v1/inventory/items/:id
  app.get<{ Params: { id: string } }>('/api/v1/inventory/items/:id', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
    }
    if (!UUID_RE.test(req.params.id)) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' } });
    }
    const scope = req.scope;
    const data = await withScope(db, scope, async (tx) => {
      const rows = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, req.params.id)).limit(1);
      const item = rows[0];
      if (!item) return null;
      const scopeBranch = branchIdFromScope(scope);
      if (scopeBranch && item.branchId !== scopeBranch) return null;
      const movements = await tx
        .select()
        .from(inventoryMovements)
        .where(eq(inventoryMovements.itemId, item.id))
        .orderBy(desc(inventoryMovements.createdAt))
        .limit(50);
      return { item, movements };
    });
    if (!data) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Item not found' } });
    }
    return reply.code(200).send({ ok: true, data });
  });

  // PATCH /api/v1/inventory/items/:id
  app.patch<{ Params: { id: string } }>('/api/v1/inventory/items/:id', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
    }
    if (!canWrite(req.scope)) {
      return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: 'Manager role required' } });
    }
    if (!UUID_RE.test(req.params.id)) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' } });
    }
    const parsed = UpdateItemSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const scope = req.scope;
    const updated = await withScope(db, scope, async (tx) => {
      const rows = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, req.params.id)).limit(1);
      const item = rows[0];
      if (!item) return { kind: 'not_found' as const };
      const scopeBranch = branchIdFromScope(scope);
      if (scopeBranch && item.branchId !== scopeBranch) return { kind: 'not_found' as const };
      const d = parsed.data;
      const values: Record<string, unknown> = { updatedAt: new Date() };
      if (d.name !== undefined) values.name = d.name;
      if (d.category !== undefined) values.category = d.category;
      if (d.unit !== undefined) values.unit = d.unit;
      if (d.unitCostCents !== undefined) values.unitCostCents = d.unitCostCents;
      if (d.reorderPoint !== undefined) values.reorderPoint = String(d.reorderPoint);
      if (d.reorderQty !== undefined) values.reorderQty = String(d.reorderQty);
      if (d.bin !== undefined) values.bin = d.bin;
      if (d.active !== undefined) values.active = d.active;
      const next = await tx.update(inventoryItems).set(values).where(eq(inventoryItems.id, item.id)).returning();
      return { kind: 'ok' as const, row: next[0]! };
    });
    if (updated.kind === 'not_found') {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Item not found' } });
    }
    return reply.code(200).send({ ok: true, data: updated.row });
  });

  // POST /api/v1/inventory/items/:id/adjust
  app.post<{ Params: { id: string } }>('/api/v1/inventory/items/:id/adjust', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
    }
    if (!canWrite(req.scope)) {
      return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: 'Manager role required' } });
    }
    if (!UUID_RE.test(req.params.id)) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' } });
    }
    const parsed = AdjustSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const scope = req.scope;
    const d = parsed.data;

    const outcome = await withScope(db, scope, async (tx) => {
      const rows = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, req.params.id)).limit(1);
      const item = rows[0];
      if (!item) return { kind: 'not_found' as const };
      const scopeBranch = branchIdFromScope(scope);
      if (scopeBranch && item.branchId !== scopeBranch) return { kind: 'not_found' as const };

      const newOnHand = num(item.qtyOnHand) + d.deltaQty;
      if (d.reason === 'consumption' && newOnHand < 0) {
        return { kind: 'insufficient' as const, onHand: num(item.qtyOnHand) };
      }
      const values: Record<string, unknown> = {
        qtyOnHand: String(newOnHand),
        updatedAt: new Date(),
      };
      if (d.reason === 'receipt' && d.unitCostCents !== undefined) {
        values.unitCostCents = d.unitCostCents;
      }
      await tx.update(inventoryItems).set(values).where(eq(inventoryItems.id, item.id));
      const movement = await tx
        .insert(inventoryMovements)
        .values({
          branchId: item.branchId,
          itemId: item.id,
          deltaQty: String(d.deltaQty),
          reason: d.reason,
          refType: 'manual',
          unitCostCents: d.unitCostCents ?? null,
          note: d.note ?? null,
          actorUserId: scope.userId,
        })
        .returning();
      return { kind: 'ok' as const, onHand: newOnHand, movement: movement[0]! };
    });
    if (outcome.kind === 'not_found') {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Item not found' } });
    }
    if (outcome.kind === 'insufficient') {
      return reply.code(422).send({
        ok: false,
        error: { code: 'INSUFFICIENT_STOCK', message: `On-hand is ${outcome.onHand}; cannot consume below zero` },
      });
    }
    return reply.code(200).send({ ok: true, data: { qtyOnHand: outcome.onHand, movement: outcome.movement } });
  });

  // GET /api/v1/inventory/exceptions — reconciliation inbox (pending by default)
  app.get('/api/v1/inventory/exceptions', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
    }
    const scope = req.scope;
    const q = req.query as Record<string, string | undefined>;
    const status = ['pending', 'resolved', 'ignored'].includes(q['status'] ?? '')
      ? q['status']!
      : 'pending';
    const limit = Math.min(Math.max(parseInt(q['limit'] ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(q['offset'] ?? '0', 10) || 0, 0);

    const { rows, total } = await withScope(db, scope, async (tx) => {
      const conditions: unknown[] = [eq(inventoryConsumptionExceptions.status, status)];
      const scopeBranch = branchIdFromScope(scope);
      if (scopeBranch) conditions.push(eq(inventoryConsumptionExceptions.branchId, scopeBranch));
      const where = and(...(conditions as Parameters<typeof and>));
      const rows = await tx
        .select()
        .from(inventoryConsumptionExceptions)
        .where(where)
        .orderBy(desc(inventoryConsumptionExceptions.createdAt))
        .limit(limit)
        .offset(offset);
      const countRows = await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(inventoryConsumptionExceptions)
        .where(where);
      return { rows, total: countRows[0]?.c ?? 0 };
    });
    return reply.code(200).send({ ok: true, data: { rows, total, limit, offset } });
  });

  // POST /api/v1/inventory/exceptions/:id/resolve — link/create an item + consume
  app.post<{ Params: { id: string } }>(
    '/api/v1/inventory/exceptions/:id/resolve',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
      }
      if (!canWrite(req.scope)) {
        return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: 'Manager role required' } });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' } });
      }
      const parsed = ResolveExceptionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
      }
      const scope = req.scope;
      const d = parsed.data;

      const outcome = await withScope(db, scope, async (tx) => {
        const excRows = await tx
          .select()
          .from(inventoryConsumptionExceptions)
          .where(eq(inventoryConsumptionExceptions.id, req.params.id))
          .limit(1);
        const exc = excRows[0];
        if (!exc) return { kind: 'not_found' as const };
        const scopeBranch = branchIdFromScope(scope);
        if (scopeBranch && exc.branchId !== scopeBranch) return { kind: 'not_found' as const };
        if (exc.status !== 'pending') return { kind: 'already' as const };

        // Resolve the target item: link an existing one or create from input.
        let itemId: string;
        if (d.itemId) {
          const itRows = await tx
            .select({ id: inventoryItems.id, branchId: inventoryItems.branchId, qtyOnHand: inventoryItems.qtyOnHand })
            .from(inventoryItems)
            .where(eq(inventoryItems.id, d.itemId))
            .limit(1);
          const it = itRows[0];
          if (!it || it.branchId !== exc.branchId) return { kind: 'item_missing' as const };
          itemId = it.id;
        } else {
          const c = d.create!;
          const dupe = await tx
            .select({ id: inventoryItems.id })
            .from(inventoryItems)
            .where(and(eq(inventoryItems.branchId, exc.branchId), eq(inventoryItems.sku, c.sku)))
            .limit(1);
          if (dupe[0]) return { kind: 'dupe' as const };
          const created = await tx
            .insert(inventoryItems)
            .values({
              branchId: exc.branchId,
              sku: c.sku,
              name: c.name,
              category: c.category ?? null,
              unit: c.unit ?? 'each',
              unitCostCents: c.unitCostCents ?? 0,
              reorderPoint: String(c.reorderPoint ?? 0),
              reorderQty: String(c.reorderQty ?? 0),
              bin: c.bin ?? null,
            })
            .returning({ id: inventoryItems.id });
          itemId = created[0]!.id;
        }

        // Consume the exception's quantity from the resolved item.
        const cur = await tx
          .select({ qtyOnHand: inventoryItems.qtyOnHand })
          .from(inventoryItems)
          .where(eq(inventoryItems.id, itemId))
          .limit(1);
        const qty = Number(exc.quantity);
        const newOnHand = Number(cur[0]!.qtyOnHand) - qty;
        await tx
          .update(inventoryItems)
          .set({ qtyOnHand: String(newOnHand), updatedAt: new Date() })
          .where(eq(inventoryItems.id, itemId));
        await tx.insert(inventoryMovements).values({
          branchId: exc.branchId,
          itemId,
          deltaQty: String(-qty),
          reason: 'consumption',
          refType: 'job',
          refId: exc.jobId,
          note: 'Reconciled from consumption exception',
          actorUserId: scope.userId,
        });
        const updated = await tx
          .update(inventoryConsumptionExceptions)
          .set({ status: 'resolved', resolvedItemId: itemId, resolvedAt: new Date() })
          .where(eq(inventoryConsumptionExceptions.id, exc.id))
          .returning();
        return { kind: 'ok' as const, row: updated[0]!, itemId };
      });

      if (outcome.kind === 'not_found') {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Exception not found' } });
      }
      if (outcome.kind === 'item_missing') {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Target item not found' } });
      }
      if (outcome.kind === 'dupe') {
        return reply.code(409).send({ ok: false, error: { code: 'DUPLICATE_SKU', message: 'That SKU is already stocked' } });
      }
      if (outcome.kind === 'already') {
        return reply.code(409).send({ ok: false, error: { code: 'ALREADY_RESOLVED', message: 'Exception is not pending' } });
      }
      return reply.code(200).send({ ok: true, data: outcome.row });
    },
  );

  // POST /api/v1/inventory/exceptions/:id/ignore
  app.post<{ Params: { id: string } }>(
    '/api/v1/inventory/exceptions/:id/ignore',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
      }
      if (!canWrite(req.scope)) {
        return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: 'Manager role required' } });
      }
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' } });
      }
      const scope = req.scope;
      const outcome = await withScope(db, scope, async (tx) => {
        const excRows = await tx
          .select({ id: inventoryConsumptionExceptions.id, branchId: inventoryConsumptionExceptions.branchId, status: inventoryConsumptionExceptions.status })
          .from(inventoryConsumptionExceptions)
          .where(eq(inventoryConsumptionExceptions.id, req.params.id))
          .limit(1);
        const exc = excRows[0];
        if (!exc) return { kind: 'not_found' as const };
        const scopeBranch = branchIdFromScope(scope);
        if (scopeBranch && exc.branchId !== scopeBranch) return { kind: 'not_found' as const };
        if (exc.status !== 'pending') return { kind: 'already' as const };
        const updated = await tx
          .update(inventoryConsumptionExceptions)
          .set({ status: 'ignored', resolvedAt: new Date() })
          .where(eq(inventoryConsumptionExceptions.id, exc.id))
          .returning();
        return { kind: 'ok' as const, row: updated[0]! };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Exception not found' } });
      }
      if (outcome.kind === 'already') {
        return reply.code(409).send({ ok: false, error: { code: 'ALREADY_RESOLVED', message: 'Exception is not pending' } });
      }
      return reply.code(200).send({ ok: true, data: outcome.row });
    },
  );
}
