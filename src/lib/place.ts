/**
 * Place helpers: building Place objects from POI clicks and coins, ToS-safe coin snapshots,
 * id classification and URLs. SHARED (src/lib). Pure.
 */
import { DEV_TEST_PLACE_RE, devTestPhoneFromHash, launchIneligibility, NON_BUSINESS_TYPES, type LaunchIneligibleReason } from '../../worker/wire';
import { links } from '../config';
import { CLUSTER, IS_REAL } from '../mode';
import type { CategoryKey, Coin, CoinPlace, LatLng, Place, PlaceSource } from '../types';
import { categoryEmoji, categoryLabel } from './categories';
import { hashString } from './rand';

/** Google place IDs are URL-safe base64-ish strings ("ChIJ…", "GhIJ…", "EiR…"). */
const GOOGLE_ID_RE = /^[A-Za-z0-9_-]{10,}$/;

export function isGooglePlaceId(id: string): boolean {
  return GOOGLE_ID_RE.test(id) && !id.startsWith('demo-');
}

export function demoPlaceId(slug: string): string {
  return `demo-${slug}`;
}

export function osmPlaceId(osmType: 'node' | 'way' | 'relation', osmId: number): string {
  return `osm:${osmType}/${osmId}`;
}

/** Infer a source from an id (for deep links /p/<id>). */
export function sourceFromId(id: string): PlaceSource {
  if (id.startsWith('demo-')) return 'demo';
  if (id.startsWith('osm:')) return 'osm';
  if (id.startsWith('link:')) return 'link';
  return 'google';
}

/** Only real Google places (and fictional demo shops in the demo) can get a coin. */
export function isLaunchableSource(source: PlaceSource): boolean {
  return source === 'google' || source === 'demo';
}

/**
 * Minimal Place for a Google POI click. We do not fetch Google fields to fill it: the panel
 * renders Google's own <gmp-place-details> for the content (DESIGN §9).
 */
export function googlePlaceStub(id: string, location: LatLng, extras: Partial<Place> = {}): Place {
  const category: CategoryKey = extras.category ?? 'other';
  return {
    id,
    source: 'google',
    name: '',
    category,
    categoryLabel: categoryLabel(category),
    emoji: categoryEmoji(category),
    location,
    mapsUrl: links.googleMapsPlace(id),
    ...extras,
  };
}

/** Place for opening a coin from lists / feed / search (uses only our data). */
export function placeFromCoin(coin: Coin): Place {
  const p = coin.place;
  return {
    id: p.id,
    source: p.source,
    name: coin.name,
    category: p.category,
    categoryLabel: categoryLabel(p.category),
    emoji: p.emoji,
    city: p.city,
    location: p.location,
    mapsUrl: p.source === 'google' ? links.googleMapsPlace(p.id) : undefined,
    demo: p.demo,
  };
}

/**
 * ToS-safe snapshot stored with a coin: id, source, location, launcher-picked category, emoji.
 * Never copies Google's name/address/photos. `demo` info is kept only for fictional shops.
 */
export function coinPlaceFrom(place: Place, category: CategoryKey, emoji: string): CoinPlace {
  return {
    id: place.id,
    source: place.source,
    location: { lat: place.location.lat, lng: place.location.lng },
    category,
    emoji,
    ...(place.source === 'demo' && place.demo ? { demo: place.demo } : {}),
  };
}

/** "Open in Maps" URL for a place, or null for fictional demo shops. */
export function mapsUrlFor(place: Pick<Place, 'id' | 'source' | 'mapsUrl' | 'location' | 'osm'>): string | null {
  switch (place.source) {
    case 'google':
      return links.googleMapsPlace(place.id);
    case 'osm':
      return place.osm ? `https://www.openstreetmap.org/${place.osm.osmType}/${place.osm.osmId}` : links.googleMapsLatLng(place.location);
    case 'link':
      return place.mapsUrl ?? null;
    case 'demo':
    default:
      return null;
  }
}

