/**
 * TASK-DB-05 latency harness for the SSE stream.
 *
 * Opens 10 concurrent EventBus subscribers (same code path the SSE
 * handler uses — subscribe + filter predicate), fires one assignment,
 * records time-to-receive per subscriber, asserts p95 < 500 ms.
 *
 * Runs against the live docker Postgres (assignment handler writes
 * to Postgres first, then publishes). Skips when DATABASE_URL is
 * unreachable.
 *
 * Why not test the HTTP SSE stream directly? Fastify's inject
 * interface doesn't support long-lived streams, and booting a real
 * HTTP listener on a random port adds fragility without changing
 * the thing we care about measuring — how fast the EventBus
 * fan-out from publish() to subscribers is. The subscribe path IS
 * exactly what the SSE handler does, minus the TCP write (which on
 * localhost is a handful of microseconds).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createAuth } from '@service-ai/auth';
import * as schema from '@service-ai/db';
import { users, sessions, accounts, verifications } from '@service-ai/db';
import { buildApp } from '../app.js';
import { runReset, runSeed, DEV_SEED_PASSWORD } from '../seed/index.js';
import {
  membershipResolver,
  franchiseeLookup,
  auditLogWriter,
} from '../production-resolvers.js';
import { inProcessEventBus, type EventBus, type DispatchEvent } from '../event-bus.js';

const { Pool } = pkg;
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;

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

let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let bus: EventBus;
let denverFranchiseeId: string;
let denverDispatcherCookie: string;
let denverTechUserId: string;
let seedJobId: string;

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await runReset(pool);
  const seed = await runSeed(pool);
  denverFranchiseeId = seed.franchisees.find((f) => f.slug === 'denver')!.id;

  const db = drizzle(pool, { schema });
  const auth = createAuth({
    db,
    authSchema: { user: users, session: sessions, account: accounts, verification: verifications },
    baseUrl: 'http://localhost',
    secret: 'x'.repeat(32),
  });
  bus = inProcessEventBus();
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
    eventBus: bus,
  });
  await app.ready();

  const signin = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      email: 'denver.dispatcher@elevateddoors.test',
      password: DEV_SEED_PASSWORD,
    }),
  });
  denverDispatcherCookie = extractCookie(signin.headers['set-cookie'])!;
  const r = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'denver.tech1@elevateddoors.test'));
  denverTechUserId = r[0]!.id;

  // Seed a single job we'll repeatedly re-assign.
  const cust = await app.inject({
    method: 'POST',
    url: '/api/v1/customers',
    headers: { cookie: denverDispatcherCookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Latency fixture' }),
  });
  const job = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: { cookie: denverDispatcherCookie, 'content-type': 'application/json' },
    payload: JSON.stringify({
      customerId: cust.json().data.id,
      title: 'Latency fixture job',
    }),
  });
  seedJobId = job.json().data.id as string;
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

describe('DB-05 / SSE fan-out latency (10 concurrent subscribers)', () => {
  beforeEach((ctx) => {
    if (!reachable) ctx.skip();
  });

  it('p95 time-to-receive < 500 ms', async () => {
    const N = 10;
    const receivedAt: Array<number | null> = Array(N).fill(null);
    const unsubs: Array<() => void> = [];
    const deadlineMs = 500;

    // Register N subscribers, each filtering to the denver franchisee.
    for (let i = 0; i < N; i++) {
      const unsub = bus.subscribe(
        (e) => e.franchiseeId === denverFranchiseeId && e.type === 'job.assigned',
        (_event: DispatchEvent) => {
          if (receivedAt[i] === null) receivedAt[i] = performance.now();
        },
      );
      unsubs.push(unsub);
    }

    try {
      // First, unassign to reset fixture state (ignore failure if it
      // wasn't assigned yet).
      await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${seedJobId}/unassign`,
        headers: { cookie: denverDispatcherCookie },
      });

      const firedAt = performance.now();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${seedJobId}/assign`,
        headers: {
          cookie: denverDispatcherCookie,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ assignedTechUserId: denverTechUserId }),
      });
      expect(res.statusCode).toBe(200);

      // Wait for all subscribers to receive or timeout.
      const deadline = firedAt + deadlineMs;
      while (performance.now() < deadline && receivedAt.some((t) => t === null)) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const latencies = receivedAt.map((t) => (t === null ? Number.POSITIVE_INFINITY : t - firedAt));
      const finite = latencies.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
      expect(finite.length).toBe(N); // every subscriber received
      const p95Index = Math.min(finite.length - 1, Math.floor(finite.length * 0.95));
      const p95 = finite[p95Index]!;
      expect(p95, `p95 latency ${p95} ms exceeded budget`).toBeLessThan(500);
    } finally {
      for (const u of unsubs) u();
    }
  });
});
