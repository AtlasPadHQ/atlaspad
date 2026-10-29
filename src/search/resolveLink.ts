/**
 * Resolve a pasted Google Maps link to a place. OWNED BY SEARCH.
 *
 *   1. Parse locally (parseMapsLink): direct place ids, ftid → ChIJ candidates, coordinates, names.
 *   2. Short links (maps.app.goo.gl, goo.gl/maps, g.page) → GET /api/resolve (the Worker: free
 *      resolveMapsUrls with the server key, then SSRF-safe manual redirects).
 *   3. Google map: Place.fetchFields on the id (then the candidate, then a free IDs-only text
 *      search by name) — always keyed on the place.id Google RETURNS, never on the parsed id.
 *      Fallback map (no Google): the link's own coordinates / name (+ Photon) — no Google content.
 *
 * Contract: resolveMapsLink(input: string | ParsedMapsLink): Promise<ResolvedLink>
 * Extra: openResolvedLink(result, { launch }) performs the store actions for a result (search bar
 * link row, hero "try now").
 */
import { FOCUS_ZOOM } from '../config';
import { isLaunchableSource, placeFromCoin } from '../lib/place';
import { placeFromParsedLink, rememberPlace, resolveGooglePlace, searchText } from '../places';
import { useStore } from '../store';
import type { ParsedMapsLink, ResolvedLink, SearchBias } from '../types';
import { runTextSearch } from './actions';
import type { ApiError, ResolveApiResponse } from './apiTypes';
import { parseMapsLink, type ParsedLink } from './parseMapsLink';

// parseMapsLink's self-contained type must stay identical to the shared ParsedMapsLink.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const PARSED_LINK_TYPES_MATCH: Same<ParsedLink, ParsedMapsLink> = true;

type ResolveError = Extract<ResolvedLink, { status: 'error' }>['error'];

const err = (error: ResolveError): ResolvedLink => ({ status: 'error', error });

function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => !!s);
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (anyFn) return anyFn(list);
  const ctrl = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

/** GET /api/resolve. Network trouble (no Worker in plain `vite`, offline…) → { error: 'network' }. */
async function callResolveApi(
  url: string,
  follow: boolean,
  signal?: AbortSignal,
): Promise<ResolveApiResponse | { error: ResolveError }> {
  try {
    const res = await fetch(`/api/resolve?url=${encodeURIComponent(url)}${follow ? '&follow=1' : ''}`, {
      headers: { accept: 'application/json' },
      signal: anySignal([signal, AbortSignal.timeout(15_000)]),
    });
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) return { error: 'network' };
    const body = (await res.json()) as ResolveApiResponse | ApiError;
    if (res.ok && 'kind' in body) return body;
    const code = 'error' in body ? body.error : undefined;
    if (code === 'directions') return { error: 'directions' };
    if (code === 'unsupported' || code === 'not_a_maps_link') return { error: code === 'unsupported' ? 'unsupported' : 'not-a-link' };
    if (code === 'not_found') return { error: 'not-found' };
    return { error: 'network' };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { error: 'network' };
  }
}

function viewportBias(): SearchBias | undefined {
  const v = useStore.getState().viewport;
  return v ? { center: v.center, bounds: v.bounds } : undefined;
}

/** Merge what the Worker found into the parsed link (Worker values win). */
function merge(p: ParsedMapsLink, r: ResolveApiResponse): ParsedMapsLink {
  const fromFinal = r.finalUrl ? parseMapsLink(r.finalUrl) : null;
  const base: ParsedMapsLink = fromFinal && fromFinal.kind !== 'unsupported' && fromFinal.kind !== 'short' ? fromFinal : p;
  return {
    ...base,
    url: p.url,
    kind: r.kind === 'short' || r.kind === 'unsupported' ? base.kind : r.kind,
    ...(r.placeId ? { placeId: r.placeId } : {}),
    ...(r.candidatePlaceId && !r.placeId ? { candidatePlaceId: r.candidatePlaceId } : {}),
    ...(r.name ? { name: r.name } : {}),
    ...(r.query ? { query: r.query } : {}),
    ...(r.location ? { location: r.location } : {}),
    ...(r.zoom != null ? { zoom: r.zoom } : {}),
    ...(r.cid ? { cid: r.cid } : {}),
  };
}

