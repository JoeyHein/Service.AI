/* Service.AI service worker — TASK-TM-01
 *
 * Strategy:
 *   - App shell (HTML routes): network-first. Try the network, fall
 *     back to the SW cache if the network fails (offline).
 *   - /api/* requests: network-first with cache. Successful GETs are
 *     cached; when offline the SW returns the last-known-good
 *     response if we have one, otherwise a 503 JSON envelope.
 *   - Hashed static assets (/_next/static/*): cache-first. These are
 *     content-addressed so they never change under the same URL.
 *   - Everything else falls through to the network untouched.
 *
 * Scope: the SW only intercepts same-origin fetches, so the DO
 * Spaces photo uploads and external Google Maps tiles bypass it.
 * Cross-origin crossings are explicitly NOT cached to avoid
 * accidental blob-in-cache leaks across user agents.
 *
 * Write queue: non-GET requests that fail offline are handed back
 * to the caller as a Response; the apiClientFetch wrapper layers the
 * IndexedDB queue on top (TM-03).
 */

/* eslint-disable no-restricted-globals */

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `service-ai-shell-${CACHE_VERSION}`;
const API_CACHE = `service-ai-api-${CACHE_VERSION}`;
const STATIC_CACHE = `service-ai-static-${CACHE_VERSION}`;

const SHELL_URLS = ['/', '/tech', '/dashboard', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(SHELL_URLS).catch(() => {
        // Don't block install on a single missing shell URL — the
        // runtime fetch will populate the cache lazily.
      }),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (k) =>
                !k.endsWith(`-${CACHE_VERSION}`) &&
                (k.startsWith('service-ai-shell-') ||
                  k.startsWith('service-ai-api-') ||
                  k.startsWith('service-ai-static-')),
            )
            .map((k) => caches.delete(k)),
        ),
      ),
  );
  self.clients.claim();
});

function isSameOrigin(url) {
  try {
    return new URL(url).origin === self.location.origin;
  } catch {
    return false;
  }
}

function isStaticAsset(url) {
  return /\/_next\/static\//.test(url);
}

function isApiRequest(url) {
  return /\/api\//.test(url);
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (request.method === 'GET' && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (isApiRequest(request.url)) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: 'OFFLINE', message: 'Offline and no cached response' },
        }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      );
    }
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (request.method === 'GET' && response.ok) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!isSameOrigin(request.url)) return;
  if (request.method !== 'GET') return;
  if (isStaticAsset(request.url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }
  if (isApiRequest(request.url)) {
    event.respondWith(networkFirst(request, API_CACHE));
    return;
  }
  event.respondWith(networkFirst(request, SHELL_CACHE));
});
