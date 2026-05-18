/**
 * RAG retriever over the kb_docs table (phase_ai_tech_assistant).
 *
 * At the ≤200-doc scale we compute cosine similarity in JS after
 * pulling the candidate set with a simple SELECT. The franchisor_id
 * column on kb_docs was dropped by migration 0016 (corporate hub
 * redesign), so the corpus is now a single corporate-wide pool. Swap
 * to pgvector when the corpus outgrows in-memory scoring.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { kbDocs, type ScopedTx } from '@service-ai/db';
import * as schema from '@service-ai/db';
import {
  cosineSimilarity,
  resolveEmbeddingClient,
  type EmbeddingClient,
} from './embedding.js';

type Drizzle = NodePgDatabase<typeof schema>;

export interface RetrieveInput {
  query: string;
  limit?: number;
  /** Optional tag filter applied before scoring. */
  requireTags?: string[];
}

export interface RetrievedDoc {
  id: string;
  title: string;
  body: string;
  source: string;
  tags: string[];
  score: number;
}

export interface RagDeps {
  embedding?: EmbeddingClient;
}

async function loadCandidates(
  tx: ScopedTx | Drizzle,
): Promise<
  Array<{
    id: string;
    title: string;
    body: string;
    source: string;
    tags: unknown;
    embedding: unknown;
  }>
> {
  return tx
    .select({
      id: kbDocs.id,
      title: kbDocs.title,
      body: kbDocs.body,
      source: kbDocs.source,
      tags: kbDocs.tags,
      embedding: kbDocs.embedding,
    })
    .from(kbDocs);
}

function toStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((v) => String(v));
  return [];
}

function toNumberArray(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  });
}

export async function retrieveKnowledge(
  tx: ScopedTx | Drizzle,
  input: RetrieveInput,
  deps: RagDeps = {},
): Promise<RetrievedDoc[]> {
  const embedding = deps.embedding ?? resolveEmbeddingClient();
  const limit = Math.max(1, Math.min(input.limit ?? 3, 25));
  const queryVec = await embedding.embed(input.query);

  const rows = await loadCandidates(tx);
  const scored: RetrievedDoc[] = [];
  for (const r of rows) {
    const docEmbedding = toNumberArray(r.embedding);
    if (docEmbedding.length !== queryVec.length) continue;
    const tags = toStringArray(r.tags);
    if (input.requireTags && input.requireTags.length > 0) {
      const hasAll = input.requireTags.every((t) => tags.includes(t));
      if (!hasAll) continue;
    }
    const score = cosineSimilarity(queryVec, docEmbedding);
    scored.push({
      id: r.id,
      title: r.title,
      body: r.body,
      source: r.source,
      tags,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
