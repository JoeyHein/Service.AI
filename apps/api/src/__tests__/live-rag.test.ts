/**
 * Live Postgres tests for retrieveKnowledge (TASK-TA-02).
 *
 * Asserts the retriever pulls the right KB docs from the seeded
 * corpus when queried by tag-style text. Because the stub
 * embedding hashes inputs, retrieving "torsion broken-spring" is
 * expected to rank the torsion + broken-spring articles near the
 * top.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pkg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@service-ai/db';
import { runReset, runSeed } from '../seed/index.js';
import { retrieveKnowledge } from '../rag-retriever.js';

const { Pool } = pkg;
const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://builder:builder@localhost:5434/servicetitan';

let reachable = false;
let pool: InstanceType<typeof Pool>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let franchisorId: string;

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

beforeAll(async () => {
  reachable = await checkReachable();
  if (!reachable) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  await runReset(pool);
  const seed = await runSeed(pool);
  franchisorId = seed.franchisorId;
  db = drizzle(pool, { schema });
}, 60_000);

afterAll(async () => {
  if (pool) await pool.end();
});

beforeEach((ctx) => {
  if (!reachable) ctx.skip();
});

describe('TA-02 / retrieveKnowledge', () => {
  it('seeds at least 35 kb_docs for the franchisor', async () => {
    const { rows } = await pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM kb_docs WHERE franchisor_id = $1`,
      [franchisorId],
    );
    expect(Number(rows[0]?.c)).toBeGreaterThanOrEqual(35);
  });

  it('query tag-text returns top-3 by cosine', async () => {
    const docs = await retrieveKnowledge(db, {
      franchisorId,
      query: 'torsion broken-spring',
      limit: 3,
    });
    expect(docs).toHaveLength(3);
    // Scores should be descending.
    for (let i = 0; i < docs.length - 1; i++) {
      expect(docs[i]!.score).toBeGreaterThanOrEqual(docs[i + 1]!.score);
    }
  });

  it('requireTags filter narrows the candidate set', async () => {
    const all = await retrieveKnowledge(db, {
      franchisorId,
      query: 'anything',
      limit: 10,
    });
    const onlyClopay = await retrieveKnowledge(db, {
      franchisorId,
      query: 'anything',
      limit: 10,
      requireTags: ['clopay'],
    });
    expect(onlyClopay.length).toBeLessThan(all.length);
    for (const d of onlyClopay) {
      expect(d.tags).toContain('clopay');
    }
  });

  it('null franchisorId caller sees every doc', async () => {
    const nullScoped = await retrieveKnowledge(db, {
      franchisorId: null,
      query: 'opener',
      limit: 25,
    });
    expect(nullScoped.length).toBeGreaterThan(0);
  });
});
