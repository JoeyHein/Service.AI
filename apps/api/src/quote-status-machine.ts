/**
 * Quote status state machine (SQB-07b).
 *
 * Same shape as job-status-machine.ts. Pure function — no DB, no side
 * effects. Encodes which transitions between quote statuses are
 * legal. Lives in its own module so the web (live quote builder) and
 * the API agree on the matrix.
 *
 * Allowed transitions per gate doc:
 *   draft → priced            (price call succeeds)
 *   draft → void
 *   priced → priced           (re-price after edit; same status, new log row)
 *   priced → committed        (commit call succeeds)
 *   priced → void
 *   committed → accepted      (customer says yes)
 *   committed → void          (within BC validity window; provider voids too)
 *   accepted → void           (refund / cancel after acceptance — manager-only)
 *   accepted is terminal otherwise
 *   void is terminal
 */

export type QuoteStatus = 'draft' | 'priced' | 'committed' | 'accepted' | 'void';

const MATRIX: Record<QuoteStatus, readonly QuoteStatus[]> = {
  // `priced → priced` is the live-edit case — every keystroke re-prices
  // and writes a status_log row, even though the status string stays
  // the same. Modeling it explicitly lets the route handler call
  // `canTransition('priced', 'priced')` without a special case.
  draft:     ['priced', 'void'],
  priced:    ['priced', 'committed', 'void'],
  committed: ['accepted', 'void'],
  accepted:  ['void'],
  void:      [],
};

export function validTransitionsFrom(status: QuoteStatus): readonly QuoteStatus[] {
  return MATRIX[status];
}

export function canTransition(from: QuoteStatus, to: QuoteStatus): boolean {
  return MATRIX[from].includes(to);
}

export const TERMINAL_STATUSES: readonly QuoteStatus[] = ['void'];
export function isTerminal(status: QuoteStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Whether the status counts as "committed-or-later" for commission /
 * downstream-effect purposes. Used by the route handler to decide
 * whether margin_overrides edits should leave the quote alone.
 */
export function isCommittedOrLater(status: QuoteStatus): boolean {
  return status === 'committed' || status === 'accepted' || status === 'void';
}
