/**
 * Auto-consume branch inventory on job completion (INV-03).
 *
 * When a job spawned from an accepted quote reaches `completed`, the parts on
 * that quote were physically used. We decrement the branch's stock for each
 * line whose `supplier_sku` matches a stocked item, writing a `consumption`
 * movement (ref = the job). Auto-consume is allowed to drive on-hand negative —
 * the parts were used; a negative balance flags a stock discrepancy for the
 * manager rather than blocking the completion.
 *
 * A line whose SKU has no stocked match becomes an
 * `inventory_consumption_exceptions` row for the reconciliation inbox.
 *
 * Idempotent: if any `consumption` movement already references this job, the
 * helper is a no-op (a re-completion / replay can't double-deduct). Runs inside
 * the caller's completion transaction so stock, the ledger, and the balance
 * invoice all commit together.
 */
import { and, eq } from 'drizzle-orm';
import {
  inventoryItems,
  inventoryMovements,
  inventoryConsumptionExceptions,
  quoteLineItems,
  type ScopedTx,
} from '@service-ai/db';

export async function consumeInventoryForJob(
  tx: ScopedTx,
  args: {
    job: { id: string; branchId: string; quoteId: string | null };
    actorUserId: string | null;
  },
): Promise<{ consumed: number; exceptions: number } | null> {
  const { job } = args;
  if (!job.quoteId) return null; // plain service job — nothing to consume.

  // Idempotency: skip if this job already produced consumption movements.
  const prior = await tx
    .select({ id: inventoryMovements.id })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.refType, 'job'),
        eq(inventoryMovements.refId, job.id),
        eq(inventoryMovements.reason, 'consumption'),
      ),
    )
    .limit(1);
  if (prior[0]) return { consumed: 0, exceptions: 0 };

  const lines = await tx
    .select({
      supplierSku: quoteLineItems.supplierSku,
      description: quoteLineItems.description,
      quantity: quoteLineItems.quantity,
    })
    .from(quoteLineItems)
    .where(eq(quoteLineItems.quoteId, job.quoteId));

  let consumed = 0;
  let exceptions = 0;
  for (const line of lines) {
    const qty = Number(line.quantity);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const matches = await tx
      .select({ id: inventoryItems.id, qtyOnHand: inventoryItems.qtyOnHand })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.branchId, job.branchId),
          eq(inventoryItems.sku, line.supplierSku),
          eq(inventoryItems.active, true),
        ),
      )
      .limit(1);
    const item = matches[0];

    if (item) {
      const newOnHand = Number(item.qtyOnHand) - qty;
      await tx
        .update(inventoryItems)
        .set({ qtyOnHand: String(newOnHand), updatedAt: new Date() })
        .where(eq(inventoryItems.id, item.id));
      await tx.insert(inventoryMovements).values({
        branchId: job.branchId,
        itemId: item.id,
        deltaQty: String(-qty),
        reason: 'consumption',
        refType: 'job',
        refId: job.id,
        note: 'Auto-consumed on job completion',
        actorUserId: args.actorUserId,
      });
      consumed += 1;
    } else {
      await tx.insert(inventoryConsumptionExceptions).values({
        branchId: job.branchId,
        jobId: job.id,
        quoteId: job.quoteId,
        sku: line.supplierSku,
        description: line.description,
        quantity: String(qty),
      });
      exceptions += 1;
    }
  }
  return { consumed, exceptions };
}
