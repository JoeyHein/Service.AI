/**
 * EventBus (TASK-DB-02).
 *
 * Pluggable in-process pub/sub so the assignment handler can fire
 * job.* events without caring whether a listener exists. Production
 * can later swap the default impl for a Redis-backed one without
 * touching callers.
 *
 * Event payload carries IDs only — never full job / customer objects
 * — so recipients that shouldn't see a row's contents can't snoop
 * via the event stream. Subscribers fetch details via /api/v1/jobs/:id
 * which is already scope-filtered.
 */
import { EventEmitter } from 'node:events';

export interface DispatchEvent {
  /** Event type. Keep these stable — web clients switch on the name. */
  type:
    | 'job.assigned'
    | 'job.unassigned'
    | 'job.transitioned';
  /** Franchisee the event belongs to. Used by SSE scope filtering. */
  franchiseeId: string;
  /** Franchisor — so franchisor_admin subscribers can match on this. */
  franchisorId: string;
  /** Job id. All events carry this so clients know what to re-fetch. */
  jobId: string;
  /** Additional IDs by event type, ids only (no names / prices / etc.). */
  assignedTechUserId?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  actorUserId?: string | null;
  /** ISO timestamp set by the publisher. */
  at: string;
}

export interface EventBus {
  publish(event: DispatchEvent): void;
  /**
   * Subscribe to events matching the predicate. Returns an unsubscribe
   * function. `predicate` receives the full event — the SSE handler
   * uses this to filter by scope.
   */
  subscribe(
    predicate: (event: DispatchEvent) => boolean,
    handler: (event: DispatchEvent) => void,
  ): () => void;
}

/**
 * Default in-process EventBus. Suitable when the API runs as a single
 * process. For multi-process / multi-host, swap for a Redis pub/sub
 * adapter with the same interface.
 */
export function inProcessEventBus(): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const CHANNEL = 'dispatch';
  return {
    publish(event) {
      emitter.emit(CHANNEL, event);
    },
    subscribe(predicate, handler) {
      const listener = (event: DispatchEvent) => {
        if (predicate(event)) handler(event);
      };
      emitter.on(CHANNEL, listener);
      return () => emitter.off(CHANNEL, listener);
    },
  };
}
