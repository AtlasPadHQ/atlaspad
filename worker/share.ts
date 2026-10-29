/**
 * Share pages + share images (DESIGN §12.5).
 *
 *  - `/c/<coinId>` and `/p/<placeId>` are the URLs people post. They serve the SPA (index.html)
 *    with Open Graph / Twitter meta rewritten for that URL: canonical og:url, a share title, and
 *    `twitter:card=summary_large_image` pointing at `/api/og/c/<coinId>.png` / `/api/og/p/<id>.png`.
 *  - `/api/og/(c|p)/<id>.png` serves the share image. Coins live in each visitor's browser in the
 *    prototype (simulated, not on a server), so the Worker serves the static AtlasPad card
 *    (`/og.png` from the assets). A per-coin server-rendered card is a Phase-2 item (README).
 *  - Every URL in the meta is built on PUBLIC_ORIGIN (mainnet: https://atlaspad.online), the canonical host that
 *    www and workers.dev redirect to (worker/canonical.ts).
 *
 * Google ToS: nothing from Google is used here (no names, photos or tiles); the title never contains
 * a Google place name.
 */

import { canonicalPubkey } from './bytes';
import { publicOrigin, realCluster, type Env } from './env';

const ORIGIN = 'https://cornershop.tiejiucai.workers.dev';
const DESC = "your cafe. your barber. your kebab shop. launch a coin for any business on earth. 100% of creator fees are held for the shop's verified owner.";

export interface ShareMeta {
  url: string;
  title: string;
  description: string;
  image: string;
  /** The image's real pixel size (og:image:width / height). */
  imageWidth: number;
  imageHeight: number;
  /** `summary_large_image` for the 1200×630 card; `summary` for square coin art (X would crop it in a large card). */
  card: 'summary' | 'summary_large_image';
}

/** A coin found in the registry for a share URL (real Workers): its ticker and art (with the stored pixel size). */
export interface ShareCoin {
  ticker: string;
  image: string | null;
  width?: number | null;
  height?: number | null;
}

const CARD_W = 1200;
const CARD_H = 630;

function coinImage(coin: ShareCoin | undefined, fallback: string): Pick<ShareMeta, 'image' | 'imageWidth' | 'imageHeight' | 'card'> {
  if (coin?.image && coin.width && coin.height) {
    const square = Math.abs(coin.width - coin.height) <= Math.max(coin.width, coin.height) * 0.02;
    return { image: coin.image, imageWidth: coin.width, imageHeight: coin.height, card: square ? 'summary' : 'summary_large_image' };
  }
  return { image: fallback, imageWidth: CARD_W, imageHeight: CARD_H, card: 'summary_large_image' };
}

/**
 * `/c/<id>` or `/p/<id>` → meta, or null for anything else. `origin` = the Worker's PUBLIC_ORIGIN (real Workers);
 * `coin` (real mode, from D1) puts the coin's $TICKER in the title and its art as og:image. Only the demo Worker
 * (`demo`: no cluster, coins live in the browser) turns a short id into a ticker (/c/kebab → $KEBAB); on a real Worker
 * that would put any made-up $TICKER (/c/TESCO) on our own domain, so a coin not found in D1 is "This coin".
 */
