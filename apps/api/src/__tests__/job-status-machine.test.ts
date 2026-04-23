import { describe, it, expect } from 'vitest';
import {
  canTransition,
  isTerminal,
  validTransitionsFrom,
  type JobStatus,
} from '../job-status-machine.js';

const ALL: JobStatus[] = [
  'unassigned',
  'scheduled',
  'en_route',
  'arrived',
  'in_progress',
  'completed',
  'canceled',
];

describe('CJ-03 / validTransitionsFrom matches the gate matrix', () => {
  it.each([
    ['unassigned', ['scheduled', 'canceled']],
    ['scheduled', ['en_route', 'unassigned', 'canceled']],
    ['en_route', ['arrived', 'canceled']],
    ['arrived', ['in_progress', 'canceled']],
    ['in_progress', ['completed', 'canceled']],
    ['completed', []],
    ['canceled', []],
  ] as [JobStatus, JobStatus[]][])('%s → %j', (from, expected) => {
    expect([...validTransitionsFrom(from)]).toEqual(expected);
  });
});

describe('CJ-03 / canTransition enforces the matrix exhaustively', () => {
  it('accepts only matrix-legal moves, rejects everything else', () => {
    for (const from of ALL) {
      const legal = new Set(validTransitionsFrom(from));
      for (const to of ALL) {
        expect(canTransition(from, to)).toBe(legal.has(to));
      }
    }
  });

  it('every non-terminal state allows canceled', () => {
    for (const s of ALL) {
      if (isTerminal(s)) continue;
      expect(canTransition(s, 'canceled')).toBe(true);
    }
  });

  it('terminal states accept nothing', () => {
    expect(canTransition('completed', 'in_progress')).toBe(false);
    expect(canTransition('completed', 'canceled')).toBe(false);
    expect(canTransition('canceled', 'unassigned')).toBe(false);
  });
});

describe('CJ-03 / isTerminal', () => {
  it('completed and canceled are terminal; nothing else is', () => {
    for (const s of ALL) {
      expect(isTerminal(s)).toBe(s === 'completed' || s === 'canceled');
    }
  });
});
