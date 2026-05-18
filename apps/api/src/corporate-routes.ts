/**
 * Corporate hub console (CHR-06).
 *
 * Replaces the deleted franchisor + franchisees routes with the canonical
 * /api/v1/corporate/* surface. Every endpoint is corporate-only; non-
 * corporate scopes (branch users) and unauthenticated callers get 404
 * NOT_FOUND so the existence of the route is not leaked.
 *
 * Endpoints:
 *
 *   POST   /api/v1/corporate/branches
 *   GET    /api/v1/corporate/branches
 *   GET    /api/v1/corporate/branches/:id
 *   PATCH  /api/v1/corporate/branches/:id
 *   POST   /api/v1/corporate/branches/:id/managers
 *
 *   GET    /api/v1/corporate/managers
 *
 *   POST   /api/v1/corporate/comp-plans
 *   GET    /api/v1/corporate/comp-plans
 *   GET    /api/v1/corporate/comp-plans/:id
 *   PATCH  /api/v1/corporate/comp-plans/:id
 *   POST   /api/v1/corporate/comp-plans/:id/assign
 *
 * Auth pattern:
 *   - req.scope is null         → 401 UNAUTHENTICATED
 *   - req.scope.type !== 'corporate' → 404 NOT_FOUND (per CLAUDE.md cross-
 *     tenant 404 rule — a branch user has no business knowing this surface
 *     exists)
 *
 * Idempotency-Key (header) is accepted on POSTs. v1 stores nothing — the
 * acceptance is forward-compat scaffolding so callers can already start
 * sending the header. A Redis-backed dedupe lands with the rest of the
 * idempotency middleware in a later phase.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  auditLog,
  branchManagers,
  branches,
  commissionLedger,
  compPlans,
  corporate,
  invoices,
  memberships,
  userCompAssignments,
  users,
  withScope,
  type RequestScope,
  type ScopedTx,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import {
  parseCompPlan,
  type CompPlanValidationError,
} from '@service-ai/contracts';
import { computeCommission } from './commission-engine.js';

type Drizzle = NodePgDatabase<typeof schema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9-]+$/;

// ---------------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------------

/**
 * Guard every corporate endpoint. Returns the scope when the caller is a
 * corporate admin; returns null after sending the structured error reply
 * for anyone else. Callers must `return` immediately when null comes back.
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
    // 404 (not 403) per the cross-tenant pattern — branch users should not
    // even learn this route exists.
    reply.code(404).send({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
    return null;
  }
  return req.scope;
}

/** Build a YYYY-MM period label from a date in UTC. */
function periodLabelFor(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** First and last instant of the calendar month containing `d`, UTC. */
function utcMonthBounds(d: Date): { start: Date; nextStart: Date } {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const nextStart = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  );
  return { start, nextStart };
}

// ---------------------------------------------------------------------------
// Branch endpoints
// ---------------------------------------------------------------------------

const CreateBranchBody = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(SLUG_RE, 'slug must be lowercase kebab'),
  legalEntityName: z.string().max(300).optional(),
  addressLine1: z.string().max(300).optional(),
  addressLine2: z.string().max(300).optional(),
  city: z.string().max(120).optional(),
  region: z.string().max(120).optional(),
  postalCode: z.string().max(40).optional(),
  countryCode: z.string().length(2).optional(),
  timezone: z.string().max(100).optional(),
  phoneNumber: z.string().max(40).optional(),
});

const UpdateBranchBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    legalEntityName: z.string().max(300).nullable().optional(),
    addressLine1: z.string().max(300).nullable().optional(),
    addressLine2: z.string().max(300).nullable().optional(),
    city: z.string().max(120).nullable().optional(),
    region: z.string().max(120).nullable().optional(),
    postalCode: z.string().max(40).nullable().optional(),
    countryCode: z.string().length(2).nullable().optional(),
    timezone: z.string().max(100).optional(),
    phoneNumber: z.string().max(40).nullable().optional(),
    status: z.enum(['active', 'paused', 'closed']).optional(),
    confirmation: z.boolean().optional(),
  })
  .strict();

interface BranchListRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  currentManagerUserId: string | null;
  currentManagerName: string | null;
  revenueMtdCents: number;
  commissionPaidMtdCents: number;
}

