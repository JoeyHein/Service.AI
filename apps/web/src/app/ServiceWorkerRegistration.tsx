'use client';

import { useEffect } from 'react';

/**
 * Registers /sw.js once at mount. Runs client-side only; on the
 * server the useEffect never fires so the rendered HTML is identical
 * in SSR and hydration. Scope defaults to the origin root so every
 * same-origin fetch is eligible (the SW itself filters by path).
 *
 * Any registration error is logged but never surfaced — an unusable
 * service worker shouldn't block the app from working.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    // Defer until the page is idle so SW registration never competes
    // with first-paint resource fetches.
    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('Service worker registration failed:', err);
        });
    };
    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
    }
  }, []);
  return null;
}
