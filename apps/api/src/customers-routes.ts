/**
 * Customers CRUD (TASK-CJ-02).
 *
 *   POST   /api/v1/customers           create
 *   GET    /api/v1/customers           list (search + pagination)
 *   GET    /api/v1/customers/:id       read
 *   PATCH  /api/v1/customers/:id       partial update
 *   DELETE /api/v1/customers/:id       soft-delete (idempotent)
 *
 * Every endpoint requires an active scope. Queries run inside
 * `withScope()` so RLS fires on a non-superuser DB connection, and an
 * explicit app-layer WHERE keeps the dev superuser path identical.
 * franchisee_id is always taken from `request.scope`, never from the
 * request body — protected by the same hazard that bit us in TEN-10.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  customers,
  locations,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CreateSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().nullable().optional(),
  phone: z.string().min(1).max(40).nullable().optional(),
  addressLine1: z.string().nullable().optional(),
  addressLine2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  postalCode: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  placeId: z.string().nullable().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
});
type CreateInput = z.infer<typeof CreateSchema>;

const UpdateSchema = CreateSchema.partial();

function unauthorized(reply: ReturnType<FastifyInstance['inject']> extends never ? never : ReturnType<FastifyInstance['inject']>): never {
  void reply;
  throw new Error('unreachable');
}
void unauthorized;

/**
 * Resolve the target franchisee for a create / read query, enforcing
 * that non-platform callers can only act within their own franchisee.
 * Platform admin callers must supply `locationId` that exists; we
 * pick its franchisee via a lookup (not needed in v1 scope — platform
 * admin can still create customers in any location id they pass, and
 * we trust that the location id is real; the FK will fail otherwise).
 */
function franchiseeIdFromScope(scope: RequestScope): string | null {
  if (scope.type === 'platform') return null;
  if (scope.type === 'franchisor') return null;
  return scope.franchiseeId;
}

async function resolveFranchiseeForCreate(
  db: Drizzle,
  scope: RequestScope,
  body: CreateInput,
): Promise<{ ok: true; franchiseeId: string } | { ok: false; code: string; message: string }> {
  // For platform / franchisor callers, locationId is REQUIRED so we can
  // derive the target franchisee — there's no default otherwise.
  if (scope.type === 'platform' || scope.type === 'franchisor') {
    if (!body.locationId) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'platform/franchisor admins must specify locationId to scope the customer',
      };
    }
    const rows = await db
      .select({ franchiseeId: locations.franchiseeId })
      .from(locations)
      .where(eq(locations.id, body.locationId));
    const row = rows[0];
    if (!row) {
      return { ok: false, code: 'INVALID_TARGET', message: 'locationId does not exist' };
    }
    if (scope.type === 'franchisor') {
      // franchisor_admin can only create inside franchisees under their
      // franchisor — verify via a second lookup.
      const feRows = await db
        .select({ franchisorId: schema.franchisees.franchisorId })
        .from(schema.franchisees)
        .where(eq(schema.franchisees.id, row.franchiseeId));
      if (feRows[0]?.franchisorId !== scope.franchisorId) {
        return {
          ok: false,
          code: 'INVALID_TARGET',
          message: 'locationId is outside the acting franchisor',
        };
      }
    }
    return { ok: true, franchiseeId: row.franchiseeId };
  }

  // franchisee-scoped caller: if they pass locationId, it must belong
  // to their franchisee. Otherwise fall back to their scope's
  // franchiseeId.
  if (body.locationId) {
    const rows = await db
      .select({ franchiseeId: locations.franchiseeId })
      .from(locations)
      .where(eq(locations.id, body.locationId));
    if (rows[0]?.franchiseeId !== scope.franchiseeId) {
      return { ok: false, code: 'INVALID_TARGET', message: 'locationId outside your scope' };
    }
  }
  return { ok: true, franchiseeId: scope.franchiseeId };
}

