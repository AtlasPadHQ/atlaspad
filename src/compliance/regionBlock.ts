/**
 * The sanctions geo-block, client side (worker/geo.ts). The Worker answers a visitor from a blocked country or region
 * with HTTP 451: a static page for the app itself, and `{error:'region_blocked'}` for every API call except
 * /api/config and /api/health. When the app is already open (it loaded before the visitor's location changed, or from
 * a cache), the first API call that comes back `region_blocked` flips this flag and <RegionBlocked/> covers the app.
 *
 * One observer on `fetch` (installed once in main.tsx) sees every client: src/realdata/api.ts, src/chain/api.ts, the
 * /api/rpc client, place and link lookups. It never changes a response; it only reads a clone of a same-origin
 * /api/* 451. Pure module (no React), unit-tested in regionBlock.test.ts.
 */
import { useSyncExternalStore } from 'react';

let blocked = false;
const listeners = new Set<() => void>();

export function isRegionBlocked(): boolean {
  return blocked;
}

/** Marks the visitor's region as blocked (sticky for this page load). */
export function markRegionBlocked(): void {
  if (blocked) return;
  blocked = true;
  for (const l of [...listeners]) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useRegionBlocked(): boolean {
  return useSyncExternalStore(subscribe, isRegionBlocked, isRegionBlocked);
}

/** True for a body the Worker sends a blocked visitor. */
export function isRegionBlockedBody(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { error?: unknown }).error === 'region_blocked';
}

function apiPath(input: RequestInfo | URL, origin: string): boolean {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw, origin);
    return u.origin === origin && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/** `fetch` that notices a same-origin /api/* answer of 451 `region_blocked`; the response is passed through untouched. */
export function watchRegionBlock(f: typeof fetch, origin: string): typeof fetch {
  return async (input, init) => {
    const res = await f(input, init);
    if (res.status === 451 && !blocked && apiPath(input, origin)) {
      try {
        if (isRegionBlockedBody(await res.clone().json())) markRegionBlocked();
      } catch {
        /* not JSON: not ours */
      }
    }
    return res;
  };
}

let installed = false;

/** Installs the observer on `window.fetch` (browser only, once). */
export function installRegionBlockWatch(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  window.fetch = watchRegionBlock(window.fetch.bind(window), window.location.origin);
}

/** Test helper. */
export function __resetRegionBlock(): void {
  blocked = false;
  listeners.clear();
}
