/**
 * CORNERSHOP Phase-1 Worker API (`/api/*`). BACKEND owns worker/** since Phase 2. Mounted by worker/index.ts after
 * the Phase-2 router (worker/router.ts), so these routes behave exactly as before on every Worker.
 *
 * Routes
 *   GET  /api/health                     → { ok, google }
 *   GET  /api/resolve?url=…[&follow=1]   → ResolveApiResponse (Google Maps link → place ID)
 *   GET  /api/claim/phone?placeId=…      → ClaimPhoneResponse (MASKED listing phone, never the number)
 *   GET  /api/listing/:placeId           → alias of /api/claim/phone (CONTRACTS.md name)
 *   POST /api/claim/start  {placeId}     → ClaimStartResponse   (prototype: simulated)
 *   POST /api/claim/verify {placeId,code}→ ClaimVerifyResponse  (prototype: simulated)
 *
 * Security
 *  - The server key (env.GOOGLE_SERVER_KEY, wrangler secret) never leaves the Worker.
 *  - /api/resolve only ever fetches allowlisted Google hosts (maps.app.goo.gl, goo.gl, app.goo.gl,
 *    g.page, google.<tld>); no credentials/ports/IP literals; consent.google.* is unwrapped from
 *    its `continue=` param and never fetched; ≤ 6 hops, 5 s per hop, bodies are never read.
 *    It sends a plain resolver User-Agent (with a browser UA maps.app.goo.gl answers 200 HTML
 *    instead of a 302 — research/google.md §6.2).
 *  - The claim endpoints only take a place ID from the client; the phone number is looked up from
 *    Google server-side and only a mask is returned.
 *  - Rate limits and caches below are per-isolate (best effort). Production: the Workers Rate
 *    Limiting binding + a Durable Object per place for the claim lock (research §5.4).
 */
import type {
  ApiError,
  ClaimPhoneResponse,
  ClaimStartResponse,
  ClaimVerifyResponse,
  ResolveApiResponse,
} from '../src/search/apiTypes';
import {
  isAllowedMapsHost,
  isConsentHost,
  isShortHost,
  parseMapsLink,
  type LinkLatLng as LatLng,
  type ParsedLink as ParsedMapsLink,
} from '../src/search/parseMapsLink';
import { ipKey } from './ipKey';

export interface Env {
  ASSETS: Fetcher;
  /** Places API (New) + Maps Grounding Lite server key (wrangler secret). Never sent to clients. */
  GOOGLE_SERVER_KEY?: string;
}

export interface Deps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
}

const defaultDeps = (): Deps => ({ fetch: (input, init) => fetch(input, init), now: () => Date.now() });

/* ================================================================== constants */

const CLAIM_TTL_MS = 10 * 60_000;
const CLAIM_MAX_WRONG = 3;
const RESOLVER_UA = 'AtlasPad-Resolver/1.0 (+https://atlaspad.online)';
const MAX_HOPS = 6;
const HOP_TIMEOUT_MS = 5_000;
const GOOGLE_TIMEOUT_MS = 8_000;
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;
const PHONE_FIELD_MASK = 'id,internationalPhoneNumber,nationalPhoneNumber,websiteUri,businessStatus';

/* ================================================================== per-isolate state */

class Limiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  take(key: string, now: number): { ok: true } | { ok: false; retryAfterSec: number } {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000)) };
    }
    recent.push(now);
    this.hits.delete(key);
    this.hits.set(key, recent);
    if (this.hits.size > 5_000) {
      // drop the oldest keys (Map keeps insertion order)
      for (const k of [...this.hits.keys()].slice(0, 1_000)) this.hits.delete(k);
    }
    return { ok: true };
  }
  clear(): void {
    this.hits.clear();
  }
}

class TtlCache<T> {
  private m = new Map<string, { v: T; exp: number }>();
  constructor(private readonly max: number) {}
  get(key: string, now: number): T | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.exp <= now) {
      this.m.delete(key);
      return undefined;
    }
    return e.v;
  }
  set(key: string, v: T, ttlMs: number, now: number): void {
    this.m.delete(key);
    this.m.set(key, { v, exp: now + ttlMs });
    if (this.m.size > this.max) {
      const first = this.m.keys().next().value;
      if (first !== undefined) this.m.delete(first);
    }
  }
  delete(key: string): void {
    this.m.delete(key);
  }
  clear(): void {
    this.m.clear();
  }
}

