/**
 * API fetch helpers for Service.AI web.
 *
 * The web app talks to the Fastify API via Next.js rewrites, so every path
 * under /api/* is same-origin from the browser's perspective. This file
 * provides two helpers:
 *
 *   - apiServerFetch  — for use inside server components / server actions.
 *                       Forwards the incoming request's Cookie header so
 *                       session auth flows through to the API.
 *   - apiClientFetch  — for use in client components. Uses credentials:
 *                       'include' so the browser attaches the session
 *                       cookie automatically.
 *
 * Both helpers default to `cache: 'no-store'` — auth-sensitive endpoints
 * must never be cached in the React Server Component fetch memoiser.
 */

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/**
 * Server-side fetch. Call only from Server Components, Route Handlers, or
 * Server Actions. Pulls cookies from the current request using
 * `next/headers`, which Next.js makes available in server contexts.
 */
export async function apiServerFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: ApiEnvelope<T>; raw: Response }> {
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const url = BASE_URL
    ? `${BASE_URL}${path}`
    : // Server runtime rewrites aren't applied to server-to-server fetches,
      // so fall back to hitting the API directly via the same env var.
      `${process.env.API_INTERNAL_URL ?? 'http://localhost:3001'}${path}`;

  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      cookie: cookieHeader,
    },
    cache: 'no-store',
  });

  const bodyText = await res.text();
  let body: ApiEnvelope<T>;
  try {
    body = bodyText ? (JSON.parse(bodyText) as ApiEnvelope<T>) : { ok: false };
  } catch {
    body = { ok: false, error: { code: 'PARSE_ERROR', message: bodyText } };
  }
  return { status: res.status, body, raw: res };
}

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Browser-side fetch. The rewrite makes /api/* same-origin so
 * credentials: 'include' is enough for cookies to pass through.
 *
 * Offline behaviour (TM-03): when `navigator.onLine === false` and
 * the request is a mutating method, the call is handed to the
 * IndexedDB outbox and a synthetic 202 `{ ok: true, data: { queued:
 * true } }` envelope is returned so callers can optimistically
 * render. GETs bypass the queue (a stale cached response is better
 * than a delayed one).
 */
export async function apiClientFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: ApiEnvelope<T> }> {
  const method = (init.method ?? 'GET').toUpperCase();
  const isOffline =
    typeof navigator !== 'undefined' && navigator.onLine === false;
  if (isOffline && WRITE_METHODS.has(method)) {
    try {
      const { enqueue } = await import('./offline-queue.js');
      const body = init.body == null ? undefined : safeParse(init.body);
      await enqueue({ method, url: path, body });
      return {
        status: 202,
        body: {
          ok: true,
          data: { queued: true } as T,
        },
      };
    } catch (err) {
      return {
        status: 507,
        body: {
          ok: false,
          error: {
            code: 'QUEUE_FAILED',
            message: err instanceof Error ? err.message : 'Queue write failed',
          },
        },
      };
    }
  }
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const bodyText = await res.text();
  let body: ApiEnvelope<T>;
  try {
    body = bodyText ? (JSON.parse(bodyText) as ApiEnvelope<T>) : { ok: false };
  } catch {
    body = { ok: false, error: { code: 'PARSE_ERROR', message: bodyText } };
  }
  return { status: res.status, body };
}

function safeParse(v: BodyInit): unknown {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}
