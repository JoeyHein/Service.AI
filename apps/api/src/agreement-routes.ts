/**
 * Franchise-agreement CRUD (TASK-RE-03).
 *
 *   POST   /api/v1/franchisees/:id/agreement           create draft
 *   GET    /api/v1/franchisees/:id/agreement           active (or most recent)
 *   PATCH  /api/v1/franchisees/:id/agreement/:aid      edit draft rules
 *   POST   /api/v1/franchisees/:id/agreement/:aid/activate
 *
 * Only platform_admin + the owning franchisor_admin may touch
 * agreements. The rest of the tenant tree gets 403 — franchisee
 * owners can *read* via the franchisee-scoped GET once RE-07's
 * `/statements` reads derive from this data, but they cannot
 * mutate their own platform fee.
 */

import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  franchiseAgreements,
  franchisees,
  royaltyRules,
  withScope,
  type RequestScope,
  type ScopedTx,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import type { RuleType } from './royalty-engine.js';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Per-rule-type Zod schemas. Defending against malformed JSONB at
// the API boundary means the engine can trust its inputs.
// ---------------------------------------------------------------------------

const PercentageSchema = z.object({
  type: z.literal('percentage'),
  params: z.object({
    basisPoints: z.number().int().nonnegative().max(10000),
  }),
});

const FlatPerJobSchema = z.object({
  type: z.literal('flat_per_job'),
  params: z.object({
    amountCents: z.number().int().nonnegative().max(1_000_000_00),
  }),
});

const TieredSchema = z.object({
  type: z.literal('tiered'),
  params: z.object({
    tiers: z
      .array(
        z.object({
          upToCents: z.number().int().positive().nullable(),
          basisPoints: z.number().int().nonnegative().max(10000),
        }),
      )
      .min(1)
      // Enforce ascending upToCents + at most one null (the tail).
      .superRefine((tiers, ctx) => {
        let prev = -1;
        let nullCount = 0;
        for (let i = 0; i < tiers.length; i++) {
          const t = tiers[i]!;
          if (t.upToCents === null) {
            nullCount++;
            if (nullCount > 1 || i !== tiers.length - 1) {
              ctx.addIssue({
                code: 'custom',
                message: 'null upToCents is only allowed on the last tier',
              });
            }
          } else {
            if (t.upToCents <= prev) {
              ctx.addIssue({
                code: 'custom',
                message: 'tiers must be in ascending upToCents order',
              });
            }
            prev = t.upToCents;
          }
        }
      }),
  }),
});

const MinimumFloorSchema = z.object({
  type: z.literal('minimum_floor'),
  params: z.object({
    perMonthCents: z.number().int().nonnegative().max(1_000_000_00),
  }),
});

const RuleSchema = z.discriminatedUnion('type', [
  PercentageSchema,
  FlatPerJobSchema,
  TieredSchema,
  MinimumFloorSchema,
]);

const AgreementBody = z.object({
  name: z.string().min(1).max(200),
  notes: z.string().max(2000).nullable().optional(),
  startsOn: z.string().datetime().nullable().optional(),
  endsOn: z.string().datetime().nullable().optional(),
  rules: z.array(RuleSchema).default([]),
});

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  notes: z.string().max(2000).nullable().optional(),
  rules: z.array(RuleSchema).optional(),
});

function canAdminFranchisee(scope: RequestScope, franchisorId: string): boolean {
  if (scope.type === 'platform') return true;
  if (scope.type === 'franchisor' && scope.franchisorId === franchisorId)
    return true;
  return false;
}

function canReadFranchisee(scope: RequestScope, franchisorId: string, franchiseeId: string): boolean {
  if (canAdminFranchisee(scope, franchisorId)) return true;
  if (scope.type === 'franchisee' && scope.franchiseeId === franchiseeId)
    return true;
  return false;
}

async function loadFranchisee(tx: ScopedTx, id: string) {
  const rows = await tx.select().from(franchisees).where(eq(franchisees.id, id));
  return rows[0] ?? null;
}

