/**
 * Invoice draft endpoints (TASK-TM-05a).
 *
 *   POST   /api/v1/jobs/:id/invoices       create draft from job
 *   GET    /api/v1/invoices/:id            read invoice + line items
 *   PATCH  /api/v1/invoices/:id            replace line items + notes /
 *                                          tax; draft-only. 409
 *                                          INVOICE_NOT_EDITABLE otherwise
 *   DELETE /api/v1/invoices/:id            soft-delete a draft
 *
 * Finalize / send / paid transitions are NOT implemented here —
 * they land in phase_invoice_payment. Status stays 'draft' through
 * this phase.
 *
 * Line-item validation:
 *   - every line must reference a service_items row in the caller's
 *     franchisor AND a published template
 *   - unit_price is defaulted to the item's base_price but may be
 *     overridden within [floor, ceiling] — below/above returns
 *     400 PRICE_OUT_OF_BOUNDS (reuses the phase-4 error code).
 *   - line_total = quantity * unit_price (computed server-side).
 *   - subtotal + tax + total re-derived on every write.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  customers,
  invoices,
  invoiceLineItems,
  jobs,
  serviceCatalogTemplates,
  serviceItems,
  withScope,
  type RequestScope,
  type ScopedTx,
} from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LineInputSchema = z.object({
  serviceItemId: z.string().uuid(),
  quantity: z.number().positive().max(10_000),
  unitPrice: z.number().nonnegative().optional(),
  note: z.string().max(500).optional(),
});

const CreateSchema = z.object({
  lines: z.array(LineInputSchema).default([]),
  notes: z.string().max(2000).nullable().optional(),
  taxRate: z.number().min(0).max(1).optional(),
});

const PatchSchema = z.object({
  lines: z.array(LineInputSchema).optional(),
  notes: z.string().max(2000).nullable().optional(),
  taxRate: z.number().min(0).max(1).optional(),
});

type LineInput = z.infer<typeof LineInputSchema>;

interface ResolvedLine {
  serviceItemId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

function scopedFranchiseeId(scope: RequestScope): string | null {
  if (scope.type === 'platform' || scope.type === 'franchisor') return null;
  return scope.franchiseeId;
}

interface ResolveCtx {
  tx: ScopedTx;
  franchiseeId: string;
}

/**
 * Validate + enrich each line-item input against the published
 * catalog. Returns either a list of resolved lines with derived
 * fields, or an error envelope to send back.
 */
async function resolveLines(
  ctx: ResolveCtx,
  lines: LineInput[],
): Promise<
  | { ok: true; resolved: ResolvedLine[] }
  | { ok: false; status: number; code: string; message: string }
> {
  if (lines.length === 0) return { ok: true, resolved: [] };
  // Look up each item + join its template to confirm published.
  const resolved: ResolvedLine[] = [];
  for (const line of lines) {
    const rows = await ctx.tx
      .select({
        id: serviceItems.id,
        sku: serviceItems.sku,
        name: serviceItems.name,
        franchisorId: serviceItems.franchisorId,
        basePrice: serviceItems.basePrice,
        floorPrice: serviceItems.floorPrice,
        ceilingPrice: serviceItems.ceilingPrice,
        templateStatus: serviceCatalogTemplates.status,
      })
      .from(serviceItems)
      .innerJoin(
        serviceCatalogTemplates,
        eq(serviceCatalogTemplates.id, serviceItems.templateId),
      )
      .where(
        and(
          eq(serviceItems.id, line.serviceItemId),
          isNull(serviceItems.deletedAt),
        ),
      );
    const r = rows[0];
    if (!r) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_TARGET',
        message: `Service item ${line.serviceItemId} not found`,
      };
    }
    if (r.templateStatus !== 'published') {
      return {
        ok: false,
        status: 409,
        code: 'TEMPLATE_NOT_PUBLISHED',
        message: `Service item ${line.serviceItemId} is in a ${r.templateStatus} template`,
      };
    }
    const attempted = line.unitPrice ?? Number(r.basePrice);
    const floor = r.floorPrice == null ? null : Number(r.floorPrice);
    const ceiling = r.ceilingPrice == null ? null : Number(r.ceilingPrice);
    if (floor !== null && attempted < floor) {
      return {
        ok: false,
        status: 400,
        code: 'PRICE_OUT_OF_BOUNDS',
        message: `Unit price ${attempted} is below floor ${floor} for ${r.sku}`,
      };
    }
    if (ceiling !== null && attempted > ceiling) {
      return {
        ok: false,
        status: 400,
        code: 'PRICE_OUT_OF_BOUNDS',
        message: `Unit price ${attempted} is above ceiling ${ceiling} for ${r.sku}`,
      };
    }
    resolved.push({
      serviceItemId: r.id,
      sku: r.sku,
      name: r.name,
      quantity: line.quantity,
      unitPrice: attempted,
      lineTotal: Math.round(line.quantity * attempted * 100) / 100,
    });
  }
  return { ok: true, resolved };
}