/**
 * Resolve a pasted link (or an already parsed one). Never throws except for an abort via
 * `opts.signal`. Errors: 'not-a-link' | 'directions' | 'unsupported' | 'not-found' | 'network'.
 */
export async function resolveMapsLink(input: string | ParsedMapsLink, opts: { signal?: AbortSignal } = {}): Promise<ResolvedLink> {
  let p: ParsedMapsLink | null = typeof input === 'string' ? parseMapsLink(input) : input;
  if (!p) return err('not-a-link');
  if (p.kind === 'directions') return err('directions');
  if (p.kind === 'unsupported') return err('unsupported');
  const google = useStore.getState().provider === 'google';

  if (p.kind === 'short') {
    // Fallback map needs coordinates/name from the expanded URL, so ask the Worker to follow.
    const r = await callResolveApi(p.url, !google, opts.signal);
    if ('error' in r) return err(r.error);
    p = merge(p, r);
    if (p.kind === 'short' || p.kind === 'unsupported') return err('unsupported');
    if (p.kind === 'directions') return err('directions');
  }

  if (p.kind === 'search') {
    const query = (p.query ?? p.name ?? '').trim();
    if (!query) return p.location ? { status: 'coords', location: p.location, ...(p.zoom ? { zoom: p.zoom } : {}) } : err('not-found');
    return { status: 'search', query, ...(p.location ? { location: p.location } : {}) };
  }
  if (p.kind === 'coords') {
    return p.location ? { status: 'coords', location: p.location, ...(p.zoom ? { zoom: p.zoom } : {}) } : err('not-found');
  }

  // kind === 'place'
  if (google) {
    try {
      const place = await resolveGooglePlace({
        placeId: p.placeId,
        candidatePlaceId: p.candidatePlaceId,
        name: p.name,
        location: p.location,
      });
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (place) return { status: 'place', place };
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      // Google unreachable: still take the user to the spot if the link says where it is.
      if (p.location) return { status: 'coords', location: p.location, zoom: p.zoom ?? FOCUS_ZOOM };
      return err('network');
    }
    if (p.location) return { status: 'coords', location: p.location, zoom: p.zoom ?? FOCUS_ZOOM };
    return err('not-found');
  }

  // Fallback (OpenStreetMap) map: never Google content — use what the link itself says.
  if (p.location) return { status: 'place', place: placeFromParsedLink(p) };
  const name = p.name ?? p.query;
  if (name) {
    try {
      const [hit] = await searchText(name, viewportBias(), opts);
      if (hit) return { status: 'place', place: rememberPlace({ ...placeFromParsedLink({ ...p, location: hit.location }), name }) };
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      return err('network');
    }
  }
  return err('not-found');
}

/** Copy for the hero's inline error and other callers (DESIGN §11, §16.1). */
export function resolveErrorMessage(error: ResolveError): string {
  return error === 'not-a-link' || error === 'unsupported' || error === 'directions'
    ? "That doesn't look like a Google Maps link."
    : "Couldn't find that place. Copy the link from Share in Google Maps.";
}

/**
 * Do what a resolved link means (DESIGN §18.1 link row / §18.3 hero "try now"):
 *  - place → fly + open its panel; `launch` also opens the launch modal when it is launchable and
 *    has no coin; a place that already has a coin opens the coin.
 *  - search → results list for the query (biased to the link's location).
 *  - coords → fly there + toast asking to tap a shop.
 * Returns false for errors (the caller shows its own error state).
 */
export function openResolvedLink(result: ResolvedLink, opts: { launch?: boolean; onSearch?: (query: string, near?: SearchBias) => void } = {}): boolean {
  const st = useStore.getState();
  switch (result.status) {
    case 'place': {
      const coin = st.coins[result.place.id];
      if (coin) st.openPlace(placeFromCoin(coin), { fly: true, from: null });
      else st.openPlace(result.place, { fly: true, from: null, launch: !!opts.launch && isLaunchableSource(result.place.source) });
      return true;
    }
    case 'search': {
      const near: SearchBias | undefined = result.location ? { center: result.location, radiusM: 3000 } : undefined;
      if (opts.onSearch) opts.onSearch(result.query, near);
      else void runTextSearch(result.query, { near, origin: 'link' });
      return true;
    }
    case 'coords':
      st.flyTo(result.location, result.zoom ?? FOCUS_ZOOM);
      st.toast('Tap any shop on the map to launch one');
      return true;
    default:
      return false;
  }
}
