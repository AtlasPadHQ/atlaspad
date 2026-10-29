/**
 * Server-side Google Places API (New) lookups with GOOGLE_SERVER_KEY (never sent to clients). Used for launch
 * eligibility (OPERATIONAL business, not a road/city/plus code), the claim phone number, the listing's website host
 * and the ≤ 30-day coordinate refresh (Google ToS: only place ids and coordinates are stored).
 *
 * DEVNET ONLY: synthetic `cornershop-test:*` places (DEV_TEST_PLACE_RE) are launchable without Google, category
 * 'other', with a deterministic location near 51.5469, -0.0712; compiled out of mainnet (__CS_DEV_ENDPOINTS__).
 */
import { categoryFromGoogle } from './categories';
import { alert, cap, DAY, type Ctx, type Deps } from './ctx';
import type { Env } from './env';
import { placeRegion, type PlaceRegion } from './geo';
import { ApiErr } from './http';
import { DEV_TEST_PLACE_RE, launchIneligibility, type CategoryKey, type LaunchIneligibleReason } from './wire';

export const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;
const GOOGLE_TIMEOUT_MS = 8_000;

export interface PlaceLookup {
  /** Canonical id Google returned (key the coin on it). */
  id: string;
  businessStatus: string | null;
  primaryType: string | null;
  types: string[];
  location: { lat: number; lng: number } | null;
  /** Country / ISO 3166-2 region from addressComponents (the geo-block, worker/geo.ts). */
  region: PlaceRegion;
}

export interface Eligibility {
  placeId: string;
  reason: 'ok' | LaunchIneligibleReason;
  category: CategoryKey | null;
  location: { lat: number; lng: number } | null;
  /** null when Google did not answer for the place (not_found / unsupported). */
  region: PlaceRegion | null;
}

const eligCache = new Map<string, { at: number; v: Eligibility }>();
const ELIG_TTL_MS = 10 * 60_000;

/**
 * Paid Places lookups per day for ALL visitors together (launch eligibility, launch prepare, the listing lookups and
 * the claim contact lookups): the per-IP caps bound one client, this bounds the bill. Fails closed. Answers from a
 * cache never spend it.
 */
export const GOOGLE_LOOKUPS_PER_DAY = 3_000;
export const GOOGLE_BUSY_MESSAGE = 'Lookups are busy today. Try again tomorrow.';

/** Takes one lookup from the global daily budget, or throws `rate_limited` (and alerts the owner, at most hourly). */
export async function spendGoogleLookup(ctx: Pick<Ctx, 'db' | 'env' | 'deps' | 'log' | 'cluster' | 'waitUntil'>): Promise<void> {
  try {
    await cap(ctx.db, 'google:global', GOOGLE_LOOKUPS_PER_DAY, DAY, ctx.deps.now(), 'rate_limited', GOOGLE_BUSY_MESSAGE);
  } catch (e) {
    if (e instanceof ApiErr && e.code === 'rate_limited') {
      ctx.waitUntil(alert(ctx, 'warn', 'google_budget', `The daily budget of ${GOOGLE_LOOKUPS_PER_DAY} Google lookups is used up; launches, eligibility checks, listing lookups and claim lookups refuse until midnight UTC`));
    }
    throw e;
  }
}

/** True for a devnet synthetic test place in a build that has dev endpoints. */
export function isDevTestPlace(placeId: string, cluster: string): boolean {
  if (cluster !== 'devnet') return false;
  if (__CS_DEV_ENDPOINTS__) return DEV_TEST_PLACE_RE.test(placeId);
  return false;
}

/** Valid place id for this cluster: a Google id, or (devnet builds only) a synthetic test place. */
export function validPlaceId(placeId: unknown, cluster: string): placeId is string {
  if (typeof placeId !== 'string') return false;
  if (PLACE_ID_RE.test(placeId)) return true;
  return isDevTestPlace(placeId, cluster);
}

/** Devnet test places sit in London (devTestLocation). */
export const DEV_TEST_REGION: PlaceRegion = { country: 'GB', regions: [] };

/** Deterministic devnet test location (stable per id, within ~1 km of 51.5469, -0.0712). */
export function devTestLocation(placeId: string): { lat: number; lng: number } {
  let h = 2166136261;
  for (let i = 0; i < placeId.length; i++) h = Math.imul(h ^ placeId.charCodeAt(i), 16777619) >>> 0;
  const dx = ((h & 0xffff) / 0xffff - 0.5) * 0.02;
  const dy = (((h >>> 16) & 0xffff) / 0xffff - 0.5) * 0.012;
  return { lat: Math.round((51.5469 + dy) * 1e6) / 1e6, lng: Math.round((-0.0712 + dx) * 1e6) / 1e6 };
}

async function placesGet(env: Env, deps: Deps, placeId: string, fieldMask: string): Promise<Record<string, unknown> | 'not_found'> {
  const key = env.GOOGLE_SERVER_KEY?.trim();
  if (!key) throw new ApiErr('not_configured', 'Place lookup is not configured');
  let res: Response;
  try {
    res = await deps.fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fieldMask },
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch {
    throw new ApiErr('upstream', 'Google lookup failed. Try again.');
  }
  if (res.status === 404 || res.status === 400) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return 'not_found';
  }
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new ApiErr('upstream', 'Google lookup failed. Try again.');
  }
  return (await res.json()) as Record<string, unknown>;
}

function cleanId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const id = v.replace(/^places\//, '');
  return PLACE_ID_RE.test(id) ? id : null;
}

