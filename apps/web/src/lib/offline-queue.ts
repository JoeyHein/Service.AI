/**
 * IndexedDB-backed offline write queue (TASK-TM-03).
 *
 * When the tech PWA is offline, mutating API calls are serialised
 * into an `outbox` object store. On reconnect (`window online` event
 * or an explicit `drain()` call), every queued entry is replayed in
 * FIFO insertion order — successful replays are deleted, failures
 * stay queued so they're retried later.
 *
 * The module uses raw IndexedDB rather than a wrapper library to
 * keep the bundle small and the dependency surface minimal. Entries
 * are JSON-serialisable, so the same schema works in browsers and
 * in tests (where `fake-indexeddb` provides the global `indexedDB`).
 *
 * Storage quota failures bubble out to the caller as thrown errors
 * rather than being silently swallowed — losing a customer-facing
 * mutation because `QuotaExceededError` went uncaught would be
 * strictly worse than reporting the failure.
 */

export interface QueuedRequest {
  /** HTTP method — validated on enqueue, must be POST/PATCH/PUT/DELETE. */
  method: string;
  /** Request path or fully-qualified URL. Relative paths resolve at drain. */
  url: string;
  /** Arbitrary JSON body. Stored verbatim. */
  body?: unknown;
  /** Optional extra headers (content-type is always set to JSON). */
  headers?: Record<string, string>;
  /** Wall-clock timestamp of enqueue, in ms since epoch. */
  enqueuedAt?: number;
}

interface StoredEntry extends QueuedRequest {
  id?: number;
  enqueuedAt: number;
}

const DB_NAME = 'service-ai-offline';
const DB_VERSION = 1;
const STORE = 'outbox';
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result: T | undefined;
        const maybe = fn(store);
        if (maybe && 'result' in maybe) {
          maybe.onsuccess = () => {
            result = maybe.result as T;
          };
          maybe.onerror = () => reject(maybe.error);
        }
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error ?? new Error('transaction aborted'));
      }),
  );
}

/**
 * Enqueue a mutation for later replay. Throws on invalid method or
 * on any IndexedDB error (quota, transaction abort, etc.).
 */
export async function enqueue(req: QueuedRequest): Promise<void> {
  const method = req.method.toUpperCase();
  if (!WRITE_METHODS.has(method)) {
    throw new Error(`enqueue: unsupported method ${req.method}`);
  }
  const entry: StoredEntry = {
    method,
    url: req.url,
    body: req.body,
    headers: req.headers,
    enqueuedAt: req.enqueuedAt ?? Date.now(),
  };
  await tx<IDBValidKey>('readwrite', (store) => store.add(entry));
}

/** Returns the count of queued entries. */
export async function size(): Promise<number> {
  const n = await tx<number>('readonly', (store) => store.count());
  return n ?? 0;
}

/** Clears the entire queue. Primarily for tests. */
export async function clear(): Promise<void> {
  await tx('readwrite', (store) => store.clear());
}

/**
 * Returns all queued entries ordered by insertion (id ascending).
 * Primarily for debugging / the "pending writes" badge.
 */
export async function list(): Promise<StoredEntry[]> {
  return new Promise((resolve, reject) => {
    openDb().then((db) => {
      const t = db.transaction(STORE, 'readonly');
      const store = t.objectStore(STORE);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result as StoredEntry[]) ?? []);
      req.onerror = () => reject(req.error);
    }, reject);
  });
}

/**
 * Replay every queued entry through the given sender. Successful
 * entries (status < 500) are deleted even if the server returned a
 * 4xx — the client chose to queue it, so the server's verdict is
 * final. 5xx and network errors keep the entry queued for a later
 * retry.
 *
 * When `navigator.onLine === false`, returns early without
 * touching the queue.
 *
 * Returns `{ replayed, remaining }` so callers can show a user
 * notification.
 */
export async function drain(
  sender: (entry: StoredEntry) => Promise<Response>,
): Promise<{ replayed: number; remaining: number }> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { replayed: 0, remaining: await size() };
  }
  const entries = await list();
  let replayed = 0;
  for (const entry of entries) {
    try {
      const res = await sender(entry);
      if (res.status < 500) {
        await tx('readwrite', (store) => store.delete(entry.id!));
        replayed++;
      } else {
        break; // 5xx → stop and retry later so order is preserved
      }
    } catch {
      break; // network error → stop
    }
  }
  return { replayed, remaining: await size() };
}

/** Default sender used by consumers that don't need a custom fetch. */
export const defaultSender = async (entry: StoredEntry): Promise<Response> => {
  return fetch(entry.url, {
    method: entry.method,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(entry.headers ?? {}),
    },
    body: entry.body === undefined ? undefined : JSON.stringify(entry.body),
  });
};