export function registerAgreementRoutes(
  app: FastifyInstance,
  db: Drizzle,
): void {
  // ----- POST /api/v1/franchisees/:id/agreement (create draft) --------------
  app.post<{ Params: { id: string } }>(
    '/api/v1/franchisees/:id/agreement',
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
      const parsed = AgreementBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;
      const userId = req.userId;
      const outcome = await withScope(db, scope, async (tx) => {
        const fe = await loadFranchisee(tx, req.params.id);
        if (!fe) return { kind: 'not_found' as const };
        if (!canAdminFranchisee(scope, fe.franchisorId))
          return { kind: 'forbidden' as const };

        const inserted = await tx
          .insert(franchiseAgreements)
          .values({
            franchiseeId: fe.id,
            franchisorId: fe.franchisorId,
            status: 'draft',
            name: parsed.data.name,
            notes: parsed.data.notes ?? null,
            startsOn: parsed.data.startsOn ? new Date(parsed.data.startsOn) : null,
            endsOn: parsed.data.endsOn ? new Date(parsed.data.endsOn) : null,
            createdByUserId: userId ?? null,
          })
          .returning();
        const agreement = inserted[0]!;
        if (parsed.data.rules.length > 0) {
          await tx.insert(royaltyRules).values(
            parsed.data.rules.map((r, idx) => ({
              agreementId: agreement.id,
              franchiseeId: fe.id,
              ruleType: r.type as RuleType,
              params: r.params,
              sortOrder: idx,
            })),
          );
        }
        const freshRules = await tx
          .select()
          .from(royaltyRules)
          .where(eq(royaltyRules.agreementId, agreement.id))
          .orderBy(royaltyRules.sortOrder);
        return { kind: 'ok' as const, agreement, rules: freshRules };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Franchisee not found' },
        });
      }
      if (outcome.kind === 'forbidden') {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Admin-only' },
        });
      }
      return reply.code(201).send({
        ok: true,
        data: { ...outcome.agreement, rules: outcome.rules },
      });
    },
  );

  // ----- GET /api/v1/franchisees/:id/agreement ------------------------------
  app.get<{ Params: { id: string } }>(
    '/api/v1/franchisees/:id/agreement',
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
        const fe = await loadFranchisee(tx, req.params.id);
        if (!fe) return { kind: 'not_found' as const };
        if (!canReadFranchisee(scope, fe.franchisorId, fe.id))
          return { kind: 'not_found' as const };
        const active = await tx
          .select()
          .from(franchiseAgreements)
          .where(
            and(
              eq(franchiseAgreements.franchiseeId, fe.id),
              eq(franchiseAgreements.status, 'active'),
            ),
          );
        let agreement = active[0];
        if (!agreement) {
          const recent = await tx
            .select()
            .from(franchiseAgreements)
            .where(eq(franchiseAgreements.franchiseeId, fe.id))
            .orderBy(desc(franchiseAgreements.createdAt))
            .limit(1);
          agreement = recent[0];
        }
        if (!agreement) return { kind: 'none' as const };
        const rules = await tx
          .select()
          .from(royaltyRules)
          .where(eq(royaltyRules.agreementId, agreement.id))
          .orderBy(royaltyRules.sortOrder);
        return { kind: 'ok' as const, agreement, rules };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Franchisee not found' },
        });
      }
      if (outcome.kind === 'none') {
        return reply.code(200).send({ ok: true, data: null });
      }
      return reply.code(200).send({
        ok: true,
        data: { ...outcome.agreement, rules: outcome.rules },
      });
    },
  );

  // ----- PATCH /api/v1/franchisees/:id/agreement/:aid -----------------------
  app.patch<{ Params: { id: string; aid: string } }>(
    '/api/v1/franchisees/:id/agreement/:aid',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.aid)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'ids must be UUIDs' },
        });
      }
      const parsed = PatchBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const scope = req.scope;
      const outcome = await withScope(db, scope, async (tx) => {
        const fe = await loadFranchisee(tx, req.params.id);
        if (!fe) return { kind: 'not_found' as const };
        if (!canAdminFranchisee(scope, fe.franchisorId))
          return { kind: 'forbidden' as const };
        const rows = await tx
          .select()
          .from(franchiseAgreements)
          .where(
            and(
              eq(franchiseAgreements.id, req.params.aid),
              eq(franchiseAgreements.franchiseeId, fe.id),
            ),
          );
        const agreement = rows[0];
        if (!agreement) return { kind: 'not_found' as const };
        if (agreement.status !== 'draft') return { kind: 'locked' as const };

        const values: Record<string, unknown> = { updatedAt: new Date() };
        if (parsed.data.name !== undefined) values.name = parsed.data.name;
        if (parsed.data.notes !== undefined) values.notes = parsed.data.notes;
        await tx
          .update(franchiseAgreements)
          .set(values)
          .where(eq(franchiseAgreements.id, agreement.id));

        if (parsed.data.rules !== undefined) {
          await tx
            .delete(royaltyRules)
            .where(eq(royaltyRules.agreementId, agreement.id));
          if (parsed.data.rules.length > 0) {
            await tx.insert(royaltyRules).values(
              parsed.data.rules.map((r, idx) => ({
                agreementId: agreement.id,
                franchiseeId: fe.id,
                ruleType: r.type as RuleType,
                params: r.params,
                sortOrder: idx,
              })),
            );
          }
        }
        const refreshed = await tx
          .select()
          .from(franchiseAgreements)
          .where(eq(franchiseAgreements.id, agreement.id));
        const rules = await tx
          .select()
          .from(royaltyRules)
          .where(eq(royaltyRules.agreementId, agreement.id))
          .orderBy(royaltyRules.sortOrder);
        return { kind: 'ok' as const, agreement: refreshed[0]!, rules };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Agreement not found' },
        });
      }
      if (outcome.kind === 'forbidden') {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Admin-only' },
        });
      }
      if (outcome.kind === 'locked') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'AGREEMENT_LOCKED',
            message: 'Only draft agreements can be edited',
          },
        });
      }
      return reply.code(200).send({
        ok: true,
        data: { ...outcome.agreement, rules: outcome.rules },
      });
    },
  );

  // ----- POST /api/v1/franchisees/:id/agreement/:aid/activate ---------------
  app.post<{ Params: { id: string; aid: string } }>(
    '/api/v1/franchisees/:id/agreement/:aid/activate',
    async (req, reply) => {
      if (req.scope === null) {
        return reply.code(401).send({
          ok: false,
          error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
        });
      }
      if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.aid)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'ids must be UUIDs' },
        });
      }
      const scope = req.scope;
      const outcome = await withScope(db, scope, async (tx) => {
        const fe = await loadFranchisee(tx, req.params.id);
        if (!fe) return { kind: 'not_found' as const };
        if (!canAdminFranchisee(scope, fe.franchisorId))
          return { kind: 'forbidden' as const };
        const rows = await tx
          .select()
          .from(franchiseAgreements)
          .where(
            and(
              eq(franchiseAgreements.id, req.params.aid),
              eq(franchiseAgreements.franchiseeId, fe.id),
            ),
          );
        const agreement = rows[0];
        if (!agreement) return { kind: 'not_found' as const };
        if (agreement.status === 'active') return { kind: 'already' as const };
        if (agreement.status !== 'draft') return { kind: 'bad' as const };
        // End any prior active, then flip this one to active — both in
        // the same transaction so the partial unique index never fires.
        await tx
          .update(franchiseAgreements)
          .set({ status: 'ended', endsOn: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(franchiseAgreements.franchiseeId, fe.id),
              eq(franchiseAgreements.status, 'active'),
            ),
          );
        const now = new Date();
        const updated = await tx
          .update(franchiseAgreements)
          .set({ status: 'active', startsOn: now, updatedAt: now })
          .where(eq(franchiseAgreements.id, agreement.id))
          .returning();
        const rules = await tx
          .select()
          .from(royaltyRules)
          .where(eq(royaltyRules.agreementId, agreement.id))
          .orderBy(royaltyRules.sortOrder);
        return { kind: 'ok' as const, agreement: updated[0]!, rules };
      });
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Agreement not found' },
        });
      }
      if (outcome.kind === 'forbidden') {
        return reply.code(403).send({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Admin-only' },
        });
      }
      if (outcome.kind === 'already') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'ALREADY_ACTIVE',
            message: 'Agreement is already active',
          },
        });
      }
      if (outcome.kind === 'bad') {
        return reply.code(409).send({
          ok: false,
          error: {
            code: 'INVALID_TRANSITION',
            message: 'Only draft agreements can be activated',
          },
        });
      }
      return reply.code(200).send({
        ok: true,
        data: { ...outcome.agreement, rules: outcome.rules },
      });
    },
  );
}
