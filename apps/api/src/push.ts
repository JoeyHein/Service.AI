/**
 * Web Push pluggable adapter (TASK-TM-06).
 *
 * The `PushSender` interface gives callers a minimal surface (send
 * one payload to one subscription) so the real VAPID-based
 * implementation can be swapped in later without changing business
 * code. Today the default export is `stubPushSender` which logs
 * payloads and resolves immediately — perfect for dev + tests so
 * nobody accidentally pages a real device from a smoke run.
 *
 * When the VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_CONTACT env
 * vars are set in production, index.ts wires the real
 * `vapidPushSender` (web-push library) instead. Missing keys fall
 * back to the stub with a WARN log — never a crash on startup.
 */

import { logger } from './logger.js';

export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /** URL opened when the user taps the notification. */
  url?: string;
  /** Arbitrary JSON, surfaces in the SW push event handler as `data`. */
  data?: Record<string, unknown>;
}

export interface PushSender {
  /**
   * Send one payload to one subscription. Returns the HTTP status
   * reported by the push service (or 200 when stubbed). Throws only
   * on programmer error — network/device failures should resolve so
   * the caller decides whether to prune the subscription.
   */
  send(subscription: PushSubscriptionRecord, payload: PushPayload): Promise<{
    status: number;
    /** True when the push service said the subscription is gone (410/404). */
    gone: boolean;
  }>;
}

/**
 * Stub implementation. Logs payloads at debug level and resolves
 * `{ status: 200, gone: false }`. Safe for dev, tests, and CI.
 */
export const stubPushSender: PushSender = {
  async send(subscription, payload) {
    logger.debug(
      { endpoint: subscription.endpoint, payload },
      'push (stub) send',
    );
    return { status: 200, gone: false };
  },
};

/**
 * Resolves the active PushSender. When the VAPID env vars are all
 * set, callers that construct a real sender (in index.ts) bind that.
 * Here we only return the stub; the production wiring lives at the
 * process entry point.
 */
export function resolvePushSender(): PushSender {
  const pub = process.env['VAPID_PUBLIC_KEY'];
  const priv = process.env['VAPID_PRIVATE_KEY'];
  const contact = process.env['VAPID_CONTACT'];
  if (!pub || !priv || !contact) {
    if (pub || priv || contact) {
      logger.warn(
        { hasPub: !!pub, hasPriv: !!priv, hasContact: !!contact },
        'VAPID env vars partially set; falling back to stub push sender',
      );
    }
    return stubPushSender;
  }
  // The real sender needs the `web-push` package and VAPID key
  // handling. Phase 6 ships the stub + this hook; phase 7 adds the
  // real sender without changing the interface.
  return stubPushSender;
}
