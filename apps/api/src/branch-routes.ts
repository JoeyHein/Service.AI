/**
 * Branch manager dashboard (CHR-07).
 *
 * One route: `GET /api/v1/branch/dashboard` returns the read-side
 * aggregate a local manager loads on `/branch`.
 *
 * Auth pattern (mirrors corporate-routes.ts):
 *   - req.scope is null              → 401 UNAUTHENTICATED
 *   - req.scope.type !== 'branch'    → 404 NOT_FOUND. Corporate admins
 *     who want a branch view impersonate via `/corporate/branches/:id`;
 *     they don't access /branch directly. CSR / tech / dispatcher get
 *     404 for the same reason corporate-only routes 404 them — the
 *     dashboard surfaces commission data they shouldn't see.
 *
 * Branch isolation is automatic — every query scopes by
 * `req.scope.branchId`. RLS enforces the same predicate at the DB
 * layer (CHR-01 _scoped policies match `branch_id = current_setting(
 * 'app.branch_id'...)`).
 *
 * Commission projection comes from `computeCommission` (CHR-05), so
 * "projected commission this period" exactly matches what the engine
 * would settle into commission_ledger when the period closes.
 *
 * The pipeline card returns an empty array under CHR — committed-quote
 * tables land in SQB-01. Wired with `TODO(SQB-bridge)` so the front
 * end doesn't have to change shape when the real data flows in.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, gte, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  branches,
  customers,
  invoices,
  jobs,
  withScope,
  type RequestScope,
  type ScopedTx,
} from '@service-ai/db';
import * as schema from '@service-ai/db';
import { computeCommission } from './commission-engine.js';

type Drizzle = NodePgDatabase<typeof schema>;

function requireBranch(
  req: FastifyRequest,
  reply: FastifyReply,
): Extract<RequestScope, { type: 'branch' }> | null {
  if (req.scope === null) {
    reply.code(401).send({
      ok: false,
      error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
    });
    return null;
  }
  if (req.scope.type !== 'branch') {
    reply.code(404).send({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
    return null;
  }
  // Only the branch manager loads the dashboard; tech/csr/dispatcher
  // see other surfaces and have no commission visibility.
  if (req.scope.role !== 'manager') {
    reply.code(404).send({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not found' },
    });
    return null;
  }
  return req.scope;
}

function periodLabelFor(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function utcMonthBounds(d: Date): { start: Date; nextStart: Date } {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const nextStart = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  );
  return { start, nextStart };
}

// ---------------------------------------------------------------------------
// Dashboard projection
// ---------------------------------------------------------------------------

export interface BranchDashboard {
  branch: {
    id: string;
    name: string;
    slug: string;
    status: string;
  };
  period: string;
  tiles: {
    revenueMtdCents: number;
    openArCents: number;
    jobsInFlight: number;
    projectedCommissionCents: number;
  };
  commission: {
    period: string;
    baseSalaryCents: number;
    commissionCents: number;
    totalCents: number;
  };
  /**
   * Committed quotes that have not yet converted to a paid invoice.
   * Returns [] under CHR — the quotes table arrives in SQB-01. The
   * shape is locked here so the web component does not change later.
   */
  pipeline: Array<{
    quoteId: string;
    customerName: string;
    totalCents: number;
    committedAt: string;
  }>;
  recentJobs: Array<{
    jobId: string;
    customerName: string;
    status: string;
    scheduledStart: string | null;
    revenueCents: number;
  }>;
}

