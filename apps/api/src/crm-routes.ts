/**
 * CRM interaction notes (CRM-02).
 *
 *   GET  /api/v1/customers/:id/notes   per-customer timeline (staff)
 *   POST /api/v1/customers/:id/notes   staff manual note
 *   POST /api/v1/crm/notes             AI/Donna ingest (header-key auth)
 *   GET  /api/v1/crm/notes-feed        org/branch feed + triage filters
 *   POST /api/v1/crm/notes/:id/link    assign an unmatched note to a customer
 *
 * Staff endpoints follow the customers-routes tenancy contract: scope
 * required, app-layer WHERE, withScope so RLS fires, cross-tenant probe → 404.
 *
 * The ingest endpoint is server-to-server (Donna PA / AI). It has no session,
 * so it runs OUTSIDE RequestScope and authenticates with an
 * `X-Service-AI-Ingest-Key` header compared to `CRM_INGEST_KEY`. It resolves a
 * customer by phone/email (corporate-wide), inheriting that customer's branch;
 * an unmatched note lands in the intake branch awaiting triage. Dedupe is on
 * `(source, source_ref)`.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, ilike, isNull, isNotNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  branches,
  customerNotes,
  customers,
  invoices,
  jobs,
  quotes,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_TYPES = ['call', 'email', 'meeting', 'sms', 'manual'] as const;

function branchIdFromScope(scope: RequestScope): string | null {
  if (scope.type === 'corporate') return null;
  return scope.branchId;
}

const CreateNoteSchema = z
  .object({
    noteType: z.enum(NOTE_TYPES).default('manual'),
    subject: z.string().max(300).nullable().optional(),
    body: z.string().min(1).max(10000),
    occurredAt: z.string().datetime().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const IngestSchema = z
  .object({
    phone: z.string().max(50).optional(),
    email: z.string().email().max(200).optional(),
    noteType: z.enum(NOTE_TYPES).default('call'),
    subject: z.string().max(300).optional(),
    body: z.string().min(1).max(10000),
    source: z.string().max(50).default('donna_pa'),
    sourceRef: z.string().max(200).optional(),
    occurredAt: z.string().datetime().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const LinkSchema = z.object({ customerId: z.string().uuid() }).strict();

/** Synthetic corporate scope used by the keyless ingest path for matching. */
const INGEST_CORP_SCOPE: RequestScope = {
  type: 'corporate',
  userId: 'crm-ingest',
  role: 'corporate_admin',
};

function dollarsToCents(numericStr: string | null): number {
  return Math.round(Number(numericStr ?? '0') * 100);
}

