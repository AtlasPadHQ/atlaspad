/**
 * Place services. OWNED BY SEARCH.
 *
 * Google mode (store.provider === 'google'): Places API (New) through src/lib/google
 * importLibrary('places') — Place.fetchFields / Place.searchByText / Place.searchNearby /
 * AutocompleteSuggestion.fetchAutocompleteSuggestions with AutocompleteSessionToken. Never the
 * legacy PlacesService / AutocompleteService (they throw on new projects).
 * Demo / fallback mode: Photon (OSM) — https://photon.komoot.io — never Google content on a
 * non-Google map. Fictional demo shops come from src/data/mockCoins.
 *
 * Billing (research/google.md §2): field sets are the minimum each call needs —
 *  - POI clicks need nothing (the panel renders Google's UI Kit element).
 *  - getPlaceDetails / ending an autocomplete session: id, location, types (Essentials).
 *  - result lists: Pro list fields, one request per explicit user action (Enter, chip, link).
 *  - pasted links: + displayName, shortFormattedAddress (Pro) for the link row; that name is then
 *    reused as the launch prefill so getLaunchPrefill doesn't pay again.
 * ToS: everything Google returns here is DISPLAY-ONLY and lives in memory for this page session
 * (the caches below). Nothing is persisted; coins persist place IDs + coordinates only.
 *
 * Contract (CONTRACTS.md, signatures fixed; extra optional params/exports are additive):
 *   getPlaceDetails(id, source): Promise<Place | null>
 *   autocomplete(q, near?): Promise<PlaceSuggestion[]>
 *   searchText(q, near?): Promise<Place[]>
 *   searchNearby(center, category, radiusM?): Promise<Place[]>
 *   placeFromOsmFeature(props, location): Place
 *   placeFromParsedLink(p): Place
 *   getListedPhoneMasked(placeId): Promise<ListingContact>   (server lookup; client never sees the number)
 *   getLaunchPrefill(placeId): Promise<{ displayName: string | null; category: CategoryKey }>
 */
import { DEMO_CLAIM_CODE, PHOTON_URL, links } from '../config';
import { createDemoPlaces, getDemoPlace } from '../lib/demoBridge';
import { categoryEmoji, categoryFromGoogle, categoryFromOsm, categoryLabel } from '../lib/categories';
import { maskPhone } from '../lib/format';
import { distanceM, isLatLng } from '../lib/geo';
import { importLibrary, type GoogleLibraryMap } from '../lib/google';
import { googlePlaceStub, isGooglePlaceId, osmPlaceId, sourceFromId } from '../lib/place';
import { hashString } from '../lib/rand';
import { useStore } from '../store';
import type { ClaimPhoneResponse, ClaimStartResponse, ClaimVerifyResponse } from '../search/apiTypes';
import type {
  Bounds,
  BusinessStatus,
  CategoryKey,
  ChipFilter,
  LatLng,
  ListingContact,
  MatchRange,
  ParsedMapsLink,
  Place,
  PlaceSource,
  PlaceSuggestion,
  SearchBias,
} from '../types';

type PlacesLib = GoogleLibraryMap['places'];
type GPlace = google.maps.places.Place;
type GPrediction = google.maps.places.PlacePrediction;

/* ================================================================== field sets */

/** Essentials: enough to fly to a place and prefill its category. */
const DETAIL_FIELDS = ['id', 'location', 'types'];
/** Essentials: city / street / area picks from autocomplete. */
const AREA_FIELDS = ['location', 'viewport'];
/** Pro: result lists (one request per explicit search). No rating/hours (Enterprise), no photos. */
const LIST_FIELDS = [
  'id',
  'displayName',
  'location',
  'primaryType',
  'primaryTypeDisplayName',
  'shortFormattedAddress',
  'types',
  'businessStatus',
];
/** Pro: pasted links (the link row shows "<name> · <short address>"). */
const LINK_FIELDS = ['id', 'displayName', 'location', 'primaryType', 'primaryTypeDisplayName', 'shortFormattedAddress', 'types'];
/**
 * Pro: launch modal title + category prefill (DESIGN §12.2), only when nothing is cached. Also the
 * launchability facts (businessStatus / primaryType / types: worker/wire launchIneligibility), at no
 * extra cost (same Pro SKU).
 */
const PREFILL_FIELDS = ['displayName', 'primaryType', 'types', 'businessStatus'];

const LANGUAGE = 'en-GB';

/* ================================================================== helpers */

function isGoogleProvider(): boolean {
  return useStore.getState().provider === 'google';
}

