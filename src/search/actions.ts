/**
 * Search actions shared by SearchBar, CategoryChips, ResultsList and NearMe. OWNED BY SEARCH.
 * Everything here drives the shared store through its public actions (CONTRACTS.md §4).
 */
import { INITIAL_CAMERA } from '../config';
import { CHIPS } from '../lib/categories';
import { boundsContains, boundsFromPoints, distanceM, padBounds } from '../lib/geo';
import { placeFromCoin } from '../lib/place';
import { isAbortError, searchNearby, searchText } from '../places';
import { coinsInBounds, filterCoins, useStore } from '../store';
import type { Bounds, ChipFilter, Coin, LatLng, Place, SearchBias, Viewport } from '../types';
import { useSearchUi, type PlaceChip } from './searchState';

/* ================================================================== helpers */

/** Location bias for searches: the visible map (CONTRACTS: use store.viewport). */
export function currentBias(): SearchBias | undefined {
  const v = useStore.getState().viewport;
  return v ? { center: v.center, bounds: v.bounds } : undefined;
}

/**
 * Radius for "near the map" searches: the circle inscribed in the visible map (so results land on
 * screen), clamped to 300 m – 3 km. 1 km before the map has reported a viewport.
 */
export function nearbyRadius(v: Viewport | null): number {
  const b = v?.bounds;
  if (!v || !b) return 1_000;
  const c = v.center;
  const w = distanceM({ lat: c.lat, lng: b.west }, { lat: c.lat, lng: b.east });
  const h = distanceM({ lat: b.north, lng: c.lng }, { lat: b.south, lng: c.lng });
  const r = Math.min(w, h) / 2;
  return Math.round(Math.min(3_000, Math.max(300, Number.isFinite(r) ? r : 1_000)));
}

export function isPlaceChip(f: ChipFilter): f is PlaceChip {
  return f !== 'live' && f !== 'fees';
}

export function chipLabel(f: ChipFilter): string {
  return CHIPS.find((c) => c.filter === f)?.label ?? f;
}

/**
 * Coins matching a query by ticker (with or without `$`) or coin name — our data only.
 * Ranked: exact ticker, ticker prefix, name prefix, word prefix, contains; then market cap.
 */
