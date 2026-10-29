/**
 * Owner verification for a place that has no coin yet (Claim on a launchable place).
 * The simulated store keys claims on coins, so we remember "this wallet verified this place" here
 * and apply it with store.claimFees the moment the place gets a coin (LaunchFlow).
 * ToS: place IDs + wallet addresses only (no Google content). localStorage, try/catch via lib/storage.
 */
import { useSyncExternalStore } from 'react';
import { STORAGE_KEYS } from '../config';
import { loadJSON, saveJSON } from '../lib/storage';

export interface PreClaim {
  owner: string;
  payoutWallet: string;
  verifiedAt: number;
}

const KEY = STORAGE_KEYS.preclaims;
const listeners = new Set<() => void>();
let cache: Record<string, PreClaim> | null = null;

function read(): Record<string, PreClaim> {
  if (cache) return cache;
  const raw = loadJSON<Record<string, PreClaim> | null>(KEY, null);
  const out: Record<string, PreClaim> = {};
  if (raw && typeof raw === 'object') {
    for (const [id, c] of Object.entries(raw)) {
      if (c && typeof c.owner === 'string' && typeof c.payoutWallet === 'string') out[id] = c;
    }
  }
  cache = out;
  return out;
}

function write(next: Record<string, PreClaim>): void {
  cache = next;
  saveJSON(KEY, next);
  for (const l of [...listeners]) l();
}

export function getPreClaim(placeId: string): PreClaim | null {
  return read()[placeId] ?? null;
}

export function setPreClaim(placeId: string, claim: PreClaim): void {
  write({ ...read(), [placeId]: claim });
}

export function clearPreClaim(placeId: string): void {
  const all = { ...read() };
  delete all[placeId];
  write(all);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React: the pre-claim for a place (re-renders on change). */
export function usePreClaim(placeId: string | null | undefined): PreClaim | null {
  return useSyncExternalStore(
    subscribe,
    () => (placeId ? (read()[placeId] ?? null) : null),
    () => null,
  );
}
