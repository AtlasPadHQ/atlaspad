/**
 * External navigation helpers + the "simulated link" rule (DESIGN §18 preamble):
 * in demo mode every coin is simulated, so Solscan / DexScreener / pump.fun rows show
 * the toast `Simulated coin — it isn't on <site>. Real coins open there.` instead of navigating.
 * Real mode: links open (Solscan cluster-aware; DexScreener / pump.fun hidden on devnet).
 * SHARED (src/lib). Browser-only.
 */
import { DEMO, links } from '../config';
import { useStore } from '../store';
import type { Coin, Place } from '../types';
import { mapsUrlFor } from './place';

/** Open a URL in a new tab with `noopener,noreferrer`. */
export function openExternal(url: string): void {
  const w = window.open(url, '_blank', 'noopener,noreferrer');
  if (w) w.opener = null;
}

/** Demo coins are simulated (link rows toast); real-mode coins come from the chain (links open). */
export function isSimulatedCoin(coin: Pick<Coin, 'mint'> & { real?: Coin['real'] }): boolean {
  return DEMO || !coin.mint || !coin.real;
}

export type CoinSite = 'Solscan' | 'DexScreener' | 'pump.fun';

export function coinSiteUrl(coin: Pick<Coin, 'mint'>, site: CoinSite): string {
  switch (site) {
    case 'Solscan':
      return links.solscanToken(coin.mint);
    case 'DexScreener':
      return links.dexscreener(coin.mint);
    case 'pump.fun':
    default:
      return links.pumpfun(coin.mint);
  }
}

/** Link-row behaviour: toast for simulated coins, new tab for real ones. */
export function openCoinSite(coin: Pick<Coin, 'mint'>, site: CoinSite): void {
  if (isSimulatedCoin(coin)) {
    useStore.getState().toast(`Simulated coin — it isn't on ${site}. Real coins open there.`);
    return;
  }
  openExternal(coinSiteUrl(coin, site));
}

/** "Open in Maps": new tab for Google/OSM places; toast for fictional demo shops (DESIGN §18.2). */
export function openInMaps(place: Pick<Place, 'id' | 'source' | 'mapsUrl' | 'location' | 'osm'>): void {
  const url = mapsUrlFor(place);
  if (!url) {
    useStore.getState().toast("Demo shop — it isn't on Google Maps.");
    return;
  }
  openExternal(url);
}
