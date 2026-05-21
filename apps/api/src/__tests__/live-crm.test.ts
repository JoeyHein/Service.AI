/**
 * Live Postgres tests for CRM-02 (customer notes API).
 *
 * Covers: anonymous 401, staff manual note + per-customer timeline,
 * cross-tenant 404, type filter, Donna/AI ingest (match / unmatched / dedup /
 * key auth), the org/branch feed with triage filters, and link-to-customer
 * triage. Auto-skips when Postgres is unreachable.
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
import { membershipResolver, auditLogWriter } from '../production-resolvers.js';

const { Pool } = pkg;

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

const INGEST_KEY = 'test-ingest-key';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let cookies: { denverManager: string; austinManager: string; corporate: string };
let prevIngestKey: string | undefined;
let prevIntakeSlug: string | undefined;

async function checkReachable(): Promise<boolean> {
  const p = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await p.query('SELECT 1 FROM customer_notes LIMIT 0');
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

async function createCustomer(
  cookie: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/customers',
    headers: { cookie, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
  if (res.statusCode !== 201) throw new Error(`createCustomer failed: ${res.body}`);
  return res.json().data.id as string;
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  prevIngestKey = process.env['CRM_INGEST_KEY'];
  prevIntakeSlug = process.env['LEAD_INTAKE_BRANCH_SLUG'];
  process.env['CRM_INGEST_KEY'] = INGEST_KEY;
  process.env['LEAD_INTAKE_BRANCH_SLUG'] = 'denver';

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
    auditWriter: auditLogWriter(db),
    magicLinkSender: { async send() {} },
    acceptUrlBase: 'http://localhost:3000',
  });
  await app.ready();

  cookies = {
    denverManager: await signIn('denver.owner@elevateddoors.test'),
    austinManager: await signIn('austin.owner@elevateddoors.test'),
    corporate: await signIn('joey@opendc.ca'),
  };
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (prevIngestKey === undefined) delete process.env['CRM_INGEST_KEY'];
  else process.env['CRM_INGEST_KEY'] = prevIngestKey;
  if (prevIntakeSlug === undefined) delete process.env['LEAD_INTAKE_BRANCH_SLUG'];
  else process.env['LEAD_INTAKE_BRANCH_SLUG'] = prevIntakeSlug;
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

function ingest(body: Record<string, unknown>, key: string | null = INGEST_KEY) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers['x-service-ai-ingest-key'] = key;
  return app.inject({
    method: 'POST',
    url: '/api/v1/crm/notes',
    headers,
    payload: JSON.stringify(body),
  });
}

describe('CRM-02 / customer notes', () => {
  it('anonymous returns 401 on staff endpoints', async () => {
    for (const [method, url, hasBody] of [
      ['GET', '/api/v1/customers/11111111-1111-1111-1111-111111111111/notes', false],
      ['POST', '/api/v1/customers/11111111-1111-1111-1111-111111111111/notes', true],
      ['GET', '/api/v1/crm/notes-feed', false],
      ['POST', '/api/v1/crm/notes/11111111-1111-1111-1111-111111111111/link', true],
    ] as const) {
      const init: { method: typeof method; url: string; headers?: Record<string, string>; payload?: string } = { method, url };
      if (hasBody) {
        init.headers = { 'content-type': 'application/json' };
        init.payload = '{}';
      }
      const res = await app.inject(init);
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('staff adds a manual note and reads the timeline (with type filter)', async () => {
    const custId = await createCustomer(cookies.denverManager, { name: 'Note Co' });
    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/customers/${custId}/notes`,
      headers: { cookie: cookies.denverManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ noteType: 'call', subject: 'Left voicemail', body: 'Called re: install date' }),
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().data.source).toBe('manual');
    expect(create.json().data.noteType).toBe('call');

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${custId}/notes`,
      headers: { cookie: cookies.denverManager },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.total).toBe(1);
    expect(list.json().data.rows[0].body).toBe('Called re: install date');

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${custId}/notes?type=email`,
      headers: { cookie: cookies.denverManager },
    });
    expect(filtered.json().data.total).toBe(0);
  });

  it('cross-tenant: austin cannot read or add notes on a denver customer', async () => {
    const custId = await createCustomer(cookies.denverManager, { name: 'Denver Private' });
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${custId}/notes`,
      headers: { cookie: cookies.austinManager },
    });
    expect(read.statusCode).toBe(404);
    const post = await app.inject({
      method: 'POST',
      url: `/api/v1/customers/${custId}/notes`,
      headers: { cookie: cookies.austinManager, 'content-type': 'application/json' },
      payload: JSON.stringify({ body: 'hijack' }),
    });
    expect(post.statusCode).toBe(404);
  });

  it('ingest: matches a customer by email and attaches the note', async () => {
    const email = `ingest-${Date.now()}@example.test`;
    const custId = await createCustomer(cookies.denverManager, { name: 'Ingest Match', email });
    const res = await ingest({
      email,
      noteType: 'call',
      body: 'Inbound call transcript',
      source: 'donna_pa',
      sourceRef: `call-${Date.now()}`,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.matched).toBe(true);
    expect(res.json().data.customerId).toBe(custId);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${custId}/notes`,
      headers: { cookie: cookies.denverManager },
    });
    expect(list.json().data.rows.map((r: { source: string }) => r.source)).toContain('donna_pa');
  });

  it('ingest: dedupes on (source, source_ref)', async () => {
    const email = `dedup-${Date.now()}@example.test`;
    await createCustomer(cookies.denverManager, { name: 'Dedup Co', email });
    const sourceRef = `call-dedup-${Date.now()}`;
    const first = await ingest({ email, body: 'first', source: 'donna_pa', sourceRef });
    const second = await ingest({ email, body: 'second (ignored)', source: 'donna_pa', sourceRef });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.deduped).toBe(true);
    expect(second.json().data.id).toBe(first.json().data.id);
  });

  it('ingest: an unmatched note lands in the intake branch', async () => {
    const res = await ingest({
      email: `nobody-${Date.now()}@nowhere.test`,
      body: 'Call from an unknown number',
      source: 'donna_pa',
      sourceRef: `unmatched-${Date.now()}`,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.matched).toBe(false);
    expect(res.json().data.customerId).toBeNull();

    // Visible in the denver feed (intake branch) under the unmatched filter.
    const feed = await app.inject({
      method: 'GET',
      url: '/api/v1/crm/notes-feed?matched=unmatched',
      headers: { cookie: cookies.denverManager },
    });
    expect(feed.statusCode).toBe(200);
    expect(feed.json().data.rows.map((r: { id: string }) => r.id)).toContain(res.json().data.id);
  });

  it('ingest: wrong key returns 401', async () => {
    const res = await ingest({ email: 'x@y.test', body: 'nope' }, 'wrong-key');
    expect(res.statusCode).toBe(401);
  });

  it('feed: matched filter returns only matched notes for the branch', async () => {
    const feed = await app.inject({
      method: 'GET',
      url: '/api/v1/crm/notes-feed?matched=matched',
      headers: { cookie: cookies.denverManager },
    });
    expect(feed.statusCode).toBe(200);
    for (const row of feed.json().data.rows as Array<{ customerId: string | null }>) {
      expect(row.customerId).not.toBeNull();
    }
  });

  it('metrics: zeros for a customer with no activity', async () => {
    const custId = await createCustomer(cookies.denverManager, { name: 'Quiet Customer' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${custId}/metrics`,
      headers: { cookie: cookies.denverManager },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.lifetimeRevenueCents).toBe(0);
    expect(d.outstandingCents).toBe(0);
    expect(d.totalJobs).toBe(0);
    expect(d.totalQuotes).toBe(0);
    expect(d.conversionRatePct).toBe(0);
    expect(d.lastContactAt).toBeNull();
  });

  it('metrics: aggregates revenue, jobs, quotes, and recency', async () => {
    const { rows: br } = await pool.query<{ id: string }>(
      `SELECT id FROM branches WHERE slug = 'denver'`,
    );
    const branchId = br[0]!.id;
    const custId = await createCustomer(cookies.denverManager, { name: 'Active Customer' });

    const { rows: sup } = await pool.query<{ id: string }>(
      `INSERT INTO suppliers (name, provider_kind, endpoint_url, api_key_secret_ref, supplier_account_code)
       VALUES ('Metrics Supplier', 'bc_ai_agent', 'http://x', 'ref', 'ACME') RETURNING id`,
    );
    const supplierId = sup[0]!.id;

    const { rows: j1 } = await pool.query<{ id: string }>(
      `INSERT INTO jobs (branch_id, customer_id, status, title) VALUES ($1,$2,'completed','Install') RETURNING id`,
      [branchId, custId],
    );
    await pool.query(
      `INSERT INTO jobs (branch_id, customer_id, status, title) VALUES ($1,$2,'scheduled','Service')`,
      [branchId, custId],
    );
    const completedJobId = j1[0]!.id;

    await pool.query(
      `INSERT INTO invoices (branch_id, job_id, customer_id, status, total) VALUES ($1,$2,$3,'paid','4200.00')`,
      [branchId, completedJobId, custId],
    );
    await pool.query(
      `INSERT INTO invoices (branch_id, job_id, customer_id, status, total) VALUES ($1,$2,$3,'sent','1000.00')`,
      [branchId, completedJobId, custId],
    );

    await pool.query(
      `INSERT INTO quotes (branch_id, customer_id, supplier_id, status, total_cents) VALUES ($1,$2,$3,'accepted',500000)`,
      [branchId, custId, supplierId],
    );
    await pool.query(
      `INSERT INTO quotes (branch_id, customer_id, supplier_id, status, total_cents) VALUES ($1,$2,$3,'void',0)`,
      [branchId, custId, supplierId],
    );

    await pool.query(
      `INSERT INTO customer_notes (branch_id, customer_id, note_type, body, source) VALUES ($1,$2,'call','hi','manual')`,
      [branchId, custId],
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${custId}/metrics`,
      headers: { cookie: cookies.denverManager },
    });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.lifetimeRevenueCents).toBe(420000);
    expect(d.paidInvoices).toBe(1);
    expect(d.avgOrderValueCents).toBe(420000);
    expect(d.outstandingCents).toBe(100000);
    expect(d.outstandingInvoices).toBe(1);
    expect(d.totalJobs).toBe(2);
    expect(d.openJobs).toBe(1);
    expect(d.jobsByStatus.completed).toBe(1);
    expect(d.jobsByStatus.scheduled).toBe(1);
    expect(d.totalQuotes).toBe(2);
    expect(d.quotesByStatus.accepted).toBe(1);
    expect(d.quotesByStatus.void).toBe(1);
    expect(d.conversionRatePct).toBe(100);
    expect(d.openQuotes).toBe(0);
    expect(d.lastContactAt).not.toBeNull();
  });

  it('timeline: unifies notes, jobs, quotes, invoices and filters by type', async () => {
    const { rows: br } = await pool.query<{ id: string }>(
      `SELECT id FROM branches WHERE slug = 'denver'`,
    );
    const branchId = br[0]!.id;
    const custId = await createCustomer(cookies.denverManager, { name: 'Timeline Co' });
    const { rows: sup } = await pool.query<{ id: string }>(
      `INSERT INTO suppliers (name, provider_kind, endpoint_url, api_key_secret_ref, supplier_account_code)
       VALUES ('TL Supplier', 'bc_ai_agent', 'http://x', 'ref', 'TL') RETURNING id`,
    );
    const { rows: jj } = await pool.query<{ id: string }>(
      `INSERT INTO jobs (branch_id, customer_id, status, title) VALUES ($1,$2,'completed','Install') RETURNING id`,
      [branchId, custId],
    );
    await pool.query(
      `INSERT INTO quotes (branch_id, customer_id, supplier_id, status, total_cents) VALUES ($1,$2,$3,'accepted',250000)`,
      [branchId, custId, sup[0]!.id],
    );
    await pool.query(
      `INSERT INTO invoices (branch_id, job_id, customer_id, status, total) VALUES ($1,$2,$3,'paid','2500.00')`,
      [branchId, jj[0]!.id, custId],
    );
    await pool.query(
      `INSERT INTO customer_notes (branch_id, customer_id, note_type, body, source) VALUES ($1,$2,'call','rang','manual')`,
      [branchId, custId],
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${custId}/timeline`,
      headers: { cookie: cookies.denverManager },
    });
    expect(res.statusCode).toBe(200);
    const kindsSeen = new Set((res.json().data.rows as Array<{ kind: string }>).map((r) => r.kind));
    expect(kindsSeen).toEqual(new Set(['note', 'job', 'quote', 'invoice']));
    expect(res.json().data.total).toBe(4);

    const onlyQuotes = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${custId}/timeline?type=quote`,
      headers: { cookie: cookies.denverManager },
    });
    expect(onlyQuotes.json().data.total).toBe(1);
    expect(onlyQuotes.json().data.rows[0].kind).toBe('quote');
  });

  it('metrics: cross-tenant 404', async () => {
    const custId = await createCustomer(cookies.denverManager, { name: 'Metrics Private' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${custId}/metrics`,
      headers: { cookie: cookies.austinManager },
    });
    expect(res.statusCode).toBe(404);
  });

  it('triage: corporate links an unmatched note to a customer', async () => {
    const note = await ingest({
      email: `triage-${Date.now()}@nowhere.test`,
      body: 'Unmatched, needs assignment',
      source: 'donna_pa',
      sourceRef: `triage-${Date.now()}`,
    });
    const noteId = note.json().data.id as string;
    expect(note.json().data.matched).toBe(false);

    const custId = await createCustomer(cookies.denverManager, { name: 'Triage Target' });
    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/crm/notes/${noteId}/link`,
      headers: { cookie: cookies.corporate, 'content-type': 'application/json' },
      payload: JSON.stringify({ customerId: custId }),
    });
    expect(link.statusCode).toBe(200);
    expect(link.json().data.customerId).toBe(custId);

    // Now appears on that customer's timeline.
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/customers/${custId}/notes`,
      headers: { cookie: cookies.denverManager },
    });
    expect(list.json().data.rows.map((r: { id: string }) => r.id)).toContain(noteId);
  });
});