function loc(v: unknown): { lat: number; lng: number } | null {
  const l = v as { latitude?: unknown; longitude?: unknown } | undefined;
  if (!l || typeof l.latitude !== 'number' || typeof l.longitude !== 'number') return null;
  if (!Number.isFinite(l.latitude) || !Number.isFinite(l.longitude)) return null;
  return { lat: l.latitude, lng: l.longitude };
}

/**
 * Places (New): id, businessStatus, primaryType, types, location, addressComponents. addressComponents is an Essentials
 * field, so it adds nothing to the Pro price this call already pays for businessStatus / primaryType.
 */
export async function lookupPlace(env: Env, deps: Deps, placeId: string): Promise<PlaceLookup | null> {
  const j = await placesGet(env, deps, placeId, 'id,businessStatus,primaryType,types,location,addressComponents');
  if (j === 'not_found') return null;
  return {
    id: cleanId(j.id) ?? placeId,
    businessStatus: typeof j.businessStatus === 'string' ? j.businessStatus : null,
    primaryType: typeof j.primaryType === 'string' ? j.primaryType : null,
    types: Array.isArray(j.types) ? j.types.filter((t): t is string => typeof t === 'string').slice(0, 50) : [],
    location: loc(j.location),
    region: placeRegion(j.addressComponents),
  };
}

/**
 * Launch eligibility for a place (cached 10 min in memory only; never persisted). `reason: 'taken'` is decided by the
 * caller (registry / chain), not here. `beforeLookup` runs only when Google is really called (the global budget).
 */
export async function eligibility(env: Env, deps: Deps, cluster: string, placeId: string, beforeLookup?: () => Promise<void>): Promise<Eligibility> {
  if (isDevTestPlace(placeId, cluster)) return { placeId, reason: 'ok', category: 'other', location: devTestLocation(placeId), region: DEV_TEST_REGION };
  if (!PLACE_ID_RE.test(placeId)) return { placeId, reason: 'unsupported_place', category: null, location: null, region: null };
  const now = deps.now();
  const hit = eligCache.get(placeId);
  if (hit && now - hit.at < ELIG_TTL_MS) return hit.v;
  if (beforeLookup) await beforeLookup();
  const p = await lookupPlace(env, deps, placeId);
  let v: Eligibility;
  if (!p) {
    v = { placeId, reason: 'not_found', category: null, location: null, region: null };
  } else {
    const why = launchIneligibility({ businessStatus: p.businessStatus, primaryType: p.primaryType, types: p.types });
    v = { placeId: p.id, reason: why ?? 'ok', category: why ? null : categoryFromGoogle(p.primaryType, p.types), location: p.location, region: p.region };
  }
  eligCache.set(placeId, { at: now, v });
  if (v.placeId !== placeId) eligCache.set(v.placeId, { at: now, v });
  if (eligCache.size > 2_000) eligCache.delete(eligCache.keys().next().value as string);
  return v;
}

export interface ContactLookup {
  id: string;
  /** E.164 when Google has an international number. Never logged, never stored, never returned. */
  e164: string | null;
  display: string | null;
  websiteUri: string | null;
  businessStatus: string | null;
  /** Country / ISO 3166-2 region from addressComponents (the geo-block, worker/geo.ts). */
  region: PlaceRegion;
}

/**
 * Phone + website from Google (claims), plus addressComponents (an Essentials field: no extra cost). Never cached: every
 * call is billed (Enterprise SKU), so callers cap first and pass `beforeLookup` (the global budget).
 */
export async function lookupContact(env: Env, deps: Deps, placeId: string, beforeLookup?: () => Promise<void>): Promise<ContactLookup | null> {
  if (beforeLookup) await beforeLookup();
  const j = await placesGet(env, deps, placeId, 'id,internationalPhoneNumber,nationalPhoneNumber,websiteUri,businessStatus,addressComponents');
  if (j === 'not_found') return null;
  const intl = typeof j.internationalPhoneNumber === 'string' ? j.internationalPhoneNumber.trim() : '';
  const national = typeof j.nationalPhoneNumber === 'string' ? j.nationalPhoneNumber.trim() : '';
  return {
    id: cleanId(j.id) ?? placeId,
    e164: intl ? toE164(intl) : null,
    display: intl || national || null,
    websiteUri: typeof j.websiteUri === 'string' ? j.websiteUri : null,
    businessStatus: typeof j.businessStatus === 'string' ? j.businessStatus : null,
    region: placeRegion(j.addressComponents),
  };
}

/** "+44 20 7946 0123" → "+442079460123"; null unless it is a plausible E.164 number. */
export function toE164(international: string): string | null {
  const t = international.trim();
  if (!t.startsWith('+')) return null;
  const digits = t.slice(1).replace(/[\s().-]/g, '');
  if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
  return `+${digits}`;
}

/** IDs-only lookup (free SKU): true when Google knows the id. Used by /api/health. */
export async function verifyPlaceIdOnly(env: Env, deps: Deps, placeId: string): Promise<boolean> {
  const j = await placesGet(env, deps, placeId, 'id');
  return j !== 'not_found' && !!cleanId(j.id);
}

/** Location only (coordinate refresh, ≤ 30-day ToS rule). */
export async function lookupLocation(env: Env, deps: Deps, placeId: string): Promise<{ lat: number; lng: number } | null> {
  const j = await placesGet(env, deps, placeId, 'location');
  if (j === 'not_found') return null;
  return loc(j.location);
}

/** Test helper. */
export function __resetGoogleCache(): void {
  eligCache.clear();
}
