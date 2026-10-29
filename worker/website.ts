/**
 * "Code on your website" owner verification (INTEGRATION §3.5, P1): SSRF-safe fetch of the listing's OWN site
 * (`isOwnSiteHost`): https only, default port, no credentials, no IP literals or local names, ≤ 3 redirects that
 * stay inside the same registrable domain (on a multi-tenant host, the same customer's site), 5 s per request,
 * ≤ 512 KB read.
 */
import type { Deps } from './ctx';
import { VERIFY_META_NAMES, WELL_KNOWN_PATHS, websiteCodeForms } from './siteMarker';
import { isOwnBusinessHost } from './wire';

export { websiteCodeValue } from './siteMarker';

const MAX_BODY = 512 * 1024;
const TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;

/**
 * Two-label public suffixes we see on business sites (`mycafe.co.uk`): an approximation of the Public Suffix List's
 * ICANN section, enough for the registrable domain of a business site.
 */
const SECOND_LEVEL = new Set([
  'co.uk', 'org.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br',
  'com.mx', 'co.jp', 'com.tr', 'com.sg', 'com.hk', 'co.in', 'co.id', 'com.my', 'com.ar', 'com.co', 'co.kr', 'com.cn',
  'com.pk', 'com.ng', 'co.ke', 'com.eg',
]);

/**
 * Hosting platforms that give every customer their own subdomain (`rosies.netlify.app`, `rosies.myshopify.com`): public
 * suffixes in the Public Suffix List's private section. The customer's site is the label in front of one (its
 * registrable domain), so a website-claim redirect from `rosies.github.io` to `someone-else.github.io` leaves the
 * site; the bare platform host is never a business's own site. Some are also in PLATFORM_HOSTS (refused outright).
 * A hand-kept subset of the list (the whole list is a follow-up); hosts whose customer label sits at no fixed depth
 * (S3 and other cloud storage) are platform hosts instead. Worker-only: the claim UI never needs it.
 */
export const MULTI_TENANT_SUFFIXES: readonly string[] = [
  'github.io', 'gitlab.io', 'bitbucket.io', 'codeberg.page', 'netlify.app', 'netlify.com', 'vercel.app', 'now.sh',
  'pages.dev', 'workers.dev', 'r2.dev', 'web.app', 'firebaseapp.com', 'appspot.com', 'herokuapp.com', 'onrender.com',
  'fly.dev', 'deno.dev', 'glitch.me', 'surge.sh', 'replit.app', 'repl.co', 'azurewebsites.net', 'azurestaticapps.net',
  'cloudfront.net', 'amplifyapp.com', 'blogspot.com', 'wordpress.com', 'wpcomstaging.com', 'wixsite.com',
  'wixstudio.io', 'squarespace.com', 'myshopify.com', 'square.site', 'godaddysites.com', 'webflow.io', 'weebly.com',
  'carrd.co', 'business.site', 'ueniweb.com', 'jimdosite.com', 'jimdofree.com', 'mystrikingly.com', 'webnode.page',
  'site123.me', 'yolasite.com', 'tilda.ws', 'framer.website', 'framer.app', 'notion.site', 'hs-sites.com',
  'mailchimpsites.com', 'bigcartel.com', 'company.site', 'tumblr.com', 'substack.com', 'ghost.io', 'neocities.org',
  'r.appspot.com', 'hs-sites-eu1.com', 'up.railway.app', 'railway.app', 'elasticbeanstalk.com',
];

/**
 * Suffixes one label deeper than a listed one, whose middle label varies (the Public Suffix List's wildcard and partition
 * entries): App Engine's `PROJECT.REGION.r.appspot.com`, Azure Static Web Apps' `NAME.2.azurestaticapps.net` and
 * Elastic Beanstalk's `APP.eu-west-2.elasticbeanstalk.com`. Group 1 is the suffix.
 */
const DEEPER_SUFFIXES: readonly RegExp[] = [
  /(?:^|\.)([a-z0-9-]+\.r\.appspot\.com)$/,
  /(?:^|\.)((?:\d+|centralus|eastasia|eastus2|westeurope|westus2)\.azurestaticapps\.net)$/,
  /(?:^|\.)([a-z]{2}(?:-gov)?-[a-z]+-\d\.elasticbeanstalk\.com)$/,
];

const normalHost = (host: string) => host.toLowerCase().replace(/\.$/, '');

/** The multi-tenant suffix `host` sits on (or is), else null (the longest when several match). */
export function multiTenantSuffix(host: string): string | null {
  const h = normalHost(host);
  let best: string | null = null;
  for (const s of MULTI_TENANT_SUFFIXES) if ((h === s || h.endsWith(`.${s}`)) && (!best || s.length > best.length)) best = s;
  for (const re of DEEPER_SUFFIXES) {
    const s = re.exec(h)?.[1];
    if (s && (!best || s.length > best.length)) best = s;
  }
  return best;
}

