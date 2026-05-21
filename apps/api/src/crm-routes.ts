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

export function registerCrmRoutes(app: FastifyInstance, db: Drizzle): void {
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
      if (d.phone) ors.push(eq(customers.phone, d.phone));
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
