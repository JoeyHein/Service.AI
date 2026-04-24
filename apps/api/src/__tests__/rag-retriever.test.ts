/**
 * Unit tests for embedding + RAG helpers (TASK-TA-02).
 */

import { describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  stubEmbeddingClient,
  EMBEDDING_DIM,
} from '../embedding.js';

describe('TA-02 / stubEmbeddingClient', () => {
  it('embedding dimension is 32', async () => {
    const v = await stubEmbeddingClient.embed('torsion spring');
    expect(v).toHaveLength(EMBEDDING_DIM);
  });

  it('identical inputs produce identical vectors', async () => {
    const a = await stubEmbeddingClient.embed('torsion spring');
    const b = await stubEmbeddingClient.embed('torsion spring');
    expect(a).toEqual(b);
  });

  it('different inputs produce different vectors', async () => {
    const a = await stubEmbeddingClient.embed('torsion spring');
    const b = await stubEmbeddingClient.embed('chain opener');
    expect(a).not.toEqual(b);
  });

  it('batch matches single calls', async () => {
    const [a, b] = await stubEmbeddingClient.embedBatch(['x', 'y']);
    const ax = await stubEmbeddingClient.embed('x');
    const by = await stubEmbeddingClient.embed('y');
    expect(a).toEqual(ax);
    expect(b).toEqual(by);
  });
});

describe('TA-02 / cosineSimilarity', () => {
  it('identical vectors → 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('orthogonal vectors → 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('opposite vectors → -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it('all-zero input → 0 (no NaN)', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('throws on length mismatch', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/length/);
  });
});
