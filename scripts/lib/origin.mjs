/**
 * The public (canonical) origin of each cluster's site, as the OPS scripts use it: smoke / watchdog default base URL,
 * the go-mainnet smoke step and the Google referrer it asks you to confirm. Source of truth is wrangler.jsonc
 * env.<cluster>.vars.PUBLIC_ORIGIN (the value the Worker writes into coin metadata and redirects to,
 * worker/canonical.ts); lib/paths.mjs ORIGINS is the fallback (mainnet: https://atlaspad.online).
 */
import { promises as dns } from 'node:dns';
import { ORIGINS, WORKERS_DEV_ORIGINS } from './paths.mjs';
import { envConfig, readWranglerConfig } from './wrangler.mjs';

/** A bare https origin (no path, port, query or trailing slash), the same rule as worker/env.ts publicOrigin. */
export function isBareHttpsOrigin(o) {
  return typeof o === 'string' && /^https:\/\/[a-z0-9.-]+$/.test(o);
}

/** env.<cluster>.vars.PUBLIC_ORIGIN when it is a bare https origin, else ORIGINS[cluster]. Never throws. */
export function publicOrigin(cluster, cfg) {
  try {
    const o = envConfig(cluster, cfg ?? readWranglerConfig())?.vars?.PUBLIC_ORIGIN?.trim();
    if (isBareHttpsOrigin(o)) return o;
  } catch {
    /* unreadable wrangler.jsonc: fall back */
  }
  return ORIGINS[cluster];
}

/**
 * Other origins the same Worker answers on, which must redirect pages to `origin` (and refuse API calls): the
 * cluster's workers.dev host, and `www.` of an apex custom domain. Empty for devnet (its origin IS workers.dev).
 */
export function canonicalAlternates(origin, cluster) {
  const out = [];
  const host = new URL(origin).hostname;
  const wd = WORKERS_DEV_ORIGINS[cluster];
  if (wd && new URL(wd).hostname !== host) out.push(wd);
  if (!host.endsWith('.workers.dev') && host.split('.').length === 2) out.push(`https://www.${host}`);
  return out;
}

/**
 * wrangler.jsonc problems for serving `env` at its PUBLIC_ORIGIN: the origin must be a bare https origin, and a custom
 * domain needs `routes` entries with `custom_domain: true` for the host (and www, which redirects to it) plus a
 * `run_worker_first` that sends page paths to the Worker (or the redirect never runs). Empty = ok.
 */
export function originProblems(env, cfg) {
  const e = envConfig(env, cfg ?? readWranglerConfig());
  if (!e) return [`wrangler.jsonc has no env.${env}`];
  const o = e.vars?.PUBLIC_ORIGIN;
  if (!isBareHttpsOrigin(o)) return [`env.${env}.vars.PUBLIC_ORIGIN must be a bare https origin like https://atlaspad.online, got ${JSON.stringify(o)}`];
  const host = new URL(o).hostname;
  if (host.endsWith('.workers.dev')) return [];
  const p = [];
  const domains = new Set((e.routes ?? []).filter((r) => r && typeof r === 'object' && r.custom_domain === true).map((r) => r.pattern));
  for (const h of [host, ...canonicalAlternates(o, env).filter((a) => !a.endsWith('.workers.dev')).map((a) => new URL(a).hostname)]) {
    if (!domains.has(h)) p.push(`env.${env}.routes has no { "pattern": "${h}", "custom_domain": true }`);
  }
  const rwf = e.assets?.run_worker_first;
  if (rwf !== true && !(Array.isArray(rwf) && rwf.includes('/*'))) p.push(`env.${env}.assets.run_worker_first must route pages ("/*") to the Worker so www / workers.dev redirect to ${o}`);
  return p;
}

/**
 * Read-only DNS check (go-mainnet preflight) that a custom domain's zone is live on Cloudflare: its nameservers are
 * `*.ns.cloudflare.com`. `wrangler deploy` uploads the Worker BEFORE it attaches the Custom Domains, so a zone that is
 * not active would leave workers.dev redirecting to a domain that serves nothing. Walks up from the host to the zone
 * apex. Empty = ok; a workers.dev origin needs no zone. `resolveNs` is injectable for tests.
 */
export async function zoneProblems(origin, resolveNs = (h) => dns.resolveNs(h)) {
  const host = new URL(origin).hostname;
  if (host.endsWith('.workers.dev')) return [];
  let lastErr = null;
  for (let h = host; h.includes('.'); h = h.slice(h.indexOf('.') + 1)) {
    let ns;
    try {
      ns = await resolveNs(h);
    } catch (e) {
      lastErr = e;
      continue; // no NS here (a subdomain): try the parent
    }
    if (!ns?.length) continue;
    if (ns.every((n) => /\.ns\.cloudflare\.com\.?$/i.test(n))) return [];
    return [`${h} is not on Cloudflare yet: its nameservers are ${ns.join(', ')} (set the two *.ns.cloudflare.com ones at the registrar)`];
  }
  return [`no nameservers found for ${host}${lastErr ? ` (${lastErr.code ?? lastErr.message})` : ''}: is the domain registered and its zone added to Cloudflare?`];
}