/**
 * Aggregate every branch + its current manager + MTD revenue + MTD
 * commission paid. Single query with two LEFT JOINs and two correlated
 * subqueries — no N+1.
 */
async function listBranches(
  tx: ScopedTx,
  now: Date,
): Promise<BranchListRow[]> {
  const { start, nextStart } = utcMonthBounds(now);
  const period = periodLabelFor(now);

  // Subqueries inline so we avoid issuing one query per branch.
  const revenueSql = sql<number>`COALESCE((
    SELECT SUM(${invoices.total})::bigint
    FROM ${invoices}
    WHERE ${invoices.branchId} = ${branches.id}
      AND ${invoices.status} = 'paid'
      AND ${invoices.paidAt} >= ${start}
      AND ${invoices.paidAt} < ${nextStart}
      AND ${invoices.deletedAt} IS NULL
  ), 0)`;

  const commissionSql = sql<number>`COALESCE((
    SELECT SUM(${commissionLedger.amountCents})::bigint
    FROM ${commissionLedger}
    WHERE ${commissionLedger.branchId} = ${branches.id}
      AND ${commissionLedger.periodLabel} = ${period}
  ), 0)`;

  const rows = await tx
    .select({
      id: branches.id,
      name: branches.name,
      slug: branches.slug,
      status: branches.status,
      managerUserId: branchManagers.userId,
      managerName: users.name,
      revenueDollars: revenueSql,
      commissionCents: commissionSql,
    })
    .from(branches)
    .leftJoin(
      branchManagers,
      and(
        eq(branchManagers.branchId, branches.id),
        isNull(branchManagers.endedAt),
      ),
    )
    .leftJoin(users, eq(users.id, branchManagers.userId))
    .orderBy(branches.name);

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    status: r.status,
    currentManagerUserId: r.managerUserId,
    currentManagerName: r.managerName,
    revenueMtdCents: Math.round(Number(r.revenueDollars) * 100),
    commissionPaidMtdCents: Number(r.commissionCents),
  }));
}

interface BranchDetail {
  branch: typeof branches.$inferSelect;
  currentManager: {
    userId: string;
    name: string | null;
    email: string;
    startedAt: Date;
  } | null;
  managerHistory: Array<{
    userId: string;
    name: string | null;
    email: string;
    startedAt: Date;
    endedAt: Date | null;
  }>;
  currentCompPlanAssignment: {
    userId: string;
    compPlanId: string;
    compPlanName: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
  } | null;
  recentAuditLog: Array<{
    id: string;
    action: string;
    actorUserId: string | null;
    metadata: unknown;
    createdAt: Date;
  }>;
}

