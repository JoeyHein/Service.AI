/**
 * Balance invoice generation on job completion (QF-03).
 *
 * When a job that was spawned from an accepted quote reaches `completed`,
 * Service.AI drafts the balance invoice: the quote's line items mirrored
 * (informational), a negative "Deposit (paid)" credit line for any deposit
 * already collected, and `total` = the balance due (quote total − deposit).
 * The office reviews + finalizes + sends; finalize charges `total`.
 *
 * One balance invoice per quote — guarded by the partial-unique index on
 * `invoices.quote_id` (live rows); this helper also checks first so a replay
 * is a clean no-op rather than a constraint error. Runs inside the caller's
 * completion transaction.
 *
 * A job with no linked quote (a plain service job) gets nothing here — the
 * existing manual `POST /jobs/:id/invoices` flow is unchanged.
 */
import { and, eq, isNull } from 'drizzle-orm';
import {
  invoices,
  invoiceLineItems,
  quotes,
  quoteLineItems,
  type ScopedTx,
} from '@service-ai/db';

/** cents → fixed(2) dollar string for the numeric(12,2) invoice columns. */
function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

export async function generateBalanceInvoiceOnCompletion(
  tx: ScopedTx,
  args: {
    job: { id: string; branchId: string; customerId: string; quoteId: string | null };
    actorUserId: string | null;
  },
): Promise<string | null> {
  const { job } = args;
  if (!job.quoteId) return null; // plain service job — no auto-invoice.

  // Idempotency: at most one live balance invoice per quote.
  const existing = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.quoteId, job.quoteId), isNull(invoices.deletedAt)))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const qRows = await tx
    .select({
      subtotalCents: quotes.subtotalCents,
      taxCents: quotes.taxCents,
      totalCents: quotes.totalCents,
      depositAmountCents: quotes.depositAmountCents,
      depositPaidAt: quotes.depositPaidAt,
      supplierQuoteRef: quotes.supplierQuoteRef,
    })
    .from(quotes)
    .where(eq(quotes.id, job.quoteId))
    .limit(1);
  const q = qRows[0];
  if (!q) return null;

  const depositPaidCents =
    q.depositPaidAt && q.depositAmountCents ? q.depositAmountCents : 0;
  const balanceCents = q.totalCents - depositPaidCents;

  const lines = await tx
    .select({
      supplierSku: quoteLineItems.supplierSku,
      description: quoteLineItems.description,
      quantity: quoteLineItems.quantity,
      unitPriceCents: quoteLineItems.unitPriceCents,
      lineTotalCents: quoteLineItems.lineTotalCents,
    })
    .from(quoteLineItems)
    .where(eq(quoteLineItems.quoteId, job.quoteId))
    .orderBy(quoteLineItems.position);

  const inserted = await tx
    .insert(invoices)
    .values({
      branchId: job.branchId,
      jobId: job.id,
      customerId: job.customerId,
      quoteId: job.quoteId,
      status: 'draft',
      subtotal: dollars(q.subtotalCents),
      taxRate: '0',
      taxAmount: dollars(q.taxCents),
      // total = balance due. The deposit credit line below documents the
      // gap between (subtotal + tax) and total.
      total: dollars(balanceCents),
      notes: q.supplierQuoteRef ? `Balance for accepted quote ${q.supplierQuoteRef}` : null,
      createdByUserId: args.actorUserId,
    })
    .returning({ id: invoices.id });
  const invoiceId = inserted[0]!.id;

  const lineValues = lines.map((l, idx) => ({
    invoiceId,
    branchId: job.branchId,
    serviceItemId: null,
    sku: l.supplierSku,
    name: l.description ?? l.supplierSku,
    quantity: l.quantity,
    unitPrice: dollars(l.unitPriceCents),
    lineTotal: dollars(l.lineTotalCents),
    sortOrder: idx,
  }));
  if (depositPaidCents > 0) {
    lineValues.push({
      invoiceId,
      branchId: job.branchId,
      serviceItemId: null,
      sku: 'DEPOSIT',
      name: 'Deposit (paid)',
      quantity: '1',
      unitPrice: dollars(-depositPaidCents),
      lineTotal: dollars(-depositPaidCents),
      sortOrder: lineValues.length,
    });
  }
  if (lineValues.length > 0) {
    await tx.insert(invoiceLineItems).values(lineValues);
  }

  return invoiceId;
}
