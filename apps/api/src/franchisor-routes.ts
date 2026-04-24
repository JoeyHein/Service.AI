/**
 * Franchisor console API (phase_franchisor_console).
 *
 *   GET  /api/v1/franchisor/network-metrics     rollup + per-franchisee
 *   POST /api/v1/franchisor/onboard             create a new franchisee
 *
 * Both endpoints are platform_admin + franchisor_admin only.
 * Franchisee-scope users / tech / CSR → 403.
 *
 * Metrics projector is pure: no writes. The onboarding endpoint
 * deliberately ignores any `franchisorId` sent in the body —
 * the caller's `request.scope` is the authoritative source.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  aiMessages,
  franchisees,
  invoices,
  jobs,
  locations,
  payments,
  royaltyStatements,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// Metrics projector
// ---------------------------------------------------------------------------

export interface PerFranchiseeMetrics {
  franchiseeId: string;
  name: string;
  revenueCents: number;
  openArCents: number;
  jobsCount: number;
  aiCostUsd: number;
  royaltyCollectedCents: number;
}

export interface NetworkMetrics {
  totals: {
    revenueCents: number;
    openArCents: number;
    aiCostUsd: number;
    royaltyCollectedCents: number;
    jobsCount: number;
    franchiseeCount: number;
  };
  perFranchisee: PerFranchiseeMetrics[];
}

export interface NetworkMetricsInput {
  scope: RequestScope;
  periodStart?: Date;
  periodEnd?: Date;
}

export async function computeNetworkMetrics(
  db: Drizzle,
  input: NetworkMetricsInput,
): Promise<NetworkMetrics> {
  const periodEnd = input.periodEnd ?? new Date();
  const periodStart =
    input.periodStart ??
    new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000);

  return await withScope(db, input.scope, async (tx) => {
    // Load the set of franchisees visible to this caller.
    const feRows = await (async () => {
      if (input.scope.type === 'platform') {
        return tx
          .select({ id: franchisees.id, name: franchisees.name })
          .from(franchisees);
      }
      if (input.scope.type === 'franchisor') {
        return tx
          .select({ id: franchisees.id, name: franchisees.name })
          .from(franchisees)
          .where(eq(franchisees.franchisorId, input.scope.franchisorId));
      }
      return [];
    })();

    const per: PerFranchiseeMetrics[] = [];
    for (const fe of feRows) {
      // Revenue = payments.amount in period.
      const payRows = await tx
        .select({
          amount: payments.amount,
          fee: payments.applicationFeeAmount,
          createdAt: payments.createdAt,
        })
        .from(payments)
        .where(
          and(
            eq(payments.franchiseeId, fe.id),
            gte(payments.createdAt, periodStart),
            lt(payments.createdAt, periodEnd),
          ),
        );
      const revenueCents = payRows.reduce(
        (acc, r) => acc + Math.round(Number(r.amount) * 100),
        0,
      );

      // Open AR = sum of sent/finalized invoice totals in period.
      const arRows = await tx
        .select({ total: invoices.total, status: invoices.status })
        .from(invoices)
        .where(
          and(
            eq(invoices.franchiseeId, fe.id),
            gte(invoices.finalizedAt, periodStart),
            lt(invoices.finalizedAt, periodEnd),
            isNull(invoices.deletedAt),
          ),
        );
      const openArCents = arRows
        .filter((r) => r.status === 'sent' || r.status === 'finalized')
        .reduce((acc, r) => acc + Math.round(Number(r.total) * 100), 0);

      // Jobs count in period (any status, in the window).
      const jobsCountRows = await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(jobs)
        .where(
          and(
            eq(jobs.franchiseeId, fe.id),
            gte(jobs.createdAt, periodStart),
            lt(jobs.createdAt, periodEnd),
            isNull(jobs.deletedAt),
          ),
        );
      const jobsCount = jobsCountRows[0]?.c ?? 0;

      // AI cost = sum(ai_messages.cost_usd) in period.
      const aiCostRows = await tx
        .select({
          total: sql<string>`COALESCE(SUM(${aiMessages.costUsd}), 0)`,
        })
        .from(aiMessages)
        .where(
          and(
            eq(aiMessages.franchiseeId, fe.id),
            gte(aiMessages.createdAt, periodStart),
            lt(aiMessages.createdAt, periodEnd),
          ),
        );
      const aiCostUsd = Number(aiCostRows[0]?.total ?? 0);

      // Royalty collected = sum(royalty_collected) from
      // royalty_statements whose period overlaps ours. For v1 we
      // take any statement with period_start within the window.
      const royRows = await tx
        .select({ collected: royaltyStatements.royaltyCollected })
        .from(royaltyStatements)
        .where(
          and(
            eq(royaltyStatements.franchiseeId, fe.id),
            gte(royaltyStatements.periodStart, periodStart),
            lt(royaltyStatements.periodStart, periodEnd),
          ),
        );
      const royaltyCollectedCents = royRows.reduce(
        (acc, r) => acc + Math.round(Number(r.collected) * 100),
        0,
      );

      per.push({
        franchiseeId: fe.id,
        name: fe.name,
        revenueCents,
        openArCents,
        jobsCount,
        aiCostUsd: Number(aiCostUsd.toFixed(4)),
        royaltyCollectedCents,
      });
    }

    const totals = per.reduce(
      (acc, r) => ({
        revenueCents: acc.revenueCents + r.revenueCents,
        openArCents: acc.openArCents + r.openArCents,
        aiCostUsd: acc.aiCostUsd + r.aiCostUsd,
        royaltyCollectedCents:
          acc.royaltyCollectedCents + r.royaltyCollectedCents,
        jobsCount: acc.jobsCount + r.jobsCount,
        franchiseeCount: acc.franchiseeCount + 1,
      }),
      {
        revenueCents: 0,
        openArCents: 0,
        aiCostUsd: 0,
        royaltyCollectedCents: 0,
        jobsCount: 0,
        franchiseeCount: 0,
      },
    );

    return { totals, perFranchisee: per };
  });
}

// ---------------------------------------------------------------------------
// Onboarding — creates a franchisee row + a default location.
// ---------------------------------------------------------------------------

const OnboardBody = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase kebab'),
  legalEntityName: z.string().max(300).optional(),
  locationName: z.string().max(200).optional(),
  timezone: z.string().max(100).optional(),
});

// ---------------------------------------------------------------------------
// Role helper
// ---------------------------------------------------------------------------

function canAdminNetwork(scope: RequestScope): boolean {
  if (scope.type === 'platform') return true;
  if (scope.type === 'franchisor') return true;
  return false;
}

export function registerFranchisorConsoleRoutes(
  app: FastifyInstance,
  db: Drizzle,
): void {
  // ----- GET /api/v1/franchisor/network-metrics ----------------------------
  app.get('/api/v1/franchisor/network-metrics', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    if (!canAdminNetwork(scope)) {
      return reply.code(403).send({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Admin-only' },
      });
    }
    const q = req.query as Record<string, string | undefined>;
    let periodStart: Date | undefined;
    let periodEnd: Date | undefined;
    if (q['periodStart']) {
      const d = new Date(q['periodStart']);
      if (Number.isNaN(d.getTime())) {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'periodStart must be ISO-8601',
          },
        });
      }
      periodStart = d;
    }
    if (q['periodEnd']) {
      const d = new Date(q['periodEnd']);
      if (Number.isNaN(d.getTime())) {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'periodEnd must be ISO-8601',
          },
        });
      }
      periodEnd = d;
    }
    const metrics = await computeNetworkMetrics(db, {
      scope,
      periodStart,
      periodEnd,
    });
    return reply.code(200).send({ ok: true, data: metrics });
  });

  // ----- POST /api/v1/franchisor/onboard -----------------------------------
  app.post('/api/v1/franchisor/onboard', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    const scope = req.scope;
    if (!canAdminNetwork(scope)) {
      return reply.code(403).send({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Admin-only' },
      });
    }
    const parsed = OnboardBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }

    // Determine the target franchisor.
    //   platform_admin: allow a body-supplied franchisorId but
    //     fail closed if omitted.
    //   franchisor_admin: always use their own scope.
    let targetFranchisorId: string;
    if (scope.type === 'franchisor') {
      targetFranchisorId = scope.franchisorId;
    } else {
      const candidate = (req.body as { franchisorId?: string } | null | undefined)
        ?.franchisorId;
      if (!candidate) {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Platform admin must supply franchisorId',
          },
        });
      }
      targetFranchisorId = candidate;
    }

    const outcome = await withScope(db, scope, async (tx) => {
      // Check slug uniqueness inside the franchisor.
      const existing = await tx
        .select({ id: franchisees.id })
        .from(franchisees)
        .where(
          and(
            eq(franchisees.franchisorId, targetFranchisorId),
            eq(franchisees.slug, parsed.data.slug),
          ),
        );
      if (existing[0]) return { kind: 'duplicate' as const };
      const inserted = await tx
        .insert(franchisees)
        .values({
          franchisorId: targetFranchisorId,
          name: parsed.data.name,
          slug: parsed.data.slug,
          legalEntityName: parsed.data.legalEntityName ?? null,
        })
        .returning();
      const fe = inserted[0]!;
      if (parsed.data.locationName) {
        await tx.insert(locations).values({
          franchiseeId: fe.id,
          name: parsed.data.locationName,
          timezone: parsed.data.timezone ?? 'America/Denver',
        });
      }
      return { kind: 'ok' as const, franchisee: fe };
    });

    if (outcome.kind === 'duplicate') {
      return reply.code(409).send({
        ok: false,
        error: {
          code: 'SLUG_TAKEN',
          message: 'A franchisee with that slug already exists',
        },
      });
    }
    return reply.code(201).send({ ok: true, data: outcome.franchisee });
  });
}
