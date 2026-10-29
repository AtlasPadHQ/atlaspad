/**
 * Canonical host. AtlasPad is served at PUBLIC_ORIGIN only (mainnet: https://atlaspad.online). The mainnet Worker also
 * answers on www.atlaspad.online and cornershop.tiejiucai.workers.dev (wrangler.jsonc env.mainnet `routes` +
 * `workers_dev`), so links, share previews, wallet sessions and the Google key referrer all stay on one origin:
 *
 *  - GET / HEAD of a page (anything outside /api) on another origin → 301 to the same path and query on PUBLIC_ORIGIN.
 *    That includes /c/*, /p/* share pages and /meta/*, /img/* coin metadata (crawlers and wallets follow it).
 *  - /api/* (and any other method) on another origin → JSON `421 wrong_host` naming the right origin. Never redirected:
 *    a redirected POST loses its body, and the Origin rule (worker/http.ts) ties writes to PUBLIC_ORIGIN anyway.
 *
 * "Another origin" is the whole origin, not just the host: plain http://atlaspad.online and Cloudflare's alternate
 * HTTPS ports (:8443 …) also reach a Custom Domain, and the app must never run there (no TLS for wallet signing, and its
 * Origin header would not match PUBLIC_ORIGIN).
 *
 * No-op when PUBLIC_ORIGIN is unset (the Phase-1 demo Worker) and for local hosts (`wrangler dev`, the Vite proxy).
 * Devnet's PUBLIC_ORIGIN is its own workers.dev host, so devnet only ever upgrades plain-http requests.
 *
 * The Worker only sees what `assets.run_worker_first` routes to it: env.mainnet routes every path except the hashed
 * /assets/* files, so www and workers.dev page loads reach this check.
 */
import type { Env } from './env';
import { json } from './http';

/** 301s are cached by browsers; a day bounds the damage of a misconfigured PUBLIC_ORIGIN. */
const REDIRECT_CACHE = 'public, max-age=86400';

/** PUBLIC_ORIGIN when it is a bare https origin (same rule as worker/env.ts publicOrigin), else null. */
export function canonicalOrigin(env: Pick<Env, 'PUBLIC_ORIGIN'>): string | null {
  const o = env.PUBLIC_ORIGIN?.trim();
  return o && /^https:\/\/[a-z0-9.-]+$/.test(o) ? o : null;
}

/** localhost, 127.0.0.1, [::1] and *.localhost: local `wrangler dev` runs, never a Cloudflare route. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

/** Response for a request on a non-canonical origin (301 or JSON 421), or null to handle it normally. */
export function canonicalHostResponse(request: Request, env: Pick<Env, 'PUBLIC_ORIGIN'>): Response | null {
  const origin = canonicalOrigin(env);
  if (!origin) return null;
  const url = new URL(request.url);
  if (url.origin === origin || isLocalHost(url.hostname)) return null;
  const api = url.pathname === '/api' || url.pathname.startsWith('/api/');
  if (!api && (request.method === 'GET' || request.method === 'HEAD')) {
    const headers: Record<string, string> = { location: `${origin}${url.pathname}${url.search}`, 'cache-control': REDIRECT_CACHE };
    // coin metadata and art are fetched cross-origin by wallets and launchpads: the redirect must pass CORS like them
    if (/^\/(meta|img)\//.test(url.pathname)) headers['access-control-allow-origin'] = '*';
    return new Response(null, { status: 301, headers });
  }
  return json({ error: 'wrong_host', message: `AtlasPad answers only at ${origin}. Use that address.`, origin }, 421);
}