const limits = {
  resolve: new Limiter(60, 60_000),
  phone: new Limiter(20, 10 * 60_000),
  claimStart: new Limiter(5, 60 * 60_000),
  claimVerify: new Limiter(20, 10 * 60_000),
};
const resolveCache = new TtlCache<ResolveApiResponse>(500);
/** Masked numbers only (never the raw number), 10 minutes. */
const phoneCache = new TtlCache<ClaimPhoneResponse>(500);
/** One active claim per place: placeId → claimant IP. */
const claimLocks = new TtlCache<string>(2_000);
/** Wrong-code counter per (placeId, ip). */
const claimWrong = new TtlCache<number>(2_000);

/** Test helper: reset all per-isolate state. */
export function __resetApiState(): void {
  Object.values(limits).forEach((l) => l.clear());
  resolveCache.clear();
  phoneCache.clear();
  claimLocks.clear();
  claimWrong.clear();
}

/* ================================================================== responses */

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'cache-control': 'no-store', ...headers },
  });
}

function fail(status: number, error: ApiError['error'], message?: string, retryAfterSec?: number): Response {
  const body: ApiError = { error, ...(message ? { message } : {}), ...(retryAfterSec ? { retryAfterSec } : {}) };
  return json(body, status, retryAfterSec ? { 'retry-after': String(retryAfterSec) } : {});
}

function onlyMethod(request: Request, ...allowed: string[]): Response | null {
  if (allowed.includes(request.method)) return null;
  return json({ error: 'method_not_allowed' } satisfies ApiError, 405, { allow: allowed.join(', ') });
}