/**
 * The Worker's own-site check (claims, every fetch): `isOwnBusinessHost` (not a platform host), and not a public suffix
 * itself (`co.uk`, or a bare `github.io` / `netlify.app` without a customer in front). A customer subdomain of a
 * multi-tenant host (`rosies.netlify.app`) counts: its registrable domain is that customer's site.
 */
export function isOwnSiteHost(host: string | null | undefined): boolean {
  if (!host || !isOwnBusinessHost(host)) return false;
  const h = normalHost(host).replace(/^www\./, '');
  return multiTenantSuffix(h) !== h && !SECOND_LEVEL.has(h);
}

/**
 * eTLD+1 without the full PSL: the label in front of a two-label country suffix (`mycafe.co.uk`) or of a multi-tenant
 * hosting suffix (`rosies.netlify.app`, not `netlify.app`), else the last two labels. A public suffix stays itself.
 */
export function registrableDomain(host: string): string {
  const h = normalHost(host);
  const parts = h.split('.');
  const tenant = multiTenantSuffix(h);
  const suffixLabels = tenant ? tenant.split('.').length : SECOND_LEVEL.has(parts.slice(-2).join('.')) ? 2 : 1;
  return parts.length <= suffixLabels ? h : parts.slice(-(suffixLabels + 1)).join('.');
}

export function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  if (h.includes(':')) return true; // IPv6
  if (/^\d+$/.test(h)) return true; // decimal integer form
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){1,3}$/i.test(h)) return true; // dotted / hex / octal forms
  return false;
}

export function safeUrl(raw: string, allowedDomain: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  const host = u.hostname.toLowerCase();
  if (isIpLiteral(host) || host === 'localhost' || /\.(local|internal|localhost|lan|home|arpa)$/.test(host)) return null;
  if (!isOwnSiteHost(host)) return null;
  if (registrableDomain(host) !== allowedDomain) return null;
  return u;
}

export interface SitePage {
  text: string;
  /** Lower-cased media type without parameters ('' when the response had none). */
  contentType: string;
}

/** Fetches a page (following ≤ 3 same-domain redirects) and returns up to 512 KB of text, or null. */
export async function fetchOwnSite(deps: Deps, start: string, allowedDomain: string): Promise<string | null> {
  return (await fetchOwnSitePage(deps, start, allowedDomain))?.text ?? null;
}