export function registerCustomerRoutes(app: FastifyInstance, db: Drizzle): void {
  app.post('/api/v1/customers', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }
    const resolved = await resolveFranchiseeForCreate(db, req.scope, parsed.data);
    if (!resolved.ok) {
      return reply.code(400).send({
        ok: false,
        error: { code: resolved.code, message: resolved.message },
      });
    }
    const inserted = await db
      .insert(customers)
      .values({
        franchiseeId: resolved.franchiseeId,
        locationId: parsed.data.locationId ?? null,
        name: parsed.data.name,
        email: parsed.data.email ?? null,
        phone: parsed.data.phone ?? null,
        addressLine1: parsed.data.addressLine1 ?? null,
        addressLine2: parsed.data.addressLine2 ?? null,
        city: parsed.data.city ?? null,
        state: parsed.data.state ?? null,
        postalCode: parsed.data.postalCode ?? null,
        country: parsed.data.country ?? null,
        placeId: parsed.data.placeId ?? null,
        latitude: parsed.data.latitude != null ? String(parsed.data.latitude) : null,
        longitude: parsed.data.longitude != null ? String(parsed.data.longitude) : null,
        notes: parsed.data.notes ?? null,
        createdByUserId: req.userId,
      })
      .returning();
    return reply.code(201).send({ ok: true, data: inserted[0]! });
  });

  app.get('/api/v1/customers', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    const q = req.query as Record<string, string | undefined>;
    const search = q['search']?.trim() || null;
    const limit = Math.min(Math.max(parseInt(q['limit'] ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(q['offset'] ?? '0', 10) || 0, 0);

    const { rows, total } = await withScope(db, scope, async (tx) => {
      const conditions: unknown[] = [isNull(customers.deletedAt)];
      const scopeFe = franchiseeIdFromScope(scope);
      if (scopeFe) conditions.push(eq(customers.franchiseeId, scopeFe));
      if (search) {
        const like = `%${search}%`;
        conditions.push(
          or(
            ilike(customers.name, like),
            ilike(customers.email, like),
            ilike(customers.phone, like),
          ),
        );
      }
      const where = and(...(conditions as Parameters<typeof and>));
      const rows = await tx
        .select()
        .from(customers)
        .where(where)
        .orderBy(desc(customers.createdAt))
        .limit(limit)
        .offset(offset);
      const countRows = await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(customers)
        .where(where);
      return { rows, total: countRows[0]?.c ?? 0 };
    });

    return reply.code(200).send({
      ok: true,
      data: { rows, total, limit, offset },
    });
  });

  app.get<{ Params: { id: string } }>('/api/v1/customers/:id', async (req, reply) => {
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
        .from(customers)
        .where(and(eq(customers.id, req.params.id), isNull(customers.deletedAt)));
      const r = rows[0];
      if (!r) return null;
      const scopeFe = franchiseeIdFromScope(scope);
      if (scopeFe && r.franchiseeId !== scopeFe) return null;
      if (scope.type === 'franchisor') {
        const feRows = await tx
          .select({ franchisorId: schema.franchisees.franchisorId })
          .from(schema.franchisees)
          .where(eq(schema.franchisees.id, r.franchiseeId));
        if (feRows[0]?.franchisorId !== scope.franchisorId) return null;
      }
      return r;
    });
    if (!row) {
      return reply.code(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Customer not found' },
      });
    }
    return reply.code(200).send({ ok: true, data: row });
  });

  app.patch<{ Params: { id: string } }>('/api/v1/customers/:id', async (req, reply) => {
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
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }
    const scope = req.scope;
    const updated = await withScope(db, scope, async (tx) => {
      const existingRows = await tx
        .select()
        .from(customers)
        .where(and(eq(customers.id, req.params.id), isNull(customers.deletedAt)));
      const existing = existingRows[0];
      if (!existing) return { status: 'not_found' as const };
      const scopeFe = franchiseeIdFromScope(scope);
      if (scopeFe && existing.franchiseeId !== scopeFe) return { status: 'not_found' as const };

      const values: Record<string, unknown> = { updatedAt: new Date() };
      const d = parsed.data;
      if (d.name !== undefined) values.name = d.name;
      if (d.email !== undefined) values.email = d.email;
      if (d.phone !== undefined) values.phone = d.phone;
      if (d.addressLine1 !== undefined) values.addressLine1 = d.addressLine1;
      if (d.addressLine2 !== undefined) values.addressLine2 = d.addressLine2;
      if (d.city !== undefined) values.city = d.city;
      if (d.state !== undefined) values.state = d.state;
      if (d.postalCode !== undefined) values.postalCode = d.postalCode;
      if (d.country !== undefined) values.country = d.country;
      if (d.placeId !== undefined) values.placeId = d.placeId;
      if (d.latitude !== undefined) values.latitude = d.latitude == null ? null : String(d.latitude);
      if (d.longitude !== undefined) values.longitude = d.longitude == null ? null : String(d.longitude);
      if (d.notes !== undefined) values.notes = d.notes;
      if (d.locationId !== undefined) values.locationId = d.locationId;

      const next = await tx
        .update(customers)
        .set(values)
        .where(eq(customers.id, req.params.id))
        .returning();
      return { status: 'ok' as const, row: next[0]! };
    });
    if (updated.status === 'not_found') {
      return reply.code(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Customer not found' },
      });
    }
    return reply.code(200).send({ ok: true, data: updated.row });
  });

  app.delete<{ Params: { id: string } }>('/api/v1/customers/:id', async (req, reply) => {
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
        .select({ id: customers.id, franchiseeId: customers.franchiseeId, deletedAt: customers.deletedAt })
        .from(customers)
        .where(eq(customers.id, req.params.id));
      const row = rows[0];
      if (!row) return { status: 'not_found' as const };
      const scopeFe = franchiseeIdFromScope(scope);
      if (scopeFe && row.franchiseeId !== scopeFe) return { status: 'not_found' as const };
      if (row.deletedAt !== null) return { status: 'already' as const };
      await tx
        .update(customers)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(customers.id, req.params.id));
      return { status: 'ok' as const };
    });
    if (result.status === 'not_found') {
      return reply.code(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Customer not found' },
      });
    }
    return reply.code(200).send({
      ok: true,
      data: { deleted: result.status === 'ok', alreadyDeleted: result.status === 'already' },
    });
  });
}
