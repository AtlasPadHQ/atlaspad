/**
 * URL sync + deep links (DESIGN §18.4). SHARED (src/lib). Started once by App.
 *
 *  - `/c/<coinId>` opens a coin (coinId = mint; placeId or ticker also accepted, e.g. /c/kebab).
 *  - `/p/<placeId>` opens a place (launched or launchable).
 *  - Opening a place pushes a history entry; switching places replaces it; closing pops it.
 *  - Opening a modal pushes an entry; browser Back closes the modal, then the panel.
 *  - Unknown routes and deep links that point at nothing: the map loads normally at `/` (the bad
 *    URL is replaced, so refresh / share don't repeat the error) + toast "That coin or place wasn't found."
 *  - document.title follows the open coin / place / list panel (titleForState).
 *
 * History entries are tagged in `history.state.cs`: undefined (base) | 'place' | 'modal'.
 * All history mutations run through one serialized queue so `history.back()` (async) never
 * races a following push.
 */
import { useStore, type AppState } from '../store';
import type { Coin, Place } from '../types';
import { findCoinByUrlId, isGooglePlaceId, isLaunchableSource, knownIneligibility, placeFromCoin, sourceFromId } from './place';

type Tag = 'place' | 'modal' | undefined;

export type DeepLink = { kind: 'coin'; id: string } | { kind: 'place'; id: string };

const NOT_FOUND = "That coin or place wasn't found.";
/** index.html's <title>. */
export const DEFAULT_TITLE = 'AtlasPad — launch a coin for any business on earth';

const LIST_TITLES: Partial<Record<AppState['panel'], string>> = {
  live: 'Live',
  top: 'Top shops',
  launched: 'Launched',
  mine: 'My coins',
  results: 'Search results',
  help: 'Help',
};

/**
 * Tab title for the app state. Only our own data (launcher-typed ticker + coin name), never
 * Google content (a launchable Google place is "this shop").
 */
export function titleForState(s: Pick<AppState, 'panel' | 'selected' | 'coins'>): string {
  if (s.panel === 'place') {
    const p = s.selected.place;
    if (p && s.selected.status !== 'error') {
      const coin = s.coins[p.id];
      if (coin) return `$${coin.ticker} · ${coin.name} — AtlasPad`;
      // OSM / unresolved-link places and non-businesses (parks, cities, roads) can't get a coin
      if (isLaunchableSource(p.source) && !knownIneligibility(p)) return 'Launch a coin for this shop — AtlasPad';
    }
    return DEFAULT_TITLE;
  }
  const list = LIST_TITLES[s.panel];
  return list ? `${list} — AtlasPad` : DEFAULT_TITLE;
}

/** Parse `/c/<id>` or `/p/<id>`. Returns null for `/` and anything else. */
export function parseDeepLink(pathname: string): DeepLink | null {
  const m = pathname.match(/^\/(c|p)\/([^/?#]+)\/?$/);
  if (!m || !m[2]) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  return m[1] === 'c' ? { kind: 'coin', id } : { kind: 'place', id };
}

/** The URL path that represents the current app state. */
export function pathForState(s: Pick<AppState, 'panel' | 'selected' | 'coins'>): string {
  const p = s.selected.place;
  if (s.panel === 'place' && p && s.selected.status !== 'error') {
    const coin = s.coins[p.id];
    if (coin) return `/c/${encodeURIComponent(coin.mint)}`;
    if (p.source === 'google' || p.source === 'demo') return `/p/${encodeURIComponent(p.id)}`;
  }
  return '/';
}

const tag = (): Tag => (history.state as { cs?: Tag } | null)?.cs;
const withSearch = (path: string) => `${path}${location.search}`;

let popWaiter: (() => void) | null = null;
let applyingPop = false;
let queue: Promise<void> = Promise.resolve();

function goBack(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      if (popWaiter === done) popWaiter = null;
      resolve();
    };
    popWaiter = done;
    history.back();
    setTimeout(done, 400); // safety net if popstate never arrives
  });
}

/** Bring the browser history in line with the app state. */
async function reconcile(): Promise<void> {
  for (let guard = 0; guard < 6; guard++) {
    const s = useStore.getState();
    const path = pathForState(s);
    const wantModal = s.modal != null;
    const top = tag();
    if (top === 'modal' && !wantModal) {
      await goBack();
      continue;
    }
    if (top === 'place' && path === '/') {
      await goBack();
      continue;
    }
    if (top === undefined && path !== location.pathname) {
      if (path === '/') history.replaceState(null, '', withSearch('/'));
      else if (location.pathname === '/') history.pushState({ cs: 'place' }, '', withSearch(path));
      else history.replaceState(null, '', withSearch(path)); // initial deep-link entry: keep it as base
      continue;
    }
    if (top === 'place' && path !== location.pathname) {
      history.replaceState({ cs: 'place' }, '', withSearch(path));
      continue;
    }
    if (wantModal && top !== 'modal') {
      history.pushState({ cs: 'modal' }, '', location.href);
      continue;
    }
    return;
  }
}

