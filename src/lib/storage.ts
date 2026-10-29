/**
 * Safe localStorage / sessionStorage JSON helpers. Every access is wrapped in try/catch:
 * storage can be missing, blocked (private mode, sandboxed iframes) or full.
 * SHARED (src/lib). Keys live in config.STORAGE_KEYS.
 *
 * ToS: never store Google place content (names, addresses, phones, photos). Place IDs only.
 */

type Area = 'local' | 'session';

function area(kind: Area): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Read and JSON-parse a key. Returns `fallback` when missing, unreadable or invalid. */
export function loadJSON<T>(key: string, fallback: T, kind: Area = 'local'): T {
  try {
    const raw = area(kind)?.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** JSON-stringify and write a key. Returns false when storage is unavailable or full. */
export function saveJSON(key: string, value: unknown, kind: Area = 'local'): boolean {
  try {
    const s = area(kind);
    if (!s) return false;
    s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Read a raw string. */
export function loadString(key: string, kind: Area = 'local'): string | null {
  try {
    return area(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Write a raw string. */
export function saveString(key: string, value: string, kind: Area = 'local'): boolean {
  try {
    const s = area(kind);
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key: string, kind: Area = 'local'): void {
  try {
    area(kind)?.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** True when the storage area can be written (used for "show hero once per session" fallback). */
export function storageAvailable(kind: Area = 'local'): boolean {
  try {
    const s = area(kind);
    if (!s) return false;
    const k = '__cs_probe__';
    s.setItem(k, '1');
    s.removeItem(k);
    return true;
  } catch {
    return false;
  }
}
