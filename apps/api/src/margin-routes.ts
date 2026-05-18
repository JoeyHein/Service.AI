/**
 * Margin policy + category-override routes (SQB-08).
 *
 * Surface mounted under `/api/v1/corporate/*`, corporate-only. Branch-
 * scoped callers and unauthenticated callers receive `404 NOT_FOUND` so
 * the existence of the route is not leaked (the canonical cross-tenant
 * pattern from CLAUDE.md).
 *
 * Endpoints:
 *
 *   GET    /api/v1/corporate/margins
 *   PATCH  /api/v1/corporate/margins/policy
 *   POST   /api/v1/corporate/margin-overrides
 *   PATCH  /api/v1/corporate/margin-overrides/:id
 *   DELETE /api/v1/corporate/margin-overrides/:id
 *
 * Auth model:
 *   - `req.scope` null              → 401 UNAUTHENTICATED
 *   - `req.scope.type !== 'corporate'` → 404 NOT_FOUND
 *
 * Spec note (v1): the SQB-08 gate calls for `min_margin_pct` /
 * `max_margin_pct` to be editable only by `platform_admin` via a
 * collapsed section. In the corporate hub model there is no
 * `platform_admin` role any more (CHR-01 collapsed it into
 * `corporate_admin`). For v1 we allow `corporate_admin` to edit all three
 * bounds; the UI keeps the bounds inputs behind a collapse + warning,
 * and a future role split can land later without a contract break.
 *
 * Every write writes one `audit_log` row with `action='corporate.margin.<op>'`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  auditLog,
  corporate,
  marginOverrides,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guard for every margin endpoint. Returns the resolved scope when the
 * caller is a corporate admin; sends a structured error reply and
 * returns null otherwise — callers must `return` immediately on null.
 */