/** The per-isolate limit key: the client IP, IPv6 on its /64 (worker/ipKey.ts). */
function clientIp(request: Request): string {
  return ipKey(request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown');
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const len = Number(request.headers.get('content-length') ?? '0');
  if (len > 4_096) return null;
  try {
    const text = await request.text();
    if (text.length > 4_096) return null;
    const v: unknown = JSON.parse(text || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* ================================================================== router */

export async function handleApi(request: Request, env: Env, deps: Deps = defaultDeps()): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const ip = clientIp(request);
  try {
    if (path === '/api/health') {
      return onlyMethod(request, 'GET', 'HEAD') ?? json({ ok: true, service: 'cornershop-api', google: !!env.GOOGLE_SERVER_KEY });
    }
    if (path === '/api/resolve') {
      return onlyMethod(request, 'GET') ?? (await handleResolve(url, env, deps, ip));
    }
    if (path === '/api/claim/phone') {
      return onlyMethod(request, 'GET') ?? (await handlePhone(url.searchParams.get('placeId') ?? '', env, deps, ip));
    }
    if (path.startsWith('/api/listing/')) {
      const id = decodeSafe(path.slice('/api/listing/'.length));
      return onlyMethod(request, 'GET') ?? (await handlePhone(id, env, deps, ip));
    }
    if (path === '/api/claim/start' || path === '/api/claim/verify') {
      // The simulated Phase-1 claim (demo code) exists only on the demo Worker. Real Workers answer 404 (the demo
      // ClaimFlow then simulates locally, as it does offline); the inline compile-time guard removes these handlers and
      // the demo code from the devnet / mainnet bundles.
      if (__CS_CLUSTER__ !== 'demo') return fail(404, 'not_found', 'Not available on this site');
      if (path === '/api/claim/start') return onlyMethod(request, 'POST') ?? (await handleClaimStart(request, deps, ip));
      return onlyMethod(request, 'POST') ?? (await handleClaimVerify(request, deps, ip));
    }
    return fail(404, 'not_found', 'Unknown API route');
  } catch (err) {
    console.error('cornershop api error', path, err instanceof Error ? err.message : err);
    return fail(502, 'upstream', 'Something went wrong. Try again.');
  }
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/* ================================================================== /api/resolve */

type ResolveOutcome = ResolveApiResponse | { status: number; error: ApiError['error'] };

async function handleResolve(url: URL, env: Env, deps: Deps, ip: string): Promise<Response> {
  const raw = (url.searchParams.get('url') ?? '').trim();
  if (!raw) return fail(400, 'bad_request', 'Missing url');
  if (raw.length > 2_048) return fail(400, 'bad_request', 'URL too long');
  const follow = url.searchParams.get('follow') === '1';
  const now = deps.now();

  const rl = limits.resolve.take(`resolve:${ip}`, now);
  if (!rl.ok) return fail(429, 'rate_limited', 'Too many requests', rl.retryAfterSec);

  const parsed = parseMapsLink(raw);
  if (!parsed) return fail(400, 'not_a_maps_link', "That doesn't look like a Google Maps link.");
  if (parsed.kind === 'directions') return fail(422, 'directions', 'Paste a single place link, not directions.');
  if (parsed.kind === 'unsupported') return fail(422, 'unsupported', 'Try the full google.com/maps link.');

  const cacheKey = `${follow ? 1 : 0}|${parsed.url}`;
  const hit = resolveCache.get(cacheKey, now);
  if (hit) return json(hit, 200, { 'cache-control': 'public, max-age=3600', 'x-cache': 'HIT' });

  const out = await resolveParsed(parsed, env.GOOGLE_SERVER_KEY?.trim() || undefined, follow, deps);
  if ('error' in out) return fail(out.status, out.error);
  // Place IDs are exempt from Google's caching limits; the rest is from the link itself.
  resolveCache.set(cacheKey, out, 60 * 60_000, now);
  return json(out, 200, { 'cache-control': 'public, max-age=3600' });
}

function fromParsed(p: ParsedMapsLink, via: ResolveApiResponse['via']): ResolveApiResponse {
  return {
    kind: p.kind,
    via,
    finalUrl: p.url,
    ...(p.name ? { name: p.name } : {}),
    ...(p.query ? { query: p.query } : {}),
    ...(p.location ? { location: p.location } : {}),
    ...(p.zoom != null ? { zoom: p.zoom } : {}),
    ...(p.cid ? { cid: p.cid } : {}),
  };
}

export async function resolveParsed(
  start: ParsedMapsLink,
  key: string | undefined,
  follow: boolean,
  deps: Deps,
): Promise<ResolveOutcome> {
  let p = start;
  let via: ResolveApiResponse['via'] = 'parse';
  let triedOfficial = false;

  // 1) Official, free resolver (Maps Tools resolveMapsUrls) — short links and place links.
  if (key && !follow && (p.kind === 'short' || (p.kind === 'place' && !p.placeId))) {
    triedOfficial = true;
    const id = await resolveMapsUrls(p.url, key, deps);
    if (id) return { ...fromParsed(p, 'resolveMapsUrls'), kind: 'place', placeId: id, verified: true };
  }

  // 2) Manual redirects for short links (plain UA, allowlisted hosts, ≤ 6 hops).
  if (p.kind === 'short') {
    const r = await followRedirects(p.url, deps);
    if ('error' in r) return { status: r.error === 'not_found' ? 404 : 502, error: r.error };
    const next = parseMapsLink(r.finalUrl);
    if (!next || next.kind === 'short' || next.kind === 'unsupported') return { status: 422, error: 'unsupported' };
    if (next.kind === 'directions') return { status: 422, error: 'directions' };
    p = next;
    via = 'redirects';
    if (key && !triedOfficial && p.kind === 'place' && !p.placeId) {
      const id = await resolveMapsUrls(p.url, key, deps);
      if (id) return { ...fromParsed(p, 'resolveMapsUrls'), kind: 'place', placeId: id, verified: true };
    }
  }

  if (p.kind !== 'place') return fromParsed(p, via);

  // 3) With the server key: canonicalise ids (free IDs-only lookups), or find the id by name.
  if (key) {
    let unverified: { placeId?: string; candidatePlaceId?: string } = {};
    const ids: [keyof typeof unverified, string | undefined][] = [
      ['placeId', p.placeId],
      ['candidatePlaceId', p.candidatePlaceId],
    ];
    for (const [field, id] of ids) {
      if (!id) continue;
      const v = await verifyPlaceId(id, key, deps);
      if (v.status === 'ok') return { ...fromParsed(p, via === 'parse' ? 'places' : via), placeId: v.id, verified: true };
      // Google unreachable (not a NOT_FOUND): hand the id to the client to validate itself.
      if (v.status === 'error' && !unverified.placeId && !unverified.candidatePlaceId) unverified = { [field]: id };
    }
    if (p.name) {
      const id = await findPlaceIdByText(p.name, p.location, key, deps);
      if (id) return { ...fromParsed(p, 'places'), placeId: id, verified: true };
    }
    // Google says the ids don't exist: return what the link itself says (name / coordinates).
    return { ...fromParsed(p, via), verified: false, ...unverified };
  }

  // 4) No key: unverified ids for the client to validate with the browser key.
  return {
    ...fromParsed(p, via),
    verified: false,
    ...(p.placeId ? { placeId: p.placeId } : p.candidatePlaceId ? { candidatePlaceId: p.candidatePlaceId } : {}),
  };
}

function cleanPlaceId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const id = v.replace(/^places\//, '');
  return PLACE_ID_RE.test(id) ? id : null;
}

/** Maps Tools Resolution API (Grounding Lite): URL → place ID. Free (Text Search IDs-only SKU). */
async function resolveMapsUrls(url: string, key: string, deps: Deps): Promise<string | null> {
  try {
    const res = await deps.fetch('https://mapstools.googleapis.com/v1:resolveMapsUrls', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key },
      body: JSON.stringify({ urls: [url] }),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { entities?: { place?: string }[] };
    return cleanPlaceId(j.entities?.[0]?.place);
  } catch {
    return null;
  }
}

/** Places (New) GET with field mask `id` — free. 'not_found' when Google says the id is invalid/obsolete. */
async function verifyPlaceId(
  id: string,
  key: string,
  deps: Deps,
): Promise<{ status: 'ok'; id: string } | { status: 'not_found' } | { status: 'error' }> {
  if (!PLACE_ID_RE.test(id)) return { status: 'not_found' };
  try {
    const res = await deps.fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'id' },
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (res.status === 404 || res.status === 400) return { status: 'not_found' };
    if (!res.ok) return { status: 'error' };
    const j = (await res.json()) as { id?: string };
    const canonical = cleanPlaceId(j.id);
    return canonical ? { status: 'ok', id: canonical } : { status: 'error' };
  } catch {
    return { status: 'error' };
  }
}

/** Text Search with field mask `places.id` (IDs-only SKU, free): name (+ location bias) → id. */
async function findPlaceIdByText(name: string, location: LatLng | undefined, key: string, deps: Deps): Promise<string | null> {
  try {
    const res = await deps.fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id' },
      body: JSON.stringify({
        textQuery: name.slice(0, 200),
        maxResultCount: 1,
        ...(location
          ? { locationBias: { circle: { center: { latitude: location.lat, longitude: location.lng }, radius: 500 } } }
          : {}),
      }),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { places?: { id?: string }[] };
    return cleanPlaceId(j.places?.[0]?.id);
  } catch {
    return null;
  }
}

/**
 * Follow redirects manually from a short link, staying on allowlisted Google hosts.
 * Stops as soon as the URL carries a place id / ftid / coordinates / query (never fetches Maps HTML
 * once it has what it needs) and unwraps consent.google.* without fetching it.
 */
export async function followRedirects(
  start: string,
  deps: Deps,
): Promise<{ finalUrl: string } | { error: 'not_found' | 'upstream' }> {
  let current = start;
  let fetches = 0;
  for (let step = 0; step < MAX_HOPS * 2 + 2; step++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      return { error: 'upstream' };
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.port) return { error: 'upstream' };
    const host = u.hostname.toLowerCase();
    if (!isAllowedMapsHost(host)) return { error: 'upstream' };
    if (isConsentHost(host)) {
      const cont = u.searchParams.get('continue');
      if (!cont) return { error: 'upstream' };
      current = cont;
      continue;
    }
    if (!isShortHost(host)) {
      const p = parseMapsLink(current);
      if (p && p.kind !== 'short' && p.kind !== 'unsupported') return { finalUrl: current };
    }
    if (fetches >= MAX_HOPS) return { error: 'upstream' };
    u.protocol = 'https:';
    fetches++;
    const res = await deps.fetch(u.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: { 'user-agent': RESOLVER_UA, accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
    });
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { error: 'upstream' };
      try {
        current = new URL(loc, u).toString();
      } catch {
        return { error: 'upstream' };
      }
      continue;
    }
    if (res.status === 404 || res.status === 410) return { error: 'not_found' };
    if (res.ok) return { finalUrl: u.toString() };
    return { error: 'upstream' };
  }
  return { error: 'upstream' };
}

/* ================================================================== /api/claim/phone */

/**
 * DESIGN §12.3 mask: country code + first 2 national digits, `•` for the rest except the last 2,
 * keeping Google's grouping. `+44 20 7946 0123` → `+44 20 •••• ••23`.
 */
export function maskPhoneNumber(phone: string): string | null {
  const raw = phone.trim();
  if (!raw) return null;
  let cc = '';
  let rest = raw;
  const m = raw.match(/^\+(\d{1,3})[\s-]*(.*)$/);
  if (m) {
    cc = `+${m[1]}`;
    rest = m[2] ?? '';
  }
  const groups = rest.replace(/[-().]/g, ' ').split(/\s+/).filter(Boolean);
  const total = groups.join('').replace(/\D/g, '').length;
  if (total < 5) return null;
  let seen = 0;
  const masked = groups.map((g) =>
    g
      .split('')
      .map((ch) => {
        if (!/\d/.test(ch)) return ch;
        const idx = seen++;
        return idx < 2 || idx >= total - 2 ? ch : '•';
      })
      .join(''),
  );
  return [cc, ...masked].filter(Boolean).join(' ');
}

/**
 * Premium / shared-cost / personal numbers we refuse to call (research §5.1). Heuristic for the
 * prototype; production uses libphonenumber-js getType() (PREMIUM_RATE, SHARED_COST, PERSONAL_NUMBER, UAN).
 */
export function isPremiumNumber(international: string): boolean {
  const d = international.replace(/[^\d+]/g, '');
  if (!d.startsWith('+')) return false;
  if (d.startsWith('+44')) return /^(?:9|87|84|70|76)/.test(d.slice(3)); // 09 premium, 084/087 shared cost, 070 personal, 076 pagers
  if (d.startsWith('+1')) return /^(?:900|976)/.test(d.slice(2));
  if (d.startsWith('+49')) return /^(?:900|137|700)/.test(d.slice(3));
  if (d.startsWith('+33')) return /^8[19]/.test(d.slice(3));
  return false;
}

function hostOf(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri) return null;
  try {
    return new URL(uri).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * True when this `/api/claim/phone` or `/api/listing/:id` request would call Google (a valid place id this isolate has
 * not cached). Real Workers spend their global daily Google budget only then (worker/router.ts).
 */
export function listingLookupCallsGoogle(url: URL, now = Date.now()): boolean {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const id = (path.startsWith('/api/listing/') ? decodeSafe(path.slice('/api/listing/'.length)) : (url.searchParams.get('placeId') ?? '')).trim();
  return PLACE_ID_RE.test(id) && !id.startsWith('demo-') && !phoneCache.get(id, now);
}

async function handlePhone(placeId: string, env: Env, deps: Deps, ip: string): Promise<Response> {
  const id = placeId.trim();
  if (!PLACE_ID_RE.test(id) || id.startsWith('demo-')) return fail(400, 'bad_request', 'Invalid placeId');
  const now = deps.now();
  const rl = limits.phone.take(`phone:${ip}`, now);
  if (!rl.ok) return fail(429, 'rate_limited', 'Too many attempts. Try again later.', rl.retryAfterSec);

  const cached = phoneCache.get(id, now);
  if (cached) return json(cached, 200, { 'cache-control': 'private, max-age=300', 'x-cache': 'HIT' });

  const key = env.GOOGLE_SERVER_KEY?.trim();
  if (!key) return fail(503, 'unavailable', 'Phone lookup is not configured');

  const res = await deps.fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, {
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': PHONE_FIELD_MASK },
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  });
  if (res.status === 404) return fail(404, 'not_found', 'Place not found');
  if (res.status === 400) return fail(400, 'bad_request', 'Invalid placeId');
  if (!res.ok) return fail(502, 'upstream', 'Google lookup failed');

  const j = (await res.json()) as {
    id?: string;
    internationalPhoneNumber?: string;
    nationalPhoneNumber?: string;
    websiteUri?: string;
    businessStatus?: string;
  };
  const intl = j.internationalPhoneNumber?.trim() ?? '';
  const phone = intl || j.nationalPhoneNumber?.trim() || '';
  const masked = phone ? maskPhoneNumber(phone) : null;
  const premium = intl ? isPremiumNumber(intl) : false;
  const body: ClaimPhoneResponse = {
    placeId: cleanPlaceId(j.id) ?? id,
    hasPhone: !!masked,
    masked,
    websiteHost: hostOf(j.websiteUri),
    blocked: !masked ? 'no-phone' : premium ? 'premium' : null,
    operational: j.businessStatus ? j.businessStatus === 'OPERATIONAL' : null,
  };
  // Only the masked form is cached, briefly, in this isolate's memory; the raw number is dropped here.
  phoneCache.set(id, body, 10 * 60_000, now);
  return json(body, 200, { 'cache-control': 'private, max-age=300' });
}

/* ================================================================== /api/claim/start + /verify */

function bodyPlaceId(body: Record<string, unknown> | null): string | null {
  const id = typeof body?.placeId === 'string' ? body.placeId.trim() : '';
  return PLACE_ID_RE.test(id) ? id : null;
}

async function handleClaimStart(request: Request, deps: Deps, ip: string): Promise<Response> {
  // compile-time guard: the body (simulated claim) exists only in the demo Worker bundle
  if (__CS_CLUSTER__ !== 'demo') return fail(404, 'not_found', 'Not available on this site');
  const body = await readJsonBody(request);
  const placeId = bodyPlaceId(body);
  if (!placeId) return fail(400, 'bad_request', 'Invalid placeId');
  const now = deps.now();

  const rl = limits.claimStart.take(`start:${ip}`, now);
  if (!rl.ok) return fail(429, 'rate_limited', 'Too many attempts. Try again in 1 hour.', rl.retryAfterSec);

  const holder = claimLocks.get(placeId, now);
  if (holder && holder !== ip) return fail(409, 'claim_active', 'Someone is verifying this shop right now. Try again in 10 minutes.', 600);
  claimLocks.set(placeId, ip, CLAIM_TTL_MS, now);
  claimWrong.delete(`${placeId}|${ip}`);

  /*
   * PRODUCTION — Twilio Verify, voice call (research/google.md §5):
   *  1. Verify the Cloudflare Turnstile token (body.turnstile) with
   *     POST https://challenges.cloudflare.com/turnstile/v0/siteverify; require a connected wallet.
   *  2. Look up internationalPhoneNumber server-side exactly like /api/claim/phone (never from the
   *     client); refuse premium numbers and non-OPERATIONAL places; convert to E.164.
   *  3. POST https://verify.twilio.com/v2/Services/{TWILIO_VERIFY_SERVICE_SID}/Verifications
   *       Authorization: Basic base64(TWILIO_API_KEY_SID:TWILIO_API_KEY_SECRET)
   *       body (form): To=<E.164>&Channel=call&RateLimits={"place_id":"<id>","end_user_ip":"<ip>"}
   *     The Verify service is created once with CodeLength=6 (and DtmfInputRequired=true).
   *  4. Keep only the verification SID bound to (placeId, wallet, ip) in a Durable Object (the
   *     per-place lock above), never the phone number. Codes expire after 10 minutes.
   */
  const out: ClaimStartResponse = {
    simulated: true,
    status: 'pending',
    channel: 'call',
    codeLength: 6,
    expiresInSec: CLAIM_TTL_MS / 1000,
    resendAfterSec: 45,
  };
  return json(out);
}

async function handleClaimVerify(request: Request, deps: Deps, ip: string): Promise<Response> {
  // compile-time guard: the body (the demo code) exists only in the demo Worker bundle
  if (__CS_CLUSTER__ !== 'demo') return fail(404, 'not_found', 'Not available on this site');
  const body = await readJsonBody(request);
  const placeId = bodyPlaceId(body);
  const code = typeof body?.code === 'string' ? body.code.replace(/\s+/g, '') : '';
  if (!placeId) return fail(400, 'bad_request', 'Invalid placeId');
  if (!/^\d{6}$/.test(code)) return fail(400, 'bad_request', 'The code has 6 digits');
  const now = deps.now();

  const rl = limits.claimVerify.take(`verify:${ip}`, now);
  if (!rl.ok) return fail(429, 'rate_limited', 'Too many attempts. Try again later.', rl.retryAfterSec);

  const wrongKey = `${placeId}|${ip}`;
  const wrong = claimWrong.get(wrongKey, now) ?? 0;
  if (wrong >= CLAIM_MAX_WRONG) return fail(429, 'too_many_attempts', 'Too many wrong codes. Request a new call.');

  /*
   * PRODUCTION: POST https://verify.twilio.com/v2/Services/{TWILIO_VERIFY_SERVICE_SID}/VerificationCheck
   *   body (form): VerificationSid=<sid from the lock>&Code=<code>  → approved when status === 'approved'.
   * Then (Phase 2) sign the owner attestation for the payout wallet and release the lock.
   */
  const approved = code === '482913'; // DEMO_CLAIM_CODE (src/config.ts), inline so real bundles never contain it
  if (approved) {
    claimWrong.delete(wrongKey);
    claimLocks.delete(placeId);
  } else {
    claimWrong.set(wrongKey, wrong + 1, CLAIM_TTL_MS, now);
  }
  const out: ClaimVerifyResponse = {
    simulated: true,
    approved,
    attemptsLeft: approved ? CLAIM_MAX_WRONG : Math.max(0, CLAIM_MAX_WRONG - wrong - 1),
  };
  return json(out);
}