export function matchCoins(coins: readonly Coin[], q: string, limit = 3): Coin[] {
  const s = q.trim().replace(/^\$/, '').toLowerCase();
  if (!s) return [];
  const scored: { c: Coin; score: number }[] = [];
  for (const c of coins) {
    const t = c.ticker.toLowerCase();
    const n = c.name.toLowerCase();
    let score = -1;
    if (t === s) score = 0;
    else if (t.startsWith(s)) score = 1;
    else if (n.startsWith(s)) score = 2;
    else if (n.split(/[\s&'.,-]+/).some((w) => w.startsWith(s))) score = 3;
    else if (s.length >= 3 && (t.includes(s) || n.includes(s))) score = 4;
    if (score >= 0) scored.push({ c, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || b.c.marketCapUsd - a.c.marketCapUsd)
    .slice(0, limit)
    .map((x) => x.c);
}

/** A coin whose ticker is exactly the query (`kebab`, `$KEBAB`). */
export function exactTickerCoin(coins: readonly Coin[], q: string): Coin | undefined {
  const s = q.trim().replace(/^\$/, '').toUpperCase();
  return s ? coins.find((c) => c.ticker === s) : undefined;
}

function dedupe(places: Place[]): Place[] {
  const seen = new Set<string>();
  return places.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

/** Fit the map to results when some of them are off screen. */
function revealPlaces(places: Place[]): void {
  const pts = places.map((p) => p.location).filter((l) => !(l.lat === 0 && l.lng === 0));
  if (pts.length === 0) return;
  const st = useStore.getState();
  const vb = st.viewport?.bounds;
  if (vb && pts.every((p) => boundsContains(vb, p))) return;
  const b = boundsFromPoints(pts);
  if (b) st.fitBounds(padBounds(b, 0.15));
}

/* ================================================================== results runs */

let runSeq = 0;
let runCtrl: AbortController | null = null;

function beginRun(): { seq: number; signal: AbortSignal } {
  runCtrl?.abort();
  runCtrl = new AbortController();
  return { seq: ++runSeq, signal: runCtrl.signal };
}

/** The run is still the latest and the user hasn't left the results panel. */
function stillWanted(seq: number): boolean {
  return seq === runSeq && useStore.getState().panel === 'results';
}

/**
 * Enter / search button / search links: results list for a text query — matching coins first
 * (our data), then Google (or Photon) places biased to the visible map. Fits the map when results
 * are off screen. Loading → skeleton; failure → error state with Try again.
 */
export async function runTextSearch(q: string, opts: { near?: SearchBias; origin?: 'text' | 'link' } = {}): Promise<void> {
  const query = q.trim();
  if (!query) return;
  const { seq, signal } = beginRun();
  const near = opts.near ?? currentBias();
  useSearchUi.getState().setOrigin({ kind: opts.origin ?? 'text', query, ...(near ? { near } : {}) });
  const st = useStore.getState();
  st.setResultsStatus('loading', query);
  const coins = matchCoins(Object.values(st.coins), query, 10).map(placeFromCoin);
  try {
    const places = await searchText(query, near, { signal });
    if (!stillWanted(seq)) return;
    const results = dedupe([...coins, ...places]);
    useStore.getState().showResults(query, results);
    revealPlaces(places.length ? places : coins);
  } catch (err) {
    if (isAbortError(err) || !stillWanted(seq)) return;
    if (coins.length) useStore.getState().showResults(query, coins);
    else useStore.getState().setResultsStatus('error', query);
  }
}

/* ---------------------------------------------------------------- category lists */

/** Where a category list looks: the map centre and the circle inscribed in the visible map. */
function categoryArea(): { center: LatLng; radiusM: number } {
  const v = useStore.getState().viewport;
  return { center: v?.center ?? INITIAL_CAMERA.center, radiusM: nearbyRadius(v) };
}

/** Nearby coins of that category (our data, nearest first) — the head of every category list. */
function nearbyCategoryCoins(filter: PlaceChip, center: LatLng, radiusM: number): Place[] {
  return Object.values(useStore.getState().coins)
    .filter((c) => c.place.category === filter && distanceM(center, c.place.location) <= radiusM * 1.5)
    .sort((a, b) => distanceM(center, a.place.location) - distanceM(center, b.place.location))
    .map(placeFromCoin);
}

const NEARBY_TTL_MS = 2 * 60_000;
const nearbyCache = new Map<string, { at: number; places: Promise<Place[]> }>();

/**
 * The places half of a category list, shared by the dropdown's count ("· 22 places") and the list
 * the row / chip opens, so both show the same shops and a click right after the count costs no
 * second Places request. Cached per (category, ~10 m centre, radius) for 2 minutes; failures are
 * not cached. Runs to completion even if a caller stops waiting (callers check their own signal).
 */
function nearbyPlaces(filter: PlaceChip, center: LatLng, radiusM: number): Promise<Place[]> {
  const key = `${useStore.getState().provider}|${filter}|${center.lat.toFixed(4)},${center.lng.toFixed(4)}|${radiusM}`;
  const t = Date.now();
  const hit = nearbyCache.get(key);
  if (hit && t - hit.at < NEARBY_TTL_MS) return hit.places;
  const places = searchNearby(center, filter, radiusM);
  nearbyCache.set(key, { at: t, places });
  places.catch(() => {
    if (nearbyCache.get(key)?.places === places) nearbyCache.delete(key);
  });
  if (nearbyCache.size > 30) {
    const first = nearbyCache.keys().next().value;
    if (first !== undefined) nearbyCache.delete(first);
  }
  return places;
}

/**
 * How many shops the "<b>Kebab</b> shops near …" row would list right now (the same coins +
 * places the row opens). Null when the search fails or is cancelled.
 */
export async function categoryResultCount(filter: PlaceChip, signal?: AbortSignal): Promise<number | null> {
  const { center, radiusM } = categoryArea();
  try {
    const places = await nearbyPlaces(filter, center, radiusM);
    if (signal?.aborted) return null;
    return dedupe([...nearbyCategoryCoins(filter, center, radiusM), ...places]).length;
  } catch {
    return null;
  }
}

/**
 * Category chip / "Kebab shops near …" row: shops of that category around the map centre —
 * nearby coins of that category first, then Google (or OSM) places, nearest first.
 */
export async function runCategorySearch(filter: PlaceChip): Promise<void> {
  const st = useStore.getState();
  const { center, radiusM } = categoryArea();
  const label = chipLabel(filter);
  const { seq } = beginRun();
  useSearchUi.getState().setOrigin({ kind: 'chip', filter, label, center, radiusM });
  st.setResultsStatus('loading', label);
  const coins = nearbyCategoryCoins(filter, center, radiusM);
  try {
    const places = await nearbyPlaces(filter, center, radiusM);
    if (!stillWanted(seq)) return;
    useStore.getState().showResults(label, dedupe([...coins, ...places]));
  } catch (err) {
    if (isAbortError(err) || !stillWanted(seq)) return;
    if (coins.length) useStore.getState().showResults(label, coins);
    else useStore.getState().setResultsStatus('error', label);
  }
}

/** Results panel "Try again". */
export function retryResults(): void {
  const o = useSearchUi.getState().origin;
  if (!o) return;
  if (o.kind === 'chip') void runCategorySearch(o.filter);
  else void runTextSearch(o.query, { near: o.near, origin: o.kind });
}

/** Close the results list (clear button / results close / chip off). */
export function closeResults(opts: { clearText?: boolean } = {}): void {
  runCtrl?.abort();
  runSeq++;
  const ui = useSearchUi.getState();
  const o = ui.origin;
  ui.setOrigin(null);
  if (opts.clearText !== false && o && o.kind !== 'chip' && ui.text.trim() === o.query) ui.setText('');
  const st = useStore.getState();
  if (st.panel === 'results') st.closePanel();
}

/* ================================================================== chips */

/** Coins that a coin-only filter ('live' / 'fees') would show, and whether any are on screen. */
function revealFilter(filter: 'live' | 'fees'): void {
  const st = useStore.getState();
  const matches = filterCoins(st.coins, filter);
  if (matches.length === 0) {
    st.toast(filter === 'live' ? 'No coins have traded in the last hour.' : 'No shops have fees waiting right now.');
    return;
  }
  const vb: Bounds | null | undefined = st.viewport?.bounds;
  if (vb && coinsInBounds(matches, vb).length > 0) return;
  const b = boundsFromPoints(matches.map((c) => c.place.location));
  if (b) st.fitBounds(padBounds(b, 0.2));
}

/**
 * A chip tap (DESIGN §6.3 / §18.1): toggle the single-select coin filter (pins + "This area"
 * update). Category chips also list nearby shops of that category (Maps-style results with pins)
 * so the chip is useful where there are no coins yet; turning the chip off closes that list.
 * 'Live coins' / 'Fees waiting' only filter (and bring matching coins into view if none are).
 */
export function applyChip(filter: ChipFilter): void {
  const st = useStore.getState();
  const turningOn = st.category !== filter;
  st.toggleCategory(filter);
  const origin = useSearchUi.getState().origin;
  const chipResultsOpen = st.panel === 'results' && origin?.kind === 'chip';
  if (!turningOn) {
    if (chipResultsOpen && origin.filter === filter) closeResults();
    return;
  }
  if (isPlaceChip(filter)) {
    void runCategorySearch(filter);
    return;
  }
  if (chipResultsOpen) closeResults();
  revealFilter(filter);
}

/** Search dropdown "<b>Kebab</b> shops near …" row: chip on (not toggled) + the nearby list. */
export function activateCategoryQuery(filter: PlaceChip): void {
  useStore.getState().setCategory(filter);
  void runCategorySearch(filter);
}

/* ================================================================== near me */

/**
 * Near me (mobile locate FAB; desktop MapControls / hero chip may reuse it): geolocation on an
 * explicit tap only (store.locate: 10 s timeout, user dot, fly to zoom 16, error toasts), then a
 * toast with the coins within 2 km — `Show` fits them on screen. Location is never stored.
 */
export async function nearMe(): Promise<void> {
  const before = useStore.getState();
  if (before.locateStatus === 'locating') return;
  await before.locate();
  const s = useStore.getState();
  if (s.locateStatus !== 'located' || !s.userLocation) return;
  const here = s.userLocation.location;
  const near = Object.values(s.coins).filter((c) => distanceM(here, c.place.location) <= 2_000);
  if (near.length === 0) {
    s.toast('No coins within 2 km yet. Tap any shop on the map to launch one.', 'info', undefined, 'near_me');
    return;
  }
  const n = near.length;
  s.toast(
    `${n} ${n === 1 ? 'coin' : 'coins'} within 2 km`,
    'info',
    {
      label: 'Show',
      run: () => {
        const b = boundsFromPoints([here, ...near.map((c) => c.place.location)]);
        if (b) useStore.getState().fitBounds(padBounds(b, 0.15));
      },
    },
    'near_me',
  );
}