function requireCorporate(
  req: FastifyRequest,
  reply: FastifyReply,
): RequestScope | null {
  if (req.scope === null) {
    reply.code(401).send({
      ok: false,
      error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
    });
    return null;
  }
  if (req.scope.type !== 'corporate') {
    reply.code(404).send({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
    return null;
  }
  return req.scope;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const PolicyPatchBody = z
  .object({
    defaultPct: z.number().min(0).max(1000).optional(),
    minPct: z.number().min(0).max(1000).optional(),
    maxPct: z.number().min(0).max(1000).optional(),
  })
  .strict();

const CreateOverrideBody = z
  .object({
    itemCategory: z.string().min(1).max(120),
    marginPct: z.number().min(0).max(1000),
    notes: z.string().max(2000).optional(),
  })
  .strict();

const UpdateOverrideBody = z
  .object({
    marginPct: z.number().min(0).max(1000).optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Shapes returned by the routes
// ---------------------------------------------------------------------------

interface MarginOverrideOut {
  id: string;
  itemCategory: string;
  marginPct: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MarginsResponse {
  defaultPct: number;
  minPct: number;
  maxPct: number;
  overrides: MarginOverrideOut[];
}

interface CorporatePolicyOut {
  defaultPct: number;
  minPct: number;
  maxPct: number;
}

function serializeOverride(row: typeof marginOverrides.$inferSelect): MarginOverrideOut {
  return {
    id: row.id,
    itemCategory: row.itemCategory,
    marginPct: Number(row.marginPct),
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializePolicy(row: typeof corporate.$inferSelect): CorporatePolicyOut {
  return {
    defaultPct: Number(row.defaultMarginPct),
    minPct: Number(row.minMarginPct),
    maxPct: Number(row.maxMarginPct),
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface MarginRouteOptions {
  drizzle: Drizzle;
}

/**
 * Mount the /api/v1/corporate/margins* + /api/v1/corporate/margin-
 * overrides* surface. Must run AFTER `requestScopePlugin` because every
 * handler reads `req.scope`.
 */
export function registerMarginRoutes(
  app: FastifyInstance,
  opts: MarginRouteOptions,
): void {
  const db = opts.drizzle;

  // -------------------------------------------------------------------------
  // GET /api/v1/corporate/margins
  // -------------------------------------------------------------------------
  app.get('/api/v1/corporate/margins', async (req, reply) => {
    const scope = requireCorporate(req, reply);
    if (!scope) return;

    const body = await withScope(db, scope, async (tx) => {
      const corpRows = await tx
        .select()
        .from(corporate)
        .limit(1);
      const corp = corpRows[0];
      const policy: CorporatePolicyOut = corp
        ? serializePolicy(corp)
        : { defaultPct: 60, minPct: 20, maxPct: 200 };
      const overrideRows = await tx
        .select()
        .from(marginOverrides)
        .orderBy(desc(marginOverrides.createdAt));
      const res: MarginsResponse = {
        defaultPct: policy.defaultPct,
        minPct: policy.minPct,
        maxPct: policy.maxPct,
        overrides: overrideRows.map(serializeOverride),
      };
      return res;
    });

    return reply.code(200).send({ ok: true, data: body });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v1/corporate/margins/policy
  // -------------------------------------------------------------------------
  app.patch('/api/v1/corporate/margins/policy', async (req, reply) => {
    const scope = requireCorporate(req, reply);
    if (!scope) return;

    const parsed = PolicyPatchBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.message,
          details: parsed.error.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        },
      });
    }

    const outcome = await withScope(db, scope, async (tx) => {
      const corpRows = await tx
        .select()
        .from(corporate)
        .limit(1);
      const existing = corpRows[0];
      if (!existing) return { kind: 'no_corporate' as const };

      const nextDefault =
        parsed.data.defaultPct ?? Number(existing.defaultMarginPct);
      const nextMin = parsed.data.minPct ?? Number(existing.minMarginPct);
      const nextMax = parsed.data.maxPct ?? Number(existing.maxMarginPct);

      if (!(nextMin <= nextDefault && nextDefault <= nextMax)) {
        return {
          kind: 'bounds_invalid' as const,
          minPct: nextMin,
          defaultPct: nextDefault,
          maxPct: nextMax,
        };
      }

      const changes: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.defaultPct !== undefined) {
        changes['defaultMarginPct'] = parsed.data.defaultPct.toFixed(2);
      }
      if (parsed.data.minPct !== undefined) {
        changes['minMarginPct'] = parsed.data.minPct.toFixed(2);
      }
      if (parsed.data.maxPct !== undefined) {
        changes['maxMarginPct'] = parsed.data.maxPct.toFixed(2);
      }

      const updated = await tx
        .update(corporate)
        .set(changes)
        .where(eq(corporate.id, existing.id))
        .returning();
      const row = updated[0]!;

      await tx.insert(auditLog).values({
        actorUserId: scope.userId,
        targetBranchId: null,
        action: 'corporate.margin.patch',
        scopeType: 'corporate',
        scopeId: null,
        metadata: {
          defaultPct: parsed.data.defaultPct ?? null,
          minPct: parsed.data.minPct ?? null,
          maxPct: parsed.data.maxPct ?? null,
        },
      });
      return { kind: 'ok' as const, row };
    });

    if (outcome.kind === 'no_corporate') {
      return reply.code(409).send({
        ok: false,
        error: {
          code: 'NO_CORPORATE',
          message: 'No corporate hub row exists; seed must run first',
        },
      });
    }
    if (outcome.kind === 'bounds_invalid') {
      return reply.code(422).send({
        ok: false,
        error: {
          code: 'BOUNDS_INVALID',
          message: `minPct (${outcome.minPct}) <= defaultPct (${outcome.defaultPct}) <= maxPct (${outcome.maxPct}) must hold`,
        },
      });
    }
    return reply.code(200).send({
      ok: true,
      data: serializePolicy(outcome.row),
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/corporate/margin-overrides
  // -------------------------------------------------------------------------
  app.post('/api/v1/corporate/margin-overrides', async (req, reply) => {
    const scope = requireCorporate(req, reply);
    if (!scope) return;

    const parsed = CreateOverrideBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.message,
          details: parsed.error.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        },
      });
    }

    const outcome = await withScope(db, scope, async (tx) => {
      const existing = await tx
        .select({ id: marginOverrides.id })
        .from(marginOverrides)
        .where(eq(marginOverrides.itemCategory, parsed.data.itemCategory))
        .limit(1);
      if (existing[0]) return { kind: 'duplicate' as const };

      const inserted = await tx
        .insert(marginOverrides)
        .values({
          itemCategory: parsed.data.itemCategory,
          marginPct: parsed.data.marginPct.toFixed(2),
          notes: parsed.data.notes ?? null,
          createdByUserId: scope.userId,
        })
        .returning();
      const row = inserted[0]!;

      await tx.insert(auditLog).values({
        actorUserId: scope.userId,
        targetBranchId: null,
        action: 'corporate.margin.create_override',
        scopeType: 'corporate',
        scopeId: null,
        metadata: {
          marginOverrideId: row.id,
          itemCategory: row.itemCategory,
          marginPct: parsed.data.marginPct,
        },
      });
      return { kind: 'ok' as const, row };
    });

    if (outcome.kind === 'duplicate') {
      return reply.code(409).send({
        ok: false,
        error: {
          code: 'CATEGORY_EXISTS',
          message: 'A margin override already exists for that item category',
        },
      });
    }
    return reply.code(201).send({
      ok: true,
      data: serializeOverride(outcome.row),
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v1/corporate/margin-overrides/:id
  // -------------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>(
    '/api/v1/corporate/margin-overrides/:id',
    async (req, reply) => {
      const scope = requireCorporate(req, reply);
      if (!scope) return;
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }

      const parsed = UpdateOverrideBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.message,
            details: parsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
          },
        });
      }

      const outcome = await withScope(db, scope, async (tx) => {
        const existingRows = await tx
          .select()
          .from(marginOverrides)
          .where(eq(marginOverrides.id, req.params.id))
          .limit(1);
        const existing = existingRows[0];
        if (!existing) return { kind: 'not_found' as const };

        const changes: Record<string, unknown> = { updatedAt: new Date() };
        if (parsed.data.marginPct !== undefined) {
          changes['marginPct'] = parsed.data.marginPct.toFixed(2);
        }
        if (parsed.data.notes !== undefined) {
          changes['notes'] = parsed.data.notes;
        }
        const updated = await tx
          .update(marginOverrides)
          .set(changes)
          .where(eq(marginOverrides.id, req.params.id))
          .returning();
        const row = updated[0]!;

        await tx.insert(auditLog).values({
          actorUserId: scope.userId,
          targetBranchId: null,
          action: 'corporate.margin.update_override',
          scopeType: 'corporate',
          scopeId: null,
          metadata: {
            marginOverrideId: row.id,
            itemCategory: row.itemCategory,
            changes: Object.keys(parsed.data),
          },
        });
        return { kind: 'ok' as const, row };
      });

      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Margin override not found' },
        });
      }
      return reply.code(200).send({
        ok: true,
        data: serializeOverride(outcome.row),
      });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/v1/corporate/margin-overrides/:id
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/api/v1/corporate/margin-overrides/:id',
    async (req, reply) => {
      const scope = requireCorporate(req, reply);
      if (!scope) return;
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }

      const outcome = await withScope(db, scope, async (tx) => {
        const existingRows = await tx
          .select()
          .from(marginOverrides)
          .where(eq(marginOverrides.id, req.params.id))
          .limit(1);
        const existing = existingRows[0];
        if (!existing) return { kind: 'not_found' as const };

        const deleted = await tx
          .delete(marginOverrides)
          .where(eq(marginOverrides.id, req.params.id))
          .returning();
        const row = deleted[0]!;

        await tx.insert(auditLog).values({
          actorUserId: scope.userId,
          targetBranchId: null,
          action: 'corporate.margin.delete_override',
          scopeType: 'corporate',
          scopeId: null,
          metadata: {
            marginOverrideId: row.id,
            itemCategory: row.itemCategory,
          },
        });
        return { kind: 'ok' as const, row };
      });

      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Margin override not found' },
        });
      }
      return reply.code(200).send({
        ok: true,
        data: serializeOverride(outcome.row),
      });
    },
  );
}