/** As `fetchOwnSite`, plus the response's content type (the proof rules below need it). */
export async function fetchOwnSitePage(deps: Deps, start: string, allowedDomain: string): Promise<SitePage | null> {
  let url = safeUrl(start, allowedDomain);
  for (let hop = 0; url && hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await deps.fetch(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': 'AtlasPadVerify/1.0 (+https://atlaspad.online)', accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      if (!loc) return null;
      let next: string;
      try {
        next = new URL(loc, url).toString();
      } catch {
        return null;
      }
      url = safeUrl(next, allowedDomain);
      continue;
    }
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(total > MAX_BODY ? value.subarray(0, value.byteLength - (total - MAX_BODY)) : value);
      if (total >= MAX_BODY) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
    const buf = new Uint8Array(Math.min(total, MAX_BODY));
    let o = 0;
    for (const c of chunks) {
      buf.set(c.subarray(0, Math.min(c.byteLength, buf.length - o)), o);
      o += c.byteLength;
      if (o >= buf.length) break;
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    return { text: new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(buf), contentType };
  }
  return null;
}

/* --------------------------------------------------------------------------------------------- ownership proof */

/**
 * `/.well-known/atlaspad.txt` (or the legacy `cornershop.txt`): a small plain-text file that only the site's owner can
 * publish. HTML is refused (a catch-all route that serves the home page, with its reviews or comments, for any path must
 * not count), and the code has to be a whole line of its own (with or without its `atlaspad-verify=` label).
 */
export function wellKnownHasCode(page: SitePage, code: string): boolean {
  if (page.contentType.includes('html') || /^\s*<(!doctype|html|head|body)\b/i.test(page.text)) return false;
  if (page.text.length > 4_096) return false;
  const forms = websiteCodeForms(code);
  return page.text.split(/\r?\n/).some((l) => forms.includes(l.trim()));
}

/** Elements whose content is text, not markup: the head scan skips to their end tag, so nothing inside one is a tag. */
const RAW_TEXT_END = new Map(
  ['script', 'style', 'noscript', 'template', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes'].map((n) => [n, new RegExp(`</${n}[\\t\\n\\f\\r />]`, 'gi')] as const),
);
const isWs = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
const isLetter = (c: string | undefined) => !!c && /[A-Za-z]/.test(c);

interface Tag {
  name: string;
  end: boolean;
  /** Lower-cased names; the first of a repeated attribute wins, as in a browser. */
  attrs: Map<string, string>;
  /** Index just past the closing `>`. */
  next: number;
}

/**
 * Reads the start or end tag at `html[i] === '<'` the way a browser tokenises it: quoted attribute values are skipped
 * whole, so a `>` or `<meta` inside one is text. Null when the tag never closes.
 */
function readTag(html: string, i: number): Tag | null {
  const end = html[i + 1] === '/';
  let p = i + (end ? 2 : 1);
  const n = html.length;
  const s0 = p;
  while (p < n && !isWs(html[p]) && html[p] !== '/' && html[p] !== '>') p++;
  const name = html.slice(s0, p).toLowerCase();
  const attrs = new Map<string, string>();
  for (;;) {
    while (p < n && (isWs(html[p]) || html[p] === '/')) p++;
    if (p >= n) return null;
    if (html[p] === '>') return { name, end, attrs, next: p + 1 };
    const s = p++; // an attribute name (its first character may even be '=')
    while (p < n && !isWs(html[p]) && html[p] !== '/' && html[p] !== '>' && html[p] !== '=') p++;
    const key = html.slice(s, p).toLowerCase();
    while (p < n && isWs(html[p])) p++;
    let value = '';
    if (html[p] === '=') {
      p++;
      while (p < n && isWs(html[p])) p++;
      const q = html[p];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, p + 1);
        if (close < 0) return null;
        value = html.slice(p + 1, close);
        p = close + 1;
      } else {
        const v = p;
        while (p < n && !isWs(html[p]) && html[p] !== '>') p++;
        value = html.slice(v, p);
      }
    }
    if (!attrs.has(key)) attrs.set(key, value);
  }
}

/**
 * Home page: only a real `<meta name="atlaspad-verify" content="…">` tag (or the legacy `cornershop-verify`) in the
 * document `<head>` counts. The head is walked tag by tag the way a browser reads it: quoted attribute values are skipped
 * whole (an `og:description` that quotes a review containing `<meta name=atlaspad-verify …>` is text, not a tag), and
 * comments, scripts, styles, templates and titles are skipped (JSON-LD review snippets in the head must not count
 * either). The head ends at a real `</head>` or `<body>`; visitor content (reviews, comments, guestbooks) lives in the
 * body. Text that merely contains the code is never enough.
 */
export function homeHeadHasCode(page: SitePage, code: string): boolean {
  if (page.contentType && !page.contentType.includes('html')) return false;
  const html = page.text;
  const forms = websiteCodeForms(code);
  const names: readonly string[] = VERIFY_META_NAMES;
  let found = false;
  for (let i = html.indexOf('<'); i >= 0; ) {
    const c = html[i + 1];
    if (html.startsWith('<!--', i)) {
      // a comment ends where a browser ends it: '<!-->', '<!--->', or the first '-->' or '--!>'
      let end: number;
      if (html[i + 4] === '>') end = i + 5;
      else if (html.startsWith('->', i + 4)) end = i + 6;
      else {
        const a = html.indexOf('-->', i + 4);
        const b = html.indexOf('--!>', i + 4);
        if (a < 0 && b < 0) return false;
        end = b >= 0 && (a < 0 || b < a) ? b + 4 : a + 3;
      }
      i = html.indexOf('<', end);
      continue;
    }
    if (!isLetter(c) && !(c === '/' && isLetter(html[i + 2]))) {
      // `<!doctype …>`, `<?…>` and `</ …>` run to the next '>'; any other '<' is text
      const e = c === '!' || c === '?' || c === '/' ? html.indexOf('>', i + 2) : i;
      if (e < 0) return false;
      i = html.indexOf('<', e + 1);
      continue;
    }
    const t = readTag(html, i);
    if (!t) return false;
    if (t.end ? t.name === 'head' : t.name === 'body') return found;
    if (!t.end && t.name === 'meta') {
      if (names.includes((t.attrs.get('name') ?? '').trim().toLowerCase()) && forms.includes((t.attrs.get('content') ?? '').trim())) found = true;
    }
    let next = t.next;
    const raw = t.end ? undefined : RAW_TEXT_END.get(t.name);
    if (raw) {
      raw.lastIndex = next;
      const m = raw.exec(html);
      if (!m) return false;
      next = m.index;
    }
    i = html.indexOf('<', next);
  }
  return false;
}

/**
 * Looks for the claim code only where the site's owner controls the content: the well-known files (atlaspad.txt, then
 * the legacy cornershop.txt), then a verify meta tag in the home page's <head>. Every fetch goes through
 * `fetchOwnSitePage` (SSRF rules, same registrable domain). Returns which proof matched, or null.
 */
export async function findOwnershipProof(deps: Deps, host: string, code: string): Promise<'well-known' | 'meta' | null> {
  const domain = registrableDomain(host);
  for (const path of WELL_KNOWN_PATHS) {
    const page = await fetchOwnSitePage(deps, `https://${host}${path}`, domain);
    if (page && wellKnownHasCode(page, code)) return 'well-known';
  }
  const home = await fetchOwnSitePage(deps, `https://${host}/`, domain);
  return home && homeHeadHasCode(home, code) ? 'meta' : null;
}

/** `atlaspad-verify=7KQ2-M9XD` (no ambiguous characters). */
export function websiteCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(8));
  const c = [...b].map((x) => A[x % A.length]).join('');
  return `${VERIFY_META_NAMES[0]}=${c.slice(0, 4)}-${c.slice(4)}`;
}
