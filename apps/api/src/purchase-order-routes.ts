/**
 * Internal purchase orders (PO-02 + PO-03).
 *
 *   POST  /api/v1/purchase-orders                 create draft
 *   POST  /api/v1/purchase-orders/from-low-stock  draft seeded from low-stock
 *   GET   /api/v1/purchase-orders                 list (status/supplier filter)
 *   GET   /api/v1/purchase-orders/:id             PO + lines
 *   POST  /api/v1/purchase-orders/:id/submit      draft -> submitted
 *   POST  /api/v1/purchase-orders/:id/cancel      -> canceled
 *   POST  /api/v1/purchase-orders/:id/receive     receive lines -> stock up
 *
 * Branch-scoped; writes are manager / corporate_admin. Cross-tenant probe → 404.
 * Receiving replenishes inventory (upsert item + `receipt` movement) in the
 * same transaction as the PO line/status update, mirroring INV-03 discipline.
 *
 * `suppliers` is a corporate-only table (its `_scoped` RLS policy denies branch
 * roles), so supplier existence is validated under a synthetic corporate scope;
 * the PO itself is written under the caller's branch scope (the FK to suppliers
 * is enforced by Postgres regardless of RLS).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  inventoryItems,
  inventoryMovements,
  purchaseOrders,
  purchaseOrderLines,
  suppliers,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { ProviderRegistry, SupplierProvider } from '@service-ai/suppliers';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORP_SCOPE: RequestScope = { type: 'corporate', userId: 'po-validate', role: 'corporate_admin' };

function branchIdFromScope(scope: RequestScope): string | null {
  if (scope.type === 'corporate') return null;
  return scope.branchId;
}
function canWrite(scope: RequestScope): boolean {
  return scope.type === 'corporate' || scope.role === 'manager';
}

const LineSchema = z
  .object({
    sku: z.string().min(1).max(100),
    description: z.string().max(300).nullable().optional(),
    quantity: z.number().positive(),
    unitCostCents: z.number().int().min(0).default(0),
    itemId: z.string().uuid().nullable().optional(),
  })
  .strict();

const CreateSchema = z
  .object({
    supplierId: z.string().uuid(),
    expectedDate: z.string().datetime().optional(),
    notes: z.string().max(2000).optional(),
    branchId: z.string().uuid().optional(),
    lines: z.array(LineSchema).min(1),
  })
  .strict();

const FromLowStockSchema = z
  .object({
    supplierId: z.string().uuid(),
    branchId: z.string().uuid().optional(),
  })
  .strict();

const CheckAvailabilitySchema = z
  .object({
    supplierId: z.string().uuid(),
    items: z
      .array(z.object({ sku: z.string().min(1), quantity: z.number().positive() }).strict())
      .min(1)
      .max(200),
  })
  .strict();

const ReceiveSchema = z
  .object({
    lines: z
      .array(z.object({ lineId: z.string().uuid(), receiveQty: z.number().positive() }).strict())
      .min(1),
  })
  .strict();

function poNumber(seq: number): string {
  return `PO-${String(seq).padStart(6, '0')}`;
}

async function supplierExists(db: Drizzle, supplierId: string): Promise<boolean> {
  return withScope(db, CORP_SCOPE, async (tx) => {
    const rows = await tx.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
    return Boolean(rows[0]);
  });
}

/** Load a supplier's provider config under a corporate scope (suppliers RLS denies branches). */
async function loadSupplierConfig(db: Drizzle, supplierId: string) {
  return withScope(db, CORP_SCOPE, async (tx) => {
    const rows = await tx
      .select({
        id: suppliers.id,
        providerKind: suppliers.providerKind,
        endpointUrl: suppliers.endpointUrl,
        apiKeySecretRef: suppliers.apiKeySecretRef,
        supplierAccountCode: suppliers.supplierAccountCode,
      })
      .from(suppliers)
      .where(eq(suppliers.id, supplierId))
      .limit(1);
    return rows[0] ?? null;
  });
}

function bindProvider(
  registry: ProviderRegistry,
  supplier: { id: string; providerKind: string; endpointUrl: string; apiKeySecretRef: string; supplierAccountCode: string },
): SupplierProvider {
  return registry.bind({
    supplierId: supplier.id,
    providerKind: supplier.providerKind as 'bc_ai_agent' | 'mock',
    endpointUrl: supplier.endpointUrl,
    apiKey: process.env[supplier.apiKeySecretRef] ?? '',
    supplierAccountCode: supplier.supplierAccountCode,
  });
}