async function projectDashboard(
  tx: ScopedTx,
  branchId: string,
  userId: string,
  now: Date,
): Promise<BranchDashboard | null> {
  const branchRows = await tx
    .select({
      id: branches.id,
      name: branches.name,
      slug: branches.slug,
      status: branches.status,
    })
    .from(branches)
    .where(eq(branches.id, branchId))
    .limit(1);
  const branch = branchRows[0];
  if (!branch) return null;

  const { start, nextStart } = utcMonthBounds(now);
  const period = periodLabelFor(now);

  // Revenue MTD: sum of `invoices.total` (numeric($,$)) for invoices
  // paid this calendar month. Convert dollars-with-2dp to cents.
  const revenueRows = await tx
    .select({
      cents: sql<string>`COALESCE(SUM(${invoices.total} * 100), 0)`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.branchId, branchId),
        eq(invoices.status, 'paid'),
        gte(invoices.paidAt, start),
        lt(invoices.paidAt, nextStart),
      ),
    );
  const revenueMtdCents = Number(revenueRows[0]?.cents ?? 0);

  // Open AR: finalized / sent invoices still unpaid.
  const arRows = await tx
    .select({
      cents: sql<string>`COALESCE(SUM(${invoices.total} * 100), 0)`,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.branchId, branchId),
        ne(invoices.status, 'paid'),
        ne(invoices.status, 'void'),
        ne(invoices.status, 'draft'),
      ),
    );
  const openArCents = Number(arRows[0]?.cents ?? 0);

  // Jobs in flight: any non-terminal status.
  const jobsRows = await tx
    .select({
      jobsInFlight: sql<string>`COUNT(*)`,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.branchId, branchId),
        ne(jobs.status, 'completed'),
        ne(jobs.status, 'canceled'),
      ),
    );
  const jobsInFlight = Number(jobsRows[0]?.jobsInFlight ?? 0);

  // Projected commission for the period — same projection the manager
  // will see in their payroll statement. Includes base salary if the
  // active comp plan covers any day of the period.
  const commission = await computeCommission(tx, userId, period);

  // Recent jobs: last 10 by scheduled_start, with revenue per job
  // pulled from the linked invoice (paid amount; otherwise 0). Single
  // LEFT JOIN, no N+1.
  const recentJobRows = await tx
    .select({
      jobId: jobs.id,
      status: jobs.status,
      scheduledStart: jobs.scheduledStart,
      customerName: customers.name,
      invoiceTotal: sql<string | null>`
        COALESCE(
          (SELECT SUM(${invoices.total}) FROM ${invoices}
            WHERE ${invoices.jobId} = ${jobs.id}
              AND ${invoices.status} = 'paid'),
          0
        )::text
      `,
    })
    .from(jobs)
    .leftJoin(customers, eq(customers.id, jobs.customerId))
    .where(eq(jobs.branchId, branchId))
    .orderBy(desc(jobs.scheduledStart))
    .limit(10);

  return {
    branch,
    period,
    tiles: {
      revenueMtdCents,
      openArCents,
      jobsInFlight,
      projectedCommissionCents: commission.totalCents,
    },
    commission: {
      period: commission.period,
      baseSalaryCents: commission.baseSalaryCents,
      commissionCents: commission.commissionCents,
      totalCents: commission.totalCents,
    },
    // TODO(SQB-bridge): replace with real committed-quote rows once the
    // `quotes` table lands. Shape is locked so the UI does not change.
    pipeline: [],
    recentJobs: recentJobRows.map((r) => ({
      jobId: r.jobId,
      customerName: r.customerName ?? '(unknown customer)',
      status: r.status,
      scheduledStart: r.scheduledStart ? r.scheduledStart.toISOString() : null,
      revenueCents: Math.round(Number(r.invoiceTotal ?? '0') * 100),
    })),
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export interface BranchRoutesOptions {
  drizzle: Drizzle;
}

export function registerBranchRoutes(
  app: FastifyInstance,
  opts: BranchRoutesOptions,
): void {
  app.get('/api/v1/branch/dashboard', async (req, reply) => {
    const scope = requireBranch(req, reply);
    if (!scope) return;

    const result = await withScope(opts.drizzle, scope, (tx) =>
      projectDashboard(tx, scope.branchId, scope.userId, new Date()),
    );
    if (!result) {
      reply.code(404).send({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Branch not found' },
      });
      return;
    }
    reply.send({ ok: true, data: result });
  });
}

// Silence unused-import lint flag — `isNull` / `isNotNull` are kept
// available for the SQB-bridge follow-up that joins to the quotes
// table; pulling them out now would cost a re-add cycle later.
void isNull;
void isNotNull;