export function registerCrmRoutes(app: FastifyInstance, db: Drizzle): void {
  // ---------------------------------------------------------------------------
  // GET /api/v1/customers/:id/metrics — Customer 360 headline KPIs
  //
  // One fixed set of aggregate queries (no per-row N+1): invoices, jobs,
  // quotes, and the notes recency are each a single grouped/aggregate pass.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/api/v1/customers/:id/metrics',
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
      const id = req.params.id;

      const data = await withScope(db, scope, async (tx) => {
        const custRows = await tx
          .select({ id: customers.id, branchId: customers.branchId })
          .from(customers)
          .where(and(eq(customers.id, id), isNull(customers.deletedAt)));
        const cust = custRows[0];
        if (!cust) return null;
        const scopeBranch = branchIdFromScope(scope);
        if (scopeBranch && cust.branchId !== scopeBranch) return null;

        const invAgg = await tx
          .select({
            paidTotal: sql<string>`COALESCE(SUM(CASE WHEN ${invoices.status} = 'paid' THEN ${invoices.total} ELSE 0 END), 0)`,
            paidCount: sql<number>`COUNT(*) FILTER (WHERE ${invoices.status} = 'paid')::int`,
            outstanding: sql<string>`COALESCE(SUM(CASE WHEN ${invoices.status} IN ('finalized', 'sent') THEN ${invoices.total} ELSE 0 END), 0)`,
            outstandingCount: sql<number>`COUNT(*) FILTER (WHERE ${invoices.status} IN ('finalized', 'sent'))::int`,
          })
          .from(invoices)
          .where(and(eq(invoices.customerId, id), isNull(invoices.deletedAt)));

        const jobRows = await tx
          .select({ status: jobs.status, c: sql<number>`count(*)::int` })
          .from(jobs)
          .where(and(eq(jobs.customerId, id), isNull(jobs.deletedAt)))
          .groupBy(jobs.status);

        const jobBounds = await tx
          .select({
            first: sql<string | null>`min(${jobs.createdAt})`,
            last: sql<string | null>`max(${jobs.createdAt})`,
            open: sql<number>`COUNT(*) FILTER (WHERE ${jobs.status} NOT IN ('completed', 'canceled'))::int`,
          })
          .from(jobs)
          .where(and(eq(jobs.customerId, id), isNull(jobs.deletedAt)));

        const quoteRows = await tx
          .select({ status: quotes.status, c: sql<number>`count(*)::int` })
          .from(quotes)
          .where(eq(quotes.customerId, id))
          .groupBy(quotes.status);

        const noteAgg = await tx
          .select({ last: sql<string | null>`max(${customerNotes.occurredAt})` })
          .from(customerNotes)
          .where(eq(customerNotes.customerId, id));

        const lifetimeRevenueCents = dollarsToCents(invAgg[0]?.paidTotal ?? '0');
        const paidCount = invAgg[0]?.paidCount ?? 0;
        const outstandingCents = dollarsToCents(invAgg[0]?.outstanding ?? '0');

        const jobsByStatus: Record<string, number> = {};
        for (const r of jobRows) jobsByStatus[r.status] = r.c;
        const quotesByStatus: Record<string, number> = {};
        for (const r of quoteRows) quotesByStatus[r.status] = r.c;

        const totalQuotes = quoteRows.reduce((s, r) => s + r.c, 0);
        const acceptedQuotes = quotesByStatus['accepted'] ?? 0;
        const nonVoidQuotes = totalQuotes - (quotesByStatus['void'] ?? 0);
        const conversionRatePct =
          nonVoidQuotes > 0
            ? Math.round((acceptedQuotes / nonVoidQuotes) * 1000) / 10
            : 0;
        const openQuotes =
          (quotesByStatus['draft'] ?? 0) +
          (quotesByStatus['priced'] ?? 0) +
          (quotesByStatus['committed'] ?? 0);

        return {
          lifetimeRevenueCents,
          outstandingCents,
          outstandingInvoices: invAgg[0]?.outstandingCount ?? 0,
          avgOrderValueCents: paidCount > 0 ? Math.round(lifetimeRevenueCents / paidCount) : 0,
          paidInvoices: paidCount,
          jobsByStatus,
          totalJobs: jobRows.reduce((s, r) => s + r.c, 0),
          openJobs: jobBounds[0]?.open ?? 0,
          firstJobAt: jobBounds[0]?.first ?? null,
          lastJobAt: jobBounds[0]?.last ?? null,
          quotesByStatus,
          totalQuotes,
          openQuotes,
          conversionRatePct,
          lastContactAt: noteAgg[0]?.last ?? null,
        };
      });

      if (!data) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Customer not found' },
        });
      }
      return reply.code(200).send({ ok: true, data });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/v1/customers/:id/timeline — unified activity feed
  //
  // One UNION ALL across notes + jobs + quotes + invoices, ordered by event
  // time. `type` filters to one kind. Paginated. RLS (via withScope) keeps it
  // to the customer's branch.
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/api/v1/customers/:id/timeline',
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
      const id = req.params.id;
      const q = req.query as Record<string, string | undefined>;
      const kinds = ['note', 'job', 'quote', 'invoice', 'payment'] as const;
      const kindFilter = kinds.includes(q['type'] as never) ? q['type']! : null;
      const limit = Math.min(Math.max(parseInt(q['limit'] ?? '50', 10) || 50, 1), 200);
      const offset = Math.max(parseInt(q['offset'] ?? '0', 10) || 0, 0);

      const result = await withScope(db, scope, async (tx) => {
        const custRows = await tx
          .select({ id: customers.id, branchId: customers.branchId })
          .from(customers)
          .where(and(eq(customers.id, id), isNull(customers.deletedAt)));
        const cust = custRows[0];
        if (!cust) return null;
        const scopeBranch = branchIdFromScope(scope);
        if (scopeBranch && cust.branchId !== scopeBranch) return null;

        const union = sql`
          SELECT id::text AS id, 'note' AS kind, occurred_at AS ts, note_type AS subtype,
                 COALESCE(subject, left(body, 80)) AS title, body AS detail,
                 NULL::text AS status, NULL::bigint AS amount_cents, source AS ref
            FROM customer_notes WHERE customer_id = ${id}
          UNION ALL
          SELECT id::text, 'job', created_at, status::text,
                 title, description, status::text, NULL::bigint, NULL::text
            FROM jobs WHERE customer_id = ${id} AND deleted_at IS NULL
          UNION ALL
          SELECT id::text, 'quote', COALESCE(committed_at, created_at), status::text,
                 COALESCE(supplier_quote_ref, 'Quote'), notes, status::text,
                 total_cents, supplier_quote_ref
            FROM quotes WHERE customer_id = ${id}
          UNION ALL
          SELECT id::text, 'invoice', COALESCE(paid_at, finalized_at, created_at), status::text,
                 'Invoice', notes, status::text, round(total * 100)::bigint, NULL::text
            FROM invoices WHERE customer_id = ${id} AND deleted_at IS NULL
          UNION ALL
          SELECT p.id::text, 'payment', p.created_at, 'payment',
                 'Payment', NULL, 'paid', round(p.amount * 100)::bigint, NULL::text
            FROM payments p JOIN invoices i ON p.invoice_id = i.id
            WHERE i.customer_id = ${id} AND i.deleted_at IS NULL
          UNION ALL
          SELECT r.id::text, 'payment', r.created_at, 'refund',
                 'Refund', NULL, 'refunded', (-round(r.amount * 100))::bigint, NULL::text
            FROM refunds r JOIN invoices i ON r.invoice_id = i.id
            WHERE i.customer_id = ${id} AND i.deleted_at IS NULL
        `;
        const filtered = kindFilter
          ? sql`SELECT * FROM (${union}) t WHERE kind = ${kindFilter}`
          : sql`SELECT * FROM (${union}) t`;
        const rowsRes = await tx.execute(
          sql`${filtered} ORDER BY ts DESC LIMIT ${limit} OFFSET ${offset}`,
        );
        const countRes = await tx.execute(
          sql`SELECT count(*)::int AS c FROM (${filtered}) c`,
        );
        return {
          rows: rowsRes.rows,
          total: Number((countRes.rows[0] as { c: number } | undefined)?.c ?? 0),
        };
      });

      if (!result) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Customer not found' },
        });
      }
      return reply.code(200).send({
        ok: true,
        data: { rows: result.rows, total: result.total, limit, offset },
      });
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/v1/customers/:id/notes — per-customer timeline
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/api/v1/customers/:id/notes',
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
      const q = req.query as Record<string, string | undefined>;
      const typeFilter = NOTE_TYPES.includes(q['type'] as never) ? q['type'] : null;
      const limit = Math.min(Math.max(parseInt(q['limit'] ?? '50', 10) || 50, 1), 200);
      const offset = Math.max(parseInt(q['offset'] ?? '0', 10) || 0, 0);

      const result = await withScope(db, scope, async (tx) => {
        // Confirm the customer is visible to this scope (cross-tenant → 404).
        const custRows = await tx
          .select({ id: customers.id, branchId: customers.branchId })
          .from(customers)
          .where(and(eq(customers.id, req.params.id), isNull(customers.deletedAt)));
        const cust = custRows[0];
        if (!cust) return null;
        const scopeBranch = branchIdFromScope(scope);
        if (scopeBranch && cust.branchId !== scopeBranch) return null;

        const conditions: unknown[] = [eq(customerNotes.customerId, req.params.id)];
        if (typeFilter) conditions.push(eq(customerNotes.noteType, typeFilter));
        const where = and(...(conditions as Parameters<typeof and>));
        const rows = await tx
          .select()
          .from(customerNotes)
          .where(where)
          .orderBy(desc(customerNotes.occurredAt))
          .limit(limit)
          .offset(offset);
        const countRows = await tx
          .select({ c: sql<number>`count(*)::int` })
          .from(customerNotes)
          .where(where);
        return { rows, total: countRows[0]?.c ?? 0 };
      });

      if (!result) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Customer not found' },
        });
      }
      return reply.code(200).send({
        ok: true,
        data: { rows: result.rows, total: result.total, limit, offset },
      });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/v1/customers/:id/notes — staff manual note
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/customers/:id/notes',
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
      const parsed = CreateNoteSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;
      const d = parsed.data;

      const outcome = await withScope(db, scope, async (tx) => {
        const custRows = await tx
          .select({ id: customers.id, branchId: customers.branchId })
          .from(customers)
          .where(and(eq(customers.id, req.params.id), isNull(customers.deletedAt)));
        const cust = custRows[0];
        if (!cust) return null;
        const scopeBranch = branchIdFromScope(scope);
        if (scopeBranch && cust.branchId !== scopeBranch) return null;

        const inserted = await tx
          .insert(customerNotes)
          .values({
            branchId: cust.branchId,
            customerId: cust.id,
            noteType: d.noteType,
            subject: d.subject ?? null,
            body: d.body,
            source: 'manual',
            authorUserId: scope.userId,
            occurredAt: d.occurredAt ? new Date(d.occurredAt) : new Date(),
            metadata: (d.metadata ?? {}) as Record<string, unknown>,
          })
          .returning();
        return inserted[0]!;
      });

      if (!outcome) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Customer not found' },
        });
      }
      return reply.code(201).send({ ok: true, data: outcome });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/v1/crm/notes — AI/Donna ingest (header-key auth, outside scope)
  // ---------------------------------------------------------------------------
  app.post('/api/v1/crm/notes', async (req, reply) => {
    const expectedKey = process.env['CRM_INGEST_KEY'];
    if (expectedKey) {
      const provided = req.headers['x-service-ai-ingest-key'];
      if (provided !== expectedKey) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Invalid ingest key' },
        });
      }
    }
    const parsed = IngestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }
    const d = parsed.data;

    // Match a customer by email (preferred) or phone, corporate-wide.
    const matched = await withScope(db, INGEST_CORP_SCOPE, async (tx) => {
      const ors: unknown[] = [];
      if (d.email) ors.push(ilike(customers.email, d.email));
      if (d.phone) {
        // TD-CRM-04: match on the last 10 digits so +1 / dashes / spaces
        // don't cause a miss (NANP). Both sides are digit-normalized in SQL.
        const digits = d.phone.replace(/\D/g, '');
        if (digits.length >= 7) {
          const last10 = digits.slice(-10);
          ors.push(
            sql`right(regexp_replace(${customers.phone}, '\\D', '', 'g'), 10) = ${last10}`,
          );
        }
      }
      if (ors.length === 0) return null;
      const rows = await tx
        .select({ id: customers.id, branchId: customers.branchId })
        .from(customers)
        .where(
          and(isNull(customers.deletedAt), or(...(ors as Parameters<typeof or>))),
        )
        .orderBy(desc(customers.createdAt))
        .limit(1);
      return rows[0] ?? null;
    });
    const matchKey = d.email ?? d.phone ?? null;
    const matchKeyType = d.email ? 'email' : d.phone ? 'phone' : null;

    // Resolve the write branch: the matched customer's branch, else intake.
    let branchId = matched?.branchId ?? null;
    if (!branchId) {
      const intakeSlug = process.env['LEAD_INTAKE_BRANCH_SLUG'];
      const brRows = await db
        .select({ id: branches.id })
        .from(branches)
        .where(intakeSlug ? eq(branches.slug, intakeSlug) : undefined)
        .orderBy(asc(branches.createdAt))
        .limit(1);
      branchId = brRows[0]?.id ?? null;
    }
    if (!branchId) {
      return reply.code(503).send({
        ok: false,
        error: { code: 'NOT_CONFIGURED', message: 'No branch to receive the note' },
      });
    }

    const writeScope: RequestScope = {
      type: 'branch',
      userId: 'crm-ingest',
      role: 'csr',
      branchId,
    };

    const note = await withScope(db, writeScope, async (tx) => {
      // Idempotent on (source, source_ref): a replayed webhook returns the
      // existing note rather than double-logging.
      if (d.sourceRef) {
        const existing = await tx
          .select()
          .from(customerNotes)
          .where(
            and(
              eq(customerNotes.source, d.source),
              eq(customerNotes.sourceRef, d.sourceRef),
            ),
          )
          .limit(1);
        if (existing[0]) return { row: existing[0], deduped: true };
      }
      const inserted = await tx
        .insert(customerNotes)
        .values({
          branchId,
          customerId: matched?.id ?? null,
          noteType: d.noteType,
          subject: d.subject ?? null,
          body: d.body,
          source: d.source,
          sourceRef: d.sourceRef ?? null,
          matchKey,
          matchKeyType,
          authorUserId: null,
          occurredAt: d.occurredAt ? new Date(d.occurredAt) : new Date(),
          metadata: (d.metadata ?? {}) as Record<string, unknown>,
        })
        .returning();
      return { row: inserted[0]!, deduped: false };
    });

    return reply.code(note.deduped ? 200 : 201).send({
      ok: true,
      data: {
        id: note.row.id,
        customerId: note.row.customerId,
        matched: note.row.customerId !== null,
        deduped: note.deduped,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/crm/notes-feed — org/branch feed with triage filters
  // ---------------------------------------------------------------------------
  app.get('/api/v1/crm/notes-feed', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    const q = req.query as Record<string, string | undefined>;
    const typeFilter = NOTE_TYPES.includes(q['type'] as never) ? q['type'] : null;
    const matched = q['matched']; // 'matched' | 'unmatched' | undefined
    const limit = Math.min(Math.max(parseInt(q['limit'] ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(q['offset'] ?? '0', 10) || 0, 0);

    const { rows, total } = await withScope(db, scope, async (tx) => {
      const conditions: unknown[] = [];
      const scopeBranch = branchIdFromScope(scope);
      if (scopeBranch) conditions.push(eq(customerNotes.branchId, scopeBranch));
      if (typeFilter) conditions.push(eq(customerNotes.noteType, typeFilter));
      if (matched === 'matched') conditions.push(isNotNull(customerNotes.customerId));
      if (matched === 'unmatched') conditions.push(isNull(customerNotes.customerId));
      const where =
        conditions.length > 0
          ? and(...(conditions as Parameters<typeof and>))
          : undefined;
      const rows = await tx
        .select({
          id: customerNotes.id,
          branchId: customerNotes.branchId,
          customerId: customerNotes.customerId,
          customerName: customers.name,
          noteType: customerNotes.noteType,
          subject: customerNotes.subject,
          body: customerNotes.body,
          source: customerNotes.source,
          matchKey: customerNotes.matchKey,
          matchKeyType: customerNotes.matchKeyType,
          occurredAt: customerNotes.occurredAt,
          createdAt: customerNotes.createdAt,
        })
        .from(customerNotes)
        .leftJoin(customers, eq(customerNotes.customerId, customers.id))
        .where(where)
        .orderBy(desc(customerNotes.occurredAt))
        .limit(limit)
        .offset(offset);
      const countRows = await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(customerNotes)
        .where(where);
      return { rows, total: countRows[0]?.c ?? 0 };
    });

    return reply.code(200).send({ ok: true, data: { rows, total, limit, offset } });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/crm/notes/:id/link — triage: assign an unmatched note
  // ---------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/crm/notes/:id/link',
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
      const parsed = LinkSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;

      const outcome = await withScope(db, scope, async (tx) => {
        const noteRows = await tx
          .select({ id: customerNotes.id, branchId: customerNotes.branchId })
          .from(customerNotes)
          .where(eq(customerNotes.id, req.params.id));
        const note = noteRows[0];
        if (!note) return { kind: 'note_missing' as const };
        const scopeBranch = branchIdFromScope(scope);
        if (scopeBranch && note.branchId !== scopeBranch) {
          return { kind: 'note_missing' as const };
        }
        const custRows = await tx
          .select({ id: customers.id, branchId: customers.branchId })
          .from(customers)
          .where(and(eq(customers.id, parsed.data.customerId), isNull(customers.deletedAt)));
        const cust = custRows[0];
        if (!cust) return { kind: 'customer_missing' as const };
        if (scopeBranch && cust.branchId !== scopeBranch) {
          return { kind: 'customer_missing' as const };
        }
        const updated = await tx
          .update(customerNotes)
          .set({ customerId: cust.id, branchId: cust.branchId, updatedAt: new Date() })
          .where(eq(customerNotes.id, note.id))
          .returning();
        return { kind: 'ok' as const, row: updated[0]! };
      });

      if (outcome.kind === 'note_missing') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Note not found' },
        });
      }
      if (outcome.kind === 'customer_missing') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Customer not found' },
        });
      }
      return reply.code(200).send({ ok: true, data: outcome.row });
    },
  );
}
