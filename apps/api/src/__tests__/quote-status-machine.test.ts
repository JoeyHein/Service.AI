/**
 * Quote status machine tests (SQB-07b).
 */
import { describe, expect, it } from 'vitest';
import {
  canTransition,
  isCommittedOrLater,
  isTerminal,
  validTransitionsFrom,
  type QuoteStatus,
} from '../quote-status-machine.js';

describe('quote-status-machine', () => {
  it.each([
    ['draft', 'priced'],
    ['draft', 'void'],
    ['priced', 'priced'],
    ['priced', 'committed'],
    ['priced', 'void'],
    ['committed', 'accepted'],
    ['committed', 'void'],
    ['accepted', 'void'],
  ] as Array<[QuoteStatus, QuoteStatus]>)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ['draft', 'committed'],
    ['draft', 'accepted'],
    ['priced', 'accepted'],
    ['committed', 'draft'],
    ['committed', 'priced'],
    ['accepted', 'committed'],
    ['accepted', 'priced'],
    ['void', 'draft'],
    ['void', 'priced'],
    ['void', 'committed'],
  ] as Array<[QuoteStatus, QuoteStatus]>)('rejects %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('void is the only terminal status', () => {
    expect(isTerminal('void')).toBe(true);
    expect(isTerminal('accepted')).toBe(false); // accepted can still be voided
    expect(isTerminal('committed')).toBe(false);
    expect(isTerminal('priced')).toBe(false);
    expect(isTerminal('draft')).toBe(false);
  });

  it('committed / accepted / void are committed-or-later', () => {
    expect(isCommittedOrLater('committed')).toBe(true);
    expect(isCommittedOrLater('accepted')).toBe(true);
    expect(isCommittedOrLater('void')).toBe(true);
    expect(isCommittedOrLater('priced')).toBe(false);
    expect(isCommittedOrLater('draft')).toBe(false);
  });

  it('validTransitionsFrom returns the matrix row', () => {
    expect(validTransitionsFrom('draft')).toEqual(['priced', 'void']);
    expect(validTransitionsFrom('void')).toEqual([]);
  });
});
