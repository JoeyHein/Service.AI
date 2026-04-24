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
import { and, eq, like } from 'drizzle-orm';
import pkg from 'pg';
import {
  customers,
  franchisees,
  invoices,
  jobs,
  memberships,
  payments,
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
        const subtotal = Math.round(total / 1.08 * 100) / 100;
        const taxAmount = Math.round((total - subtotal) * 100) / 100;
        const [inv] = await db
          .insert(invoices)
          .values({
            franchiseeId: denver.id,
            jobId: j.id,
            customerId: customer.id,
            status: 'paid',
            subtotal: String(subtotal),
            taxRate: '0.0800',
            taxAmount: String(taxAmount),
            total: String(total),
            paidAt: actualEnd ?? now,
            sentAt: actualEnd ?? now,
            finalizedAt: actualEnd ?? now,
          })
          .returning({ id: invoices.id });
        if (!inv) continue;
        invoiceInserts++;
        await db.insert(payments).values({
          franchiseeId: denver.id,
          invoiceId: inv.id,
          stripePaymentIntentId: `pi_demo_${j.id.slice(0, 8)}`,
          stripeChargeId: `ch_demo_${j.id.slice(0, 8)}`,
          amount: String(total),
          applicationFeeAmount: String(Math.round(total * 0.029 * 100) / 100),
          status: 'succeeded',
          createdAt: actualEnd ?? now,
        });
        paymentInserts++;
      }
    }

    console.log('Demo data seeded:');
    console.log(`  customers: ${customerRows.length}`);
    console.log(`  jobs:      ${jobInserts}`);
    console.log(`  invoices:  ${invoiceInserts}`);
    console.log(`  payments:  ${paymentInserts}`);
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
