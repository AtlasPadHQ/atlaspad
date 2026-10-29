/**
 * Wire types for the CORNERSHOP Worker API (worker/api.ts) — shared by the client
 * (src/search/resolveLink.ts, src/places) and the Worker. OWNED BY SEARCH. Types only.
 */
import type { LinkLatLng as LatLng, ParsedLink as ParsedMapsLink } from './parseMapsLink';

/** GET /api/resolve?url=<maps link>[&follow=1] → 200 */
export interface ResolveApiResponse {
  /** What the (final) link points at. */
  kind: ParsedMapsLink['kind'];
  /** Google place ID. `verified` says whether Google confirmed it (server key present). */
  placeId?: string;
  verified?: boolean;
  /** ftid-derived `ChIJ…` candidate that could not be verified server-side. */
  candidatePlaceId?: string;
  /** Last URL reached after unwrapping consent / following redirects (allowlisted hosts only). */
  finalUrl?: string;
  /** Name / search text from the link itself (display only). */
  name?: string;
  query?: string;
  location?: LatLng;
  zoom?: number;
  cid?: string;
  /** How the answer was found. */
  via: 'resolveMapsUrls' | 'redirects' | 'parse' | 'places';
}

/** Error body for every non-2xx /api response. */
export interface ApiError {
  error:
    | 'bad_request'
    | 'not_a_maps_link'
    | 'directions'
    | 'unsupported'
    | 'not_found'
    | 'upstream'
    | 'unavailable'
    | 'rate_limited'
    | 'claim_active'
    | 'too_many_attempts'
    | 'method_not_allowed';
  message?: string;
  retryAfterSec?: number;
}

/** GET /api/claim/phone?placeId=… → 200. Never contains the raw number. */
export interface ClaimPhoneResponse {
  /** Canonical place ID as returned by Google. */
  placeId: string;
  hasPhone: boolean;
  /** e.g. "+44 20 •••• ••23" */
  masked: string | null;
  websiteHost: string | null;
  blocked: 'no-phone' | 'premium' | null;
  /** businessStatus === 'OPERATIONAL' (null when Google did not say). */
  operational: boolean | null;
}

/** POST /api/claim/start {placeId} → 200 (prototype: simulated). */
export interface ClaimStartResponse {
  simulated: boolean;
  status: 'pending';
  channel: 'call';
  codeLength: 6;
  expiresInSec: number;
  resendAfterSec: number;
}

/** POST /api/claim/verify {placeId, code} → 200 (prototype: simulated). */
export interface ClaimVerifyResponse {
  simulated: boolean;
  approved: boolean;
  attemptsLeft: number;
}
