/**
 * Local Google Maps URL parsing (research/google.md §6.2–§6.4). OWNED BY SEARCH.
 *
 * Pure and dependency-free (no DOM, no store) so the Cloudflare Worker (worker/api.ts) can use
 * the exact same rules when it follows short-link redirects.
 *
 * Contract:
 *   looksLikeMapsLink(text): boolean — the text contains a Google Maps URL (maps.app.goo.gl/,
 *     goo.gl/maps/, google.<tld>/maps, maps.google.<tld>, consent-wrapped, g.page, or a Google
 *     share link we can't read) → the search dropdown shows the link row.
 *   parseMapsLink(text): ParsedMapsLink | null — null for junk / non-Google URLs.
 *
 * What is extracted (research §6.3):
 *   placeId   ← query_place_id, q=place_id:…, data …!19sChIJ…
 *   ftid      ← ftid=0xHI:0xLO, or the first !1s0xHI:0xLO in a /maps/place/ path → candidatePlaceId
 *   cid       ← cid= / ludocid= (or the low half of an ftid)
 *   location  ← !3d…!4d… (exact pin) → q/query/ll/center "lat,lng" → /@lat,lng (viewport centre)
 *   zoom      ← /@lat,lng,NNz or zoom=
 *   name      ← /maps/place/<name>/ → q text (plus code stripped, first comma segment)
 *   query     ← /maps/search/<q>/ → query= / q= text
 * Always key coins on the place.id Google returns, never on what this parser extracts.
 */

/*
 * Self-contained types (structurally identical to ParsedMapsLink / LatLng in src/types.ts) so the
 * Worker program, which has no DOM lib, never has to compile src/types.ts. resolveLink.ts assigns
 * these to the shared types, so any drift is a compile error in the app.
 */
export interface LinkLatLng {
  lat: number;
  lng: number;
}

export interface ParsedLink {
  url: string;
  host: string;
  kind: 'place' | 'short' | 'search' | 'coords' | 'directions' | 'unsupported';
  placeId?: string;
  ftid?: { hi: string; lo: string };
  candidatePlaceId?: string;
  cid?: string;
  location?: LinkLatLng;
  zoom?: number;
  name?: string;
  query?: string;
}

type LatLng = LinkLatLng;
type ParsedMapsLink = ParsedLink;

/* ------------------------------------------------------------------ hosts */

const TLD = String.raw`(?:com|[a-z]{2,3}|com?\.[a-z]{2})`;
/** google.<tld>, www.google.<tld>, maps.google.<tld> */
const GOOGLE_HOST_RE = new RegExp(`^(?:www\\.|maps\\.)?google\\.${TLD}$`, 'i');
const CONSENT_HOST_RE = new RegExp(`^consent\\.google\\.${TLD}$`, 'i');
/** Short / redirecting hosts that only the Worker can resolve. */
const SHORT_HOST_RE = /^(?:maps\.app\.goo\.gl|goo\.gl|app\.goo\.gl|g\.page)$/i;
/** Google share links that are not Maps links (research §6.2 #16). */
const UNSUPPORTED_HOST_RE = /^(?:share\.google|g\.co)$/i;

export function isGoogleMapsHost(host: string): boolean {
  return GOOGLE_HOST_RE.test(host);
}
export function isConsentHost(host: string): boolean {
  return CONSENT_HOST_RE.test(host);
}
export function isShortHost(host: string): boolean {
  return SHORT_HOST_RE.test(host);
}
/** Hosts the resolver may ever fetch (SSRF allowlist for worker/api.ts). */
export function isAllowedMapsHost(host: string): boolean {
  return isGoogleMapsHost(host) || isConsentHost(host) || isShortHost(host);
}

/* ------------------------------------------------------------------ regexes */

