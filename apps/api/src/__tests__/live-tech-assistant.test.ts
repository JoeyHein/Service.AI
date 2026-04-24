/**
 * Live Postgres tests for the photoQuote + notesToInvoice
 * pipelines + feedback endpoint (TASK-TA-03 + TA-04 + TA-05).
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
import { stubAIClient, type AssistantTurn } from '@service-ai/ai';
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
  austinOwner: string;
};
let denverJobId: string;

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

async function signIn(a: FastifyInstance, email: string): Promise<string> {
  const res = await a.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email, password: DEV_SEED_PASSWORD }),
  });
  const c = extractCookie(res.headers['set-cookie']);
  if (!c) throw new Error(`signIn ${email} failed: ${res.body}`);
  return c;
}

async function buildApplication(notesScript: AssistantTurn[] = []): Promise<FastifyInstance> {
  const ai = stubAIClient({ script: notesScript });
  const db = drizzle(pool, { schema });
  const auth = createAuth({
    db,
    authSchema: { user: users, session: sessions, account: accounts, verification: verifications },
    baseUrl: 'http://localhost',
    secret: 'x'.repeat(32),
  });
  const a = buildApp({
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
    aiClient: ai,
    vision: stubVisionClient(),
  });
  await a.ready();
  return a;
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
  app = await buildApplication([]);
  cookies = {
    denverTech: await signIn(app, 'denver.tech1@elevateddoors.test'),
    denverOwner: await signIn(app, 'denver.owner@elevateddoors.test'),
    denverCsr: await signIn(app, 'denver.csr@elevateddoors.test'),
    austinOwner: await signIn(app, 'austin.owner@elevateddoors.test'),
  };
  // Seed a customer + job in denver to run pipelines against.
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (franchisee_id, name)
       VALUES ($1, 'Fixture Co') RETURNING id`,
    [ids.denverId],
  );
  const job = await pool.query<{ id: string }>(
    `INSERT INTO jobs (franchisee_id, customer_id, title, status)
       VALUES ($1, $2, 'Door down', 'unassigned') RETURNING id`,
    [ids.denverId, cust.rows[0]!.id],
  );
  denverJobId = job.rows[0]!.id;
}, 60_000);

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

// ---------------------------------------------------------------------------
// photoQuote
// ---------------------------------------------------------------------------

describe('TA-03 / photoQuote', () => {
  it('anonymous → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photo-quote`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ imageRef: 'fixture:broken-torsion' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('CSR cannot use → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photo-quote`,
      headers: { cookie: cookies.denverCsr, 'content-type': 'application/json' },
      payload: JSON.stringify({ imageRef: 'fixture:broken-torsion' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('tech + broken-torsion fixture → candidates include SPR-TORSION SKUs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photo-quote`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ imageRef: 'fixture:broken-torsion' }),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      candidates: Array<{
        sku: string;
        confidence: number;
        requiresConfirmation: boolean;
      }>;
    };
    expect(data.candidates.length).toBeGreaterThan(0);
    const skus = data.candidates.map((c) => c.sku);
    const hasSpring = skus.some((s) => s.startsWith('SPR-'));
    expect(hasSpring).toBe(true);
  });

  it('unknown fixture → low-confidence, empty candidates', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/photo-quote`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ imageRef: 'fixture:does-not-exist' }),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      vision: { confidence: number };
      candidates: unknown[];
    };
    expect(data.vision.confidence).toBeLessThan(0.5);
    expect(data.candidates).toEqual([]);
  });

  it('cross-tenant job → 404', async () => {
    const austinCust = await pool.query<{ id: string }>(
      `INSERT INTO customers (franchisee_id, name) VALUES ($1, 'Aus') RETURNING id`,
      [ids.austinId],
    );
    const austinJob = await pool.query<{ id: string }>(
      `INSERT INTO jobs (franchisee_id, customer_id, title, status)
         VALUES ($1, $2, 'aus', 'unassigned') RETURNING id`,
      [ids.austinId, austinCust.rows[0]!.id],
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${austinJob.rows[0]!.id}/photo-quote`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ imageRef: 'fixture:broken-torsion' }),
    });
    expect(res.statusCode).toBe(404);
  });

  it('above-cap line items are flagged requiresConfirmation=true', async () => {
    // Set the denver cap to $1 so every candidate exceeds it.
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
    const data = res.json().data as {
      candidates: Array<{ requiresConfirmation: boolean }>;
    };
    for (const c of data.candidates) {
      expect(c.requiresConfirmation).toBe(true);
    }
    // Restore.
    await pool.query(
      `UPDATE franchisees
         SET ai_guardrails = jsonb_set(ai_guardrails, '{techPhotoQuoteCapCents}', '50000')
       WHERE id = $1`,
      [ids.denverId],
    );
  });
});

// ---------------------------------------------------------------------------
// notesToInvoice
// ---------------------------------------------------------------------------

describe('TA-04 / notesToInvoice', () => {
  it('parses JSON assistant reply into description + intent + warnings', async () => {
    const a = await buildApplication([
      {
        role: 'assistant',
        kind: 'text',
        text: JSON.stringify({
          description: 'Replaced torsion spring pair and lubricated rollers.',
          intent: 'repair',
          warnings: [],
        }),
        confidence: 1,
        costUsd: 0.0002,
        provider: 'stub',
        model: 'stub-1',
      },
    ]);
    const cookie = await signIn(a, 'denver.tech1@elevateddoors.test');
    const res = await a.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/notes-to-invoice`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        notes: 'replaced 2 torsion springs; lubed rollers; tested 3 cycles',
      }),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      description: string;
      intent: string;
      warnings: string[];
    };
    expect(data.description).toContain('torsion spring');
    expect(data.intent).toBe('repair');
    await a.close();
  });

  it('non-JSON assistant reply falls back to verbatim description', async () => {
    const a = await buildApplication([
      {
        role: 'assistant',
        kind: 'text',
        text: 'Replaced spring. No warranty on extension rework.',
        confidence: 1,
        costUsd: 0.0001,
        provider: 'stub',
        model: 'stub-1',
      },
    ]);
    const cookie = await signIn(a, 'denver.tech1@elevateddoors.test');
    const res = await a.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/notes-to-invoice`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ notes: 'spring redo' }),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { description: string };
    expect(data.description).toContain('Replaced spring');
    await a.close();
  });

  it('empty notes → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/jobs/${denverJobId}/notes-to-invoice`,
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({ notes: '' }),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// feedback
// ---------------------------------------------------------------------------

describe('TA-05 / feedback', () => {
  it('denver tech records an accept feedback row scoped to denver', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/feedback',
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({
        kind: 'accept',
        subjectKind: 'photo_quote_item',
        subjectRef: { serviceItemId: 'sku-example' },
      }),
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as { franchiseeId: string; kind: string };
    expect(data.franchiseeId).toBe(ids.denverId);
    expect(data.kind).toBe('accept');
  });

  it('invalid subjectKind → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/feedback',
      headers: { cookie: cookies.denverTech, 'content-type': 'application/json' },
      payload: JSON.stringify({
        kind: 'accept',
        subjectKind: 'garbage',
        subjectRef: {},
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('CSR → 403 on feedback write', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/ai/feedback',
      headers: { cookie: cookies.denverCsr, 'content-type': 'application/json' },
      payload: JSON.stringify({
        kind: 'accept',
        subjectKind: 'photo_quote_item',
        subjectRef: { x: 1 },
      }),
    });
    expect(res.statusCode).toBe(403);
  });
});

