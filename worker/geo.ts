/**
 * Geo-blocking (sanctions and local rules). Two checks share one configuration:
 *  - Visitors: `geoBlock()` runs first in worker/index.ts. A visitor whose country or region is blocked gets HTTP 451.
 *  - Businesses: `assertPlaceAllowed()` refuses a launch (launch prepare) or a claim (claim call, website code) for a
 *    place in a blocked country or region, from Google's addressComponents (worker/google.ts).
 *
 * Config (wrangler vars, all optional; nothing here is secret):
 *   GEO_BLOCK          'off' turns every geography rule off (visitors and places). 'on' also gates visitors on the
 *                      demo Worker. Unset: on for the real clusters (devnet, mainnet), off on the demo Worker.
 *   BLOCKED_COUNTRIES  CSV of ISO 3166-1 alpha-2 codes. Unset or blank: DEFAULT_BLOCKED_COUNTRIES. 'none': no country.
 *   BLOCKED_REGIONS    CSV of ISO 3166-2 codes (`UA-43`). Unset or blank: DEFAULT_BLOCKED_REGIONS. 'none': no region.
 * A blank list falls back to the defaults on purpose: a mistyped var must never unblock everything; GEO_BLOCK=off is
 * the one switch that does.
 *
 * Visitors are located by Cloudflare: `request.cf.country` and `request.cf.regionCode` (the subdivision part of ISO
 * 3166-2, "43" for UA-43). An unknown location (no `cf` object in local dev and tests, 'XX', Tor 'T1') is not blocked.
 * A blocked visitor still reaches /api/health and /api/config (uptime monitors, the app's boot), /terms and /privacy,
 * and plain static files (/assets/*, coin metadata and art under /meta/* and /img/* that coins link to on-chain, the
 * favicon). Every other /api/* route answers 451 {error:'region_blocked'}; every other path (the app, the /c/ and /p/
 * share pages) answers the static 451 page below. The API answer is the real gate: wrangler's run_worker_first skips
 * the Worker for /assets/*, so a made-up /assets/ path still gets the app shell through the SPA fallback, and there
 * the first refused API call shows <RegionBlocked/> (src/compliance). Wallet screening (worker/sanctions.ts) is
 * separate and always on.
 */
import { realCluster, type Env } from './env';
import { ApiErr, errorResponse } from './http';

export const DEFAULT_BLOCKED_COUNTRIES: readonly string[] = ['KP', 'IR', 'SY', 'CU', 'RU', 'BY'];
/** Crimea, Sevastopol, Donetsk, Luhansk. */
export const DEFAULT_BLOCKED_REGIONS: readonly string[] = ['UA-43', 'UA-40', 'UA-14', 'UA-09'];

const COUNTRY_RE = /^[A-Z]{2}$/;
const REGION_RE = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;

export interface GeoRules {
  countries: ReadonlySet<string>;
  regions: ReadonlySet<string>;
}

function parseList(raw: string | undefined, defaults: readonly string[], re: RegExp): ReadonlySet<string> {
  const t = raw?.trim() ?? '';
  if (!t) return new Set(defaults);
  if (t.toLowerCase() === 'none') return new Set();
  const out = t
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => re.test(s));
  // a list with no valid entry is a typo, not "block nothing"
  return new Set(out.length ? out : defaults);
}

const rulesCache = new Map<string, GeoRules>();

/** The blocked countries and regions, or null when GEO_BLOCK=off. */
export function geoRules(env: Pick<Env, 'GEO_BLOCK' | 'BLOCKED_COUNTRIES' | 'BLOCKED_REGIONS'>): GeoRules | null {
  if (env.GEO_BLOCK?.trim().toLowerCase() === 'off') return null;
  const key = `${env.BLOCKED_COUNTRIES ?? ''}|${env.BLOCKED_REGIONS ?? ''}`;
  let r = rulesCache.get(key);
  if (!r) {
    r = { countries: parseList(env.BLOCKED_COUNTRIES, DEFAULT_BLOCKED_COUNTRIES, COUNTRY_RE), regions: parseList(env.BLOCKED_REGIONS, DEFAULT_BLOCKED_REGIONS, REGION_RE) };
    if (rulesCache.size > 8) rulesCache.clear();
    rulesCache.set(key, r);
  }
  return r;
}