/** App path for a place: `/c/<mint>` when it has a coin, else `/p/<placeId>`. */
export function placePath(placeId: string, coin?: Coin | null): string {
  return coin ? `/c/${encodeURIComponent(coin.mint)}` : `/p/${encodeURIComponent(placeId)}`;
}

/** Find a coin by URL id: mint, placeId, or ticker (case-insensitive, e.g. /c/kebab). */
export function findCoinByUrlId(coins: Record<string, Coin>, urlId: string): Coin | null {
  const id = decodeURIComponent(urlId);
  if (coins[id]) return coins[id] ?? null;
  const list = Object.values(coins);
  return (
    list.find((c) => c.mint === id) ??
    list.find((c) => c.ticker.toLowerCase() === id.toLowerCase()) ??
    list.find((c) => c.placeId === `demo-${id}`) ??
    null
  );
}

/* ------------------------------------------------------------------ launchability (Phase-1 minor #4) */

/**
 * Why a place can't get a coin, judged from what this session already knows about it (search /
 * link / POI data), or null when nothing known rules it out. Plus codes, cities, roads, regions and
 * other non-business types are never launchable; a known non-OPERATIONAL status is "closed".
 * Unknown facts are NOT a reason (POI clicks without types still go through the full check —
 * the server in real mode, `launchIneligibility` on fetched facts in the demo).
 */
export function knownIneligibility(place: Pick<Place, 'source' | 'primaryType' | 'types' | 'businessStatus'>): LaunchIneligibleReason | null {
  if (place.source !== 'google') return null;
  const types = place.types ?? [];
  if (place.primaryType && NON_BUSINESS_TYPES.includes(place.primaryType)) return 'not_business';
  if (!place.primaryType && types.some((t) => NON_BUSINESS_TYPES.includes(t))) return 'not_business';
  // Google marks plain geographic results with types but no business status
  if (types.length > 0 && !types.includes('establishment') && !types.includes('point_of_interest') && !place.businessStatus) return 'not_business';
  if (place.businessStatus && place.businessStatus !== 'OPERATIONAL') return 'closed';
  return null;
}

/** Full rule on complete facts (all three fields fetched): see worker/wire `launchIneligibility`. */
export function ineligibilityFromFacts(f: { businessStatus?: string | null; primaryType?: string | null; types?: readonly string[] | null }): LaunchIneligibleReason | null {
  return launchIneligibility(f);
}

/* ------------------------------------------------------------------ devnet test places */

/** Devnet-only synthetic place ids for automated E2E (`cornershop-test:cafe-1`). Always false elsewhere. */
export function isDevTestPlaceId(id: string): boolean {
  return IS_REAL && CLUSTER === 'devnet' && DEV_TEST_PLACE_RE.test(id);
}

/**
 * DEVNET synthetic places only: the masked fictitious number the Worker "calls" for this place — the same derivation as
 * worker/claims.ts `devTestPhone` (worker/wire.ts devTestPhoneFromHash), so the claim modal's Verify step shows the
 * number its Code step reports.
 */
export async function devTestPhoneMasked(placeId: string): Promise<string> {
  return devTestPhoneFromHash(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(placeId)))).masked;
}

/** A devnet test place (no Google data; deterministic spot near Dalston). Null outside devnet. */
export function devTestPlace(id: string): Place | null {
  if (!isDevTestPlaceId(id)) return null;
  const h = hashString(id);
  const location = { lat: 51.5469 + ((h % 1000) - 500) / 100_000, lng: -0.0712 + ((Math.floor(h / 1000) % 1000) - 500) / 100_000 };
  return {
    id,
    source: 'google',
    name: `Devnet test place ${id.slice('cornershop-test:'.length)}`,
    category: 'other',
    categoryLabel: categoryLabel('other'),
    emoji: categoryEmoji('other'),
    location,
    businessStatus: 'OPERATIONAL',
  };
}
