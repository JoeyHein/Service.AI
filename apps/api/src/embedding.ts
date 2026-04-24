/**
 * Pluggable embedding client (phase_ai_tech_assistant).
 *
 * Phase 11 ships a deterministic 32-dimensional stub so the RAG
 * tests reproduce exactly without an external embedding
 * provider. `resolveEmbeddingClient()` is a hook for a future
 * phase to swap in OpenAI text-embedding-3-small or
 * VoyageAI voyage-2. Until then the stub is used unconditionally.
 */

import { createHash } from 'node:crypto';

export const EMBEDDING_DIM = 32;

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
  /** Batched version; real providers are cheaper in bulk. */
  embedBatch(texts: string[]): Promise<number[][]>;
}

function hashToFloats(text: string, dim: number): number[] {
  // SHA-256 → 32 bytes = 32 floats in [-1, 1). We concat two
  // digests when the dim exceeds 32 so the helper stays general.
  const digests: Buffer[] = [];
  let seed = text;
  while (digests.reduce((acc, d) => acc + d.length, 0) < dim) {
    digests.push(createHash('sha256').update(seed).digest());
    seed = `${seed}:${digests.length}`;
  }
  const combined = Buffer.concat(digests);
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    // Map byte 0..255 → float in [-1, 1). Deterministic and
    // cheap; not semantically meaningful, but good enough for
    // "same tags retrieve same docs" tests.
    out[i] = combined[i]! / 128 - 1;
  }
  return out;
}

/**
 * Deterministic stub. Two different strings that share a common
 * substring (e.g. "broken torsion spring") will NOT have similar
 * embeddings — because we hash the whole string. To make
 * RAG-over-tags work, callers embed the *joined tag set* so two
 * docs tagged `["spring", "torsion"]` hash identically.
 */
export const stubEmbeddingClient: EmbeddingClient = {
  async embed(text) {
    return hashToFloats(text, EMBEDDING_DIM);
  },
  async embedBatch(texts) {
    return texts.map((t) => hashToFloats(t, EMBEDDING_DIM));
  },
};

export function resolveEmbeddingClient(): EmbeddingClient {
  // When OPENAI_EMBEDDING_API_KEY (etc.) is wired, swap here.
  // For phase 11 the stub is the only path.
  return stubEmbeddingClient;
}

/**
 * Cosine similarity between two equal-length numeric arrays.
 * Returns 0 when either input is all-zero (avoids NaN).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: length mismatch (${a.length} vs ${b.length})`,
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