/** True when the country or any of the ISO 3166-2 region codes is blocked. */
export function isBlocked(rules: GeoRules, country: string | null, regions: readonly string[] = []): boolean {
  if (country && rules.countries.has(country)) return true;
  return regions.some((r) => rules.regions.has(r));
}

/* ================================================================================================= visitors */

export interface VisitorLocation {
  country: string | null;
  /** Full ISO 3166-2 code (`UA-43`), or null. */
  region: string | null;
}

/** Where Cloudflare places the visitor (`request.cf`); nulls when unknown. */
export function visitorLocation(request: Request): VisitorLocation {
  const cf = (request as { cf?: { country?: unknown; regionCode?: unknown } }).cf;
  const c = typeof cf?.country === 'string' ? cf.country.trim().toUpperCase() : '';
  const country = COUNTRY_RE.test(c) ? c : null;
  const rc = typeof cf?.regionCode === 'string' ? cf.regionCode.trim().toUpperCase() : '';
  const full = rc.includes('-') ? rc : country && rc ? `${country}-${rc}` : '';
  return { country, region: REGION_RE.test(full) ? full : null };
}

/** The visitor gate: GEO_BLOCK 'off' → off, 'on' → on, unset → on for the real clusters only. */
export function visitorGateOn(env: Env): boolean {
  const v = env.GEO_BLOCK?.trim().toLowerCase();
  if (v === 'off') return false;
  if (v === 'on') return true;
  return realCluster(env) !== null;
}

/** Paths a blocked visitor still reaches (see the header). */
const OPEN_API = /^\/api\/(health|config)\/?$/;
const OPEN_PATHS = /^\/(?:(?:terms|privacy)(?:\.html)?\/?|favicon\.svg|og\.png|(?:assets|meta|img)\/.*)$/;

export const REGION_BLOCKED_MESSAGE = "AtlasPad isn't available in your region.";

/**
 * The 451 page: static and self-contained (inline CSS, no script, no font or image requests), so it works however
 * little of the site the visitor can reach. Only /terms and /privacy are linked.
 */
export const REGION_BLOCKED_HTML = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Not available in your region — AtlasPad</title>
<style>:root{color-scheme:light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#e8e6e1;color:#1f1f1f;font:400 16px/24px "Roboto Flex",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}main{box-sizing:border-box;max-width:420px;margin:24px 16px;padding:32px 28px;background:#fff;border-radius:24px;box-shadow:0 1px 2px rgba(60,64,67,.3),0 2px 6px 2px rgba(60,64,67,.15);text-align:center}.brand{margin:0;font-weight:800;letter-spacing:.6px;font-stretch:120%;color:#0e7c47}.globe{width:72px;height:72px;margin:20px auto 0;border-radius:50%;background:#eef8f1;border:2.5px dashed #0e7c47;display:grid;place-items:center}h1{margin:16px 0 0;font-size:20px;line-height:28px;font-weight:600}p{margin:8px 0 0;font-size:14px;line-height:20px;color:#5e5e5e}a{color:#0e7c47}footer{margin-top:24px;font-size:13px;line-height:18px;color:#80868b}</style>
</head>
<body>
<main>
<p class="brand">ATLASPAD</p>
<div class="globe" aria-hidden="true"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#0e7c47" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg></div>
<h1>AtlasPad isn't available in your region</h1>
<p>Because of sanctions and local rules, AtlasPad can't be used from where you are. Nothing in your wallet has changed.</p>
<p>If you think this is a mistake, write to <a href="mailto:hello@atlaspad.online">hello@atlaspad.online</a>.</p>
<footer><a href="/terms">Terms</a> · <a href="/privacy">Privacy</a></footer>
</main>
</body>
</html>
`;

const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

/**
 * The Worker's first step: the 451 response for a blocked visitor, or null to carry on. Never throws (a broken
 * config must not take the site down).
 */
export function geoBlock(request: Request, env: Env): Response | null {
  try {
    if (!visitorGateOn(env)) return null;
    const rules = geoRules(env);
    if (!rules) return null;
    const where = visitorLocation(request);
    if (!isBlocked(rules, where.country, where.region ? [where.region] : [])) return null;
    const path = new URL(request.url).pathname;
    if (OPEN_API.test(path) || OPEN_PATHS.test(path)) return null;
    if (path === '/api' || path.startsWith('/api/')) return errorResponse(new ApiErr('region_blocked', REGION_BLOCKED_MESSAGE));
    return new Response(request.method === 'HEAD' ? null : REGION_BLOCKED_HTML, { status: 451, headers: PAGE_HEADERS });
  } catch {
    return null;
  }
}

/* =================================================================================================== places */

/** Where a business is, from Google's addressComponents. `country: null, regions: []` = unknown. */
export interface PlaceRegion {
  country: string | null;
  /** ISO 3166-2 codes this place is in, as far as we can tell (`US-CA`, `UA-14`). */
  regions: string[];
}

interface AddressComponent {
  longText?: unknown;
  shortText?: unknown;
  types?: unknown;
}

/**
 * Google names for the default blocked regions (Places API returns names, not ISO 3166-2 codes), matched on the
 * first-level division only and only for places Google puts in UA, RU or no country (Crimea often has none).
 * English and transliterated spellings plus Ukrainian and Russian, after normalise().
 */
const REGION_ALIASES: readonly { code: string; re: RegExp }[] = [
  { code: 'UA-43', re: /crimea|krym|крым|крим/ },
  { code: 'UA-40', re: /sevastopol|севастопол/ },
  { code: 'UA-14', re: /donetsk|донецк|донецьк/ },
  { code: 'UA-09', re: /luhansk|lugansk|луганск|луганськ/ },
];

function normalise(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’ʼ`]/g, '')
    .toLowerCase();
}