let placesPromise: Promise<PlacesLib> | null = null;
function placesLib(): Promise<PlacesLib> {
  placesPromise ??= importLibrary('places').catch((err: unknown) => {
    placesPromise = null; // allow a retry later
    throw err;
  });
  return placesPromise;
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function abortError(): Error {
  try {
    return new DOMException('Aborted', 'AbortError');
  } catch {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    return e;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** True for AbortController cancellations (callers ignore these). */
export function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name} ${err.message}` : String(err);
}

function isNotFound(err: unknown): boolean {
  return /NOT_FOUND|not found|INVALID_ARGUMENT|not valid/i.test(errText(err));
}

function matchRanges(text: string, q: string): MatchRange[] {
  const i = text.toLowerCase().indexOf(q.trim().toLowerCase());
  return i >= 0 && q.trim() ? [{ start: i, end: i + q.trim().length }] : [];
}

function sortByDistance<T extends { location: LatLng }>(list: T[], from: LatLng): T[] {
  return [...list].sort((a, b) => distanceM(from, a.location) - distanceM(from, b.location));
}

/** Square-ish bounds around a circle (for locationRestriction / Photon bbox). */
function circleBounds(center: LatLng, radiusM: number): Bounds {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.max(0.01, Math.cos((center.lat * Math.PI) / 180)));
  return { north: center.lat + dLat, south: center.lat - dLat, east: center.lng + dLng, west: center.lng - dLng };
}

/* ================================================================== in-memory caches (page session only) */

const placeCache = new Map<string, Place>();
const typeLabels = new Map<string, string>();
const prefillCache = new Map<string, { displayName: string | null; category: CategoryKey; facts?: LaunchFacts }>();

function remember(place: Place): Place {
  const prev = placeCache.get(place.id);
  const merged: Place = prev
    ? {
        ...prev,
        ...place,
        name: place.name || prev.name,
        address: place.address ?? prev.address,
        types: place.types ?? prev.types,
        primaryType: place.primaryType ?? prev.primaryType,
      }
    : place;
  placeCache.delete(place.id);
  placeCache.set(place.id, merged);
  if (placeCache.size > 400) {
    const first = placeCache.keys().next().value;
    if (first !== undefined) placeCache.delete(first);
  }
  return merged;
}

/** A place seen in this page session (search result, autocomplete pick, resolved link). Memory only. */
export function cachedPlace(id: string): Place | undefined {
  return placeCache.get(id);
}

/** Store a place in the session cache (e.g. a resolved link) so getPlaceDetails can return it. */
export function rememberPlace(place: Place): Place {
  return remember(place);
}

/** Human type label for list rows: Google's primaryTypeDisplayName when known, else our category label. */
export function placeTypeLabel(place: Pick<Place, 'id' | 'category' | 'categoryLabel'>): string {
  return typeLabels.get(place.id) ?? (place.category === 'other' ? '' : place.categoryLabel);
}

/** "350 m" / "1.2 km". */
export function distanceLabel(m: number): string {
  if (!Number.isFinite(m)) return '';
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(m < 9_950 ? 1 : 0)} km`;
}

/* ================================================================== Google → Place */

function latLngOf(p: GPlace): LatLng | null {
  const l = safe(() => p.location);
  if (!l) return null;
  const v = { lat: l.lat(), lng: l.lng() };
  return isLatLng(v) ? v : null;
}

function fromGoogle(p: GPlace, fallback?: Partial<Place>): Place | null {
  const id = safe(() => p.id);
  if (!id) return null;
  const location = latLngOf(p) ?? fallback?.location;
  if (!location) return null;
  const primaryType = safe(() => p.primaryType) ?? fallback?.primaryType ?? undefined;
  const types = safe(() => p.types) ?? fallback?.types;
  const category = categoryFromGoogle(primaryType, types);
  const label = safe(() => p.primaryTypeDisplayName);
  if (label) typeLabels.set(id, label);
  const status = safe(() => p.businessStatus);
  return remember({
    id,
    source: 'google',
    name: safe(() => p.displayName) || fallback?.name || '',
    category,
    categoryLabel: categoryLabel(category),
    emoji: categoryEmoji(category),
    address: safe(() => p.shortFormattedAddress) || fallback?.address || undefined,
    location,
    mapsUrl: links.googleMapsPlace(id),
    ...(status ? { businessStatus: status as BusinessStatus } : {}),
    ...(primaryType ? { primaryType } : {}),
    ...(types?.length ? { types: [...types] } : {}),
  });
}

async function fetchGoogle(id: string, fields: string[], fallback?: Partial<Place>): Promise<Place | null> {
  const lib = await placesLib();
  const p = new lib.Place({ id });
  await p.fetchFields({ fields });
  return fromGoogle(p, fallback);
}

/* ================================================================== details */

/**
 * Place for an id: demo shops from the seed data; Google ids via one Essentials fetch
 * (id, location, types) keyed on the id Google returns; OSM / link places from this session.
 */
export async function getPlaceDetails(id: string, source: PlaceSource): Promise<Place | null> {
  if (source === 'demo') return getDemoPlace(id, useStore.getState().coins);
  const cached = placeCache.get(id);
  if (source !== 'google') return cached ?? null;
  if (cached) return cached;
  if (!isGoogleProvider() || !isGooglePlaceId(id)) return null;
  try {
    return await fetchGoogle(id, DETAIL_FIELDS);
  } catch (err) {
    if (!isNotFound(err)) console.warn('[places] details failed', errText(err));
    return null;
  }
}

/**
 * Resolve a Google place from the ids/name a Maps link carries (resolveLink.ts). Tries the place
 * id, then the ftid candidate, then a free IDs-only text search by name near the link's location.
 * Returns null when Google has no such place; throws on network failure.
 */
export async function resolveGooglePlace(hint: {
  placeId?: string;
  candidatePlaceId?: string;
  name?: string;
  location?: LatLng;
}): Promise<Place | null> {
  const lib = await placesLib();
  let lastErr: unknown = null;
  for (const id of [hint.placeId, hint.candidatePlaceId]) {
    if (!id || !isGooglePlaceId(id)) continue;
    try {
      const p = new lib.Place({ id });
      await p.fetchFields({ fields: LINK_FIELDS });
      const place = fromGoogle(p);
      if (place) return place;
    } catch (err) {
      lastErr = err;
    }
  }
  if (hint.name) {
    try {
      // Text Search IDs-only SKU (free), then one Pro fetch for the link row.
      const { places } = await lib.Place.searchByText({
        textQuery: hint.name.slice(0, 200),
        fields: ['id'],
        maxResultCount: 1,
        language: LANGUAGE,
        ...(hint.location ? { locationBias: { center: hint.location, radius: 500 } } : {}),
      });
      const id = places[0] ? safe(() => places[0]?.id) : undefined;
      if (id) {
        const p = new lib.Place({ id });
        await p.fetchFields({ fields: LINK_FIELDS });
        const place = fromGoogle(p);
        if (place) return place;
      }
      return null;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr && !isNotFound(lastErr)) throw lastErr;
  return null;
}

/* ================================================================== recent */

const recentMisses = new Set<string>();

/**
 * Display name + short address + location for a Google place in the search box's `Recent` list
 * (DESIGN §6.2) when this page session hasn't seen it yet (cs_recent keeps IDs only, so after a
 * reload the name must be fetched again — display only, never stored). Pro fields (the link-row
 * set), at most once per place per session; the result also serves the launch prefill.
 * Resolves null when Google isn't the map, the id isn't a Google place ID, or the lookup fails.
 */
export async function getRecentPlace(id: string): Promise<Place | null> {
  const cached = placeCache.get(id);
  if (cached?.name) return cached;
  if (!isGoogleProvider() || !isGooglePlaceId(id) || recentMisses.has(id)) return null;
  try {
    const place = await fetchGoogle(id, LINK_FIELDS, cached);
    if (place?.name) return place;
  } catch {
    /* closed / removed place or network: not shown */
  }
  recentMisses.add(id);
  return null;
}

/* ================================================================== autocomplete */

let sessionToken: google.maps.places.AutocompleteSessionToken | null = null;
let sessionStartedAt = 0;
const SESSION_MAX_MS = 3 * 60_000;

function currentToken(lib: PlacesLib): google.maps.places.AutocompleteSessionToken {
  if (!sessionToken || Date.now() - sessionStartedAt > SESSION_MAX_MS) {
    sessionToken = new lib.AutocompleteSessionToken();
    sessionStartedAt = Date.now();
  }
  return sessionToken;
}

/** End the autocomplete billing session (after a pick, or when the dropdown closes unused). Never reuse a token. */
export function resetAutocompleteSession(): void {
  sessionToken = null;
}

function demoSuggestions(q: string): PlaceSuggestion[] {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  const coins = useStore.getState().coins;
  return createDemoPlaces()
    .filter((p) => !coins[p.id] && p.name.toLowerCase().includes(s))
    .map((p) => ({
      kind: 'place' as const,
      id: p.id,
      source: 'demo' as const,
      main: p.name,
      secondary: p.demo?.address ?? p.city,
      matches: matchRanges(p.name, q),
      location: p.location,
    }));
}

function fromPrediction(pred: GPrediction): PlaceSuggestion {
  const main = pred.mainText?.text ?? pred.text.text;
  return {
    kind: 'place',
    id: pred.placeId,
    source: 'google',
    main,
    secondary: pred.secondaryText?.text ?? undefined,
    matches: (pred.mainText?.matches ?? []).map((m) => ({ start: m.startOffset, end: m.endOffset })),
    types: [...pred.types],
    raw: pred,
  };
}

/**
 * Place suggestions for the search dropdown. Google: AutocompleteSuggestion with a session token
 * (rotated after a pick), biased to the visible map. Demo: Photon. Fictional demo shops that match
 * are listed first. `opts.signal` cancels (rejects with an AbortError).
 */
export async function autocomplete(q: string, near?: SearchBias, opts: { signal?: AbortSignal } = {}): Promise<PlaceSuggestion[]> {
  const query = q.trim();
  if (query.length < 2) return [];
  const demo = demoSuggestions(query);
  if (isGoogleProvider()) {
    const lib = await placesLib();
    throwIfAborted(opts.signal);
    const req: google.maps.places.AutocompleteRequest = { input: query.slice(0, 200), sessionToken: currentToken(lib), language: LANGUAGE };
    if (near) {
      req.locationBias = near.bounds ? { ...near.bounds } : { center: near.center, radius: near.radiusM ?? 2000 };
      req.origin = near.center;
    }
    const { suggestions } = await lib.AutocompleteSuggestion.fetchAutocompleteSuggestions(req);
    throwIfAborted(opts.signal);
    const out = suggestions.flatMap((s) => (s.placePrediction ? [fromPrediction(s.placePrediction)] : []));
    return [...demo, ...out].slice(0, 8);
  }
  const center = near?.center ?? useStore.getState().viewport?.center;
  const zoom = useStore.getState().viewport?.zoom;
  const features = await photon(
    'api',
    {
      q: query.slice(0, 200),
      limit: 8,
      lang: 'en',
      ...(center ? { lat: center.lat.toFixed(5), lon: center.lng.toFixed(5) } : {}),
      ...(zoom ? { zoom: Math.round(Math.min(18, Math.max(4, zoom))) } : {}),
    },
    opts.signal,
  );
  const out = features.map((f) => photonSuggestion(f, query)).filter((s): s is PlaceSuggestion => !!s);
  return [...demo, ...out].slice(0, 8);
}

/** Result of picking a place suggestion: open a place, or fly to an area (city, street…). */
export type SuggestionPick = { kind: 'place'; place: Place } | { kind: 'area'; center: LatLng; bounds?: Bounds };

/** True when a suggestion is an area / street rather than a shop (the dropdown flies there). */
export function isAreaSuggestion(s: PlaceSuggestion): boolean {
  if (s.source === 'osm') return !!s.types?.includes('area');
  if (s.source === 'google') return !!s.types && !s.types.includes('establishment') && !s.types.includes('point_of_interest');
  return false;
}

/**
 * Turn a picked suggestion into a place (ends the Google autocomplete session with one Essentials
 * fetchFields — every keystroke request in the session is then billed as part of it).
 */
export async function choosePlaceSuggestion(s: PlaceSuggestion): Promise<SuggestionPick | null> {
  if (s.source === 'demo') {
    const p = getDemoPlace(s.id, useStore.getState().coins);
    return p ? { kind: 'place', place: p } : null;
  }
  if (s.source === 'osm') {
    const raw = s.raw as { props?: Record<string, unknown>; location?: LatLng; bounds?: Bounds } | undefined;
    const location = raw?.location ?? s.location;
    if (!location) return null;
    if (isAreaSuggestion(s)) return { kind: 'area', center: location, ...(raw?.bounds ? { bounds: raw.bounds } : {}) };
    return { kind: 'place', place: placeFromOsmFeature(raw?.props ?? { name: s.main }, location) };
  }
  if (s.source === 'google') {
    const pred = s.raw as GPrediction | undefined;
    if (pred && typeof pred.toPlace === 'function') {
      const p = pred.toPlace(); // carries the session token into this fetch
      const area = isAreaSuggestion(s);
      try {
        await p.fetchFields({ fields: area ? AREA_FIELDS : DETAIL_FIELDS });
      } finally {
        resetAutocompleteSession();
      }
      if (area) {
        const center = latLngOf(p);
        if (!center) return null;
        const vp = safe(() => p.viewport?.toJSON());
        return { kind: 'area', center, ...(vp ? { bounds: vp } : {}) };
      }
      const place = fromGoogle(p, { name: s.main, address: s.secondary });
      if (place) prefillCache.set(place.id, { displayName: s.main || null, category: place.category });
      return place ? { kind: 'place', place } : null;
    }
    const place = await getPlaceDetails(s.id, 'google');
    return place ? { kind: 'place', place } : null;
  }
  return null;
}

/* ================================================================== text / nearby search */

/**
 * Results list for a query (Enter in the search box, search links). Google: one searchByText with
 * Pro list fields biased to the visible map. Demo: Photon. Demo shops that match come first.
 */
export async function searchText(q: string, near?: SearchBias, opts: { signal?: AbortSignal } = {}): Promise<Place[]> {
  const query = q.trim();
  if (!query) return [];
  const demo = demoSuggestions(query)
    .map((s) => getDemoPlace(s.id, useStore.getState().coins))
    .filter((p): p is Place => !!p);
  if (isGoogleProvider()) {
    const lib = await placesLib();
    throwIfAborted(opts.signal);
    const { places } = await lib.Place.searchByText({
      textQuery: query.slice(0, 200),
      fields: LIST_FIELDS,
      maxResultCount: 20,
      language: LANGUAGE,
      ...(near ? { locationBias: near.bounds ? { ...near.bounds } : { center: near.center, radius: near.radiusM ?? 5000 } } : {}),
    });
    throwIfAborted(opts.signal);
    return [...demo, ...places.map((p) => fromGoogle(p)).filter((p): p is Place => !!p)];
  }
  const center = near?.center ?? useStore.getState().viewport?.center;
  const features = await photon(
    'api',
    { q: query.slice(0, 200), limit: 20, lang: 'en', ...(center ? { lat: center.lat.toFixed(5), lon: center.lng.toFixed(5) } : {}) },
    opts.signal,
  );
  const places = features.map(photonPlace).filter((p): p is Place => !!p);
  return [...demo, ...places];
}

interface NearbyTypes {
  /** Types every Places (New) project accepts. */
  core: string[];
  /** Newer Table A types (tried first; dropped if the API rejects them). */
  extra?: string[];
  /** Use a text search instead (cuisines that have no reliable primary type). */
  text?: string;
}

const NEARBY_TYPES: Record<CategoryKey, NearbyTypes> = {
  cafe: { core: ['cafe', 'coffee_shop', 'tea_house'], extra: ['cat_cafe', 'dog_cafe'] },
  barber: { core: ['barber_shop', 'hair_salon'], extra: ['hair_care'] },
  kebab: { core: ['turkish_restaurant', 'middle_eastern_restaurant', 'lebanese_restaurant'], text: 'kebab' },
  pizza: { core: ['pizza_restaurant'], extra: ['pizza_delivery'] },
  bakery: { core: ['bakery', 'bagel_shop', 'donut_shop'], extra: ['pastry_shop', 'cake_shop'] },
  pub: { core: ['pub', 'bar', 'wine_bar'], extra: ['irish_pub', 'sports_bar', 'gastropub', 'brewpub', 'cocktail_bar', 'beer_garden'] },
  corner: { core: ['convenience_store', 'grocery_store', 'liquor_store'] },
  restaurant: { core: ['restaurant', 'meal_takeaway', 'fast_food_restaurant'] },
  other: { core: ['store', 'restaurant', 'cafe', 'bar', 'bakery'] },
};

/** Photon category filters (`include=osm.<key>.<value>`, comma = OR) per category. */
const PHOTON_NEARBY: Record<CategoryKey, { include: string; q?: string }> = {
  cafe: { include: 'osm.amenity.cafe,osm.shop.coffee,osm.shop.tea' },
  barber: { include: 'osm.shop.hairdresser,osm.shop.barber,osm.shop.beauty' },
  kebab: { include: 'osm.amenity.fast_food,osm.amenity.restaurant', q: 'kebab' },
  pizza: { include: 'osm.amenity.fast_food,osm.amenity.restaurant', q: 'pizza' },
  bakery: { include: 'osm.shop.bakery,osm.shop.pastry,osm.shop.confectionery' },
  pub: { include: 'osm.amenity.pub,osm.amenity.bar,osm.amenity.biergarten' },
  corner: { include: 'osm.shop.convenience,osm.shop.newsagent,osm.shop.alcohol,osm.shop.kiosk,osm.shop.greengrocer' },
  restaurant: { include: 'osm.amenity.restaurant,osm.amenity.fast_food' },
  other: { include: 'osm.shop,osm.amenity.cafe,osm.amenity.restaurant' },
};

let extraTypesRejected = false;

/**
 * Shops of a category around a point (category chips, "Kebab shops near …" row). Google: one
 * searchNearby with includedPrimaryTypes ranked by distance (kebab: text search, since kebab shops
 * rarely have a kebab primary type). Demo: Photon category filters. Sorted nearest first.
 * 'live' / 'fees' are coin filters, not place categories → [].
 */
export async function searchNearby(
  center: LatLng,
  category: CategoryKey | ChipFilter,
  radiusM = 1000,
  opts: { signal?: AbortSignal } = {},
): Promise<Place[]> {
  if (category === 'live' || category === 'fees') return [];
  const radius = Math.round(Math.min(50_000, Math.max(100, radiusM)));
  if (isGoogleProvider()) {
    const lib = await placesLib();
    throwIfAborted(opts.signal);
    const spec = NEARBY_TYPES[category];
    let list: GPlace[];
    if (spec.text) {
      ({ places: list } = await lib.Place.searchByText({
        textQuery: spec.text,
        fields: LIST_FIELDS,
        maxResultCount: 20,
        language: LANGUAGE,
        locationRestriction: circleBounds(center, radius),
      }));
    } else {
      const run = (types: string[]) =>
        lib.Place.searchNearby({
          fields: LIST_FIELDS,
          locationRestriction: { center, radius },
          includedPrimaryTypes: types,
          maxResultCount: 20,
          rankPreference: lib.SearchNearbyRankPreference.DISTANCE,
          language: LANGUAGE,
        });
      const full = extraTypesRejected || !spec.extra ? spec.core : [...spec.core, ...spec.extra];
      try {
        ({ places: list } = await run(full));
      } catch (err) {
        if (full === spec.core || !/INVALID_ARGUMENT|invalid|unsupported/i.test(errText(err))) throw err;
        extraTypesRejected = true;
        ({ places: list } = await run(spec.core));
      }
    }
    throwIfAborted(opts.signal);
    return sortByDistance(
      list.map((p) => fromGoogle(p)).filter((p): p is Place => !!p),
      center,
    );
  }
  const spec = PHOTON_NEARBY[category];
  const b = circleBounds(center, radius);
  const features = await photon(
    'api',
    {
      ...(spec.q ? { q: spec.q } : {}),
      include: spec.include,
      lat: center.lat.toFixed(5),
      lon: center.lng.toFixed(5),
      bbox: [b.west, b.south, b.east, b.north].map((n) => n.toFixed(5)).join(','),
      limit: 20,
      lang: 'en',
    },
    opts.signal,
  );
  return sortByDistance(
    features.map(photonPlace).filter((p): p is Place => !!p),
    center,
  );
}

/* ================================================================== Photon (OSM) */

interface PhotonProps {
  osm_type?: string;
  osm_id?: number;
  osm_key?: string;
  osm_value?: string;
  type?: string;
  name?: string;
  housenumber?: string;
  street?: string;
  locality?: string;
  district?: string;
  city?: string;
  postcode?: string;
  state?: string;
  country?: string;
  extent?: number[];
}

interface PhotonFeature {
  geometry?: { coordinates?: number[] };
  properties?: PhotonProps;
}

const POI_KEYS = new Set(['amenity', 'shop', 'craft', 'tourism', 'leisure', 'office', 'healthcare']);

async function photon(
  path: 'api' | 'reverse',
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<PhotonFeature[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const res = await fetch(`${PHOTON_URL}/${path === 'api' ? 'api/' : 'reverse'}?${qs.toString()}`, {
    signal,
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  const j = (await res.json()) as { features?: unknown };
  return Array.isArray(j.features) ? (j.features as PhotonFeature[]) : [];
}

function photonLocation(f: PhotonFeature): LatLng | null {
  const c = f.geometry?.coordinates;
  if (!c || c.length < 2) return null;
  const v = { lat: Number(c[1]), lng: Number(c[0]) };
  return isLatLng(v) ? v : null;
}

function photonBounds(p: PhotonProps): Bounds | undefined {
  const e = p.extent;
  if (!Array.isArray(e) || e.length !== 4 || !e.every((n) => Number.isFinite(n))) return undefined;
  const [lng1, lat1, lng2, lat2] = e as [number, number, number, number];
  return { north: Math.max(lat1, lat2), south: Math.min(lat1, lat2), east: Math.max(lng1, lng2), west: Math.min(lng1, lng2) };
}

function photonIsPoi(p: PhotonProps): boolean {
  return POI_KEYS.has(p.osm_key ?? '');
}

function photonSecondary(p: PhotonProps): string | undefined {
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const parts = [p.name ? street : '', p.district ?? p.locality, p.city ?? p.state, p.city ? undefined : p.country]
    .filter((x): x is string => !!x && x.trim().length > 0);
  const uniq = parts.filter((x, i) => parts.indexOf(x) === i && x !== p.name);
  return uniq.length ? uniq.join(', ') : undefined;
}

function photonSuggestion(f: PhotonFeature, q: string): PlaceSuggestion | null {
  const p = f.properties ?? {};
  const location = photonLocation(f);
  if (!location) return null;
  const main = p.name ?? ([p.housenumber, p.street].filter(Boolean).join(' ') || p.city || '');
  if (!main) return null;
  const poi = photonIsPoi(p);
  const bounds = photonBounds(p);
  return {
    kind: 'place',
    id: osmPlaceId(osmTypeOf(p.osm_type), Number(p.osm_id) || hashString(`${main}${location.lat}${location.lng}`)),
    source: 'osm',
    main,
    secondary: photonSecondary(p),
    matches: matchRanges(main, q),
    types: [p.osm_key ?? '', p.osm_value ?? '', p.type ?? '', poi ? 'poi' : 'area'].filter(Boolean),
    location,
    raw: { props: { ...p }, location, ...(bounds ? { bounds } : {}) },
  };
}

function photonPlace(f: PhotonFeature): Place | null {
  const location = photonLocation(f);
  if (!location) return null;
  const p = f.properties ?? {};
  if (!p.name && !p.street) return null;
  return placeFromOsmFeature({ ...p }, location);
}

function osmTypeOf(t: unknown): 'node' | 'way' | 'relation' {
  return t === 'W' || t === 'way' ? 'way' : t === 'R' || t === 'relation' ? 'relation' : 'node';
}

/** Area name for "Kebab shops near <area>" (Photon reverse; OSM data, cached per ~1 km). */
const areaCache = new Map<string, string | null>();
export async function areaName(center: LatLng, signal?: AbortSignal): Promise<string | null> {
  const key = `${center.lat.toFixed(2)},${center.lng.toFixed(2)}`;
  if (areaCache.has(key)) return areaCache.get(key) ?? null;
  const [f] = await photon('reverse', { lat: center.lat.toFixed(5), lon: center.lng.toFixed(5), limit: 1, lang: 'en' }, signal);
  const p = f?.properties;
  const name = p?.district ?? p?.locality ?? p?.city ?? null;
  areaCache.set(key, name);
  return name;
}

/**
 * Build a Place from an OpenMapTiles `poi` feature (MapLibre fallback map: class/subclass/name)
 * or Photon properties (osm_type/osm_id/osm_key/osm_value/…). Never launchable (source 'osm').
 */
export function placeFromOsmFeature(props: Record<string, unknown>, location: LatLng): Place {
  const str = (k: string) => (typeof props[k] === 'string' && (props[k] as string).trim() ? (props[k] as string).trim() : undefined);
  const name = str('name') ?? str('name:en') ?? str('name_en') ?? str('name:latin') ?? '';
  const cls = str('class') ?? str('osm_key');
  const sub = str('subclass') ?? str('osm_value');
  const category = categoryFromOsm(cls, sub, name);
  const osmId = Number(props.osm_id ?? props.id ?? 0);
  const osmType = osmTypeOf(props.osm_type);
  const street = [str('housenumber'), str('street')].filter(Boolean).join(' ');
  const area = str('district') ?? str('locality');
  const city = str('city');
  const address = [street, area, city].filter((x): x is string => !!x).filter((x, i, a) => a.indexOf(x) === i).join(', ');
  return remember({
    id: osmPlaceId(osmType, Number.isFinite(osmId) && osmId > 0 ? osmId : hashString(`${name}${location.lat}${location.lng}`)),
    source: 'osm',
    name,
    category,
    categoryLabel: categoryLabel(category),
    emoji: categoryEmoji(category),
    address: address || undefined,
    city,
    location,
    osm: { osmType, osmId: Number.isFinite(osmId) ? osmId : 0, key: cls, value: sub },
  });
}

/* ================================================================== links */

/**
 * Place for a parsed link without network calls. With a Google id + coordinates (Google map
 * only) → a Google place stub; otherwise an unresolved 'link' place (never launchable).
 */
export function placeFromParsedLink(p: ParsedMapsLink): Place {
  const gid = p.placeId ?? p.candidatePlaceId;
  if (gid && p.location && isGoogleProvider()) {
    return remember(googlePlaceStub(gid, p.location, p.name ? { name: p.name } : {}));
  }
  const category: CategoryKey = 'other';
  return remember({
    id: `link:${hashString(p.url).toString(36)}`,
    source: 'link',
    name: p.name ?? p.query ?? '',
    category,
    categoryLabel: categoryLabel(category),
    emoji: categoryEmoji(category),
    location: p.location ?? { lat: 0, lng: 0 },
    mapsUrl: p.url,
  });
}

/* ================================================================== owner claim (server lookups) */

/** Kept for existing imports: the shared ListingContact now carries `error` and `operational`. */
export type ListingContactResult = ListingContact;

async function apiJson<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; error?: string }> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
      signal: init?.signal ?? AbortSignal.timeout(12_000),
    });
    const ct = res.headers.get('content-type') ?? '';
    // Without the Worker (plain `vite`), /api/* may fall through to index.html.
    if (!ct.includes('application/json')) return { ok: false, status: 503 };
    const body = (await res.json()) as T & { error?: string };
    return res.ok ? { ok: true, data: body } : { ok: false, status: res.status, error: body.error };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * Masked listing phone for the claim modal. The Worker looks the number up on Google with the
 * server key and only returns `+44 20 •••• ••23`; the client never sends or sees a number.
 * Fictional demo shops are masked locally from their `020 7946 0xxx` drama-range numbers.
 * Never rejects: failures come back as `{ masked: null, error }`.
 */
export async function getListedPhoneMasked(placeId: string): Promise<ListingContactResult> {
  const source = sourceFromId(placeId);
  if (source === 'demo') {
    const demo = getDemoPlace(placeId, useStore.getState().coins)?.demo;
    return demo?.phone
      ? { masked: maskPhone(demo.phone), websiteHost: demo.website || null, blocked: null, operational: true }
      : { masked: null, websiteHost: demo?.website ?? null, blocked: 'no-phone' };
  }
  if (source !== 'google' || !isGooglePlaceId(placeId)) return { masked: null, websiteHost: null, blocked: 'no-phone' };
  const r = await apiJson<ClaimPhoneResponse>(`/api/claim/phone?placeId=${encodeURIComponent(placeId)}`);
  if (r.ok) {
    return { masked: r.data.masked, websiteHost: r.data.websiteHost, blocked: r.data.blocked, operational: r.data.operational };
  }
  if (r.status === 429) return { masked: null, websiteHost: null, blocked: null, error: 'rate-limited' };
  if (r.status === 404) return { masked: null, websiteHost: null, blocked: 'no-phone', error: 'not-found' };
  return { masked: null, websiteHost: null, blocked: null, error: 'unavailable' };
}

/**
 * Start the (simulated) verification call. Uses the Worker when reachable; otherwise simulates
 * locally. `claim-active` = someone else is verifying this place (DESIGN §12.3 blocking case).
 */
export async function requestClaimCall(
  placeId: string,
): Promise<{ ok: true; simulated: true; expiresInSec: number; resendAfterSec: number } | { ok: false; reason: 'claim-active' | 'rate-limited'; retryAfterSec?: number }> {
  if (sourceFromId(placeId) === 'google' && isGooglePlaceId(placeId)) {
    const r = await apiJson<ClaimStartResponse & { retryAfterSec?: number }>('/api/claim/start', {
      method: 'POST',
      body: JSON.stringify({ placeId }),
    });
    if (r.ok) return { ok: true, simulated: true, expiresInSec: r.data.expiresInSec, resendAfterSec: r.data.resendAfterSec };
    if (r.status === 409) return { ok: false, reason: 'claim-active' };
    if (r.status === 429) return { ok: false, reason: 'rate-limited' };
  }
  return { ok: true, simulated: true, expiresInSec: 600, resendAfterSec: 45 };
}

/** Check a 6-digit code (demo accepts 482913). Uses the Worker when reachable, else local simulation. */
export async function checkClaimCode(
  placeId: string,
  code: string,
): Promise<{ approved: boolean; attemptsLeft?: number; error?: 'too-many-attempts' | 'rate-limited' }> {
  const digits = code.replace(/\D/g, '');
  if (sourceFromId(placeId) === 'google' && isGooglePlaceId(placeId)) {
    const r = await apiJson<ClaimVerifyResponse>('/api/claim/verify', { method: 'POST', body: JSON.stringify({ placeId, code: digits }) });
    if (r.ok) return { approved: r.data.approved, attemptsLeft: r.data.attemptsLeft };
    if (r.status === 429) return { approved: false, error: r.error === 'too_many_attempts' ? 'too-many-attempts' : 'rate-limited' };
  }
  return { approved: digits === DEMO_CLAIM_CODE };
}

/* ================================================================== launch prefill */

/**
 * Launch modal title + prefill (DESIGN §12.2): Google's displayName (display/prefill only — the
 * coin stores what the launcher types) and a category from the place's types. Uses what this
 * session already knows (search pick / pasted link) before paying for one Pro fetchFields.
 */
/** Google facts behind the launch rule (all three fetched together; see worker/wire launchIneligibility). */
export interface LaunchFacts {
  businessStatus: string | null;
  primaryType: string | null;
  types: string[];
}

export async function getLaunchPrefill(placeId: string): Promise<{ displayName: string | null; category: CategoryKey; facts?: LaunchFacts }> {
  const source = sourceFromId(placeId);
  if (source === 'demo') {
    const p = getDemoPlace(placeId, useStore.getState().coins);
    return { displayName: p?.name ?? null, category: p?.category ?? 'other' };
  }
  const known = prefillCache.get(placeId);
  if (known) return known;
  const cached = placeCache.get(placeId);
  if (cached?.name) return { displayName: cached.name, category: cached.category };
  if (source !== 'google' || !isGoogleProvider() || !isGooglePlaceId(placeId)) {
    return { displayName: cached?.name || null, category: cached?.category ?? 'other' };
  }
  try {
    const lib = await placesLib();
    const p = new lib.Place({ id: placeId });
    await p.fetchFields({ fields: PREFILL_FIELDS });
    const out = {
      displayName: safe(() => p.displayName) || null,
      category: categoryFromGoogle(safe(() => p.primaryType), safe(() => p.types)),
      facts: {
        businessStatus: (safe(() => p.businessStatus) as string | null | undefined) ?? null,
        primaryType: safe(() => p.primaryType) ?? null,
        types: [...(safe(() => p.types) ?? [])],
      },
    };
    prefillCache.set(placeId, out);
    return out;
  } catch (err) {
    console.warn('[places] prefill failed', errText(err));
    return { displayName: null, category: cached?.category ?? 'other' };
  }
}