export function shareMetaFor(pathname: string, origin: string = ORIGIN, coin?: ShareCoin, demo = false): ShareMeta | null {
  const m = pathname.match(/^\/(c|p)\/([^/?#]{1,200})\/?$/);
  if (!m || !m[1] || !m[2]) return null;
  const kind = m[1] as 'c' | 'p';
  let id: string;
  try {
    id = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_:\-./]+$/.test(id)) return null;
  const enc = encodeURIComponent(id);
  if (kind === 'c') {
    // On the demo Worker a short ticker-like id (e.g. /c/kebab) reads well in the title; mints don't.
    const ticker = coin ? `$${coin.ticker}` : demo && /^[A-Za-z0-9]{2,8}$/.test(id) ? `$${id.toUpperCase()}` : 'This coin';
    return {
      url: `${origin}/c/${enc}`,
      title: `${ticker} on AtlasPad — 100% of creator fees held for the shop`,
      description: DESC,
      ...coinImage(coin, `${origin}/api/og/c/${enc}.png`),
    };
  }
  // a place link: once the place has a coin, the preview names it (the coin's metadata `website` points here)
  if (coin) {
    return {
      url: `${origin}/p/${enc}`,
      title: `$${coin.ticker} on AtlasPad — 100% of creator fees held for the shop`,
      description: DESC,
      ...coinImage(coin, `${origin}/api/og/p/${enc}.png`),
    };
  }
  return {
    url: `${origin}/p/${enc}`,
    title: 'This shop has no coin yet. First launch wins. — AtlasPad',
    description: DESC,
    ...coinImage(undefined, `${origin}/api/og/p/${enc}.png`),
  };
}

/**
 * Share meta for a real Worker: `/c/<mint>` looks the coin up by mint, `/p/<placeId>` by place (the coin's metadata
 * `website` points at /p/, so a launched place's link must preview its coin), with the art's stored pixel size.
 */
export async function coinShareMeta(env: Env, pathname: string): Promise<ShareMeta | null> {
  const cluster = realCluster(env);
  const origin = publicOrigin(env, cluster);
  const base = shareMetaFor(pathname, origin, undefined, !cluster);
  if (!base || !cluster || !env.DB) return base;
  const cm = /^\/c\/([^/?#]{32,44})\/?$/.exec(pathname);
  const mint = cm ? canonicalPubkey(cm[1]) : null;
  const pm = /^\/p\/([^/?#]{1,300})\/?$/.exec(pathname);
  let placeId: string | null = null;
  if (pm) {
    try {
      placeId = decodeURIComponent(pm[1]!);
    } catch {
      placeId = null;
    }
  }
  if (!mint && !placeId) return base;
  try {
    const where = mint ? 'coins.mint = ?1' : 'coins.place_id = ?1';
    const row = await env.DB.prepare(
      `SELECT coins.ticker, coins.image_id, assets.content_type, assets.width, assets.height FROM coins LEFT JOIN assets ON assets.id = coins.image_id
       WHERE ${where} AND coins.status = 'live' AND coins.cluster = ?2`,
    )
      .bind(mint ?? placeId, cluster)
      .first<{ ticker: string; image_id: string | null; content_type: string | null; width: number | null; height: number | null }>();
    if (!row) return base;
    const ext = row.content_type === 'image/png' ? 'png' : row.content_type === 'image/jpeg' ? 'jpg' : row.content_type === 'image/webp' ? 'webp' : null;
    return shareMetaFor(pathname, origin, {
      ticker: row.ticker,
      image: row.image_id && ext ? `${origin}/img/${row.image_id}.${ext}` : null,
      width: row.width,
      height: row.height,
    });
  } catch {
    return base;
  }
}

class SetAttr {
  constructor(
    private readonly attr: string,
    private readonly value: string,
  ) {}
  element(el: Element): void {
    el.setAttribute(this.attr, this.value);
  }
}

class SetText {
  constructor(private readonly value: string) {}
  element(el: Element): void {
    el.setInnerContent(this.value);
  }
}

class AppendMeta {
  constructor(private readonly meta: ShareMeta) {}
  element(el: Element): void {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    el.append(
      [
        `<link rel="canonical" href="${esc(this.meta.url)}">`,
        `<meta property="og:image" content="${esc(this.meta.image)}">`,
        `<meta property="og:image:width" content="${this.meta.imageWidth}">`,
        `<meta property="og:image:height" content="${this.meta.imageHeight}">`,
        '<meta property="og:image:alt" content="AtlasPad — launch a coin for any business on earth">',
        `<meta name="twitter:image" content="${esc(this.meta.image)}">`,
      ].join(''),
      { html: true },
    );
  }
}

/** Serve the SPA for a share URL with its meta rewritten. */
export async function handleSharePage(request: Request, assets: Fetcher, meta: ShareMeta): Promise<Response> {
  const indexUrl = new URL('/', request.url);
  const res = await assets.fetch(new Request(indexUrl.toString(), { method: 'GET', headers: request.headers }));
  const ct = res.headers.get('content-type') ?? '';
  // HTMLRewriter exists in the Workers runtime (not in unit tests under Node): serve the page as is.
  if (!res.ok || !ct.includes('text/html') || typeof HTMLRewriter === 'undefined') {
    if (!ct.includes('text/html')) return res;
    const plain = new Response(res.body, res);
    setPageSecurityHeaders(plain.headers);
    return plain;
  }
  const out = new HTMLRewriter()
    .on('title', new SetText(meta.title))
    .on('meta[property="og:url"]', new SetAttr('content', meta.url))
    .on('meta[property="og:title"]', new SetAttr('content', meta.title))
    .on('meta[property="og:description"]', new SetAttr('content', meta.description))
    .on('meta[name="description"]', new SetAttr('content', meta.description))
    .on('meta[name="twitter:card"]', new SetAttr('content', meta.card))
    .on('meta[name="twitter:title"]', new SetAttr('content', meta.title))
    .on('meta[name="twitter:description"]', new SetAttr('content', meta.description))
    .on('meta[property^="og:image"]', { element: (el) => void el.remove() })
    .on('meta[name="twitter:image"]', { element: (el) => void el.remove() })
    .on('link[rel="canonical"]', { element: (el) => void el.remove() })
    .on('head', new AppendMeta(meta))
    .transform(res);
  const headers = new Headers(out.headers);
  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  setPageSecurityHeaders(headers);
  return new Response(out.body, { status: 200, headers });
}

/**
 * Anti-clickjacking for every HTML page we serve (the SPA through public/_headers, the share pages here): the app must
 * never be framed by another site, because Launch / Buy / Claim are one click away (and the devnet test wallet signs
 * in-page). Only `frame-ancestors` is set in the CSP, so Google Maps, fonts and wallets are unaffected. HSTS keeps
 * browsers on https for a year after one visit (no downgrade to a plain-http copy of the wallet pages).
 */
export const PAGE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

export function setPageSecurityHeaders(h: Headers): void {
  for (const [k, v] of Object.entries(PAGE_SECURITY_HEADERS)) h.set(k, v);
}

/** `/api/og/(c|p)/<id>.png` → the static share card (PNG). */
export async function handleOgImage(request: Request, assets: Fetcher): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const res = await assets.fetch(new Request(new URL('/og.png', request.url).toString(), { method: request.method }));
  if (!res.ok) return new Response('Not found', { status: 404 });
  const headers = new Headers(res.headers);
  headers.set('content-type', 'image/png');
  headers.set('cache-control', 'public, max-age=3600');
  return new Response(res.body, { status: 200, headers });
}
