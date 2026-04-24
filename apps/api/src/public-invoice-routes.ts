/**
 * Public (token-gated) invoice surface + receipt PDF (TASK-IP-07).
 *
 *   GET /api/v1/public/invoices/:token        JSON summary for the pay page
 *   GET /api/v1/invoices/:id/receipt.pdf      PDF receipt (authenticated)
 *
 * Token routes are deliberately OUTSIDE RequestScope — a paying
 * customer has no Service.AI account, so we authenticate with the
 * 32-byte random token stored on the invoice row. The unique
 * partial index on payment_link_token makes lookups cheap.
 *
 * Exposed fields are deliberately narrow: enough to render the
 * pay page and kick off Stripe Elements, nothing more. Customer
 * name is included (since the customer already knows it); the
 * franchisee legal name is included so the receipt shows who
 * they're paying.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  customers,
  franchisees,
  invoices,
  invoiceLineItems,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import { renderReceiptPdf, type ReceiptLine } from './receipt-pdf.js';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/;

function scopedFranchiseeId(scope: RequestScope): string | null {
  if (scope.type === 'platform' || scope.type === 'franchisor') return null;
  return scope.franchiseeId;
}

export function registerPublicInvoiceRoutes(
  app: FastifyInstance,
  db: Drizzle,
): void {
  // ----- GET /api/v1/public/invoices/:token (no auth) -----------------------
  app.get<{ Params: { token: string } }>(
    '/api/v1/public/invoices/:token',
    async (req, reply) => {
      if (!TOKEN_RE.test(req.params.token)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'bad token shape' },
        });
      }
      const invRows = await db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.paymentLinkToken, req.params.token),
            isNull(invoices.deletedAt),
          ),
        );
      const inv = invRows[0];
      if (!inv) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Invoice not found' },
        });
      }
      const feRows = await db
        .select({
          name: franchisees.name,
          legalEntityName: franchisees.legalEntityName,
        })
        .from(franchisees)
        .where(eq(franchisees.id, inv.franchiseeId));
      const custRows = await db
        .select({ name: customers.name })
        .from(customers)
        .where(eq(customers.id, inv.customerId));

      return reply.code(200).send({
        ok: true,
        data: {
          status: inv.status,
          subtotal: inv.subtotal,
          taxAmount: inv.taxAmount,
          total: inv.total,
          currency: 'usd',
          customerName: custRows[0]?.name ?? 'Customer',
          franchiseeName:
            feRows[0]?.legalEntityName ?? feRows[0]?.name ?? 'Service provider',
          paymentIntentId: inv.stripePaymentIntentId,
          paidAt: inv.paidAt,
        },
      });
    },
  );

  // ----- GET /api/v1/invoices/:id/receipt.pdf (authenticated) ---------------
  app.get<{ Params: { id: string } }>(
    '/api/v1/invoices/:id/receipt.pdf',
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
      const loaded = await withScope(db, scope, async (tx) => {
        const rows = await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.id, req.params.id), isNull(invoices.deletedAt)));
        const inv = rows[0];
        if (!inv) return null;
        const feScope = scopedFranchiseeId(scope);
        if (feScope && inv.franchiseeId !== feScope) return null;
        const feRows = await tx
          .select()
          .from(franchisees)
          .where(eq(franchisees.id, inv.franchiseeId));
        const franchisee = feRows[0];
        if (!franchisee) return null;
        if (
          scope.type === 'franchisor' &&
          franchisee.franchisorId !== scope.franchisorId
        )
          return null;
        const custRows = await tx
          .select()
          .from(customers)
          .where(eq(customers.id, inv.customerId));
        const customer = custRows[0];
        if (!customer) return null;
        const lineRows = await tx
          .select()
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, inv.id))
          .orderBy(invoiceLineItems.sortOrder);
        return { inv, franchisee, customer, lineRows };
      });

      if (!loaded) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Invoice not found' },
        });
      }
      if (loaded.inv.status === 'draft') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'INVALID_TRANSITION',
            message: 'Draft invoices do not have receipts',
          },
        });
      }
      const lines: ReceiptLine[] = loaded.lineRows.map((l) => ({
        sku: l.sku,
        name: l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
      }));
      const pdf = await renderReceiptPdf({
        franchiseeName:
          loaded.franchisee.legalEntityName ?? loaded.franchisee.name,
        customerName: loaded.customer.name,
        customerEmail: loaded.customer.email,
        invoiceNumber: loaded.inv.id.slice(0, 8).toUpperCase(),
        status: loaded.inv.status,
        issuedAt: loaded.inv.finalizedAt ?? loaded.inv.createdAt,
        lines,
        subtotal: loaded.inv.subtotal,
        taxAmount: loaded.inv.taxAmount,
        total: loaded.inv.total,
        paidAt: loaded.inv.paidAt,
        notes: loaded.inv.notes,
      });
      reply.header('content-type', 'application/pdf');
      reply.header(
        'content-disposition',
        `inline; filename="invoice-${loaded.inv.id.slice(0, 8)}.pdf"`,
      );
      return reply.code(200).send(pdf);
    },
  );
}
