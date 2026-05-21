'use client';

import { useEffect, useRef, useState } from 'react';

const DESIGNER_URL =
  process.env.NEXT_PUBLIC_DOOR_DESIGNER_URL ??
  'https://portal.opendc.ca/widget/opendc-door-designer.iife.js';

declare global {
  interface Window {
    OpenDCDesigner?: {
      init(opts: {
        container: string | HTMLElement;
        quoteWebhook?: string;
        dealerLocatorUrl?: string;
      }): { unmount?: () => void } | undefined;
    };
  }
}

/** Load the door-designer IIFE once; resolve when window.OpenDCDesigner exists. */
function loadDesignerScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('no window'));
    if (window.OpenDCDesigner) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-opendc-designer]',
    );
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('load failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = DESIGNER_URL;
    s.async = true;
    s.dataset['opendcDesigner'] = 'true';
    s.addEventListener('load', () => resolve());
    s.addEventListener('error', () => reject(new Error('load failed')));
    document.head.appendChild(s);
  });
}

/**
 * "Design a door" modal for the quote builder. Embeds the OPENDC door-designer
 * IIFE and points its quoteWebhook at `/api/v1/quotes/:id/design-config`
 * (same-origin, so the session cookie flows). v1 lands the config on the
 * current quote as a notes block; a manager prices it after.
 */
export function DesignDoorModal({
  quoteId,
  onClose,
}: {
  quoteId: string;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let root: { unmount?: () => void } | undefined;
    let cancelled = false;
    void (async () => {
      try {
        await loadDesignerScript();
        if (cancelled || !containerRef.current || !window.OpenDCDesigner) return;
        root = window.OpenDCDesigner.init({
          container: containerRef.current,
          quoteWebhook: `/api/v1/quotes/${quoteId}/design-config`,
        });
        setLoading(false);
      } catch {
        if (!cancelled) {
          setError('Could not load the door designer. Check your connection.');
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      root?.unmount?.();
    };
  }, [quoteId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      data-testid="design-door-modal"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-medium text-slate-900">Design a door</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
            data-testid="design-door-close"
            aria-label="Close"
          >
            Close
          </button>
        </div>
        <div className="overflow-auto p-4">
          {loading && (
            <p className="text-sm text-slate-500">Loading designer…</p>
          )}
          {error && (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
              {error}
            </div>
          )}
          <div ref={containerRef} data-testid="design-door-container" />
        </div>
        <div className="border-t border-slate-200 px-4 py-3 text-xs text-slate-500">
          When you submit the design, it lands on this quote as a note for
          pricing.
        </div>
      </div>
    </div>
  );
}