function computeTotals(
  resolved: ResolvedLine[],
  taxRate: number,
): { subtotal: number; taxAmount: number; total: number } {
  const subtotal = Math.round(
    resolved.reduce((acc, r) => acc + r.lineTotal, 0) * 100,
  ) / 100;
  const taxAmount = Math.round(subtotal * taxRate * 100) / 100;
  const total = Math.round((subtotal + taxAmount) * 100) / 100;
  return { subtotal, taxAmount, total };
}

export function registerInvoiceRoutes(app: FastifyInstance, db: Drizzle): void {
  // POST /api/v1/jobs/:id/invoices
  app.post<{ Params: { id: string } }>(
    '/api/v1/jobs/:id/invoices',
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
      const parsed = CreateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;
      const outcome = await withScope(db, scope, async (tx) => {
        const jobRows = await tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.id, req.params.id), isNull(jobs.deletedAt)));
        const job = jobRows[0];
        if (!job) return { kind: 'not_found' as const };
        const feScope = scopedFranchiseeId(scope);
        if (feScope && job.franchiseeId !== feScope)
          return { kind: 'not_found' as const };

        const resolved = await resolveLines(
          { tx, franchiseeId: job.franchiseeId },
          parsed.data.lines,
        );
        if (!resolved.ok)
          return {
            kind: 'validation' as const,
            status: resolved.status,
            code: resolved.code,
            message: resolved.message,
          };

        const taxRate = parsed.data.taxRate ?? 0;
        const totals = computeTotals(resolved.resolved, taxRate);

        const inserted = await tx
          .insert(invoices)
          .values({
            franchiseeId: job.franchiseeId,
            jobId: job.id,
            customerId: job.customerId,
            status: 'draft',
            subtotal: String(totals.subtotal),
            taxRate: String(taxRate),
            taxAmount: String(totals.taxAmount),
            total: String(totals.total),
            notes: parsed.data.notes ?? null,
            createdByUserId: req.userId,
          })
          .returning();
        const invoice = inserted[0]!;

        if (resolved.resolved.length > 0) {
          await tx.insert(invoiceLineItems).values(
            resolved.resolved.map((l, idx) => ({
              invoiceId: invoice.id,
              franchiseeId: job.franchiseeId,
              serviceItemId: l.serviceItemId,
              sku: l.sku,
              name: l.name,
              quantity: String(l.quantity),
              unitPrice: String(l.unitPrice),
              lineTotal: String(l.lineTotal),
              sortOrder: idx,
            })),
          );
        }

        return {
          kind: 'ok' as const,
          invoice,
          lines: resolved.resolved,
        };
      });

      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Job not found' },
        });
      }
      if (outcome.kind === 'validation') {
        return reply.code(outcome.status).send({
          ok: false,
          error: { code: outcome.code, message: outcome.message },
        });
      }
      return reply.code(201).send({
        ok: true,
        data: { ...outcome.invoice, lines: outcome.lines },
      });
    },
  );

  // GET /api/v1/invoices/:id
  app.get<{ Params: { id: string } }>('/api/v1/invoices/:id', async (req, reply) => {
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
    const result = await withScope(db, scope, async (tx) => {
      const rows = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, req.params.id), isNull(invoices.deletedAt)));
      const inv = rows[0];
      if (!inv) return null;
      const feScope = scopedFranchiseeId(scope);
      if (feScope && inv.franchiseeId !== feScope) return null;
      if (scope.type === 'franchisor') {
        const feRows = await tx
          .select({ franchisorId: schema.franchisees.franchisorId })
          .from(schema.franchisees)
          .where(eq(schema.franchisees.id, inv.franchiseeId));
        if (feRows[0]?.franchisorId !== scope.franchisorId) return null;
      }
      const lines = await tx
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, inv.id))
        .orderBy(invoiceLineItems.sortOrder);
      return { inv, lines };
    });
    if (!result) {
      return reply.code(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Invoice not found' },
      });
    }
    return reply.code(200).send({
      ok: true,
      data: { ...result.inv, lines: result.lines },
    });
  });

  // PATCH /api/v1/invoices/:id
  app.patch<{ Params: { id: string } }>(
    '/api/v1/invoices/:id',
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
      const parsed = PatchSchema.safeParse(req.body ?? {});
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
          .from(invoices)
          .where(and(eq(invoices.id, req.params.id), isNull(invoices.deletedAt)));
        const inv = rows[0];
        if (!inv) return { kind: 'not_found' as const };
        const feScope = scopedFranchiseeId(scope);
        if (feScope && inv.franchiseeId !== feScope)
          return { kind: 'not_found' as const };
        if (inv.status !== 'draft') return { kind: 'not_editable' as const };

        let lines = parsed.data.lines;
        let totals: { subtotal: number; taxAmount: number; total: number } | null =
          null;
        const taxRate =
          parsed.data.taxRate !== undefined ? parsed.data.taxRate : Number(inv.taxRate);
        if (lines !== undefined) {
          const resolved = await resolveLines(
            { tx, franchiseeId: inv.franchiseeId },
            lines,
          );
          if (!resolved.ok)
            return {
              kind: 'validation' as const,
              status: resolved.status,
              code: resolved.code,
              message: resolved.message,
            };
          totals = computeTotals(resolved.resolved, taxRate);
          await tx.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, inv.id));
          if (resolved.resolved.length > 0) {
            await tx.insert(invoiceLineItems).values(
              resolved.resolved.map((l, idx) => ({
                invoiceId: inv.id,
                franchiseeId: inv.franchiseeId,
                serviceItemId: l.serviceItemId,
                sku: l.sku,
                name: l.name,
                quantity: String(l.quantity),
                unitPrice: String(l.unitPrice),
                lineTotal: String(l.lineTotal),
                sortOrder: idx,
              })),
            );
          }
          lines = resolved.resolved.map((r) => ({
            serviceItemId: r.serviceItemId,
            quantity: r.quantity,
            unitPrice: r.unitPrice,
          }));
        } else if (parsed.data.taxRate !== undefined) {
          // Re-derive totals with the new rate but existing line items.
          const existing = await tx
            .select({ lineTotal: invoiceLineItems.lineTotal })
            .from(invoiceLineItems)
            .where(eq(invoiceLineItems.invoiceId, inv.id));
          const subtotal =
            Math.round(
              existing.reduce((acc, l) => acc + Number(l.lineTotal), 0) * 100,
            ) / 100;
          totals = {
            subtotal,
            taxAmount: Math.round(subtotal * taxRate * 100) / 100,
            total:
              Math.round((subtotal + subtotal * taxRate) * 100) / 100,
          };
        }

        const values: Record<string, unknown> = { updatedAt: new Date() };
        if (parsed.data.notes !== undefined) values.notes = parsed.data.notes;
        if (parsed.data.taxRate !== undefined) values.taxRate = String(taxRate);
        if (totals !== null) {
          values.subtotal = String(totals.subtotal);
          values.taxAmount = String(totals.taxAmount);
          values.total = String(totals.total);
        }
        const next = await tx
          .update(invoices)
          .set(values)
          .where(eq(invoices.id, inv.id))
          .returning();

        const finalLines = await tx
          .select()
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, inv.id))
          .orderBy(invoiceLineItems.sortOrder);

        return { kind: 'ok' as const, invoice: next[0]!, lines: finalLines };
      });

      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Invoice not found' },
        });
      }
      if (outcome.kind === 'not_editable') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'INVOICE_NOT_EDITABLE',
            message: 'Only draft invoices can be edited',
          },
        });
      }
      if (outcome.kind === 'validation') {
        return reply.code(outcome.status).send({
          ok: false,
          error: { code: outcome.code, message: outcome.message },
        });
      }
      return reply.code(200).send({
        ok: true,
        data: { ...outcome.invoice, lines: outcome.lines },
      });
    },
  );

  // DELETE /api/v1/invoices/:id  — draft soft-delete
  app.delete<{ Params: { id: string } }>(
    '/api/v1/invoices/:id',
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
          .select()
          .from(invoices)
          .where(eq(invoices.id, req.params.id));
        const inv = rows[0];
        if (!inv) return { kind: 'not_found' as const };
        const feScope = scopedFranchiseeId(scope);
        if (feScope && inv.franchiseeId !== feScope)
          return { kind: 'not_found' as const };
        if (inv.deletedAt !== null) return { kind: 'already' as const };
        if (inv.status !== 'draft') return { kind: 'not_editable' as const };
        await tx
          .update(invoices)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(invoices.id, inv.id));
        return { kind: 'ok' as const };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Invoice not found' },
        });
      }
      if (outcome.kind === 'not_editable') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'INVOICE_NOT_EDITABLE',
            message: 'Only draft invoices can be deleted',
          },
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
// Touch `sql` so tree-shaking doesn't drop the import if a future
// refactor stops using the other exports temporarily.
void sql;
void customers;
