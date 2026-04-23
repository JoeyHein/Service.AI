'use client';

import { useEffect } from 'react';
import { drain, defaultSender, size } from '../../lib/offline-queue.js';

/**
 * Idempotently attaches a single `online` event listener that drains
 * the IndexedDB outbox whenever the browser regains connectivity.
 * Also drains once on mount so an app reload while offline picks
 * back up where it left off the next time the network recovers.
 *
 * Mounted inside the tech layout so only the PWA pays the bundle
 * cost; the office UI doesn't need offline replay.
 */
export function OfflineQueueDrainer() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;

    const runDrain = async () => {
      try {
        if ((await size()) === 0) return;
        await drain(defaultSender);
      } catch {
        // Swallow errors — they surface as retained queue entries,
        // and the next online transition retries them. Logging them
        // from a user-facing toast is TM-05b territory.
      }
    };

    // Initial drain once at mount.
    if (navigator.onLine) {
      void runDrain();
    }

    const handler = () => {
      if (cancelled) return;
      void runDrain();
    };
    window.addEventListener('online', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('online', handler);
    };
  }, []);
  return null;
}
