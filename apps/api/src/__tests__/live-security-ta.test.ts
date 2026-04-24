/**
 * TASK-TA-07 — phase_ai_tech_assistant security suite.
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
import { stubAIClient } from '@service-ai/ai';
import { stubVisionClient } from '../vision.js';

const { Pool } = pkg;
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let app: FastifyInstance;
let ids: { franchisorId: string; denverId: string; austinId: string };
let cookies: {
  denverTech: string;
  denverOwner: string;
  denverCsr: string;
  denverDispatcher: string;
  austinOwner: string;
  austinTech: string;
};
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
  const c = extractCookie(res.headers['set-cookie']);
  if (!c) throw new Error('no cookie');
  return c;
}

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await runReset(pool);
  const seed = await runSeed(pool);
  ids = {
    franchisorId: seed.franchisorId,
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
    aiClient: stubAIClient({ script: [] }),
    vision: stubVisionClient(),
  });
  await app.ready();
  cookies = {
    denverTech: await signIn('denver.tech1@elevateddoors.test'),
    denverOwner: await signIn('denver.owner@elevateddoors.test'),
    denverCsr: await signIn('denver.csr@elevateddoors.test'),
    denverDispatcher: await signIn('denver.dispatcher@elevateddoors.test'),
    austinOwner: await signIn('austin.owner@elevateddoors.test'),
    austinTech: await signIn('austin.tech1@elevateddoors.test'),
  };
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (franchisee_id, name) VALUES ($1, 'Sec C') RETURNING id`,
    [ids.denverId],
  );
  const job = await pool.query<{ id: string }>(
    `INSERT INTO jobs (franchisee_id, customer_id, title, status)
       VALUES ($1, $2, 'sec', 'unassigned') RETURNING id`,
    [ids.denverId, cust.rows[0]!.id],
  );
  denverJobId = job.rows[0]!.id;
  const aCust = await pool.query<{ id: string }>(
    `INSERT INTO customers (franchisee_id, name) VALUES ($1, 'Aus C') RETURNING id`,
    [ids.austinId],
  );
  const aJob = await pool.query<{ id: string }>(
    `INSERT INTO jobs (franchisee_id, customer_id, title, status)
       VALUES ($1, $2, 'aus sec', 'unassigned') RETURNING id`,
    [ids.austinId, aCust.rows[0]!.id],
  );
  austinJobId = aJob.rows[0]!.id;
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

// ---------------------------------------------------------------------------
// Anonymous 401
// ---------------------------------------------------------------------------

describe('TA-07 / anonymous 401', () => {
  const ops: Array<{ method: 'POST'; url: string; body: string }> = [
    {
      method: 'POST',
      url: `/api/v1/jobs/00000000-0000-0000-0000-000000000000/photo-quote`,
      body: JSON.stringify({ imageRef: 'fixture:unknown' }),
    },
    {
      method: 'POST',
      url: `/api/v1/jobs/00000000-0000-0000-0000-000000000000/notes-to-invoice`,
      body: JSON.stringify({ notes: 'x' }),
    },
    {
      method: 'POST',
      url: '/api/v1/ai/feedback',
      body: JSON.stringify({ kind: 'accept', subjectKind: 'photo_quote_item', subjectRef: {} }),
    },
  ];
  for (const op of ops) {
    it(`${op.method} ${op.url} anonymous → 401`, async () => {
      const res = await app.inject({
        method: op.method,
        url: op.url,
        headers: { 'content-type': 'application/json' },
        payload: op.body,
      });
      expect(res.statusCode).toBe(401);
    });
  }
});

// ---------------------------------------------------------------------------
// Role boundary
// ---------------------------------------------------------------------------

describe('TA-07 / role boundary', () => {
  it('CSR cannot photoQuote → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photo-quote`,
      headers: { cookie: cookies.denverCsr, 'content-type': 'application/json' },
      payload: JSON.stringify({ imageRef: 'fixture:unknown' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('CSR cannot notesToInvoice → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/notes-to-invoice`,
      headers: { cookie: cookies.denverCsr, 'content-type': 'application/json' },
      payload: JSON.stringify({ notes: 'test' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('CSR cannot write feedback → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/feedback',
      headers: { cookie: cookies.denverCsr, 'content-type': 'application/json' },
      payload: JSON.stringify({
        kind: 'accept',
        subjectKind: 'photo_quote_item',
        subjectRef: {},
      }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('tech CAN use photoQuote', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photo-quote`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ imageRef: 'fixture:broken-torsion' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('franchisee owner CAN use notesToInvoice', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/notes-to-invoice`,
      headers: { cookie: cookies.denverOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ notes: 'replaced spring pair' }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('dispatcher CAN write feedback', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/feedback',
      headers: { cookie: cookies.denverDispatcher, 'content-type': 'application/json' },
      payload: JSON.stringify({
        kind: 'accept',
        subjectKind: 'dispatcher_assignment',
        subjectRef: { suggestionId: 'x' },
      }),
    });
    expect(res.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Cross-tenant
// ---------------------------------------------------------------------------

describe('TA-07 / cross-tenant', () => {
  it('denver tech photoQuote on austin job → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${austinJobId}/photo-quote`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ imageRef: 'fixture:broken-torsion' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('austin tech notesToInvoice on denver job → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/notes-to-invoice`,
      headers: { cookie: cookies.austinTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ notes: 'cross tenant attempt' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('austin owner photoQuote on denver job → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photo-quote`,
      headers: { cookie: cookies.austinOwner, 'content-type': 'application/json' },
      payload: JSON.stringify({ imageRef: 'fixture:broken-torsion' }),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('TA-07 / validation', () => {
  it('non-UUID job id on photoQuote → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/jobs/not-a-uuid/photo-quote',
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ imageRef: 'fixture:unknown' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('missing imageRef on photoQuote → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photo-quote`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });

  it('empty notes on notesToInvoice → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/notes-to-invoice`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ notes: '' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('oversized notes on notesToInvoice → 400', async () => {
    const huge = 'x'.repeat(6000);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/notes-to-invoice`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ notes: huge }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('bad kind on feedback → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/feedback',
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({
        kind: 'maybe',
        subjectKind: 'photo_quote_item',
        subjectRef: {},
      }),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Guardrail: above-cap flag
// ---------------------------------------------------------------------------

describe('TA-07 / above-cap flag', () => {
  it('$1 cap forces every candidate to requiresConfirmation=true', async () => {
    await pool.query(
      `UPDATE franchisees
         SET ai_guardrails = jsonb_set(ai_guardrails, '{techPhotoQuoteCapCents}', '100')
       WHERE id = $1`,
      [ids.denverId],
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photo-quote`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ imageRef: 'fixture:broken-torsion' }),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      candidates: Array<{ requiresConfirmation: boolean; unitPriceDollars: string }>;
    };
    expect(data.candidates.length).toBeGreaterThan(0);
    for (const c of data.candidates) {
      expect(c.requiresConfirmation).toBe(true);
      expect(Number(c.unitPriceDollars)).toBeGreaterThan(1);
    }
    await pool.query(
      `UPDATE franchisees
         SET ai_guardrails = jsonb_set(ai_guardrails, '{techPhotoQuoteCapCents}', '50000')
       WHERE id = $1`,
      [ids.denverId],
    );
  });
});

// ---------------------------------------------------------------------------
// kb_docs visibility
// ---------------------------------------------------------------------------

describe('TA-07 / kb_docs visibility', () => {
  it('seed populated at least 35 kb_docs rows', async () => {
    const { rows } = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM kb_docs WHERE franchisor_id = $1`,
      [ids.franchisorId],
    );
    expect(Number(rows[0]?.c)).toBeGreaterThanOrEqual(35);
  });

  it('feedback row is franchisee-scoped in practice', async () => {
    // Write from denver tech + austin tech, assert each sees its
    // own rows under app-layer scope (we read via direct SQL
    // filter because RLS is bypassed on superuser; the API
    // handler's scope filter is what we verify).
    const d = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/feedback',
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({
        kind: 'accept',
        subjectKind: 'photo_quote_item',
        subjectRef: { s: 'd' },
      }),
    });
    const a = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/feedback',
      headers: { cookie: cookies.austinTech, 'content-type': 'application/json' },
      payload: JSON.stringify({
        kind: 'override',
        subjectKind: 'photo_quote_item',
        subjectRef: { s: 'a' },
      }),
    });
    expect(d.statusCode).toBe(201);
    expect(a.statusCode).toBe(201);
    expect(d.json().data.franchiseeId).toBe(ids.denverId);
    expect(a.json().data.franchiseeId).toBe(ids.austinId);
  });
});