function registerBranchRoutes(app: FastifyInstance, db: Drizzle): void {
  // POST /branches
  app.post('/api/v1/corporate/branches', async (req, reply) => {
    const scope = requireCorporate(req, reply);
    if (!scope) return;
    const parsed = CreateBranchBody.safeParse(req.body ?? {});
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
        .select({ id: corporate.id })
        .from(corporate)
        .limit(1);
      const corpId = corpRows[0]?.id;
      if (!corpId) return { kind: 'no_corporate' as const };

      const existing = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.slug, parsed.data.slug));
      if (existing[0]) return { kind: 'duplicate' as const };

      const inserted = await tx
        .insert(branches)
        .values({
          corporateId: corpId,
          name: parsed.data.name,
          slug: parsed.data.slug,
          legalEntityName: parsed.data.legalEntityName ?? null,
          addressLine1: parsed.data.addressLine1 ?? null,
          addressLine2: parsed.data.addressLine2 ?? null,
          city: parsed.data.city ?? null,
          region: parsed.data.region ?? null,
          postalCode: parsed.data.postalCode ?? null,
          countryCode: parsed.data.countryCode ?? null,
          timezone: parsed.data.timezone ?? 'America/Edmonton',
          phoneNumber: parsed.data.phoneNumber ?? null,
        })
        .returning();
      const br = inserted[0]!;
      await tx.insert(auditLog).values({
        actorUserId: scope.userId,
        targetBranchId: br.id,
        action: 'branch.create',
        scopeType: 'corporate',
        scopeId: null,
        metadata: { name: br.name, slug: br.slug },
      });
      return { kind: 'ok' as const, branch: br };
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
    if (outcome.kind === 'duplicate') {
      return reply.code(409).send({
        ok: false,
        error: {
          code: 'SLUG_TAKEN',
          message: 'A branch with that slug already exists',
        },
      });
    }
    return reply.code(201).send({ ok: true, data: outcome.branch });
  });

  // GET /branches
  app.get('/api/v1/corporate/branches', async (req, reply) => {
    const scope = requireCorporate(req, reply);
    if (!scope) return;
    const now = new Date();
    const rows = await withScope(db, scope, (tx) => listBranches(tx, now));
    return reply.code(200).send({ ok: true, data: rows });
  });

  // GET /branches/:id
  app.get<{ Params: { id: string } }>(
    '/api/v1/corporate/branches/:id',
    async (req, reply) => {
      const scope = requireCorporate(req, reply);
      if (!scope) return;
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const branchId = req.params.id;
      const detail = await withScope(db, scope, async (tx) => {
        const brRows = await tx
          .select()
          .from(branches)
          .where(eq(branches.id, branchId))
          .limit(1);
        const br = brRows[0];
        if (!br) return null;

        const history = await tx
          .select({
            userId: branchManagers.userId,
            startedAt: branchManagers.startedAt,
            endedAt: branchManagers.endedAt,
            name: users.name,
            email: users.email,
          })
          .from(branchManagers)
          .leftJoin(users, eq(users.id, branchManagers.userId))
          .where(eq(branchManagers.branchId, branchId))
          .orderBy(desc(branchManagers.startedAt))
          .limit(5);

        const currentRow = history.find((h) => h.endedAt === null) ?? null;

        const assignmentRows = await tx
          .select({
            userId: userCompAssignments.userId,
            compPlanId: userCompAssignments.compPlanId,
            compPlanName: compPlans.name,
            effectiveFrom: userCompAssignments.effectiveFrom,
            effectiveTo: userCompAssignments.effectiveTo,
          })
          .from(userCompAssignments)
          .innerJoin(
            compPlans,
            eq(compPlans.id, userCompAssignments.compPlanId),
          )
          .where(
            and(
              eq(userCompAssignments.branchId, branchId),
              isNull(userCompAssignments.effectiveTo),
            ),
          )
          .orderBy(desc(userCompAssignments.effectiveFrom))
          .limit(1);

        const auditRows = await tx
          .select({
            id: auditLog.id,
            action: auditLog.action,
            actorUserId: auditLog.actorUserId,
            metadata: auditLog.metadata,
            createdAt: auditLog.createdAt,
          })
          .from(auditLog)
          .where(eq(auditLog.targetBranchId, branchId))
          .orderBy(desc(auditLog.createdAt))
          .limit(10);

        const detail: BranchDetail = {
          branch: br,
          currentManager: currentRow
            ? {
                userId: currentRow.userId,
                name: currentRow.name,
                email: currentRow.email ?? '',
                startedAt: currentRow.startedAt,
              }
            : null,
          managerHistory: history.map((h) => ({
            userId: h.userId,
            name: h.name,
            email: h.email ?? '',
            startedAt: h.startedAt,
            endedAt: h.endedAt,
          })),
          currentCompPlanAssignment: assignmentRows[0]
            ? {
                userId: assignmentRows[0].userId,
                compPlanId: assignmentRows[0].compPlanId,
                compPlanName: assignmentRows[0].compPlanName,
                effectiveFrom: assignmentRows[0].effectiveFrom,
                effectiveTo: assignmentRows[0].effectiveTo,
              }
            : null,
          recentAuditLog: auditRows,
        };
        return detail;
      });
      if (!detail) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Branch not found' },
        });
      }
      return reply.code(200).send({ ok: true, data: detail });
    },
  );

  // PATCH /branches/:id
  app.patch<{ Params: { id: string } }>(
    '/api/v1/corporate/branches/:id',
    async (req, reply) => {
      const scope = requireCorporate(req, reply);
      if (!scope) return;
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const parsed = UpdateBranchBody.safeParse(req.body ?? {});
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
      const branchId = req.params.id;
      const result = await withScope(db, scope, async (tx) => {
        const existingRows = await tx
          .select()
          .from(branches)
          .where(eq(branches.id, branchId))
          .limit(1);
        const existing = existingRows[0];
        if (!existing) return { kind: 'not_found' as const };

        // active -> paused requires { confirmation: true }
        if (
          parsed.data.status === 'paused' &&
          existing.status === 'active' &&
          parsed.data.confirmation !== true
        ) {
          return { kind: 'confirmation_required' as const };
        }

        const values: Record<string, unknown> = { updatedAt: new Date() };
        const d = parsed.data;
        if (d.name !== undefined) values['name'] = d.name;
        if (d.legalEntityName !== undefined)
          values['legalEntityName'] = d.legalEntityName;
        if (d.addressLine1 !== undefined)
          values['addressLine1'] = d.addressLine1;
        if (d.addressLine2 !== undefined)
          values['addressLine2'] = d.addressLine2;
        if (d.city !== undefined) values['city'] = d.city;
        if (d.region !== undefined) values['region'] = d.region;
        if (d.postalCode !== undefined) values['postalCode'] = d.postalCode;
        if (d.countryCode !== undefined) values['countryCode'] = d.countryCode;
        if (d.timezone !== undefined) values['timezone'] = d.timezone;
        if (d.phoneNumber !== undefined) values['phoneNumber'] = d.phoneNumber;
        if (d.status !== undefined) values['status'] = d.status;

        const next = await tx
          .update(branches)
          .set(values)
          .where(eq(branches.id, branchId))
          .returning();
        await tx.insert(auditLog).values({
          actorUserId: scope.userId,
          targetBranchId: branchId,
          action: 'branch.update',
          scopeType: 'corporate',
          scopeId: null,
          metadata: { changes: Object.keys(values).filter((k) => k !== 'updatedAt') },
        });
        return { kind: 'ok' as const, row: next[0]! };
      });
      if (result.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Branch not found' },
        });
      }
      if (result.kind === 'confirmation_required') {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'CONFIRMATION_REQUIRED',
            message: 'Pausing an active branch requires confirmation: true',
          },
        });
      }
      return reply.code(200).send({ ok: true, data: result.row });
    },
  );

  // POST /branches/:id/managers
  const AssignManagerBody = z.object({
    userId: z.string().min(1),
  });
  app.post<{ Params: { id: string } }>(
    '/api/v1/corporate/branches/:id/managers',
    async (req, reply) => {
      const scope = requireCorporate(req, reply);
      if (!scope) return;
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const parsed = AssignManagerBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.message,
          },
        });
      }
      const branchId = req.params.id;
      const result = await withScope(db, scope, async (tx) => {
        const brRows = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(eq(branches.id, branchId))
          .limit(1);
        if (!brRows[0]) return { kind: 'not_found' as const };

        const userRows = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, parsed.data.userId))
          .limit(1);
        if (!userRows[0]) return { kind: 'user_not_found' as const };

        const now = new Date();
        await tx
          .update(branchManagers)
          .set({ endedAt: now })
          .where(
            and(
              eq(branchManagers.branchId, branchId),
              isNull(branchManagers.endedAt),
            ),
          );
        const inserted = await tx
          .insert(branchManagers)
          .values({
            branchId,
            userId: parsed.data.userId,
            startedAt: now,
          })
          .returning();
        await tx.insert(auditLog).values({
          actorUserId: scope.userId,
          targetBranchId: branchId,
          action: 'branch.assign_manager',
          scopeType: 'corporate',
          scopeId: null,
          metadata: { userId: parsed.data.userId },
        });
        return { kind: 'ok' as const, row: inserted[0]! };
      });
      if (result.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Branch not found' },
        });
      }
      if (result.kind === 'user_not_found') {
        return reply.code(400).send({
          ok: false,
          error: { code: 'USER_NOT_FOUND', message: 'userId does not exist' },
        });
      }
      return reply.code(201).send({ ok: true, data: result.row });
    },
  );
}