const NUM = String.raw`-?\d{1,3}(?:\.\d+)?`;
const RE = {
  firstUrl: /\bhttps?:\/\/[^\s<>"'`]+/i,
  bareUrl: new RegExp(
    String.raw`(?:^|[\s(<\[])((?:(?:www\.|maps\.)?google\.${TLD}\/maps|maps\.google\.${TLD}|maps\.app\.goo\.gl\/|goo\.gl\/maps\/|g\.page\/|consent\.google\.${TLD}\/)[^\s<>"'\`]*)`,
    'i',
  ),
  trailing: /[)\].,;:!?'"»”’>]+$/,
  placeIdData: /!19s(ChIJ[A-Za-z0-9_-]{16,})/,
  ftidParam: /^(0x[0-9a-f]{1,16}):(0x[0-9a-f]{1,16})$/i,
  ftidData: /!1s(0x[0-9a-f]{1,16}):(0x[0-9a-f]{1,16})/i,
  pin: new RegExp(`!3d(${NUM})!4d(${NUM})`),
  center: new RegExp(`/@(${NUM}),(${NUM})(?:,(\\d+(?:\\.\\d+)?)z)?`),
  latlng: new RegExp(`^\\s*(${NUM})\\s*,\\s*(${NUM})\\s*$`),
  placeName: /\/maps\/place\/([^/@?#]+)/,
  searchPath: /\/maps\/search\/([^/@?#]+)/,
  placeIdQ: /^place_id:([A-Za-z0-9_-]{10,})$/,
  googleId: /^[A-Za-z0-9_-]{10,}$/,
  // Plus code prefix ("55XH+FQX "); the "+" often arrives as a space after URL decoding.
  plusCode: /^(?=[23456789CFGHJMPQRVWX]*\d)[23456789CFGHJMPQRVWX]{4,8}[+\s][23456789CFGHJMPQRVWX]{2,3}[\s,]+/i,
  digits: /^\d{1,24}$/,
};

/* ------------------------------------------------------------------ helpers */

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** `+` means space inside path segments and query text that Google writes. */
function decodeText(s: string): string {
  return safeDecode(s.replace(/\+/g, ' ')).trim();
}

function toLatLng(lat: number, lng: number): LatLng | undefined {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  return { lat, lng };
}

function parseLatLng(text: string | null | undefined): LatLng | undefined {
  if (!text) return undefined;
  const m = text.match(RE.latlng);
  return m ? toLatLng(Number(m[1]), Number(m[2])) : undefined;
}

/** Name from a Google `q=` value: drop a leading plus code, keep the first comma segment. */
function nameFromQueryText(text: string): string {
  const noPlus = text.replace(RE.plusCode, '');
  return (noPlus.split(',')[0] ?? noPlus).trim();
}

/** ftid (`0xHI:0xLO`) → `ChIJ…` candidate (research §6.4; verified against Google's Googleplex sample). */
export function ftidToPlaceId(hi: string, lo: string): string {
  const b = new Uint8Array(20);
  const dv = new DataView(b.buffer);
  b[0] = 0x0a;
  b[1] = 0x12;
  b[2] = 0x09;
  dv.setBigUint64(3, BigInt(hi), true);
  b[11] = 0x11;
  dv.setBigUint64(12, BigInt(lo), true);
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * First URL in pasted text (share text often is "Name\nAddress\nhttps://maps.app.goo.gl/…").
 * Accepts scheme-less Google Maps hosts too ("maps.app.goo.gl/abc"). Trailing punctuation is stripped.
 */
export function extractFirstUrl(text: string): string | null {
  if (!text) return null;
  const s = text.trim();
  const m = s.match(RE.firstUrl);
  let url: string | null = m ? m[0] : null;
  if (!url) {
    const b = s.match(RE.bareUrl);
    if (b?.[1]) url = `https://${b[1]}`;
  }
  if (!url) return null;
  // strip trailing punctuation, but keep a closing paren that belongs to the URL "(…)"
  let prev = '';
  while (prev !== url) {
    prev = url;
    const t = url.match(RE.trailing);
    if (!t) break;
    const tail = t[0];
    if (tail === ')' && url.includes('(')) break;
    url = url.slice(0, url.length - tail.length);
  }
  return url || null;
}

function toUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || u.port) return null;
    return u;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ public API */

/** True when `text` contains something that should get the "Google Maps link detected" row. */
export function looksLikeMapsLink(text: string): boolean {
  const raw = extractFirstUrl(text);
  if (!raw) return false;
  const u = toUrl(raw);
  if (!u) return false;
  const host = u.hostname.toLowerCase();
  if (isShortHost(host)) return host !== 'goo.gl' || /^\/maps\b/i.test(u.pathname);
  if (isConsentHost(host)) return true;
  if (UNSUPPORTED_HOST_RE.test(host)) return true;
  if (isGoogleMapsHost(host)) {
    if (host.startsWith('maps.')) return true;
    return /^\/maps\b/i.test(u.pathname) || (/^\/search\b/.test(u.pathname) && u.searchParams.has('ludocid'));
  }
  return false;
}

/** Parse a pasted Google Maps link. Returns null for empty input, junk and non-Google URLs. */
export function parseMapsLink(text: string): ParsedMapsLink | null {
  return parseUrl(extractFirstUrl(text), 0);
}

function parseUrl(raw: string | null, depth: number): ParsedMapsLink | null {
  if (!raw || depth > 4) return null;
  const u = toUrl(raw);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const url = u.toString();

  // consent.google.* interstitial → unwrap `continue`, never follow it
  if (isConsentHost(host)) {
    const cont = u.searchParams.get('continue');
    return cont ? parseUrl(cont, depth + 1) : null;
  }

  if (UNSUPPORTED_HOST_RE.test(host)) return { url, host, kind: 'unsupported' };

  if (isShortHost(host)) {
    // Firebase dynamic link: maps.app.goo.gl/?link=<encoded maps URL>
    const link = u.searchParams.get('link');
    if (link) {
      const inner = parseUrl(link, depth + 1);
      if (inner && inner.kind !== 'unsupported') return inner;
    }
    if (host === 'goo.gl' && !/^\/maps\b/i.test(u.pathname)) return null;
    return { url, host, kind: 'short' };
  }

  if (!isGoogleMapsHost(host)) return null;

  const path = u.pathname;
  const isMapsPath = host.startsWith('maps.') || /^\/maps\b/i.test(path);
  const ludocid = u.searchParams.get('ludocid');
  // google.<tld>/search?q=<name>&ludocid=<cid> (Business Profile redirect target, research #15)
  if (!isMapsPath && !(path.startsWith('/search') && ludocid)) return null;

  const q = u.searchParams;
  const decodedPath = safeDecode(path);
  const out: ParsedMapsLink = { url, host, kind: 'unsupported' };

  // directions → rejected
  if (/^\/maps\/dir\b/i.test(path) || q.has('daddr') || q.has('saddr') || q.has('destination')) {
    return { ...out, kind: 'directions' };
  }

  /* place id */
  const qp = q.get('query_place_id')?.trim();
  if (qp && RE.googleId.test(qp)) out.placeId = qp;
  if (!out.placeId) {
    for (const key of ['q', 'query']) {
      const v = q.get(key)?.trim();
      const m = v?.match(RE.placeIdQ);
      if (m?.[1]) {
        out.placeId = m[1];
        break;
      }
    }
  }
  if (!out.placeId) {
    const m = decodedPath.match(RE.placeIdData) ?? safeDecode(u.search).match(RE.placeIdData);
    if (m?.[1]) out.placeId = m[1];
  }

  /* ftid → candidate place id + cid */
  const ftidQ = q.get('ftid')?.trim().match(RE.ftidParam);
  const ftidD = /^\/maps\/place\//i.test(path) ? decodedPath.match(RE.ftidData) : null;
  const ft = ftidQ ?? ftidD;
  if (ft?.[1] && ft[2]) {
    const hi = ft[1].toLowerCase();
    const lo = ft[2].toLowerCase();
    out.ftid = { hi, lo };
    try {
      if (BigInt(hi) !== 0n) out.candidatePlaceId = ftidToPlaceId(hi, lo);
      out.cid = BigInt(lo).toString();
    } catch {
      /* malformed hex — ignore */
    }
  }

  /* cid */
  const cidQ = (q.get('cid') ?? ludocid ?? '').trim();
  if (RE.digits.test(cidQ)) out.cid = cidQ;

  /* location: exact pin → q/query/ll/center → @centre */
  const pin = decodedPath.match(RE.pin);
  if (pin) out.location = toLatLng(Number(pin[1]), Number(pin[2]));
  if (!out.location) {
    for (const key of ['q', 'query', 'll', 'center', 'sll']) {
      const loc = parseLatLng(q.get(key));
      if (loc) {
        out.location = loc;
        break;
      }
    }
  }
  const at = decodedPath.match(RE.center);
  if (at) {
    if (!out.location) out.location = toLatLng(Number(at[1]), Number(at[2]));
    if (at[3]) out.zoom = Number(at[3]);
  }
  const zq = Number(q.get('zoom') ?? q.get('z') ?? NaN);
  if (out.zoom == null && Number.isFinite(zq) && zq > 0 && zq <= 22) out.zoom = zq;

  /* name / query */
  const placeSeg = path.match(RE.placeName)?.[1];
  let placeSegIsCoords = false;
  if (placeSeg) {
    const name = decodeText(placeSeg);
    const asCoords = parseLatLng(name);
    if (asCoords) {
      placeSegIsCoords = true;
      if (!out.location) out.location = asCoords;
    } else if (name) out.name = name;
  }
  const searchSeg = path.match(RE.searchPath)?.[1];
  if (searchSeg) {
    const s = decodeText(searchSeg);
    const asCoords = parseLatLng(s);
    if (asCoords) {
      if (!out.location) out.location = asCoords;
    } else if (s) out.query = s;
  }
  for (const key of ['query', 'q']) {
    const v = q.get(key)?.trim();
    if (!v || RE.placeIdQ.test(v) || parseLatLng(v)) continue;
    if (!out.query) out.query = v;
    if (!out.name && (out.placeId || out.ftid || out.cid)) out.name = nameFromQueryText(v);
    break;
  }

  /* kind */
  if (out.placeId || out.candidatePlaceId || out.cid) out.kind = 'place';
  else if (out.name) out.kind = 'place';
  else if (placeSegIsCoords && out.location) out.kind = 'coords';
  else if (out.query) out.kind = 'search';
  else if (out.location) out.kind = 'coords';
  else out.kind = 'unsupported';
  return out;
}

/** Short label for the link row sub-line: `maps.app.goo.gl/…`. */
export function linkHostLabel(textOrParsed: string | ParsedMapsLink): string {
  const host =
    typeof textOrParsed === 'string'
      ? (() => {
          const raw = extractFirstUrl(textOrParsed);
          const u = raw ? toUrl(raw) : null;
          return u?.hostname ?? '';
        })()
      : textOrParsed.host;
  const clean = host.replace(/^www\./, '');
  return clean ? `${clean}/…` : 'google.com/maps/…';
}
