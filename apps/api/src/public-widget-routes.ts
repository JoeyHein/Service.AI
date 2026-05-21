/**
 * Public door-designer widget intake (WI-01).
 *
 *   POST /api/v1/public/widget/quote-request
 *
 * The OPENDC door-designer widget (bc-ai-agent/widget, a standalone IIFE)
 * POSTs `{ contact, doorConfig, doorImage, source?, timestamp }` here when a
 * homeowner finishes configuring a door on a public site (elevateddoors.com).
 * This is an inbound lead — no auth; the route runs OUTSIDE RequestScope.
 *
 * v1 = lead capture (not auto-priced): the widget yields a human-readable
 * doorConfig, not resolved BC SKUs (SKU resolution lives in BC AI Agent's
 * part_number_service). We find-or-create the customer and open a DRAFT quote
 * capturing the config in notes; a manager prices it in the quote builder.
 * Auto-resolution (config → SKUs → priced lines) is a TD follow-up.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  branches,
  customers,
  quotes,
  suppliers,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import { storeDoorImage, type ObjectStore } from './object-store.js';

type Drizzle = NodePgDatabase<typeof schema>;

const PayloadSchema = z
  .object({
    contact: z.object({
      name: z.string().min(1).max(200),
      email: z.string().email().max(200).optional(),
      phone: z.string().max(50).optional(),
      postalCode: z.string().max(20).optional(),
      notes: z.string().max(2000).optional(),
    }),
    // The widget's doorConfig is an evolving open object; accept it as-is.
    doorConfig: z.record(z.string(), z.unknown()).default({}),
    doorImage: z.string().optional(),
    source: z.string().max(50).optional(),
    timestamp: z.string().optional(),
  })
  .strict();

/** Human-readable one-line summary of the configured door for the notes. */
function summarizeConfig(cfg: Record<string, unknown>): string {
  const parts = [cfg['family'], cfg['size'], cfg['design'], cfg['color']]
    .filter((v) => typeof v === 'string' && v)
    .join(' · ');
  const windows = cfg['windows'] && cfg['windows'] !== 'None' ? ` · windows: ${String(cfg['windows'])}` : '';
  return parts + windows;
}

export function registerPublicWidgetRoutes(
  app: FastifyInstance,
  db: Drizzle,
  objectStore: ObjectStore,
): void {
  app.post('/api/v1/public/widget/quote-request', async (req, reply) => {
    if ((req.headers['content-type'] ?? '').includes('application/json') === false) {
      return reply.code(415).send({
        ok: false,
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'JSON body required' },
      });
    }
    const parsed = PayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }
    const { contact, doorConfig, doorImage, source } = parsed.data;

    // Resolve the intake branch (single-branch pilot: LEAD_INTAKE_BRANCH_SLUG
    // or the first branch) and the corporate default supplier.
    const intakeSlug = process.env['LEAD_INTAKE_BRANCH_SLUG'];
    const branchRows = await db
      .select({ id: branches.id })
      .from(branches)
      .where(intakeSlug ? eq(branches.slug, intakeSlug) : undefined)
      .orderBy(asc(branches.createdAt))
      .limit(1);
    const branch = branchRows[0];
    const supRows = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .orderBy(asc(suppliers.createdAt))
      .limit(1);
    const supplier = supRows[0];
    if (!branch || !supplier) {
      return reply.code(503).send({
        ok: false,
        error: { code: 'NOT_CONFIGURED', message: 'Lead intake is not configured yet' },
      });
    }

    const scope: RequestScope = {
      type: 'branch',
      userId: 'widget-lead',
      role: 'csr',
      branchId: branch.id,
    };
    const configSummary = summarizeConfig(doorConfig);

    const result = await withScope(db, scope, async (tx) => {
      // Find-or-create the customer by email within the branch.
      let customerId: string | null = null;
      if (contact.email) {
        const existing = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(
            and(
              eq(customers.branchId, branch.id),
              eq(customers.email, contact.email),
              isNull(customers.deletedAt),
            ),
          )
          .limit(1);
        customerId = existing[0]?.id ?? null;
      }
      if (!customerId) {
        const ins = await tx
          .insert(customers)
          .values({
            branchId: branch.id,
            name: contact.name,
            email: contact.email ?? null,
            phone: contact.phone ?? null,
            postalCode: contact.postalCode ?? null,
            notes: `Web lead (door designer${source ? `: ${source}` : ''})`,
            createdByUserId: null,
          })
          .returning({ id: customers.id });
        customerId = ins[0]!.id;
      }

      const quoteNotes =
        `Door designer lead — ${configSummary}\n` +
        (contact.notes ? `Customer note: ${contact.notes}\n` : '') +
        `Config: ${JSON.stringify(doorConfig)}`;
      const q = await tx
        .insert(quotes)
        .values({
          branchId: branch.id,
          customerId,
          supplierId: supplier.id,
          status: 'draft',
          notes: quoteNotes,
          createdByUserId: null,
        })
        .returning({ id: quotes.id });
      const quoteId = q[0]!.id;

      // Best-effort: store the configured-door image and stamp its key on
      // the notes so a manager can see what was designed. Never blocks intake.
      const imageKey = await storeDoorImage(
        objectStore,
        `widget-leads/${quoteId}.png`,
        doorImage,
      );
      if (imageKey) {
        await tx
          .update(quotes)
          .set({ notes: `${quoteNotes}\nImage: ${imageKey}` })
          .where(eq(quotes.id, quoteId));
      }
      return { quoteId, customerId };
    });

    return reply.code(201).send({ ok: true, data: result });
  });
}
