'use client';

/**
 * Requests Web Push permission once, subscribes via the registered
 * service worker, and POSTs the resulting subscription to
 * /api/v1/push/subscribe. Runs best-effort: any failure (permission
 * denied, missing VAPID public key, older browser) is logged to the
 * console and swallowed — the tech PWA still works fully without
 * push.
 *
 * Mounted inside the tech layout so only signed-in techs are asked.
 */

import { useEffect } from 'react';
import { apiClientFetch } from '../../lib/api.js';

const ASKED_KEY = 'service-ai-push-asked-v1';

function bufferToBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToUint8Array(v: string): Uint8Array {
  const padding = '='.repeat((4 - (v.length % 4)) % 4);
  const base64 = (v + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function PushSubscribe() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(ASKED_KEY))
      return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!vapidKey) return;

    const run = async () => {
      try {
        if (Notification.permission === 'denied') return;
        if (Notification.permission === 'default') {
          const granted = await Notification.requestPermission();
          if (granted !== 'granted') return;
        }
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        const sub =
          existing ??
          (await reg.pushManager.subscribe({
            userVisibleOnly: true,
            // Cast through `BufferSource`: newer TS lib types parameterise
            // Uint8Array over ArrayBufferLike, which the Push spec's
            // ArrayBufferView<ArrayBuffer> rejects without a widen.
            applicationServerKey: base64UrlToUint8Array(vapidKey) as BufferSource,
          }));
        const p256dh = sub.getKey('p256dh');
        const auth = sub.getKey('auth');
        if (!p256dh || !auth) return;
        await apiClientFetch('/api/v1/push/subscribe', {
          method: 'POST',
          body: JSON.stringify({
            endpoint: sub.endpoint,
            keys: {
              p256dh: bufferToBase64Url(p256dh),
              auth: bufferToBase64Url(auth),
            },
            userAgent: navigator.userAgent,
          }),
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('push subscribe failed:', err);
      } finally {
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem(ASKED_KEY, '1');
        }
      }
    };

    const timer = setTimeout(() => {
      void run();
    }, 1500);
    return () => clearTimeout(timer);
  }, []);
  return null;
}
