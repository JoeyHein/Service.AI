/**
 * Owner dashboard API — phase 14 pass 1.
 *
 *   GET /api/v1/dashboard/owner?period=7d|30d|90d|ytd
 *
 * Admin + dispatch roles only (platform_admin, franchisor_admin,
 * franchisee_owner, location_manager, dispatcher). Tech + CSR → 403.
 *
 * Scope rules:
 * - franchisee-scoped callers get their own franchisee's tiles.
 * - franchisor_admin / platform_admin impersonating a franchisee
 *   get that franchisee's view (via X-Impersonate-Franchisee).
 * - franchisor_admin / platform_admin without impersonation get
 *   a rollup across every visible franchisee.
 *
 * Returned shape:
 *   {
 *     period: { start, end, label },
 *     tiles: { revenueCents, openArCents, jobsCompleted,
 *              bookingsFuture, avgTicketCents, voiceCalls,
 *              collectionsPending },
 *     topTechs:     [{ techId, name, revenueCents, jobsCount }],
 *     topCustomers: [{ customerId, name, ltvCents, jobsCount }],
 *     recentJobs:   [{ jobId, customerName, status,
 *                      scheduledStart, revenueCents }]
 *   }
 *
 * All money fields are cents (int) to avoid float drift. The DB
 * stores numeric(12,2) dollars; the projector converts once.
 */

import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gt, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import {
  aiConversations,
  callSessions,
  collectionsDrafts,
  customers,
  franchisees,
  invoiceLineItems,
  invoices,
  jobs,
  memberships,
  notificationsLog,
  payments,
  serviceItems,
  users,
  withScope,
  type RequestScope,
} from '@service-ai/db';
import * as schema from '@service-ai/db';

type Drizzle = NodePgDatabase<typeof schema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardTiles {
  revenueCents: number;
  openArCents: number;
  jobsCompleted: number;
  bookingsFuture: number;
  avgTicketCents: number;
  voiceCalls: number;
  collectionsPending: number;
  emailsSent: number;
  smsSent: number;
  /** Gross profit cents — revenue minus COGS minus labor cost. */
  profitCents: number;
  /** Gross margin percentage as int×100 (e.g. 4231 = 42.31%). */
  marginBps: number;
  voiceAnsweredPct: number;
  voiceAvgDurationSec: number;
}

export interface AgingBuckets {
  current: number;
  d1to7: number;
  d8to14: number;
  d15to30: number;
  d31to60: number;
  d60plus: number;
}

export interface QuotesPipeline {
  draft: number;
  finalized: number;
  sent: number;
  paid: number;
}

export interface TechRanking {
  techId: string;
  name: string;
  revenueCents: number;
  jobsCount: number;
}

export interface CustomerRanking {
  customerId: string;
  name: string;
  ltvCents: number;
  jobsCount: number;
}

export interface RecentJob {
  jobId: string;
  customerName: string;
  status: string;
  scheduledStart: string | null;
  revenueCents: number;
}

export interface OwnerDashboard {
  period: { start: string; end: string; label: string };
  tiles: DashboardTiles;
  agingBuckets: AgingBuckets;
  quotesPipeline: QuotesPipeline;
  topTechs: TechRanking[];
  topCustomers: CustomerRanking[];
  recentJobs: RecentJob[];
}

export type PeriodLabel = '7d' | '30d' | '90d' | 'ytd';

