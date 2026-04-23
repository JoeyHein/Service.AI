/**
 * Live Postgres tests for TASK-CJ-07 job photo upload flow.
 *
 * The stubObjectStore never opens a socket; the "upload" step is
 * purely URL generation. We verify: the flow issues a presigned URL
 * with a deterministic storage_key, finalise writes a job_photos row
 * with a downloadable URL, listing returns it, delete removes it, and
 * every endpoint is scoped + auth-gated.
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
let cookies: { denverOwner: string; austinOwner: string };
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

async function createCustomerAndJob(cookie: string, customerName: string) {
  const cust = await app.inject({
    method: 'POST',
    url: '/api/v1/customers',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ name: customerName }),
  });
  const customerId = cust.json().data.id as string;
  const job = await app.inject({
    method: 'POST',
    url: '/api/v1/jobs',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify({ customerId, title: `${customerName} job` }),
  });
  return job.json().data.id as string;
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
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
  };
  denverJobId = await createCustomerAndJob(cookies.denverOwner, 'Photos Denver');
  austinJobId = await createCustomerAndJob(cookies.austinOwner, 'Photos Austin');
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('CJ-07 / job photos', () => {
  it('anonymous: 401 on every photo endpoint', async () => {
    const calls = [
      { method: 'POST' as const, url: `/api/v1/jobs/${denverJobId}/photos/upload-url`, body: { contentType: 'image/jpeg' } },
      { method: 'POST' as const, url: `/api/v1/jobs/${denverJobId}/photos`, body: { storageKey: 'x', contentType: 'image/jpeg', sizeBytes: 1 } },
      { method: 'GET' as const, url: `/api/v1/jobs/${denverJobId}/photos` },
      { method: 'DELETE' as const, url: `/api/v1/jobs/${denverJobId}/photos/11111111-1111-1111-1111-111111111111` },
    ];
    for (const c of calls) {
      const init: { method: typeof c.method; url: string; headers?: Record<string, string>; payload?: string } = {
        method: c.method,
        url: c.url,
      };
      if ('body' in c && c.body) {
        init.headers = { 'content-type': 'application/json' };
        init.payload = JSON.stringify(c.body);
      }
      const res = await app.inject(init);
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(401);
    }
  });

  it('full flow: upload-url → finalise → list → delete', async () => {
    const urlRes = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photos/upload-url`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ contentType: 'image/jpeg', extension: 'jpg' }),
    });
    expect(urlRes.statusCode).toBe(200);
    const up = urlRes.json().data as {
      uploadUrl: string;
      storageKey: string;
      expiresAt: string;
    };
    expect(up.storageKey.startsWith(`jobs/${denverJobId}/photos/`)).toBe(true);
    expect(up.uploadUrl.startsWith('stub://upload/')).toBe(true);
    // expiresAt is in the near future — within 30 minutes.
    const expMs = new Date(up.expiresAt).getTime() - Date.now();
    expect(expMs).toBeGreaterThan(0);
    expect(expMs).toBeLessThanOrEqual(30 * 60 * 1000);

    const finalise = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photos`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        storageKey: up.storageKey,
        contentType: 'image/jpeg',
        sizeBytes: 12345,
        label: 'before',
      }),
    });
    expect(finalise.statusCode).toBe(201);
    const photo = finalise.json().data as { id: string; downloadUrl: string; label: string };
    expect(photo.downloadUrl.startsWith('stub://download/')).toBe(true);
    expect(photo.label).toBe('before');

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${denverJobId}/photos`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json().data as Array<{ id: string; downloadUrl: string }>;
    expect(rows.map((r) => r.id)).toContain(photo.id);
    expect(rows.find((r) => r.id === photo.id)?.downloadUrl).toBeTruthy();

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/jobs/${denverJobId}/photos/${photo.id}`,
      headers: { cookie: cookies.denverOwner },
    });
    expect(del.statusCode).toBe(200);

    const listAfter = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${denverJobId}/photos`,
      headers: { cookie: cookies.denverOwner },
    });
    expect((listAfter.json().data as unknown[]).length).toBe(0);
  });

  it('rejects finalise when storageKey belongs to a different job', async () => {
    const otherKey = `jobs/${austinJobId}/photos/abc.jpg`;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photos`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        storageKey: otherKey,
        contentType: 'image/jpeg',
        sizeBytes: 10,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TARGET');
  });

  it('cross-tenant: austin cannot upload or list denver job photos', async () => {
    const urlRes = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photos/upload-url`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ contentType: 'image/jpeg' }),
    });
    expect(urlRes.statusCode).toBe(404);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${denverJobId}/photos`,
      headers: { cookie: cookies.austinOwner },
    });
    expect(list.statusCode).toBe(404);
  });

  it('validation: sizeBytes must be positive and ≤ 50 MB', async () => {
    const tooBig = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photos`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({
        storageKey: `jobs/${denverJobId}/photos/abc.jpg`,
        contentType: 'image/jpeg',
        sizeBytes: 60_000_000,
      }),
    });
    expect(tooBig.statusCode).toBe(400);
  });

  it('invalid extension in upload-url request is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photos/upload-url`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ contentType: 'image/jpeg', extension: '../evil' }),
    });
    expect(res.statusCode).toBe(400);
  });
});