function schedule(): void {
  if (applyingPop) return;
  queue = queue.then(reconcile).catch(() => {});
}

export interface RouterOptions {
  /** Resolve a place for `/p/<id>` (src/places getPlaceDetails; real mode checks the registry first). */
  resolvePlace: (id: string, source: Place['source']) => Promise<Place | null>;
  /**
   * Real mode: look a coin up by its URL id (mint) when the store doesn't have it yet (registry
   * `/api/coins/:mint`). Null = not found. Demo mode omits it (every coin is in the store).
   */
  resolveCoin?: (id: string) => Promise<Coin | null>;
  /** Ids that are valid place ids besides Google ones (devnet test places). */
  isExtraPlaceId?: (id: string) => boolean;
}

/**
 * A deep link that points at nothing: toast, and bring the URL back in line with the app state
 * (`/` on first load; a stale history entry is popped), so refresh / share don't repeat the error.
 */
function notFound(): void {
  useStore.getState().toast(NOT_FOUND, 'error');
  schedule();
}

/** Open whatever a deep link points at. Unknown → toast + back to `/`. */
export async function openDeepLink(link: DeepLink, opts: RouterOptions): Promise<void> {
  const st = useStore.getState();
  if (link.kind === 'coin') {
    const coin = findCoinByUrlId(st.coins, link.id);
    if (coin) {
      st.openPlace(placeFromCoin(coin), { fly: true, from: null });
      return;
    }
    if (!opts.resolveCoin) {
      notFound();
      return;
    }
    st.setPlaceLoading(null);
    try {
      const found = await opts.resolveCoin(link.id);
      if (found) useStore.getState().openPlace(placeFromCoin(found), { fly: true, from: null });
      else {
        useStore.getState().closePanel();
        notFound();
      }
    } catch {
      useStore.getState().closePanel();
      notFound();
    }
    return;
  }
  const existing = st.coins[link.id];
  if (existing) {
    st.openPlace(placeFromCoin(existing), { fly: true, from: null });
    return;
  }
  const source = sourceFromId(link.id);
  if (source === 'osm' || source === 'link' || (source === 'google' && !isGooglePlaceId(link.id) && !opts.isExtraPlaceId?.(link.id))) {
    notFound();
    return;
  }
  // no coin has this place ID (checked above): show the launchable skeleton (.lhero), not the launched one
  st.setPlaceLoading(null, { launchable: true });
  try {
    const place = await opts.resolvePlace(link.id, source);
    if (place) useStore.getState().openPlace(place, { fly: true, from: null });
    else {
      useStore.getState().closePanel();
      notFound();
    }
  } catch {
    useStore.getState().closePanel();
    notFound();
  }
}

/**
 * Start URL sync. Call once after demo coins are seeded and user coins hydrated, so the initial
 * deep link can find its coin. Returns a cleanup function.
 */
export function startRouter(opts: RouterOptions): () => void {
  if (typeof window === 'undefined') return () => {};
  try {
    history.scrollRestoration = 'manual';
  } catch {
    /* ignore */
  }

  const onPop = () => {
    if (popWaiter) {
      popWaiter();
      return;
    }
    // A user Back/Forward: make the app match the URL.
    applyingPop = true;
    try {
      const st = useStore.getState();
      if (tag() !== 'modal' && st.modal) st.closeModal();
      const link = parseDeepLink(location.pathname);
      if (!link) {
        if (st.panel === 'place') st.closePanel();
      } else if (location.pathname !== pathForState(useStore.getState())) {
        void openDeepLink(link, opts);
      }
    } finally {
      applyingPop = false;
    }
    schedule();
  };
  window.addEventListener('popstate', onPop);

  const unsub = useStore.subscribe(
    (s) => `${pathForState(s)}|${s.modal ? 1 : 0}`,
    () => schedule(),
  );
  const unsubTitle = useStore.subscribe(
    (s) => titleForState(s),
    (title) => {
      document.title = title;
    },
    { fireImmediately: true },
  );

  // Initial route
  const link = parseDeepLink(location.pathname);
  if (link) void openDeepLink(link, opts);
  else if (location.pathname !== '/' && location.pathname !== '/index.html') {
    history.replaceState(null, '', withSearch('/'));
    useStore.getState().toast(NOT_FOUND, 'error');
  }

  return () => {
    window.removeEventListener('popstate', onPop);
    unsub();
    unsubTitle();
    document.title = DEFAULT_TITLE;
  };
}