export interface OwnerDashboardInput {
  scope: RequestScope;
  period: PeriodLabel;
  /**
   * Override the window; exposed for tests. When absent, `period`
   * decides the bounds.
   */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Projector
// ---------------------------------------------------------------------------

function resolvePeriod(label: PeriodLabel, now: Date): { start: Date; end: Date } {
  const end = now;
  if (label === '7d') {
    return { start: new Date(end.getTime() - 7 * 24 * 3600_000), end };
  }
  if (label === '90d') {
    return { start: new Date(end.getTime() - 90 * 24 * 3600_000), end };
  }
  if (label === 'ytd') {
    const start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
    return { start, end };
  }
  return { start: new Date(end.getTime() - 30 * 24 * 3600_000), end };
}

export async function computeOwnerDashboard(
  db: Drizzle,
  input: OwnerDashboardInput,
): Promise<OwnerDashboard> {
  const { start, end } = resolvePeriod(input.period, input.now ?? new Date());

  // Resolve the set of franchisees visible to this caller.
  const franchiseeIds = await withScope(db, input.scope, async (tx) => {
    if (input.scope.type === 'franchisee') {
      return [input.scope.franchiseeId];
    }
    if (input.scope.type === 'franchisor') {
      const rows = await tx
        .select({ id: franchisees.id })
        .from(franchisees)
        .where(eq(franchisees.franchisorId, input.scope.franchisorId));
      return rows.map((r) => r.id);
    }
    // platform
    const rows = await tx.select({ id: franchisees.id }).from(franchisees);
    return rows.map((r) => r.id);
  });

  if (franchiseeIds.length === 0) {
    return emptyDashboard(start, end, input.period);
  }

  return await withScope(db, input.scope, async (tx) => {
    // --- Revenue: sum payments.amount in period (Stripe-settled only) ---
    const payRows = await tx
      .select({ amount: payments.amount })
      .from(payments)
      .where(
        and(
          inArray(payments.franchiseeId, franchiseeIds),
          gte(payments.createdAt, start),
          lt(payments.createdAt, end),
          eq(payments.status, 'succeeded'),
        ),
      );
    const revenueCents = payRows.reduce(
      (acc, r) => acc + Math.round(Number(r.amount) * 100),
      0,
    );

    // --- Open AR + aging: finalized/sent invoices split into buckets
    //     by days past due_date (or 'current' if not yet due). ---
    const arRows = await tx
      .select({ total: invoices.total, dueDate: invoices.dueDate })
      .from(invoices)
      .where(
        and(
          inArray(invoices.franchiseeId, franchiseeIds),
          inArray(invoices.status, ['finalized', 'sent']),
          isNull(invoices.deletedAt),
        ),
      );
    const nowMs = (input.now ?? new Date()).getTime();
    const agingBuckets: AgingBuckets = {
      current: 0,
      d1to7: 0,
      d8to14: 0,
      d15to30: 0,
      d31to60: 0,
      d60plus: 0,
    };
    let openArCents = 0;
    for (const r of arRows) {
      const cents = Math.round(Number(r.total) * 100);
      openArCents += cents;
      const daysOver = r.dueDate
        ? Math.floor((nowMs - r.dueDate.getTime()) / (24 * 3600_000))
        : -1;
      if (daysOver <= 0) agingBuckets.current += cents;
      else if (daysOver <= 7) agingBuckets.d1to7 += cents;
      else if (daysOver <= 14) agingBuckets.d8to14 += cents;
      else if (daysOver <= 30) agingBuckets.d15to30 += cents;
      else if (daysOver <= 60) agingBuckets.d31to60 += cents;
      else agingBuckets.d60plus += cents;
    }

    // --- Jobs completed in period (by actual_end) ---
    const jobsCompletedRows = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(jobs)
      .where(
        and(
          inArray(jobs.franchiseeId, franchiseeIds),
          eq(jobs.status, 'completed'),
          gte(jobs.actualEnd, start),
          lt(jobs.actualEnd, end),
          isNull(jobs.deletedAt),
        ),
      );
    const jobsCompleted = jobsCompletedRows[0]?.c ?? 0;

    // --- Bookings future: scheduled/en_route/arrived/in_progress
    //     with scheduled_start in the future ---
    const bookingsFutureRows = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(jobs)
      .where(
        and(
          inArray(jobs.franchiseeId, franchiseeIds),
          inArray(jobs.status, ['scheduled', 'en_route', 'arrived', 'in_progress']),
          gt(jobs.scheduledStart, input.now ?? new Date()),
          isNull(jobs.deletedAt),
        ),
      );
    const bookingsFuture = bookingsFutureRows[0]?.c ?? 0;

    // --- Voice calls in period (csr.voice capability) ---
    const voiceCallsRows = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(aiConversations)
      .where(
        and(
          inArray(aiConversations.franchiseeId, franchiseeIds),
          eq(aiConversations.capability, 'csr.voice'),
          gte(aiConversations.startedAt, start),
          lt(aiConversations.startedAt, end),
        ),
      );
    const voiceCalls = voiceCallsRows[0]?.c ?? 0;

    // --- Voice analytics: % answered (status=completed) + avg
    //     duration in seconds (ended_at - started_at). ---
    const voiceAnalyticsRows = await tx
      .select({
        total: sql<number>`count(*)::int`,
        answered: sql<number>`count(*) filter (where ${callSessions.status} = 'completed')::int`,
        avgSec: sql<string>`COALESCE(AVG(EXTRACT(EPOCH FROM (${callSessions.endedAt} - ${callSessions.startedAt}))) FILTER (WHERE ${callSessions.endedAt} IS NOT NULL), 0)`,
      })
      .from(callSessions)
      .where(
        and(
          inArray(callSessions.franchiseeId, franchiseeIds),
          gte(callSessions.startedAt, start),
          lt(callSessions.startedAt, end),
        ),
      );
    const totalCalls = voiceAnalyticsRows[0]?.total ?? 0;
    const answeredCalls = voiceAnalyticsRows[0]?.answered ?? 0;
    const voiceAnsweredPct =
      totalCalls > 0 ? Math.round((answeredCalls / totalCalls) * 100) : 0;
    const voiceAvgDurationSec = Math.round(
      Number(voiceAnalyticsRows[0]?.avgSec ?? 0),
    );

    // --- Collections drafts pending review (not period-scoped —
    //     it's a "what needs my attention right now" metric) ---
    const collectionsPendingRows = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(collectionsDrafts)
      .where(
        and(
          inArray(collectionsDrafts.franchiseeId, franchiseeIds),
          eq(collectionsDrafts.status, 'pending'),
        ),
      );
    const collectionsPending = collectionsPendingRows[0]?.c ?? 0;

    // --- Notifications volume in period (outbound only) ---
    const notifCountsRows = await tx
      .select({
        channel: notificationsLog.channel,
        c: sql<number>`count(*)::int`,
      })
      .from(notificationsLog)
      .where(
        and(
          inArray(notificationsLog.franchiseeId, franchiseeIds),
          eq(notificationsLog.direction, 'outbound'),
          gte(notificationsLog.sentAt, start),
          lt(notificationsLog.sentAt, end),
        ),
      )
      .groupBy(notificationsLog.channel);
    let emailsSent = 0;
    let smsSent = 0;
    for (const row of notifCountsRows) {
      if (row.channel === 'email') emailsSent = row.c;
      else if (row.channel === 'sms') smsSent = row.c;
    }

    // --- Quotes pipeline: invoice status distribution (any age) ---
    const pipelineRows = await tx
      .select({
        status: invoices.status,
        c: sql<number>`count(*)::int`,
      })
      .from(invoices)
      .where(
        and(
          inArray(invoices.franchiseeId, franchiseeIds),
          isNull(invoices.deletedAt),
        ),
      )
      .groupBy(invoices.status);
    const quotesPipeline: QuotesPipeline = {
      draft: 0,
      finalized: 0,
      sent: 0,
      paid: 0,
    };
    for (const row of pipelineRows) {
      if (row.status === 'draft') quotesPipeline.draft = row.c;
      else if (row.status === 'finalized') quotesPipeline.finalized = row.c;
      else if (row.status === 'sent') quotesPipeline.sent = row.c;
      else if (row.status === 'paid') quotesPipeline.paid = row.c;
    }

    const avgTicketCents =
      jobsCompleted > 0 ? Math.round(revenueCents / jobsCompleted) : 0;

    // --- Profit (gross): revenue − COGS − labor. ---
    // Materials COGS = sum over invoice_line_items joined to
    // service_items, multiplied by line quantity. Lines pointing at
    // service_items with NULL cogs_price contribute 0.
    const cogsRows = await tx
      .select({
        cogs: sql<string>`COALESCE(SUM(${invoiceLineItems.quantity} * ${serviceItems.cogsPrice}), 0)`,
      })
      .from(invoiceLineItems)
      .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
      .innerJoin(jobs, eq(jobs.id, invoices.jobId))
      .leftJoin(serviceItems, eq(serviceItems.id, invoiceLineItems.serviceItemId))
      .where(
        and(
          inArray(invoiceLineItems.franchiseeId, franchiseeIds),
          eq(jobs.status, 'completed'),
          gte(jobs.actualEnd, start),
          lt(jobs.actualEnd, end),
          isNull(jobs.deletedAt),
        ),
      );
    const cogsCents = Math.round(Number(cogsRows[0]?.cogs ?? 0) * 100);

    // Labor cost = sum over completed jobs with assigned techs:
    //   (actual_end - actual_start) hours × tech.hourly_rate
    // Techs without an hourly rate contribute 0 labor cost.
    const laborRows = await tx
      .select({
        laborDollars: sql<string>`COALESCE(SUM(EXTRACT(EPOCH FROM (${jobs.actualEnd} - ${jobs.actualStart})) / 3600.0 * ${memberships.hourlyRate}), 0)`,
      })
      .from(jobs)
      .innerJoin(
        memberships,
        and(
          eq(memberships.userId, jobs.assignedTechUserId),
          eq(memberships.role, 'tech'),
          isNull(memberships.deletedAt),
        ),
      )
      .where(
        and(
          inArray(jobs.franchiseeId, franchiseeIds),
          eq(jobs.status, 'completed'),
          gte(jobs.actualEnd, start),
          lt(jobs.actualEnd, end),
          isNull(jobs.deletedAt),
          sql`${jobs.assignedTechUserId} IS NOT NULL`,
          sql`${jobs.actualStart} IS NOT NULL`,
          sql`${jobs.actualEnd} IS NOT NULL`,
        ),
      );
    const laborCents = Math.round(
      Number(laborRows[0]?.laborDollars ?? 0) * 100,
    );

    const profitCents = revenueCents - cogsCents - laborCents;
    const marginBps =
      revenueCents > 0
        ? Math.round((profitCents / revenueCents) * 10_000)
        : 0;

    // --- Top 5 techs by attributed revenue (completed jobs → invoices) ---
    const topTechsRows = await tx
      .select({
        techId: jobs.assignedTechUserId,
        name: users.name,
        revenue: sql<string>`COALESCE(SUM(${invoices.total}), 0)`,
        count: sql<number>`count(distinct ${jobs.id})::int`,
      })
      .from(jobs)
      .leftJoin(invoices, eq(invoices.jobId, jobs.id))
      .leftJoin(users, eq(users.id, jobs.assignedTechUserId))
      .where(
        and(
          inArray(jobs.franchiseeId, franchiseeIds),
          eq(jobs.status, 'completed'),
          gte(jobs.actualEnd, start),
          lt(jobs.actualEnd, end),
          isNull(jobs.deletedAt),
          sql`${jobs.assignedTechUserId} is not null`,
        ),
      )
      .groupBy(jobs.assignedTechUserId, users.name)
      .orderBy(sql`COALESCE(SUM(${invoices.total}), 0) desc`)
      .limit(5);
    const topTechs: TechRanking[] = topTechsRows.map((r) => ({
      techId: r.techId ?? '',
      name: r.name ?? '(unnamed)',
      revenueCents: Math.round(Number(r.revenue) * 100),
      jobsCount: r.count,
    }));

    // --- Top 5 customers by LTV (all-time, not period-scoped) ---
    const topCustomersRows = await tx
      .select({
        customerId: customers.id,
        name: customers.name,
        ltv: sql<string>`COALESCE(SUM(${invoices.total}), 0)`,
        count: sql<number>`count(distinct ${jobs.id})::int`,
      })
      .from(customers)
      .leftJoin(jobs, eq(jobs.customerId, customers.id))
      .leftJoin(invoices, eq(invoices.jobId, jobs.id))
      .where(
        and(
          inArray(customers.franchiseeId, franchiseeIds),
          isNull(customers.deletedAt),
        ),
      )
      .groupBy(customers.id, customers.name)
      .orderBy(sql`COALESCE(SUM(${invoices.total}), 0) desc`)
      .limit(5);
    const topCustomers: CustomerRanking[] = topCustomersRows
      .filter((r) => Number(r.ltv) > 0)
      .map((r) => ({
        customerId: r.customerId,
        name: r.name,
        ltvCents: Math.round(Number(r.ltv) * 100),
        jobsCount: r.count,
      }));

    // --- Recent 10 jobs ---
    const recentJobsRows = await tx
      .select({
        jobId: jobs.id,
        customerName: customers.name,
        status: jobs.status,
        scheduledStart: jobs.scheduledStart,
        revenue: sql<string>`COALESCE((SELECT SUM(total) FROM invoices i WHERE i.job_id = ${jobs.id} AND i.deleted_at IS NULL), 0)`,
      })
      .from(jobs)
      .innerJoin(customers, eq(customers.id, jobs.customerId))
      .where(
        and(
          inArray(jobs.franchiseeId, franchiseeIds),
          isNull(jobs.deletedAt),
        ),
      )
      .orderBy(desc(jobs.createdAt))
      .limit(10);
    const recentJobs: RecentJob[] = recentJobsRows.map((r) => ({
      jobId: r.jobId,
      customerName: r.customerName,
      status: r.status,
      scheduledStart: r.scheduledStart ? r.scheduledStart.toISOString() : null,
      revenueCents: Math.round(Number(r.revenue) * 100),
    }));

    return {
      period: {
        start: start.toISOString(),
        end: end.toISOString(),
        label: input.period,
      },
      tiles: {
        revenueCents,
        openArCents,
        jobsCompleted,
        bookingsFuture,
        avgTicketCents,
        voiceCalls,
        collectionsPending,
        emailsSent,
        smsSent,
        profitCents,
        marginBps,
        voiceAnsweredPct,
        voiceAvgDurationSec,
      },
      agingBuckets,
      quotesPipeline,
      topTechs,
      topCustomers,
      recentJobs,
    };
  });
}

function emptyDashboard(
  start: Date,
  end: Date,
  label: PeriodLabel,
): OwnerDashboard {
  return {
    period: { start: start.toISOString(), end: end.toISOString(), label },
    tiles: {
      revenueCents: 0,
      openArCents: 0,
      jobsCompleted: 0,
      bookingsFuture: 0,
      avgTicketCents: 0,
      voiceCalls: 0,
      collectionsPending: 0,
      emailsSent: 0,
      smsSent: 0,
      profitCents: 0,
      marginBps: 0,
      voiceAnsweredPct: 0,
      voiceAvgDurationSec: 0,
    },
    agingBuckets: {
      current: 0,
      d1to7: 0,
      d8to14: 0,
      d15to30: 0,
      d31to60: 0,
      d60plus: 0,
    },
    quotesPipeline: { draft: 0, finalized: 0, sent: 0, paid: 0 },
    topTechs: [],
    topCustomers: [],
    recentJobs: [],
  };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const QuerySchema = z.object({
  period: z.enum(['7d', '30d', '90d', 'ytd']).default('30d'),
});

const DASHBOARD_ROLES = new Set([
  'platform_admin',
  'franchisor_admin',
  'franchisee_owner',
  'location_manager',
  'dispatcher',
]);

export function registerOwnerDashboardRoutes(
  app: FastifyInstance,
  db: Drizzle,
): void {
  app.get('/api/v1/dashboard/owner', async (req, reply) => {
    if (req.scope === null) {
      return reply.code(401).send({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Sign-in required' },
      });
    }
    if (!DASHBOARD_ROLES.has(req.scope.role)) {
      return reply.code(403).send({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Dashboard access denied' },
      });
    }

    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid query params',
          details: parsed.error.flatten(),
        },
      });
    }

    const data = await computeOwnerDashboard(db, {
      scope: req.scope,
      period: parsed.data.period,
    });
    return reply.send({ ok: true, data });
  });
}