/** Country and region codes from a Places API (New) `addressComponents` array. Never throws. */
export function placeRegion(components: unknown): PlaceRegion {
  const out: PlaceRegion = { country: null, regions: [] };
  if (!Array.isArray(components)) return out;
  const list = components.filter((c): c is AddressComponent => !!c && typeof c === 'object');
  const has = (c: AddressComponent, t: string) => Array.isArray(c.types) && c.types.includes(t);
  const country = list.find((c) => has(c, 'country'));
  const cc = typeof country?.shortText === 'string' ? country.shortText.trim().toUpperCase() : '';
  if (COUNTRY_RE.test(cc)) out.country = cc;
  for (const c of list.filter((x) => has(x, 'administrative_area_level_1'))) {
    const short = typeof c.shortText === 'string' ? c.shortText.trim().toUpperCase() : '';
    if (REGION_RE.test(short)) out.regions.push(short);
    else if (out.country && /^[A-Z0-9]{1,3}$/.test(short)) out.regions.push(`${out.country}-${short}`);
    if (out.country === null || out.country === 'UA' || out.country === 'RU') {
      const names = normalise(`${typeof c.longText === 'string' ? c.longText : ''} ${typeof c.shortText === 'string' ? c.shortText : ''}`);
      for (const a of REGION_ALIASES) if (a.re.test(names) && !out.regions.includes(a.code)) out.regions.push(a.code);
    }
  }
  return out;
}

export const PLACE_BLOCKED_MESSAGE = "AtlasPad isn't available for businesses in this region.";
export const PLACE_UNKNOWN_MESSAGE = "We couldn't confirm which country this business is in, so it can't have a coin.";

/**
 * Refuses a place in a blocked country or region (`place_region_blocked`). An unknown location refuses a launch
 * (we never guess) but lets a claim go ahead: the coin already exists and its fees belong to the shop.
 */
export function assertPlaceAllowed(env: Env, region: PlaceRegion | null | undefined, use: 'launch' | 'claim'): void {
  const rules = geoRules(env);
  if (!rules) return;
  const r = region ?? { country: null, regions: [] };
  if (isBlocked(rules, r.country, r.regions)) throw new ApiErr('place_region_blocked', PLACE_BLOCKED_MESSAGE);
  if (use === 'launch' && r.country === null && r.regions.length === 0) throw new ApiErr('place_region_blocked', PLACE_UNKNOWN_MESSAGE);
}
