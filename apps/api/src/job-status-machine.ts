/**
 * Job status state machine (TASK-CJ-03).
 *
 * Pure function — no DB, no side effects. Encodes which transitions
 * between job statuses are legal. Lives in its own module so the UI
 * and the API both read the same matrix (web renders only the buttons
 * for `validTransitionsFrom(current)`).
 */

export type JobStatus =
  | 'unassigned'
  | 'scheduled'
  | 'en_route'
  | 'arrived'
  | 'in_progress'
  | 'completed'
  | 'canceled';

const MATRIX: Record<JobStatus, readonly JobStatus[]> = {
  unassigned:  ['scheduled', 'canceled'],
  scheduled:   ['en_route', 'unassigned', 'canceled'],
  en_route:    ['arrived', 'canceled'],
  arrived:     ['in_progress', 'canceled'],
  in_progress: ['completed', 'canceled'],
  completed:   [],
  canceled:    [],
};

export function validTransitionsFrom(status: JobStatus): readonly JobStatus[] {
  return MATRIX[status];
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return MATRIX[from].includes(to);
}

export const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'canceled'];
export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
