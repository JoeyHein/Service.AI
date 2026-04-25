/**
 * Demo-data seed — optional, for local dev only.
 *
 * Creates 15 customers + 30 jobs + invoices + payments for the
 * Denver franchisee so the owner dashboard lights up. Idempotent:
 * if any customer already exists whose name starts with "Demo —",
 * the script bails without inserting anything.
 *
 * Run with: pnpm seed:demo
 *
 * Tech assignments use denver.tech1 + denver.tech2 (seeded in
 * the base seed). Invoice totals are randomised in a realistic
 * range for a residential garage-door trade ($280 – $2,400).
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, like, sql } from 'drizzle-orm';
import pkg from 'pg';
import {
  callSessions,
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
} from '@service-ai/db';
import * as schema from '@service-ai/db';

const { Pool } = pkg;

const DEMO_NAME_PREFIX = 'Demo — ';

const CUSTOMER_NAMES = [
  'Amanda Chen',
  'Brent Morales',
  'Carla Okonkwo',
  'Derek Hassan',
  'Elena Petrov',
  'Felix Brooks',
  'Grace Lin',
  'Hector Alvarez',
  'Isla Thompson',
  'Jasper Reed',
  'Kira Nakamura',
  'Liam Donovan',
  'Maya Patel',
  'Noah Wexler',
  'Olivia Sharp',
];

const JOB_TITLES = [
  'Replace broken torsion spring',
  'New sectional door install',
  'Opener tune-up + lubrication',
  'Cable replacement (snapped)',
  'Weather seal + threshold',
  'Roller replacement (set of 10)',
  'Panel dent repair',
  'Smart opener + keypad install',
  'Annual safety inspection',
  'Emergency call — door off track',
];

type Status =
  | 'completed'
  | 'scheduled'
  | 'en_route'
  | 'arrived'
  | 'in_progress'
  | 'unassigned'
  | 'canceled';

interface JobSpec {
  titleIdx: number;
  status: Status;
  daysOffset: number; // negative = past, positive = future
  invoiceTotal: number | null;
  techIdx: 0 | 1 | null;
}

// 30 jobs: 15 completed (past 60 days), 8 scheduled future,
// 3 in_progress today, 3 unassigned, 1 canceled.
const JOB_SPECS: JobSpec[] = [
  // Completed (past) — invoice + payment
  { titleIdx: 0, status: 'completed', daysOffset: -1, invoiceTotal: 485, techIdx: 0 },
  { titleIdx: 1, status: 'completed', daysOffset: -3, invoiceTotal: 2380, techIdx: 1 },
  { titleIdx: 2, status: 'completed', daysOffset: -5, invoiceTotal: 220, techIdx: 0 },
  { titleIdx: 3, status: 'completed', daysOffset: -7, invoiceTotal: 310, techIdx: 1 },
  { titleIdx: 4, status: 'completed', daysOffset: -8, invoiceTotal: 395, techIdx: 0 },
  { titleIdx: 5, status: 'completed', daysOffset: -10, invoiceTotal: 540, techIdx: 1 },
  { titleIdx: 6, status: 'completed', daysOffset: -12, invoiceTotal: 680, techIdx: 0 },
  { titleIdx: 7, status: 'completed', daysOffset: -14, invoiceTotal: 925, techIdx: 1 },
  { titleIdx: 8, status: 'completed', daysOffset: -16, invoiceTotal: 150, techIdx: 0 },
  { titleIdx: 9, status: 'completed', daysOffset: -18, invoiceTotal: 720, techIdx: 1 },
  { titleIdx: 0, status: 'completed', daysOffset: -22, invoiceTotal: 475, techIdx: 0 },
  { titleIdx: 2, status: 'completed', daysOffset: -25, invoiceTotal: 195, techIdx: 1 },
  { titleIdx: 5, status: 'completed', daysOffset: -28, invoiceTotal: 560, techIdx: 0 },
  { titleIdx: 7, status: 'completed', daysOffset: -35, invoiceTotal: 1050, techIdx: 1 },
  { titleIdx: 1, status: 'completed', daysOffset: -50, invoiceTotal: 2200, techIdx: 0 },
  // Scheduled future
  { titleIdx: 0, status: 'scheduled', daysOffset: 1, invoiceTotal: null, techIdx: 0 },
  { titleIdx: 2, status: 'scheduled', daysOffset: 2, invoiceTotal: null, techIdx: 1 },
  { titleIdx: 3, status: 'scheduled', daysOffset: 3, invoiceTotal: null, techIdx: 0 },
  { titleIdx: 4, status: 'scheduled', daysOffset: 4, invoiceTotal: null, techIdx: 1 },
  { titleIdx: 6, status: 'scheduled', daysOffset: 6, invoiceTotal: null, techIdx: 0 },
  { titleIdx: 8, status: 'scheduled', daysOffset: 8, invoiceTotal: null, techIdx: 1 },
  { titleIdx: 9, status: 'scheduled', daysOffset: 10, invoiceTotal: null, techIdx: 0 },
  { titleIdx: 1, status: 'scheduled', daysOffset: 13, invoiceTotal: null, techIdx: 1 },
  // In progress today
  { titleIdx: 5, status: 'in_progress', daysOffset: 0, invoiceTotal: null, techIdx: 0 },
  { titleIdx: 7, status: 'in_progress', daysOffset: 0, invoiceTotal: null, techIdx: 1 },
  { titleIdx: 0, status: 'en_route', daysOffset: 0, invoiceTotal: null, techIdx: 0 },
  // Unassigned intake
  { titleIdx: 9, status: 'unassigned', daysOffset: 0, invoiceTotal: null, techIdx: null },
  { titleIdx: 4, status: 'unassigned', daysOffset: 0, invoiceTotal: null, techIdx: null },
  { titleIdx: 2, status: 'unassigned', daysOffset: 0, invoiceTotal: null, techIdx: null },
  // One canceled for realism
  { titleIdx: 6, status: 'canceled', daysOffset: -4, invoiceTotal: null, techIdx: null },
];

async function runDemoSeed(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('FATAL: DATABASE_URL is not set');
    process.exit(2);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  try {
    // Resolve Denver franchisee id
    const [denver] = await db
      .select({ id: franchisees.id })
      .from(franchisees)
      .where(eq(franchisees.slug, 'denver'))
      .limit(1);
    if (!denver) {
      console.error(
        'Denver franchisee not found. Run `pnpm seed` first to create the base tenant tree.',
      );
      process.exit(1);
    }

    // Idempotency: bail if demo customers already exist
    const [existing] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.franchiseeId, denver.id),
          like(customers.name, `${DEMO_NAME_PREFIX}%`),
        ),
      )
      .limit(1);
    if (existing) {
      console.log('Demo data already seeded. Run `pnpm seed:reset` first to start over.');
      process.exit(0);
    }

    // Resolve tech user ids (denver.tech1 + denver.tech2)
    const techRows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(
        and(
          eq(memberships.franchiseeId, denver.id),
          eq(memberships.role, 'tech'),
        ),
      );
    const tech1 = techRows.find((t) => t.email?.startsWith('denver.tech1'));
    const tech2 = techRows.find((t) => t.email?.startsWith('denver.tech2'));
    if (!tech1 || !tech2) {
      console.error('Denver techs not found. Base seed may be incomplete.');
      process.exit(1);
    }
    const techIds: [string, string] = [tech1.id, tech2.id];

    // Stamp hourly rates so the profit projector can compute labor.
    // tech1 = $65/hr, tech2 = $80/hr (the senior tech).
    await db
      .update(memberships)
      .set({ hourlyRate: '65.00' })
      .where(
        and(
          eq(memberships.userId, tech1.id),
          eq(memberships.role, 'tech'),
        ),
      );
    await db
      .update(memberships)
      .set({ hourlyRate: '80.00' })
      .where(
        and(
          eq(memberships.userId, tech2.id),
          eq(memberships.role, 'tech'),
        ),
      );

    // Stamp cogs on every service item under Elevated Doors so the
    // materials projector has data to work with. Use 35% of base
    // price as a generic placeholder — the pricebook editor lets
    // operators tune per-item later.
    await db
      .update(serviceItems)
      .set({
        cogsPrice: sql`ROUND(${serviceItems.basePrice} * 0.35, 2)::numeric(12,2)`,
      })
      .where(
        eq(
          serviceItems.franchisorId,
          sql`(SELECT franchisor_id FROM franchisees WHERE id = ${denver.id})`,
        ),
      );

    // Pick a representative service item for line-item seeding.
    const [seedItem] = await db
      .select({
        id: serviceItems.id,
        sku: serviceItems.sku,
        name: serviceItems.name,
        basePrice: serviceItems.basePrice,
      })
      .from(serviceItems)
      .where(
        eq(
          serviceItems.franchisorId,
          sql`(SELECT franchisor_id FROM franchisees WHERE id = ${denver.id})`,
        ),
      )
      .limit(1);

    // Insert customers
    const customerRows = await db
      .insert(customers)
      .values(
        CUSTOMER_NAMES.map((name) => ({
          franchiseeId: denver.id,
          name: `${DEMO_NAME_PREFIX}${name}`,
          email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@demo.test`,
          phone: `+1303555${Math.floor(Math.random() * 9000 + 1000)}`,
          city: 'Denver',
          state: 'CO',
          country: 'USA',
        })),
      )
      .returning({ id: customers.id });

    const now = new Date();
    const jobIdsByCustomer: Record<string, string[]> = {};
    let jobInserts = 0;
    let invoiceInserts = 0;
    let paymentInserts = 0;

    for (let i = 0; i < JOB_SPECS.length; i++) {
      const spec = JOB_SPECS[i]!;
      const customer = customerRows[i % customerRows.length]!;
      const scheduledStart = new Date(
        now.getTime() + spec.daysOffset * 24 * 3600_000 + (i % 8) * 3600_000,
      );
      const scheduledEnd = new Date(scheduledStart.getTime() + 2 * 3600_000);
      const actualStart =
        spec.status === 'completed' || spec.status === 'in_progress'
          ? scheduledStart
          : null;
      const actualEnd = spec.status === 'completed' ? scheduledEnd : null;

      const [j] = await db
        .insert(jobs)
        .values({
          franchiseeId: denver.id,
          customerId: customer.id,
          status: spec.status,
          title: JOB_TITLES[spec.titleIdx]!,
          description: 'Demo job seeded via pnpm seed:demo',
          scheduledStart,
          scheduledEnd,
          actualStart,
          actualEnd,
          assignedTechUserId:
            spec.techIdx !== null ? techIds[spec.techIdx] : null,
        })
        .returning({ id: jobs.id });
      if (!j) continue;
      jobInserts++;
      (jobIdsByCustomer[customer.id] ??= []).push(j.id);

      if (spec.invoiceTotal !== null && spec.status === 'completed') {
        const total = spec.invoiceTotal;
        const subtotal = Math.round((total / 1.08) * 100) / 100;
        const taxAmount = Math.round((total - subtotal) * 100) / 100;
        // A handful of completed invoices stay open with manually
        // tuned due dates so the aging chart shows multiple buckets.
        // Map keyed by JOB_SPECS index → days overdue (negative = future).
        const openWithOverdueDays: Record<number, number> = {
          0: -25, // current ($485, due in 25 days)
          5: 4,   // d1to7  ($540)
          7: 12,  // d8to14 ($925)
          11: 22, // d15to30 ($195)
          13: 45, // d31to60 ($1050)
          14: 65, // d60plus ($2200)
        };
        const overdueDays = openWithOverdueDays[i];
        const stayOpen = overdueDays !== undefined;
        const status: 'paid' | 'sent' = stayOpen ? 'sent' : 'paid';
        const finalized = actualEnd ?? now;
        const dueDate = stayOpen
          ? new Date(now.getTime() - overdueDays * 24 * 3600_000)
          : new Date(finalized.getTime() + 30 * 24 * 3600_000);
        const [inv] = await db
          .insert(invoices)
          .values({
            franchiseeId: denver.id,
            jobId: j.id,
            customerId: customer.id,
            status,
            subtotal: String(subtotal),
            taxRate: '0.0800',
            taxAmount: String(taxAmount),
            total: String(total),
            paidAt: status === 'paid' ? finalized : null,
            sentAt: finalized,
            finalizedAt: finalized,
            dueDate,
          })
          .returning({ id: invoices.id });
        if (!inv) continue;
        invoiceInserts++;
        if (seedItem) {
          // Scale qty so the line equals the invoice subtotal at the
          // SKU's base_price. Cogs (cogs_price = 35% of base_price)
          // therefore lands at ~35% of the invoice — realistic gross
          // margin for the trade.
          const basePrice = Number(seedItem.basePrice);
          const qty = basePrice > 0 ? subtotal / basePrice : 1;
          await db.insert(invoiceLineItems).values({
            invoiceId: inv.id,
            franchiseeId: denver.id,
            serviceItemId: seedItem.id,
            sku: seedItem.sku,
            name: seedItem.name,
            quantity: qty.toFixed(3),
            unitPrice: String(seedItem.basePrice),
            lineTotal: String(subtotal),
            sortOrder: 0,
          });
        }
        if (status === 'paid') {
          await db.insert(payments).values({
            franchiseeId: denver.id,
            invoiceId: inv.id,
            stripePaymentIntentId: `pi_demo_${j.id.slice(0, 8)}`,
            stripeChargeId: `ch_demo_${j.id.slice(0, 8)}`,
            amount: String(total),
            applicationFeeAmount: String(Math.round(total * 0.029 * 100) / 100),
            status: 'succeeded',
            createdAt: finalized,
          });
          paymentInserts++;
        }
      }
    }

    // Add a few quotes (draft invoices) so the pipeline tile lights up.
    const draftCustomers = customerRows.slice(-3);
    for (let q = 0; q < draftCustomers.length; q++) {
      const customer = draftCustomers[q]!;
      const [j] = await db
        .insert(jobs)
        .values({
          franchiseeId: denver.id,
          customerId: customer.id,
          status: 'unassigned',
          title: 'Quote — multi-door replacement',
          description: 'Demo quote awaiting acceptance',
        })
        .returning({ id: jobs.id });
      if (!j) continue;
      const total = 1850 + q * 320;
      await db.insert(invoices).values({
        franchiseeId: denver.id,
        jobId: j.id,
        customerId: customer.id,
        status: 'draft',
        subtotal: String(Math.round((total / 1.08) * 100) / 100),
        taxRate: '0.0800',
        taxAmount: String(
          Math.round((total - total / 1.08) * 100) / 100,
        ),
        total: String(total),
      });
      invoiceInserts++;
    }

    // Sample outbound notifications across the last 14 days. Roughly
    // 2 emails + 1 SMS per completed job, for owner-dashboard volume.
    const completedJobIds = JOB_SPECS
      .map((s, idx) => ({ s, idx }))
      .filter((r) => r.s.status === 'completed');
    let notifInserts = 0;
    for (let i = 0; i < completedJobIds.length; i++) {
      const customer = customerRows[i % customerRows.length]!;
      const sentAt = new Date(
        now.getTime() - (i + 1) * 18 * 3600_000,
      );
      await db.insert(notificationsLog).values({
        franchiseeId: denver.id,
        channel: 'email',
        direction: 'outbound',
        toAddress: `${customer.id}@demo.test`,
        subject: 'Your service appointment is confirmed',
        bodyPreview: 'Demo confirmation email body',
        relatedKind: 'job-confirmation',
        sentAt,
      });
      await db.insert(notificationsLog).values({
        franchiseeId: denver.id,
        channel: 'email',
        direction: 'outbound',
        toAddress: `${customer.id}@demo.test`,
        subject: 'Your invoice from Elevated Doors',
        bodyPreview: 'Demo invoice email body',
        relatedKind: 'invoice',
        sentAt: new Date(sentAt.getTime() + 3600_000),
      });
      await db.insert(notificationsLog).values({
        franchiseeId: denver.id,
        channel: 'sms',
        direction: 'outbound',
        toAddress: `+1303555${1000 + i}`,
        bodyPreview: 'Demo SMS — your tech is en route',
        relatedKind: 'tech-en-route',
        sentAt: new Date(sentAt.getTime() + 7200_000),
      });
      notifInserts += 3;
    }

    // 18 inbound voice calls in last 14 days, mix of completed +
    // ringing + failed so the answered-% tile shows ~83%.
    let callInserts = 0;
    const callOutcomes: Array<{
      status: 'completed' | 'failed' | 'ringing';
      durationSec: number;
    }> = [
      { status: 'completed', durationSec: 245 },
      { status: 'completed', durationSec: 372 },
      { status: 'completed', durationSec: 88 },
      { status: 'completed', durationSec: 510 },
      { status: 'completed', durationSec: 156 },
      { status: 'completed', durationSec: 412 },
      { status: 'completed', durationSec: 91 },
      { status: 'completed', durationSec: 223 },
      { status: 'completed', durationSec: 178 },
      { status: 'completed', durationSec: 314 },
      { status: 'completed', durationSec: 462 },
      { status: 'completed', durationSec: 95 },
      { status: 'completed', durationSec: 287 },
      { status: 'completed', durationSec: 199 },
      { status: 'completed', durationSec: 145 },
      { status: 'failed', durationSec: 12 },
      { status: 'failed', durationSec: 8 },
      { status: 'ringing', durationSec: 0 },
    ];
    for (let i = 0; i < callOutcomes.length; i++) {
      const o = callOutcomes[i]!;
      const startedAt = new Date(now.getTime() - (i + 1) * 8 * 3600_000);
      const endedAt =
        o.status === 'ringing'
          ? null
          : new Date(startedAt.getTime() + o.durationSec * 1000);
      await db.insert(callSessions).values({
        franchiseeId: denver.id,
        twilioCallSid: `CA_demo_${i}_${Date.now()}`,
        fromE164: `+1303555${2000 + i}`,
        toE164: '+13035550100',
        direction: 'inbound',
        status: o.status,
        outcome: o.status === 'completed' ? 'booked' : 'none',
        startedAt,
        endedAt,
      });
      callInserts++;
    }

    console.log('Demo data seeded:');
    console.log(`  customers:     ${customerRows.length}`);
    console.log(`  jobs:          ${jobInserts + draftCustomers.length}`);
    console.log(`  invoices:      ${invoiceInserts}`);
    console.log(`  payments:      ${paymentInserts}`);
    console.log(`  notifications: ${notifInserts}`);
    console.log(`  call sessions: ${callInserts}`);
    console.log('');
    console.log('Sign in as denver.owner@elevateddoors.test / changeme123!A');
    console.log('and visit /dashboard.');
  } finally {
    await pool.end();
  }
}

runDemoSeed().catch((err) => {
  console.error(err);
  process.exit(1);
});
