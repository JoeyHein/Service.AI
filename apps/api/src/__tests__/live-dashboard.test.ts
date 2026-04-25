/**
 * Live tests for the owner dashboard (phase 14 pass 1).
 *
 * 401 anonymous, 403 tech/CSR, happy path for owner/dispatcher,
 * platform admin rolls up across franchisees, cross-franchisee
 * isolation (denver.owner sees only denver numbers).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { createAuth } from '@service-ai/auth';
import * as schema from '@service-ai/db';
import {
  users,
  sessions,
  accounts,
  verifications,
  customers,
  invoices,
  jobs,
  notificationsLog,
  payments,
} from '@service-ai/db';
import { buildApp } from '../app.js';
import { runReset, runSeed, DEV_SEED_PASSWORD } from '../seed/index.js';
import {
  membershipResolver,
  franchiseeLookup,
  auditLogWriter,
} from '../production-resolvers.js';

const { Pool } = pkg;
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let cookies: {
  platformAdmin: string;
  denverOwner: string;
  denverDispatcher: string;
  denverTech: string;
  denverCsr: string;
  austinOwner: string;
};
let ids: { denverId: string; austinId: string };

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await p.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await p.end();
  }
}

function extractCookie(set: string | string[] | undefined): string | null {
  if (!set) return null;
  const s = Array.isArray(set) ? set[0]! : set;
  const m = s.match(/^([^=]+=[^;]+)/);
  return m ? m[1]! : null;
}

async function signIn(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD }),
  });
  const c = extractCookie(res.headers['set-cookie']);
  if (!c) throw new Error(`no cookie for ${email}`);
  return c;
}

async function seedDashboardData(
  db: ReturnType<typeof drizzle>,
  franchiseeId: string,
  techUserId: string,
  opts: { revenuePerJob: number; jobsCount: number },
): Promise<void> {
  const customerRows = await db
    .insert(customers)
    .values({ franchiseeId, name: `Dashboard Customer ${franchiseeId.slice(0, 6)}` })
    .returning({ id: customers.id });
  const customerId = customerRows[0]!.id;

  const now = new Date();
  for (let i = 0; i < opts.jobsCount; i++) {
    const end = new Date(now.getTime() - (i + 1) * 24 * 3600_000);
    const start = new Date(end.getTime() - 2 * 3600_000);
    const jobRows = await db
      .insert(jobs)
      .values({
        franchiseeId,
        customerId,
        status: 'completed',
        title: `Live test job ${i}`,
        scheduledStart: start,
        scheduledEnd: end,
        actualStart: start,
        actualEnd: end,
        assignedTechUserId: techUserId,
      })
      .returning({ id: jobs.id });
    const jobId = jobRows[0]!.id;
    const invRows = await db
      .insert(invoices)
      .values({
        franchiseeId,
        jobId,
        customerId,
        status: 'paid',
        subtotal: String(opts.revenuePerJob),
        taxRate: '0.0000',
        taxAmount: '0',
        total: String(opts.revenuePerJob),
        paidAt: end,
        finalizedAt: end,
        dueDate: new Date(end.getTime() + 30 * 24 * 3600_000),
      })
      .returning({ id: invoices.id });
    await db.insert(payments).values({
      franchiseeId,
      invoiceId: invRows[0]!.id,
      stripePaymentIntentId: `pi_live_${jobId.slice(0, 8)}`,
      stripeChargeId: `ch_live_${jobId.slice(0, 8)}`,
      amount: String(opts.revenuePerJob),
      applicationFeeAmount: '0',
      status: 'succeeded',
      createdAt: end,
    });
  }
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await runReset(pool);
  const seed = await runSeed(pool);
  ids = {
    denverId: seed.franchisees.find((f) => f.slug === 'denver')!.id,
    austinId: seed.franchisees.find((f) => f.slug === 'austin')!.id,
  };

  const db = drizzle(pool, { schema });
  const auth = createAuth({
    db,
    authSchema: { user: users, session: sessions, account: accounts, verification: verifications },
    baseUrl: 'http://localhost',
    secret: 'x'.repeat(32),
  });
  app = buildApp({
    db: { query: async () => ({ rows: [] }) },
    redis: { ping: async () => 'PONG' },
    logger: false,
    auth,
    drizzle: db,
    membershipResolver: membershipResolver(db),
    franchiseeLookup: franchiseeLookup(db),
    auditWriter: auditLogWriter(db),
    magicLinkSender: { async send() {} },
    acceptUrlBase: 'http://localhost:3000',
  });
  await app.ready();

  // Look up the denver + austin tech user ids to attribute jobs to.
  const denverTechRow = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email = 'denver.tech1@elevateddoors.test'`,
  );
  const austinTechRow = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email = 'austin.tech1@elevateddoors.test'`,
  );

  await seedDashboardData(db, ids.denverId, denverTechRow.rows[0]!.id, {
    revenuePerJob: 500,
    jobsCount: 4,
  });
  await seedDashboardData(db, ids.austinId, austinTechRow.rows[0]!.id, {
    revenuePerJob: 1000,
    jobsCount: 2,
  });

  // Pass-2 fixtures: 1 open invoice 10d overdue ($800) + 1 draft
  // quote ($300) + 2 emails + 1 SMS for Denver — to exercise aging
  // bucket d8to14, quotes pipeline draft+sent, and notif tiles.
  const denverCustomerRows = await db
    .insert(customers)
    .values({ franchiseeId: ids.denverId, name: 'Aging Customer' })
    .returning({ id: customers.id });
  const overdueCustomerId = denverCustomerRows[0]!.id;
  const overdueJobRows = await db
    .insert(jobs)
    .values({
      franchiseeId: ids.denverId,
      customerId: overdueCustomerId,
      status: 'completed',
      title: 'Overdue invoice job',
      actualEnd: new Date(Date.now() - 40 * 24 * 3600_000),
    })
    .returning({ id: jobs.id });
  await db.insert(invoices).values({
    franchiseeId: ids.denverId,
    jobId: overdueJobRows[0]!.id,
    customerId: overdueCustomerId,
    status: 'sent',
    subtotal: '800',
    taxRate: '0',
    taxAmount: '0',
    total: '800',
    finalizedAt: new Date(Date.now() - 40 * 24 * 3600_000),
    sentAt: new Date(Date.now() - 40 * 24 * 3600_000),
    dueDate: new Date(Date.now() - 10 * 24 * 3600_000),
  });
  const draftJobRows = await db
    .insert(jobs)
    .values({
      franchiseeId: ids.denverId,
      customerId: overdueCustomerId,
      status: 'unassigned',
      title: 'Quote — draft',
    })
    .returning({ id: jobs.id });
  await db.insert(invoices).values({
    franchiseeId: ids.denverId,
    jobId: draftJobRows[0]!.id,
    customerId: overdueCustomerId,
    status: 'draft',
    subtotal: '300',
    taxRate: '0',
    taxAmount: '0',
    total: '300',
  });
  await db.insert(notificationsLog).values([
    {
      franchiseeId: ids.denverId,
      channel: 'email',
      direction: 'outbound',
      toAddress: 'a@test',
      subject: 'first',
      bodyPreview: 'b',
      sentAt: new Date(),
    },
    {
      franchiseeId: ids.denverId,
      channel: 'email',
      direction: 'outbound',
      toAddress: 'b@test',
      subject: 'second',
      bodyPreview: 'b',
      sentAt: new Date(),
    },
    {
      franchiseeId: ids.denverId,
      channel: 'sms',
      direction: 'outbound',
      toAddress: '+1303',
      bodyPreview: 'sms',
      sentAt: new Date(),
    },
  ]);

  cookies = {
    platformAdmin: await signIn('joey@opendc.ca'),
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
    denverDispatcher: await signIn('denver.dispatcher@elevateddoors.test'),
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    denverCsr: await signIn('denver.csr@elevateddoors.test'),
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
  };
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('Owner dashboard — auth boundaries', () => {
  it('anonymous → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/owner?period=30d',
    });
    expect(res.statusCode).toBe(401);
  });

  it('tech → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/owner?period=30d',
      headers: { cookie: cookies.denverTech },
    });
    expect(res.statusCode).toBe(403);
  });

  it('CSR → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/owner?period=30d',
      headers: { cookie: cookies.denverCsr },
    });
    expect(res.statusCode).toBe(403);
  });

  it('owner → 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/owner?period=30d',
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(200);
  });

  it('dispatcher → 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/owner?period=30d',
      headers: { cookie: cookies.denverDispatcher },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('Owner dashboard — period validation', () => {
  it('bogus period → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/owner?period=forever',
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(400);
  });

  it('default period when none supplied', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/owner',
      headers: { cookie: cookies.denverOwner },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.period.label).toBe('30d');
  });
});

describe('Owner dashboard — scope isolation', () => {
  it('denver owner sees denver revenue only (4 jobs × $500 = $2000)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/owner?period=30d',
      headers: { cookie: cookies.denverOwner },
    });
    const d = res.json().data;
    expect(d.tiles.revenueCents).toBe(200_000);
    expect(d.tiles.jobsCompleted).toBe(4);
  });

  it('austin owner sees austin revenue only (2 jobs × $1000 = $2000)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/owner?period=30d',
      headers: { cookie: cookies.austinOwner },
    });
    const d = res.json().data;
    expect(d.tiles.revenueCents).toBe(200_000);
    expect(d.tiles.jobsCompleted).toBe(2);
  });

  it('platform admin rolls up across all franchisees (6 jobs, $4000)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/owner?period=30d',
      headers: { cookie: cookies.platformAdmin },
    });
    const d = res.json().data;
    expect(d.tiles.revenueCents).toBe(400_000);
    expect(d.tiles.jobsCompleted).toBe(6);
  });
});

describe('Owner dashboard — pass 2 fields', () => {
  it('aging bucket d8to14 contains the overdue $800 invoice', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/owner?period=30d',
      headers: { cookie: cookies.denverOwner },
    });
    const d = res.json().data;
    expect(d.agingBuckets.d8to14).toBe(80_000);
    expect(d.tiles.openArCents).toBe(80_000);
  });

  it('quotes pipeline reports draft + paid counts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/owner?period=30d',
      headers: { cookie: cookies.denverOwner },
    });
    const d = res.json().data;
    expect(d.quotesPipeline.draft).toBe(1);
    expect(d.quotesPipeline.sent).toBe(1);
    expect(d.quotesPipeline.paid).toBe(4); // from seedDashboardData
  });

  it('emailsSent + smsSent count outbound notifications in period', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/owner?period=30d',
      headers: { cookie: cookies.denverOwner },
    });
    const d = res.json().data;
    expect(d.tiles.emailsSent).toBe(2);
    expect(d.tiles.smsSent).toBe(1);
  });

  it('austin owner does not see denver notifications or aging', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/owner?period=30d',
      headers: { cookie: cookies.austinOwner },
    });
    const d = res.json().data;
    expect(d.tiles.emailsSent).toBe(0);
    expect(d.tiles.smsSent).toBe(0);
    expect(d.agingBuckets.d8to14).toBe(0);
    expect(d.quotesPipeline.draft).toBe(0);
  });
});

describe('Owner dashboard — shape', () => {
  it('returns tiles + rankings + recent jobs arrays', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/owner?period=30d',
      headers: { cookie: cookies.denverOwner },
    });
    const d = res.json().data;
    expect(typeof d.tiles.revenueCents).toBe('number');
    expect(typeof d.tiles.avgTicketCents).toBe('number');
    expect(Array.isArray(d.topTechs)).toBe(true);
    expect(Array.isArray(d.topCustomers)).toBe(true);
    expect(Array.isArray(d.recentJobs)).toBe(true);
    // Avg ticket = 200_000 / 4 = 50_000 cents = $500
    expect(d.tiles.avgTicketCents).toBe(50_000);
    // Top tech should be denver tech1 with all 4 jobs
    expect(d.topTechs.length).toBeGreaterThan(0);
    expect(d.topTechs[0].jobsCount).toBe(4);
  });
});
