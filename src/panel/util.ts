/**
 * Place-panel helpers (PANEL module): owner state, clock hook, launch gating, panel scrolling.
 */
import { useEffect, useState } from 'react';
import { isDevTestPlaceId, isLaunchableSource, knownIneligibility } from '../lib/place';
import { isOwner, useStore } from '../store';
import type { Coin, MapProvider, Place } from '../types';

export type OwnerState = 'unclaimed' | 'pending' | 'claimed' | 'yours';

export function ownerState(coin: Coin, wallet: string | null): OwnerState {
  if (isOwner(coin, wallet)) return 'yours';
  if (coin.claimed) return 'claimed';
  if (coin.claimPending) return 'pending';
  return 'unclaimed';
}

/** Re-render every `ms` (relative times like `12s`). Paused while the tab is hidden. */
export function useNow(ms = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      clearInterval(t);
      t = setInterval(() => setNow(Date.now()), ms);
    };
    const onVis = () => {
      if (document.hidden) clearInterval(t);
      else {
        setNow(Date.now());
        start();
      }
    };
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [ms]);
  return now;
}

export const LAUNCH_NEEDS_GOOGLE = 'Launching needs Google Maps. Try again later.';
/**
 * OpenStreetMap places (fallback map) and unresolved links have no ID a link can reopen
 * (`/p/<id>` needs a Google place ID or a demo shop), so sharing one would only share the homepage.
 */
export const SHARE_NEEDS_GOOGLE = 'Sharing this shop needs Google Maps. Try again later.';

/** Why a place can't be shared, or null when its `/p/<id>` (or coin `/c/<mint>`) link reopens it. */
export function shareBlockReason(place: Pick<Place, 'source'>): string | null {
  return isLaunchableSource(place.source) ? null : SHARE_NEEDS_GOOGLE;
}
export const OFFLINE_TIP = "You're offline";

/**
 * Why Launch is unavailable for a place, or null when it can launch.
 * OSM / unresolved-link places are never launchable; real Google places need the Google map
 * (the fallback map pauses launching, DESIGN §9.4 / §13.5); fictional demo shops always work.
 * (Offline is handled by the modal's primary buttons, DESIGN §13.5.)
 */
export function launchBlockReason(place: Pick<Place, 'source' | 'id' | 'primaryType' | 'types' | 'businessStatus'>, provider: MapProvider): string | null {
  if (!isLaunchableSource(place.source)) return LAUNCH_NEEDS_GOOGLE;
  // Phase-1 minor #4: plus codes, cities, roads, regions and closed businesses can't get a coin
  const inelig = knownIneligibility(place);
  if (inelig) return inelig === 'closed' ? NOT_LAUNCHABLE_CLOSED : NOT_LAUNCHABLE;
  if (place.source === 'google' && provider !== 'google' && !isDevTestPlaceId(place.id)) return LAUNCH_NEEDS_GOOGLE;
  return null;
}

export const NOT_LAUNCHABLE = "This place can't have a coin";
export const NOT_LAUNCHABLE_CLOSED = 'This business is marked as closed on Google';

export function useLaunchBlockReason(place: Pick<Place, 'source' | 'id' | 'primaryType' | 'types' | 'businessStatus'>): string | null {
  const provider = useStore((s) => s.provider);
  return launchBlockReason(place, provider);
}

/** The panel's scroll container (PanelShell `.panel-scroll`) for an element inside it. */
export function panelScroller(el: Element | null): HTMLElement | null {
  return (el?.closest('.panel-scroll') as HTMLElement | null) ?? null;
}

/** `+offset` of `el` inside the panel scroller's content box. */
export function offsetInScroller(el: Element, scroller: HTMLElement): number {
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}