// ---------------------------------------------------------------------------
// Managers
// ---------------------------------------------------------------------------

interface ManagerRow {
  userId: string;
  name: string | null;
  email: string;
  branchId: string | null;
  branchName: string | null;
  compPlanId: string | null;
  compPlanName: string | null;
  currentPeriodTotalCents: number;
}

function registerManagerRoutes(app: FastifyInstance, db: Drizzle): void {
  app.get('/api/v1/corporate/managers', async (req, reply) => {
    const scope = requireCorporate(req, reply);
    if (!scope) return;
    const now = new Date();
    const period = periodLabelFor(now);

    const rows = await withScope(db, scope, async (tx) => {
      // Every user with a manager-role membership, joined to their active
      // branch_managers row (if any) and active comp plan assignment.
      const memberRows = await tx
        .select({
          userId: memberships.userId,
          name: users.name,
          email: users.email,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.role, 'manager'),
            isNull(memberships.deletedAt),
          ),
        );

      // Deduplicate (a user could in theory have two manager memberships
      // before this scope is cleaned up — keep the first row).
      const unique = new Map<string, (typeof memberRows)[number]>();
      for (const m of memberRows) {
        if (!unique.has(m.userId)) unique.set(m.userId, m);
      }

      const out: ManagerRow[] = [];
      for (const m of unique.values()) {
        const bm = await tx
          .select({
            branchId: branchManagers.branchId,
            branchName: branches.name,
          })
          .from(branchManagers)
          .leftJoin(branches, eq(branches.id, branchManagers.branchId))
          .where(
            and(
              eq(branchManagers.userId, m.userId),
              isNull(branchManagers.endedAt),
            ),
          )
          .limit(1);
        const assignment = await tx
          .select({
            compPlanId: userCompAssignments.compPlanId,
            compPlanName: compPlans.name,
          })
          .from(userCompAssignments)
          .innerJoin(
            compPlans,
            eq(compPlans.id, userCompAssignments.compPlanId),
          )
          .where(
            and(
              eq(userCompAssignments.userId, m.userId),
              isNull(userCompAssignments.effectiveTo),
            ),
          )
          .orderBy(desc(userCompAssignments.effectiveFrom))
          .limit(1);

        const commission = await computeCommission(tx, m.userId, period);

        out.push({
          userId: m.userId,
          name: m.name,
          email: m.email,
          branchId: bm[0]?.branchId ?? null,
          branchName: bm[0]?.branchName ?? null,
          compPlanId: assignment[0]?.compPlanId ?? null,
          compPlanName: assignment[0]?.compPlanName ?? null,
          currentPeriodTotalCents: commission.totalCents,
        });
      }
      return out;
    });
    return reply.code(200).send({ ok: true, data: rows });
  });
}

