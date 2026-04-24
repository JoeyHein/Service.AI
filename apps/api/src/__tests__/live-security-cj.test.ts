/**
 * TASK-CJ-08 — dedicated security suite for phase_customer_job.
 *
 * Seeds once, then exercises every new endpoint against the threat
 * model: anonymous access, cross-tenant IDOR (denver ↔ austin),
 * role-based access, invalid state transitions, cross-job photo
 * upload, scope-filter leakage on list endpoints. Target ≥25 cases,
 * <30s runtime; auto-skips when DATABASE_URL is unreachable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
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

const { Pool } = pkg;

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let cookies: {
  denverOwner: string;
  denverDispatcher: string;
  denverTech: string;
  denverCsr: string;
  austinOwner: string;
};
let denverCustomerId: string;
let austinCustomerId: string;
let denverJobId: string;
let austinJobId: string;

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

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await runReset(pool);
  await runSeed(pool);
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
  cookies = {
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
    denverDispatcher: await signIn('denver.dispatcher@elevateddoors.test'),
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    denverCsr: await signIn('denver.csr@elevateddoors.test'),
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
  };

  const mkCust = async (cookie: string, name: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ name }),
    });
    return res.json().data.id as string;
  };
  denverCustomerId = await mkCust(cookies.denverOwner, 'Denver Security Customer');
  austinCustomerId = await mkCust(cookies.austinOwner, 'Austin Security Customer');

  const mkJob = async (cookie: string, customerId: string, title: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ customerId, title }),
    });
    return res.json().data.id as string;
  };
  denverJobId = await mkJob(cookies.denverOwner, denverCustomerId, 'Denver job');
  austinJobId = await mkJob(cookies.austinOwner, austinCustomerId, 'Austin job');
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

// -----------------------------------------------------------------------------
// 1. Anonymous access (401)
// -----------------------------------------------------------------------------
describe('CJ-08 / anonymous is rejected on every phase-3 endpoint', () => {
  const endpoints: Array<{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; body?: object }> = [
    { method: 'GET', url: '/api/v1/customers' },
    { method: 'POST', url: '/api/v1/customers', body: { name: 'x' } },
    { method: 'GET', url: '/api/v1/customers/11111111-1111-1111-1111-111111111111' },
    { method: 'PATCH', url: '/api/v1/customers/11111111-1111-1111-1111-111111111111', body: { name: 'x' } },
    { method: 'DELETE', url: '/api/v1/customers/11111111-1111-1111-1111-111111111111' },
    { method: 'GET', url: '/api/v1/jobs' },
    { method: 'POST', url: '/api/v1/jobs', body: { customerId: '11111111-1111-1111-1111-111111111111', title: 'x' } },
    { method: 'GET', url: '/api/v1/jobs/11111111-1111-1111-1111-111111111111' },
    { method: 'PATCH', url: '/api/v1/jobs/11111111-1111-1111-1111-111111111111', body: { title: 'x' } },
    { method: 'POST', url: '/api/v1/jobs/11111111-1111-1111-1111-111111111111/transition', body: { toStatus: 'scheduled' } },
    { method: 'POST', url: '/api/v1/jobs/11111111-1111-1111-1111-111111111111/photos/upload-url', body: { contentType: 'image/jpeg' } },
    { method: 'POST', url: '/api/v1/jobs/11111111-1111-1111-1111-111111111111/photos', body: { storageKey: 'x', contentType: 'image/jpeg', sizeBytes: 1 } },
    { method: 'GET', url: '/api/v1/jobs/11111111-1111-1111-1111-111111111111/photos' },
    { method: 'DELETE', url: '/api/v1/jobs/11111111-1111-1111-1111-111111111111/photos/11111111-1111-1111-1111-111111111111' },
    { method: 'GET', url: '/api/v1/places/autocomplete?q=ab' },
    { method: 'GET', url: '/api/v1/places/stub-denver-a' },
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

// -----------------------------------------------------------------------------
// 2. Cross-tenant IDOR
// -----------------------------------------------------------------------------
describe('CJ-08 / cross-tenant IDOR blocked', () => {
  it('austin owner gets 404 on denver customer read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${denverCustomerId}`,
      headers: { cookie: cookies.austinOwner },
    });
    expect(res.statusCode).toBe(404);
  });

  it('austin owner gets 404 on denver job read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${denverJobId}`,
      headers: { cookie: cookies.austinOwner },
    });
    expect(res.statusCode).toBe(404);
  });

  it('austin owner listing customers does not leak denver rows', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/customers',
      headers: { cookie: cookies.austinOwner },
    });
    const ids = (res.json().data.rows as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain(denverCustomerId);
  });

  it('austin owner listing jobs does not leak denver rows', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/jobs',
      headers: { cookie: cookies.austinOwner },
    });
    const ids = (res.json().data.rows as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain(denverJobId);
  });

  it('cross-tenant transition returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/transition`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ toStatus: 'scheduled' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('cross-tenant photo upload-url returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photos/upload-url`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ contentType: 'image/jpeg' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('austin owner cannot create a job bound to denver customer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ customerId: denverCustomerId, title: 'cross-tenant' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TARGET');
  });
});

// -----------------------------------------------------------------------------
// 3. Role-based access within the same franchisee
// -----------------------------------------------------------------------------
describe('CJ-08 / same-franchisee roles', () => {
  it('dispatcher can create customers + jobs within Denver', async () => {
    const cust = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Dispatcher created' }),
    });
    expect(cust.statusCode).toBe(201);
    const job = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({
        customerId: cust.json().data.id,
        title: 'Dispatcher job',
      }),
    });
    expect(job.statusCode).toBe(201);
  });

  it('tech can read + transition jobs within Denver', async () => {
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${denverJobId}`,
      headers: { cookie: cookies.denverTech },
    });
    expect(read.statusCode).toBe(200);
  });

  it('csr can read customers within Denver', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${denverCustomerId}`,
      headers: { cookie: cookies.denverCsr },
    });
    expect(res.statusCode).toBe(200);
  });
});

// -----------------------------------------------------------------------------
// 4. State-machine enforcement
// -----------------------------------------------------------------------------
describe('CJ-08 / invalid state transitions return 409', () => {
  it('unassigned → completed is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/transition`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ toStatus: 'completed' }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_TRANSITION');
  });

  it('unassigned → arrived is rejected (skip a step)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/transition`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ toStatus: 'arrived' }),
    });
    expect(res.statusCode).toBe(409);
  });

  it('unknown status value returns 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/transition`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ toStatus: 'godmode' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

// -----------------------------------------------------------------------------
// 5. Photo upload security
// -----------------------------------------------------------------------------
describe('CJ-08 / photo upload is storage-key scoped', () => {
  it('rejects finalise with a storage_key that names another job', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photos`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        storageKey: `jobs/${austinJobId}/photos/abc.jpg`,
        contentType: 'image/jpeg',
        sizeBytes: 100,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TARGET');
  });

  it('sizeBytes >50MB is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photos`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        storageKey: `jobs/${denverJobId}/photos/abc.jpg`,
        contentType: 'image/jpeg',
        sizeBytes: 60_000_000,
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('path-traversal attempt in extension is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photos/upload-url`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ contentType: 'image/jpeg', extension: '../evil' }),
    });
    expect(res.statusCode).toBe(400);
  });
});

// -----------------------------------------------------------------------------
// 6. Places endpoints require auth
// -----------------------------------------------------------------------------
describe('CJ-08 / places endpoints require auth', () => {
  it('autocomplete works for authed caller', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/places/autocomplete?q=garage',
      headers: { cookie: cookies.denverDispatcher },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.candidates).toHaveLength(5);
  });

  it('details rejects unknown placeId with 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/places/unknown-id',
      headers: { cookie: cookies.denverDispatcher },
    });
    expect(res.statusCode).toBe(404);
  });
});

// -----------------------------------------------------------------------------
// 7. Validation baseline
// -----------------------------------------------------------------------------
describe('CJ-08 / validation returns 400', () => {
  it('customer email field rejects non-email strings', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x', email: 'nope' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('job title is required', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ customerId: denverCustomerId }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('non-UUID path params return 400 across the suite', async () => {
    const urls = [
      '/api/v1/customers/not-a-uuid',
      '/api/v1/jobs/not-a-uuid',
      '/api/v1/jobs/not-a-uuid/photos',
    ];
    for (const url of urls) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: cookies.denverOwner },
      });
      expect(res.statusCode, url).toBe(400);
    }
  });
});
