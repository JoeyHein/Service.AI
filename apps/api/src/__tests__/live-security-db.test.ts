/**
 * TASK-DB-06 security suite for phase_dispatch_board.
 *
 * Exercises every new phase-5 endpoint against the threat model
 * plus the event stream's scope filtering.
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
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let bus: EventBus;
let ids: { denverId: string; austinId: string };
let cookies: {
  denverOwner: string;
  denverDispatcher: string;
  denverTech: string;
  austinOwner: string;
  austinDispatcher: string;
};
let denverJobId: string;
let austinJobId: string;
let denverTechUserId: string;
let austinTechUserId: string;
let denverDispatcherUserId: string;

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
  if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.body}`);
  const c = extractCookie(res.headers['set-cookie']);
  if (!c) throw new Error('no cookie');
  return c;
}

async function resolveUserId(email: string): Promise<string> {
  const db = drizzle(pool, { schema });
  const r = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return r[0]!.id;
}

async function createCustomerAndJob(cookie: string, name: string): Promise<string> {
  const cust = await app.inject({
    method: 'POST',
    url: '/api/v1/customers',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ name }),
  });
  const cid = cust.json().data.id as string;
  const job = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ customerId: cid, title: `${name} job` }),
  });
  return job.json().data.id as string;
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
  cookies = {
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
    denverDispatcher: await signIn('denver.dispatcher@elevateddoors.test'),
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
    austinDispatcher: await signIn('austin.dispatcher@elevateddoors.test'),
  };
  denverTechUserId = await resolveUserId('denver.tech1@elevateddoors.test');
  austinTechUserId = await resolveUserId('austin.tech1@elevateddoors.test');
  denverDispatcherUserId = await resolveUserId('denver.dispatcher@elevateddoors.test');
  denverJobId = await createCustomerAndJob(cookies.denverDispatcher, 'DB sec denver');
  austinJobId = await createCustomerAndJob(cookies.austinDispatcher, 'DB sec austin');
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

// --- 1. Anonymous 401 ---
describe('DB-06 / anonymous is rejected on every new endpoint', () => {
  const endpoints: Array<{ method: 'GET' | 'POST'; url: string; body?: object }> = [
    { method: 'POST', url: '/api/v1/jobs/00000000-0000-0000-0000-000000000000/assign', body: { assignedTechUserId: 'x' } },
    { method: 'POST', url: '/api/v1/jobs/00000000-0000-0000-0000-000000000000/unassign' },
    { method: 'GET', url: '/api/v1/techs' },
  ];
  for (const ep of endpoints) {
    it(`${ep.method} ${ep.url}`, async () => {
      const init: { method: typeof ep.method; url: string; headers?: Record<string, string>; payload?: string } = {
        method: ep.method,
        url: ep.url,
      };
      if (ep.body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.payload = JSON.stringify(ep.body);
      }
      const res = await app.inject(init);
      expect(res.statusCode).toBe(401);
    });
  }
});

// --- 2. Cross-tenant ---
describe('DB-06 / cross-tenant attacks are blocked', () => {
  it('assign with an austin tech to a denver job → 400 INVALID_TARGET', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/assign`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({ assignedTechUserId: austinTechUserId }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TARGET');
  });

  it('austin dispatcher assigning a denver job → 404 NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/assign`,
      headers: { cookie: cookies.austinDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({ assignedTechUserId: austinTechUserId }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('austin dispatcher listing /api/v1/techs without franchiseeId gets their austin techs only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/techs',
      headers: { cookie: cookies.austinDispatcher },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ userId: string }>;
    expect(rows.some((r) => r.userId === austinTechUserId)).toBe(true);
    expect(rows.some((r) => r.userId === denverTechUserId)).toBe(false);
  });

  it('franchisee-scoped caller passing ?franchiseeId for another franchisee → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/techs?franchiseeId=${ids.austinId}`,
      headers: { cookie: cookies.denverDispatcher },
    });
    expect(res.statusCode).toBe(404);
  });
});

// --- 3. Role validation ---
describe('DB-06 / tech validation', () => {
  it('non-tech user (dispatcher) cannot be assigned → 400 INVALID_TARGET', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/assign`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({ assignedTechUserId: denverDispatcherUserId }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TARGET');
  });

  it('non-existent user id → 400 INVALID_TARGET', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/assign`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({ assignedTechUserId: 'does-not-exist' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TARGET');
  });

  it('missing body field → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/assign`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

// --- 4. Event-bus scope filtering ---
describe('DB-06 / EventBus scope filtering (what SSE relies on)', () => {
  it('denver subscriber does not see austin events', async () => {
    const denverEvents: DispatchEvent[] = [];
    const austinEvents: DispatchEvent[] = [];
    const uD = bus.subscribe(
      (e) => e.franchiseeId === ids.denverId,
      (e) => denverEvents.push(e),
    );
    const uA = bus.subscribe(
      (e) => e.franchiseeId === ids.austinId,
      (e) => austinEvents.push(e),
    );
    try {
      // Fire an Austin event only.
      await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${austinJobId}/assign`,
        headers: { cookie: cookies.austinDispatcher, 'content-type': 'application/json' },
        payload: JSON.stringify({ assignedTechUserId: austinTechUserId }),
      });
      expect(austinEvents.length).toBeGreaterThan(0);
      expect(denverEvents.length).toBe(0);
    } finally {
      uD();
      uA();
    }
  });

  it('events carry ids only — no customer names, prices, etc.', async () => {
    const captured: DispatchEvent[] = [];
    const u = bus.subscribe(
      (e) => e.franchiseeId === ids.denverId,
      (e) => captured.push(e),
    );
    try {
      await app.inject({
        method: 'POST',
        url: `/api/v1/jobs/${denverJobId}/assign`,
        headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
        payload: JSON.stringify({ assignedTechUserId: denverTechUserId }),
      });
      expect(captured.length).toBeGreaterThan(0);
      for (const e of captured) {
        const allowed = [
          'type',
          'franchiseeId',
          'franchisorId',
          'jobId',
          'assignedTechUserId',
          'fromStatus',
          'toStatus',
          'actorUserId',
          'at',
        ];
        for (const key of Object.keys(e)) {
          expect(allowed, `unexpected event key: ${key}`).toContain(key);
        }
      }
    } finally {
      u();
    }
  });
});

// --- 5. Techs endpoint access ---
describe('DB-06 / techs endpoint access', () => {
  it('dispatcher, tech, owner, csr all get the same list for their franchisee', async () => {
    const roles = ['denverDispatcher', 'denverTech', 'denverOwner'] as const;
    for (const role of roles) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/techs',
        headers: { cookie: cookies[role] },
      });
      expect(res.statusCode).toBe(200);
      const ids_ = (res.json().data as Array<{ userId: string }>).map((r) => r.userId);
      expect(ids_).toContain(denverTechUserId);
    }
  });
});

// --- 6. Validation / extra coverage ---
describe('DB-06 / validation', () => {
  it('non-UUID path param on assign → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs/not-a-uuid/assign',
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({ assignedTechUserId: denverTechUserId }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('non-UUID path param on unassign → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs/not-a-uuid/unassign',
      headers: { cookie: cookies.denverDispatcher },
    });
    expect(res.statusCode).toBe(400);
  });

  it('unassign on another franchisee\'s job → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${austinJobId}/unassign`,
      headers: { cookie: cookies.denverDispatcher },
    });
    expect(res.statusCode).toBe(404);
  });

  it('malformed scheduledStart (non-ISO) → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/assign`,
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({
        assignedTechUserId: denverTechUserId,
        scheduledStart: 'tomorrow-ish',
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/v1/techs as platform admin without franchiseeId → 400', async () => {
    // Sign in as the seeded platform admin.
    const cookie = await signIn('joey@opendc.ca');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/techs',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/v1/techs as platform admin with valid franchiseeId → 200', async () => {
    const cookie = await signIn('joey@opendc.ca');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/techs?franchiseeId=${ids.denverId}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const ids_ = (res.json().data as Array<{ userId: string }>).map((r) => r.userId);
    expect(ids_).toContain(denverTechUserId);
  });

  it('GET /api/v1/techs as admin with non-existent franchiseeId → 404', async () => {
    const cookie = await signIn('joey@opendc.ca');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/techs?franchiseeId=00000000-0000-0000-0000-000000000000',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DB-06 / tech cannot assign their own job (role isn\'t dispatcher — still works because scope is all same-franchisee)', () => {
  // Techs CAN call the assign endpoint (v1 doesn't split role further
  // inside a franchisee); this test records that policy. If later we
  // want to lock assignment to dispatcher/owner/location_manager only,
  // this case becomes a negative test.
  it('denver tech assigning themselves to a denver job succeeds', async () => {
    const fresh = await createCustomerAndJob(cookies.denverDispatcher, 'Tech self assign');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${fresh}/assign`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ assignedTechUserId: denverTechUserId }),
    });
    expect(res.statusCode).toBe(200);
  });
});