export function registerPurchaseOrderRoutes(
  app: FastifyInstance,
  db: Drizzle,
  registry: ProviderRegistry,
): void {
  // GET /api/v1/suppliers — corporate-shared vendor list (any authenticated
  // user; read under a corporate scope since `suppliers` RLS denies branches).
  app.get('/api/v1/suppliers', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
    }
    const rows = await withScope(db, CORP_SCOPE, async (tx) =>
      tx.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).orderBy(suppliers.name),
    );
    return reply.code(200).send({ ok: true, data: { rows } });
  });

  // POST /api/v1/purchase-orders
  app.post('/api/v1/purchase-orders', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
    }
    if (!canWrite(req.scope)) {
      return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: 'Manager role required' } });
    }
    const parsed = CreateSchema.safeParse(req.body ?? {});
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
    if (!(await supplierExists(db, d.supplierId))) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Supplier not found' } });
    }

    const created = await withScope(db, scope, async (tx) => {
      const seqRows = await tx.execute(sql`SELECT nextval('purchase_order_number_seq') AS n`);
      const seq = Number((seqRows.rows[0] as { n: string | number }).n);
      const subtotal = d.lines.reduce((s, l) => s + Math.round(l.quantity * l.unitCostCents), 0);
      const po = await tx
        .insert(purchaseOrders)
        .values({
          branchId,
          supplierId: d.supplierId,
          poNumber: poNumber(seq),
          status: 'draft',
          subtotalCents: subtotal,
          notes: d.notes ?? null,
          expectedDate: d.expectedDate ? new Date(d.expectedDate) : null,
          createdByUserId: scope.userId,
        })
        .returning();
      const lineRows = await tx
        .insert(purchaseOrderLines)
        .values(
          d.lines.map((l, i) => ({
            poId: po[0]!.id,
            branchId,
            position: i + 1,
            sku: l.sku,
            description: l.description ?? null,
            quantity: String(l.quantity),
            unitCostCents: l.unitCostCents,
            itemId: l.itemId ?? null,
          })),
        )
        .returning();
      return { po: po[0]!, lines: lineRows };
    });
    return reply.code(201).send({ ok: true, data: created });
  });

  // POST /api/v1/purchase-orders/from-low-stock
  app.post('/api/v1/purchase-orders/from-low-stock', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
    }
    if (!canWrite(req.scope)) {
      return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: 'Manager role required' } });
    }
    const parsed = FromLowStockSchema.safeParse(req.body ?? {});
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
    if (!(await supplierExists(db, d.supplierId))) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Supplier not found' } });
    }

    const outcome = await withScope(db, scope, async (tx) => {
      const lowItems = await tx
        .select()
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.branchId, branchId),
            eq(inventoryItems.active, true),
            sql`${inventoryItems.qtyOnHand} - ${inventoryItems.qtyReserved} <= ${inventoryItems.reorderPoint}`,
          ),
        );
      if (lowItems.length === 0) return { kind: 'empty' as const };

      const seqRows = await tx.execute(sql`SELECT nextval('purchase_order_number_seq') AS n`);
      const seq = Number((seqRows.rows[0] as { n: string | number }).n);
      const lines = lowItems.map((it) => {
        const available = Number(it.qtyOnHand) - Number(it.qtyReserved);
        const reorderQty = Number(it.reorderQty);
        const qty = reorderQty > 0 ? reorderQty : Math.max(1, Number(it.reorderPoint) - available);
        return {
          item: it,
          qty,
          cost: it.unitCostCents,
        };
      });
      const subtotal = lines.reduce((s, l) => s + Math.round(l.qty * l.cost), 0);
      const po = await tx
        .insert(purchaseOrders)
        .values({
          branchId,
          supplierId: d.supplierId,
          poNumber: poNumber(seq),
          status: 'draft',
          subtotalCents: subtotal,
          notes: 'Generated from low-stock report',
          createdByUserId: scope.userId,
        })
        .returning();
      const lineRows = await tx
        .insert(purchaseOrderLines)
        .values(
          lines.map((l, i) => ({
            poId: po[0]!.id,
            branchId,
            position: i + 1,
            sku: l.item.sku,
            description: l.item.name,
            quantity: String(l.qty),
            unitCostCents: l.cost,
            itemId: l.item.id,
          })),
        )
        .returning();
      return { kind: 'ok' as const, po: po[0]!, lines: lineRows };
    });
    if (outcome.kind === 'empty') {
      return reply.code(422).send({ ok: false, error: { code: 'NOTHING_LOW', message: 'No items are below their reorder point' } });
    }
    return reply.code(201).send({ ok: true, data: { po: outcome.po, lines: outcome.lines } });
  });

  // GET /api/v1/purchase-orders
  app.get('/api/v1/purchase-orders', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
    }
    const scope = req.scope;
    const q = req.query as Record<string, string | undefined>;
    const statusFilter = ['draft', 'submitted', 'partial', 'received', 'canceled'].includes(q['status'] ?? '')
      ? q['status']!
      : null;
    const supplierFilter = q['supplierId'] && UUID_RE.test(q['supplierId']) ? q['supplierId'] : null;
    const limit = Math.min(Math.max(parseInt(q['limit'] ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(q['offset'] ?? '0', 10) || 0, 0);

    const { rows, total } = await withScope(db, scope, async (tx) => {
      const conditions: unknown[] = [];
      const scopeBranch = branchIdFromScope(scope);
      if (scopeBranch) conditions.push(eq(purchaseOrders.branchId, scopeBranch));
      if (statusFilter) conditions.push(eq(purchaseOrders.status, statusFilter));
      if (supplierFilter) conditions.push(eq(purchaseOrders.supplierId, supplierFilter));
      const where = conditions.length > 0 ? and(...(conditions as Parameters<typeof and>)) : undefined;
      const rows = await tx
        .select()
        .from(purchaseOrders)
        .where(where)
        .orderBy(desc(purchaseOrders.createdAt))
        .limit(limit)
        .offset(offset);
      const countRows = await tx.select({ c: sql<number>`count(*)::int` }).from(purchaseOrders).where(where);
      return { rows, total: countRows[0]?.c ?? 0 };
    });
    return reply.code(200).send({ ok: true, data: { rows, total, limit, offset } });
  });

  // GET /api/v1/purchase-orders/:id
  app.get<{ Params: { id: string } }>('/api/v1/purchase-orders/:id', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
    }
    if (!UUID_RE.test(req.params.id)) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' } });
    }
    const scope = req.scope;
    const data = await withScope(db, scope, async (tx) => {
      const rows = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, req.params.id)).limit(1);
      const po = rows[0];
      if (!po) return null;
      const scopeBranch = branchIdFromScope(scope);
      if (scopeBranch && po.branchId !== scopeBranch) return null;
      const lines = await tx
        .select()
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.poId, po.id))
        .orderBy(purchaseOrderLines.position);
      return { po, lines };
    });
    if (!data) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Purchase order not found' } });
    }
    return reply.code(200).send({ ok: true, data });
  });

  // POST /api/v1/purchase-orders/:id/submit — flip to submitted + best-effort
  // push a real BC purchase order (TD-PO-01); stamp the BC ref on success.
  app.post<{ Params: { id: string } }>('/api/v1/purchase-orders/:id/submit', async (req, reply) => {
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

    // Phase 1: flip draft → submitted (local source of truth) + load lines.
    const flipped = await withScope(db, scope, async (tx) => {
      const rows = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, req.params.id)).limit(1);
      const po = rows[0];
      if (!po) return { kind: 'not_found' as const };
      const scopeBranch = branchIdFromScope(scope);
      if (scopeBranch && po.branchId !== scopeBranch) return { kind: 'not_found' as const };
      if (po.status !== 'draft') return { kind: 'invalid' as const, from: po.status };
      const upd = await tx
        .update(purchaseOrders)
        .set({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date() })
        .where(eq(purchaseOrders.id, po.id))
        .returning();
      const lines = await tx
        .select()
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.poId, po.id))
        .orderBy(purchaseOrderLines.position);
      return { kind: 'ok' as const, po: upd[0]!, lines };
    });

    if (flipped.kind === 'not_found') {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Purchase order not found' } });
    }
    if (flipped.kind === 'invalid') {
      return reply.code(409).send({ ok: false, error: { code: 'INVALID_TRANSITION', message: `cannot submit from ${flipped.from}` } });
    }

    // Phase 2 (best-effort, post-commit): push to BC. A failure leaves the PO
    // submitted with a null ref — a later resubmit/retry path can re-sync.
    let po = flipped.po;
    const supplier = await loadSupplierConfig(db, po.supplierId);
    if (supplier) {
      const provider = bindProvider(registry, supplier);
      if (provider.createPurchaseOrder) {
        const res = await provider.createPurchaseOrder({
          supplierAccountCode: supplier.supplierAccountCode,
          externalPoId: po.id,
          poNumber: po.poNumber ?? undefined,
          lines: flipped.lines.map((l) => ({
            sku: l.sku,
            quantity: Number(l.quantity),
            unitCostCents: l.unitCostCents,
            description: l.description ?? undefined,
          })),
          requestId: req.id,
        });
        if (res.ok) {
          const stamped = await withScope(db, scope, async (tx) =>
            tx
              .update(purchaseOrders)
              .set({
                supplierPoRef: res.data.supplierPoRef,
                supplierPoId: res.data.supplierPoId,
                bcSyncedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(purchaseOrders.id, po.id))
              .returning(),
          );
          po = stamped[0] ?? po;
        } else {
          req.log.warn({ poId: po.id, error: res.error }, 'BC purchase-order sync failed (PO left submitted)');
        }
      }
    }
    return reply.code(200).send({ ok: true, data: po });
  });

  // POST /api/v1/inventory/check-availability — supplier stock for a basket.
  app.post('/api/v1/inventory/check-availability', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
    }
    const parsed = CheckAvailabilitySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const supplier = await loadSupplierConfig(db, parsed.data.supplierId);
    if (!supplier) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Supplier not found' } });
    }
    const provider = bindProvider(registry, supplier);
    if (!provider.checkAvailability) {
      return reply.code(501).send({ ok: false, error: { code: 'NOT_SUPPORTED', message: 'Supplier has no availability surface' } });
    }
    const res = await provider.checkAvailability({
      supplierAccountCode: supplier.supplierAccountCode,
      items: parsed.data.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
      requestId: req.id,
    });
    if (!res.ok) {
      return reply.code(502).send({ ok: false, error: { code: res.error.code, message: res.error.message } });
    }
    return reply.code(200).send({ ok: true, data: res.data });
  });

  // POST /api/v1/purchase-orders/:id/cancel
  app.post<{ Params: { id: string } }>('/api/v1/purchase-orders/:id/cancel', async (req, reply) => {
    return transition(req, reply, 'cancel');
  });

  async function transition(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    action: 'submit' | 'cancel',
  ) {
    const params = req.params;
    if (req.scope === null) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
    }
    if (!canWrite(req.scope)) {
      return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: 'Manager role required' } });
    }
    if (!UUID_RE.test(params.id)) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' } });
    }
    const scope = req.scope;
    const outcome = await withScope(db, scope, async (tx) => {
      const rows = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, params.id)).limit(1);
      const po = rows[0];
      if (!po) return { kind: 'not_found' as const };
      const scopeBranch = branchIdFromScope(scope);
      if (scopeBranch && po.branchId !== scopeBranch) return { kind: 'not_found' as const };

      if (action === 'submit') {
        if (po.status !== 'draft') return { kind: 'invalid' as const, from: po.status, to: 'submitted' };
        const upd = await tx
          .update(purchaseOrders)
          .set({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date() })
          .where(eq(purchaseOrders.id, po.id))
          .returning();
        return { kind: 'ok' as const, row: upd[0]! };
      }
      // cancel
      if (po.status === 'received' || po.status === 'canceled') {
        return { kind: 'invalid' as const, from: po.status, to: 'canceled' };
      }
      const upd = await tx
        .update(purchaseOrders)
        .set({ status: 'canceled', updatedAt: new Date() })
        .where(eq(purchaseOrders.id, po.id))
        .returning();
      return { kind: 'ok' as const, row: upd[0]! };
    });
    if (outcome.kind === 'not_found') {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Purchase order not found' } });
    }
    if (outcome.kind === 'invalid') {
      return reply.code(409).send({
        ok: false,
        error: { code: 'INVALID_TRANSITION', message: `cannot ${action} from ${outcome.from}` },
      });
    }
    return reply.code(200).send({ ok: true, data: outcome.row });
  }

  // POST /api/v1/purchase-orders/:id/receive  (PO-03)
  app.post<{ Params: { id: string } }>('/api/v1/purchase-orders/:id/receive', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' } });
    }
    if (!canWrite(req.scope)) {
      return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN', message: 'Manager role required' } });
    }
    if (!UUID_RE.test(req.params.id)) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' } });
    }
    const parsed = ReceiveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }
    const scope = req.scope;

    const outcome = await withScope(db, scope, async (tx) => {
      const rows = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, req.params.id)).limit(1);
      const po = rows[0];
      if (!po) return { kind: 'not_found' as const };
      const scopeBranch = branchIdFromScope(scope);
      if (scopeBranch && po.branchId !== scopeBranch) return { kind: 'not_found' as const };
      if (po.status !== 'submitted' && po.status !== 'partial') {
        return { kind: 'invalid' as const, from: po.status };
      }
      const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, po.id));
      const byId = new Map(lines.map((l) => [l.id, l]));

      for (const recv of parsed.data.lines) {
        const line = byId.get(recv.lineId);
        if (!line) return { kind: 'line_missing' as const };
        const newReceived = Number(line.receivedQty) + recv.receiveQty;
        if (newReceived > Number(line.quantity)) {
          return { kind: 'over' as const, sku: line.sku };
        }
        // Upsert the branch inventory item by (branch, sku).
        const existing = await tx
          .select({ id: inventoryItems.id, qtyOnHand: inventoryItems.qtyOnHand })
          .from(inventoryItems)
          .where(and(eq(inventoryItems.branchId, po.branchId), eq(inventoryItems.sku, line.sku)))
          .limit(1);
        let itemId: string;
        if (existing[0]) {
          itemId = existing[0].id;
          await tx
            .update(inventoryItems)
            .set({
              qtyOnHand: String(Number(existing[0].qtyOnHand) + recv.receiveQty),
              unitCostCents: line.unitCostCents,
              updatedAt: new Date(),
            })
            .where(eq(inventoryItems.id, itemId));
        } else {
          const createdItem = await tx
            .insert(inventoryItems)
            .values({
              branchId: po.branchId,
              sku: line.sku,
              name: line.description ?? line.sku,
              unitCostCents: line.unitCostCents,
              qtyOnHand: String(recv.receiveQty),
            })
            .returning({ id: inventoryItems.id });
          itemId = createdItem[0]!.id;
        }
        await tx.insert(inventoryMovements).values({
          branchId: po.branchId,
          itemId,
          deltaQty: String(recv.receiveQty),
          reason: 'receipt',
          refType: 'po',
          refId: po.id,
          unitCostCents: line.unitCostCents,
          note: `Received against ${po.poNumber ?? 'PO'}`,
          actorUserId: scope.userId,
        });
        await tx
          .update(purchaseOrderLines)
          .set({ receivedQty: String(newReceived), itemId, updatedAt: new Date() })
          .where(eq(purchaseOrderLines.id, line.id));
        byId.set(line.id, { ...line, receivedQty: String(newReceived) });
      }

      // Recompute PO status from the updated line set.
      const updatedLines = [...byId.values()];
      const allReceived = updatedLines.every((l) => Number(l.receivedQty) >= Number(l.quantity));
      const anyReceived = updatedLines.some((l) => Number(l.receivedQty) > 0);
      const nextStatus = allReceived ? 'received' : anyReceived ? 'partial' : po.status;
      const upd = await tx
        .update(purchaseOrders)
        .set({
          status: nextStatus,
          receivedAt: allReceived ? new Date() : po.receivedAt,
          updatedAt: new Date(),
        })
        .where(eq(purchaseOrders.id, po.id))
        .returning();
      return { kind: 'ok' as const, row: upd[0]! };
    });

    if (outcome.kind === 'not_found') {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'Purchase order not found' } });
    }
    if (outcome.kind === 'line_missing') {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'PO line not found' } });
    }
    if (outcome.kind === 'over') {
      return reply.code(422).send({ ok: false, error: { code: 'OVER_RECEIPT', message: `Cannot receive ${outcome.sku} beyond the ordered quantity` } });
    }
    if (outcome.kind === 'invalid') {
      return reply.code(409).send({ ok: false, error: { code: 'INVALID_TRANSITION', message: `cannot receive a ${outcome.from} PO` } });
    }
    return reply.code(200).send({ ok: true, data: outcome.row });
  });
}