// ---------------------------------------------------------------------------
// Comp plans
// ---------------------------------------------------------------------------

interface AssignmentRow {
  userId: string;
  branchId: string;
  branchName: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

interface CompPlanDetail {
  plan: typeof compPlans.$inferSelect;
  assignedUsers: AssignmentRow[];
}

/**
 * Map a CompPlanValidationError thrown by parseCompPlan into a Fastify
 * reply. Returns true when the caller should stop (after sending). The
 * thrown object is a plain object (not Error instance) so we just type-
 * guard on shape.
 */
function isCompPlanValidationError(
  e: unknown,
): e is CompPlanValidationError {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    ((e as { code: unknown }).code === 'INVALID_COMP_PLAN' ||
      (e as { code: unknown }).code === 'INVALID_COMMISSION_RULE')
  );
}

const AssignCompPlanBody = z.object({
  userId: z.string().min(1),
  branchId: z.string().uuid(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .nullable()
    .optional(),
});

function registerCompPlanRoutes(app: FastifyInstance, db: Drizzle): void {
  // POST /comp-plans — body validated via parseCompPlan
  app.post('/api/v1/corporate/comp-plans', async (req, reply) => {
    const scope = requireCorporate(req, reply);
    if (!scope) return;
    let parsed: ReturnType<typeof parseCompPlan>;
    try {
      parsed = parseCompPlan(req.body ?? {});
    } catch (err) {
      if (isCompPlanValidationError(err)) {
        return reply
          .code(400)
          .send({ ok: false, error: err });
      }
      throw err;
    }
    const inserted = await withScope(db, scope, async (tx) => {
      const rows = await tx
        .insert(compPlans)
        .values({
          name: parsed.name,
          kind: parsed.kind,
          baseSalaryCents: parsed.baseSalaryCents,
          payPeriod: parsed.payPeriod,
          commissionRules: parsed.commissionRules,
          effectiveFrom: new Date(parsed.effectiveFrom),
          effectiveTo: parsed.effectiveTo
            ? new Date(parsed.effectiveTo)
            : null,
        })
        .returning();
      const plan = rows[0]!;
      await tx.insert(auditLog).values({
        actorUserId: scope.userId,
        targetBranchId: null,
        action: 'comp_plan.create',
        scopeType: 'corporate',
        scopeId: null,
        metadata: { compPlanId: plan.id, name: plan.name },
      });
      return plan;
    });
    return reply.code(201).send({ ok: true, data: inserted });
  });

  // GET /comp-plans
  app.get('/api/v1/corporate/comp-plans', async (req, reply) => {
    const scope = requireCorporate(req, reply);
    if (!scope) return;
    const rows = await withScope(db, scope, (tx) =>
      tx
        .select()
        .from(compPlans)
        .orderBy(desc(compPlans.effectiveFrom)),
    );
    return reply.code(200).send({ ok: true, data: rows });
  });

  // GET /comp-plans/:id
  app.get<{ Params: { id: string } }>(
    '/api/v1/corporate/comp-plans/:id',
    async (req, reply) => {
      const scope = requireCorporate(req, reply);
      if (!scope) return;
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const planId = req.params.id;
      const detail = await withScope(db, scope, async (tx) => {
        const planRows = await tx
          .select()
          .from(compPlans)
          .where(eq(compPlans.id, planId))
          .limit(1);
        const plan = planRows[0];
        if (!plan) return null;
        const assignments = await tx
          .select({
            userId: userCompAssignments.userId,
            branchId: userCompAssignments.branchId,
            branchName: branches.name,
            effectiveFrom: userCompAssignments.effectiveFrom,
            effectiveTo: userCompAssignments.effectiveTo,
          })
          .from(userCompAssignments)
          .leftJoin(branches, eq(branches.id, userCompAssignments.branchId))
          .where(
            and(
              eq(userCompAssignments.compPlanId, planId),
              isNull(userCompAssignments.effectiveTo),
            ),
          )
          .orderBy(desc(userCompAssignments.effectiveFrom));
        const out: CompPlanDetail = { plan, assignedUsers: assignments };
        return out;
      });
      if (!detail) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Comp plan not found' },
        });
      }
      return reply.code(200).send({ ok: true, data: detail });
    },
  );

  // PATCH /comp-plans/:id — partial update; re-validate the merged result.
  app.patch<{ Params: { id: string } }>(
    '/api/v1/corporate/comp-plans/:id',
    async (req, reply) => {
      const scope = requireCorporate(req, reply);
      if (!scope) return;
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const planId = req.params.id;
      const body = (req.body ?? {}) as Record<string, unknown>;

      const result = await withScope(db, scope, async (tx) => {
        const existingRows = await tx
          .select()
          .from(compPlans)
          .where(eq(compPlans.id, planId))
          .limit(1);
        const existing = existingRows[0];
        if (!existing) return { kind: 'not_found' as const };

        // Build the candidate merged plan in the application-level shape
        // expected by parseCompPlan (note: date columns come back as Date
        // objects, the contract wants YYYY-MM-DD strings).
        const merged = {
          id: existing.id,
          name: 'name' in body ? body['name'] : existing.name,
          kind: 'kind' in body ? body['kind'] : existing.kind,
          baseSalaryCents:
            'baseSalaryCents' in body
              ? body['baseSalaryCents']
              : existing.baseSalaryCents,
          payPeriod:
            'payPeriod' in body ? body['payPeriod'] : existing.payPeriod,
          commissionRules:
            'commissionRules' in body
              ? body['commissionRules']
              : existing.commissionRules,
          effectiveFrom:
            'effectiveFrom' in body
              ? body['effectiveFrom']
              : existing.effectiveFrom.toISOString().slice(0, 10),
          effectiveTo:
            'effectiveTo' in body
              ? body['effectiveTo']
              : existing.effectiveTo
                ? existing.effectiveTo.toISOString().slice(0, 10)
                : null,
        };

        let validated: ReturnType<typeof parseCompPlan>;
        try {
          validated = parseCompPlan(merged);
        } catch (err) {
          if (isCompPlanValidationError(err)) {
            return { kind: 'validation' as const, error: err };
          }
          throw err;
        }

        const updated = await tx
          .update(compPlans)
          .set({
            name: validated.name,
            kind: validated.kind,
            baseSalaryCents: validated.baseSalaryCents,
            payPeriod: validated.payPeriod,
            commissionRules: validated.commissionRules,
            effectiveFrom: new Date(validated.effectiveFrom),
            effectiveTo: validated.effectiveTo
              ? new Date(validated.effectiveTo)
              : null,
            updatedAt: new Date(),
          })
          .where(eq(compPlans.id, planId))
          .returning();
        await tx.insert(auditLog).values({
          actorUserId: scope.userId,
          targetBranchId: null,
          action: 'comp_plan.update',
          scopeType: 'corporate',
          scopeId: null,
          metadata: { compPlanId: planId, fields: Object.keys(body) },
        });
        return { kind: 'ok' as const, row: updated[0]! };
      });

      if (result.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Comp plan not found' },
        });
      }
      if (result.kind === 'validation') {
        return reply.code(400).send({ ok: false, error: result.error });
      }
      return reply.code(200).send({ ok: true, data: result.row });
    },
  );

  // POST /comp-plans/:id/assign
  app.post<{ Params: { id: string } }>(
    '/api/v1/corporate/comp-plans/:id/assign',
    async (req, reply) => {
      const scope = requireCorporate(req, reply);
      if (!scope) return;
      if (!UUID_RE.test(req.params.id)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'id must be a UUID' },
        });
      }
      const parsed = AssignCompPlanBody.safeParse(req.body ?? {});
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
      const planId = req.params.id;
      const result = await withScope(db, scope, async (tx) => {
        const planRows = await tx
          .select({ id: compPlans.id })
          .from(compPlans)
          .where(eq(compPlans.id, planId))
          .limit(1);
        if (!planRows[0]) return { kind: 'not_found' as const };

        // Close any active assignment for this user.
        const today = new Date(parsed.data.effectiveFrom);
        await tx
          .update(userCompAssignments)
          .set({ effectiveTo: today })
          .where(
            and(
              eq(userCompAssignments.userId, parsed.data.userId),
              isNull(userCompAssignments.effectiveTo),
            ),
          );

        const inserted = await tx
          .insert(userCompAssignments)
          .values({
            userId: parsed.data.userId,
            compPlanId: planId,
            branchId: parsed.data.branchId,
            effectiveFrom: new Date(parsed.data.effectiveFrom),
            effectiveTo: parsed.data.effectiveTo
              ? new Date(parsed.data.effectiveTo)
              : null,
          })
          .returning();
        await tx.insert(auditLog).values({
          actorUserId: scope.userId,
          targetBranchId: parsed.data.branchId,
          action: 'comp_plan.assign',
          scopeType: 'corporate',
          scopeId: null,
          metadata: {
            compPlanId: planId,
            userId: parsed.data.userId,
            branchId: parsed.data.branchId,
          },
        });
        return { kind: 'ok' as const, row: inserted[0]! };
      });
      if (result.kind === 'not_found') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: 'Comp plan not found' },
        });
      }
      return reply.code(201).send({ ok: true, data: result.row });
    },
  );
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export interface CorporateRouteOptions {
  drizzle: Drizzle;
}

/**
 * Mount the /api/v1/corporate/* surface. Must run AFTER requestScopePlugin
 * is registered (the handlers read req.scope).
 */
export function registerCorporateRoutes(
  app: FastifyInstance,
  opts: CorporateRouteOptions,
): void {
  registerBranchRoutes(app, opts.drizzle);
  registerManagerRoutes(app, opts.drizzle);
  registerCompPlanRoutes(app, opts.drizzle);
}
