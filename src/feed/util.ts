/**
 * Rail-panel helpers (non-component exports live here so the .tsx files stay Fast-Refresh
 * friendly). OWNED BY RAIL+FEED.
 */
import { useEffect, useRef } from 'react';
import { placeFromCoin } from '../lib/place';
import { feesWaiting, useStore } from '../store';
import type { Coin } from '../types';

export type TopSort = 'mcap' | 'fees';

/** Top shops sort options (DESIGN §10.3: `Market cap` | `Fees earned`). */
export const SORT_OPTIONS: readonly { value: TopSort; label: string }[] = [
  { value: 'mcap', label: 'Market cap' },
  { value: 'fees', label: 'Fees earned' },
];

/* ------------------------------------------------------------------ navigation */

/** Feed / leaderboard / Launched / My coins row → fly to the coin (zoom 16) + open its panel (back chip is automatic). */
export function openCoin(placeId: string): void {
  const s = useStore.getState();
  const coin = s.coins[placeId];
  if (!coin) {
    s.toast("That coin or place wasn't found.", 'error');
    return;
  }
  s.openPlace(placeFromCoin(coin), { fly: true });
}

/* ------------------------------------------------------------------ freshness (.frow.new) */

/**
 * Returns `isFresh(id)`: true for ~700ms after an id first appears in `allIds` (after the
 * first render), so newly inserted rows play `rowin` once. Ids present at mount, or that were
 * merely filtered out before, never animate.
 */
export function useFreshness(allIds: readonly string[]): (id: string) => boolean {
  const seen = useRef(new Map<string, number>());
  const primed = useRef(false);
  useEffect(() => {
    primed.current = true;
  }, []);
  const m = seen.current;
  const t = typeof performance === 'undefined' ? Date.now() : performance.now();
  for (const id of allIds) if (!m.has(id)) m.set(id, primed.current ? t : -Infinity);
  if (m.size > allIds.length + 300) {
    const keep = new Set(allIds);
    for (const k of m.keys()) if (!keep.has(k)) m.delete(k);
  }
  return (id: string) => t - (m.get(id) ?? -Infinity) < 700;
}

/** Fees an owner can still be paid for a shop they claimed (all fees follow the claim). */
export function ownerFeesUsd(coin: Coin): number {
  // real mode: what the owner can still withdraw (exact lamports, rounded down); demo: the claim paid everything
  if (coin.real) return coin.real.feesWaitingUsd;
  return coin.claimed ? coin.feesEarnedUsd : feesWaiting(coin);
}
