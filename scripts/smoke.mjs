#!/usr/bin/env node
/**
 * Read-only smoke test of a deployed real-mode Worker (INTEGRATION §3.6, §3.9, §10.2). Sends no transaction.
 *
 *   node scripts/smoke.mjs https://cornershop-devnet.tiejiucai.workers.dev --cluster devnet
 *   node scripts/smoke.mjs --cluster mainnet          (after go-mainnet; = the mainnet PUBLIC_ORIGIN, https://atlaspad.online)
 *   node scripts/smoke.mjs http://127.0.0.1:8787 --cluster devnet                         (wrangler dev)
 *   options: --json (report to scripts/out/) · --strict-latency (latency over budget fails instead of warns)
 *   Without an origin it smoke-tests the cluster's PUBLIC_ORIGIN (wrangler.jsonc, lib/origin.mjs).
 *
 * Asserts: /api/health ok (every check) · /api/config cluster/program/config/ALT/attestor/window match
 * deploy/<cluster>.json · /api/rpc getLatestBlockhash + getGenesisHash OK · getProgramAccounts → -32601 · parameter
 * rules → -32602 · oversized batch refused · cross-origin POST → 403 forbidden_origin · /api/dev/airdrop present on
 * devnet, 404 on mainnet · read endpoints shaped right · static assets immutable · canonical host (www, workers.dev and
 * plain http 301 pages to the origin, API calls on www / workers.dev get 421 wrong_host) · NO response (body or
 * header) contains a known secret value or a provider URL (in-memory compare; names only reported). Latency vs §8
 * budgets (measured from this machine, so it includes your network RTT).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDeploy } from './lib/deployJson.mjs';
import { Checks, fatal, head, info, parseArgs } from './lib/log.mjs';
import { canonicalAlternates, publicOrigin } from './lib/origin.mjs';
import { CONFIG_PDA, GENESIS, OUT_DIR, PROGRAM_ID } from './lib/paths.mjs';
import { findLeaks, knownSecrets, knownSeeds } from './lib/secrets.mjs';

/** Warm p50 budgets in ms (INTEGRATION §8, edge p95; we compare our warm median from this machine). */
export const LATENCY_MS = { config: 80, coins: 150, detail: 150, market: 250, feed: 120, top: 150, rpcOverhead: 40, health: 400 };

export function originOk(o) {
  try {
    const u = new URL(o);
    if (u.pathname !== '/' || u.search) return false;
    return (u.protocol === 'https:' && /\.workers\.dev$|^cornershop|(^|\.)atlaspad\.online$/.test(u.hostname)) || (u.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(u.hostname));
  } catch {
    return false;
  }
}

/** origin + cluster from argv: `--cluster mainnet` alone means the mainnet PUBLIC_ORIGIN; a devnet / atlaspad URL implies its cluster. */
export function smokeTarget(args, cfg) {
  const given = args._[0];
  let host = '';
  try {
    host = given ? new URL(given).hostname : '';
  } catch {
    /* originOk rejects it */
  }
  const cluster = args.cluster ?? (/^cornershop-devnet\./.test(host) ? 'devnet' : /(^|\.)atlaspad\.online$/.test(host) ? 'mainnet' : undefined);
  const origin = given ?? (cluster === 'devnet' || cluster === 'mainnet' ? publicOrigin(cluster, cfg) : undefined);
  return { origin, cluster };
}

/**
 * Canonical host (worker/canonical.ts): every other origin this Worker answers on (workers.dev, www of an apex domain)
 * 301s a page to the same path on `origin` and refuses the API with 421 wrong_host; plain http:// of a custom domain
 * 301s to https (the Worker or the zone's "Always Use HTTPS" may answer, so only the page is checked there). Nothing to
 * check for a workers.dev origin (devnet) or a local one.
 */
export async function checkCanonical({ call, origin, cluster, checks }) {
  if (!/^https:/.test(origin)) return;
  const alternates = canonicalAlternates(origin, cluster);
  const plain = new URL(origin).hostname.endsWith('.workers.dev') ? null : origin.replace(/^https:/, 'http:');
  if (!alternates.length && !plain) return;
  head('canonical host (worker/canonical.ts)');
  const want = `${origin}/c/smoke?x=1`;
  for (const alt of plain ? [...alternates, plain] : alternates) {
    const page = await call(`${alt}/c/smoke?x=1`, { raw: true });
    checks.check(page.status === 301 && page.headers.get('location') === want, `${alt} page → 301 ${origin}`, `HTTP ${page.status} ${page.headers.get('location') ?? ''}`);
    if (alt === plain) continue;
    const api = await call(`${alt}/api/health`);
    checks.check(api.status === 421 && api.json?.error === 'wrong_host', `${alt}/api → 421 wrong_host`, `HTTP ${api.status} ${api.json?.error ?? ''}`);
  }
}

/**
 * H6: `/api/dev/airdrop` answers on devnet only. A mainnet bundle has no dev route at all, so the Worker answers 404
 * `not_found` (unknown API route); `not_enabled` (a build that registers the route but refuses it) is accepted too.
 */
export function checkDevRoute({ res, cluster, checks }) {
  const detail = `HTTP ${res.status} ${res.json?.error ?? ''}`.trim();
  if (cluster === 'mainnet') checks.check(res.status === 404 && ['not_found', 'not_enabled'].includes(res.json?.error), '/api/dev/airdrop is 404 on mainnet', detail);
  else checks.check(res.status !== 404, '/api/dev/airdrop exists on devnet', detail);
}

export function makeClient(origin) {
  const bodies = [];
  async function call(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
    const t0 = performance.now();
    const res = await fetch(new URL(path, origin), {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    bodies.push(`${path}\n${[...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${text}`);
    let json = null;
    if (!raw) {
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
    }
    return { status: res.status, headers: res.headers, text, json, ms };
  }
  return { call, bodies };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};

export async function smoke({ origin, cluster, strictLatency = false }) {
  const checks = new Checks();
  const { call, bodies } = makeClient(origin);
  const dep = readDeploy(cluster) ?? {};
  const report = { origin, cluster, at: new Date().toISOString(), latency: {} };
  const post = (path, body, extra = {}) => call(path, { method: 'POST', body, headers: { origin, ...extra } });
  const rpc = (method, params = [], extra) => post('/api/rpc', { jsonrpc: '2.0', id: 1, method, params }, extra);
  const latency = async (name, fn, n = 3) => {
    const runs = [];
    let last;
    for (let i = 0; i < n; i++) {
      last = await fn();
      runs.push(last.ms);
    }
    const warm = median(runs.slice(1));
    report.latency[name] = Math.round(warm);
    const budget = LATENCY_MS[name];
    if (budget !== undefined && last.status === 200) {
      const okLat = warm <= budget;
      if (okLat) checks.pass(`latency ${name}`, `${Math.round(warm)} ms warm (budget ${budget} ms)`);
      else if (strictLatency) checks.fail(`latency ${name}`, `${Math.round(warm)} ms warm > ${budget} ms`);
      else checks.warn(`latency ${name}`, `${Math.round(warm)} ms warm > ${budget} ms (includes this machine's RTT)`);
    }
    return last;
  };

  // ------------------------------------------------------------------------------------------ health
  head('health + config');
  const h = await call('/api/health');
  report.health = h.json;
  if (h.status === 421 && h.json?.error === 'wrong_host') checks.fail('/api/health', `this host is not the canonical one: smoke ${h.json.origin ?? 'the PUBLIC_ORIGIN'} instead`);
  else if (h.status !== 200 || !h.json) checks.fail('/api/health', `HTTP ${h.status}`);
  else if (!h.json.checks) checks.fail('/api/health', 'no real-mode checks (is this the Phase-1 demo Worker?)');
  else {
    for (const [k, v] of Object.entries(h.json.checks ?? {})) {
      // devnet: a low faucet only stops airdrops (the test wallet still works), so it warns instead of failing
      const benign =
        v === 'ok' || v === 'n/a' || ((k === 'turnstile' || k === 'phone') && cluster === 'devnet' && v !== 'error' && v !== 'mismatch') || (k === 'faucet' && cluster === 'devnet' && v === 'stale');
      if (v === 'ok' || v === 'n/a') checks.pass(`health.${k}`, v);
      else if (benign) checks.warn(`health.${k}`, v);
      else checks.fail(`health.${k}`, v);
    }
    checks.check(h.json.ok === true, '/api/health ok', `cluster ${h.json.cluster} · build ${h.json.buildId} · indexer lag ${h.json.indexerLagSec ?? '—'} s · SOL/USD age ${h.json.solUsdAgeSec ?? '—'} s`);
    checks.check(h.json.cluster === cluster, 'health.cluster', h.json.cluster);
  }

  const c = await latency('config', () => call('/api/config'));
  const cfg = c.json;
  report.config = cfg;
  if (c.status !== 200 || !cfg) checks.fail('/api/config', `HTTP ${c.status}`);
  else {
    checks.check(cfg.cluster === cluster, 'config.cluster', cfg.cluster);
    checks.check(cfg.genesisHash === GENESIS[cluster], 'config.genesisHash', cfg.genesisHash);
    checks.check(cfg.programId === PROGRAM_ID, 'config.programId', cfg.programId);
    checks.check(cfg.configPda === CONFIG_PDA, 'config.configPda', cfg.configPda);
    checks.check(new URL(cfg.publicOrigin).origin === new URL(origin).origin || /^http:/.test(origin), 'config.publicOrigin', cfg.publicOrigin);
    if (dep.alt) checks.check(cfg.alt === dep.alt, 'config.alt = deploy json', cfg.alt);
    else checks.warn('config.alt', `deploy/${cluster}.json has no alt to compare (${cfg.alt})`);
    if (dep.attestor) checks.check(cfg.attestor === dep.attestor, 'config.attestor = deploy json', cfg.attestor);
    if (dep.claimWindowSecs) checks.check(cfg.claimWindowSecs === dep.claimWindowSecs, 'config.claimWindowSecs', String(cfg.claimWindowSecs));
    checks.check(cluster === 'devnet' ? cfg.claimWindowSecs >= 60 : cfg.claimWindowSecs >= 259_200, 'claim window within the build bounds', `${cfg.claimWindowSecs} s`);
    const phone = cfg.features?.phoneVerification;
    if (cluster === 'devnet') checks.check(phone === 'screen', 'features.phoneVerification = screen (devnet)', phone);
    else if (phone === 'none') checks.warn('features.phoneVerification', 'none: phone calls are off, owners verify with a website code (add the TWILIO_* secrets to switch calls on)');
    else checks.check(phone === 'call', 'features.phoneVerification = call (Twilio)', phone);
    if (cluster === 'mainnet') checks.check(cfg.features?.testWallet === false, 'features.testWallet off on mainnet', String(cfg.features?.testWallet));
    else {
      // the test wallet never depends on the faucet; only airdrops do
      checks.check(cfg.features?.testWallet === true, 'features.testWallet on (devnet)', String(cfg.features?.testWallet));
      if (cfg.features?.faucet === false) checks.warn('features.faucet', 'the dev faucet is below 0.3 SOL: airdrops refuse until it is refilled (RUNBOOK)');
    }
    if (cluster === 'mainnet') checks.check(!cfg.features?.faucet, 'features.faucet off on mainnet', String(cfg.features?.faucet));
    checks.check(cfg.features?.privy === false || !!cfg.features?.privy, 'features.privy reported', String(cfg.features?.privy));
    const ex = cfg.explorer ?? {};
    const devQ = (s) => typeof s === 'string' && s.includes('cluster=devnet');
    checks.check(cluster === 'devnet' ? devQ(ex.tx) && devQ(ex.address) && devQ(ex.token) : !devQ(ex.tx) && !devQ(ex.address) && !devQ(ex.token), 'explorer templates match the cluster', ex.tx);
    if (cfg.solUsd === null) checks.warn('config.solUsd', 'null (price cron not run yet?)');
    else checks.pass('config.solUsd', `$${cfg.solUsd} at ${cfg.solUsdAt ? new Date(cfg.solUsdAt).toISOString() : '—'}`);
    if (cfg.launchesPaused) checks.warn('launches paused', 'Config.paused = 1');
    const cc = c.headers.get('cache-control') ?? '';
    checks.check(/max-age=30/.test(cc), '/api/config cache-control', cc);
  }

  // ------------------------------------------------------------------------------------------ rpc proxy
  head('/api/rpc');
  const bh = await latency('rpc', () => rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]));
  checks.check(typeof bh.json?.result?.value?.blockhash === 'string', 'getLatestBlockhash', bh.json?.result?.value?.blockhash ?? `HTTP ${bh.status} ${bh.text.slice(0, 80)}`);
  const gh = await rpc('getGenesisHash');
  checks.check(gh.json?.result === GENESIS[cluster], 'getGenesisHash via proxy', gh.json?.result);
  const gpa = await rpc('getProgramAccounts', [PROGRAM_ID]);
  checks.check(gpa.json?.error?.code === -32601, 'getProgramAccounts refused (-32601)', JSON.stringify(gpa.json?.error ?? gpa.status));
  const sst = await rpc('getSignatureStatuses', [['1111111111111111111111111111111111111111111111111111111111111111'], { searchTransactionHistory: true }]);
  checks.check(sst.json?.error?.code === -32602, 'searchTransactionHistory:true refused (-32602)', JSON.stringify(sst.json?.error ?? sst.status));
  const sfa = await rpc('getSignaturesForAddress', [PROGRAM_ID, { limit: 1000 }]);
  checks.check(sfa.json?.error?.code === -32602, 'getSignaturesForAddress limit > 25 refused (-32602)', JSON.stringify(sfa.json?.error ?? sfa.status));
  const batch = Array.from({ length: 11 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'getSlot', params: [] }));
  const big = await post('/api/rpc', batch);
  const bigOk = big.status === 200 && Array.isArray(big.json) && big.json.length === 11 && big.json.every((r) => 'result' in r);
  checks.check(!bigOk, 'batch of 11 refused (max 10)', `HTTP ${big.status}`);
  const xo = await rpc('getSlot', [], { origin: 'https://evil.example' });
  checks.check(xo.status === 403 && xo.json?.error === 'forbidden_origin', 'cross-origin POST → 403 forbidden_origin', `HTTP ${xo.status} ${xo.json?.error ?? ''}`);
  if (typeof bh.json?.result?.value?.blockhash === 'string') {
    const t = [];
    for (let i = 0; i < 3; i++) t.push((await rpc('getGenesisHash')).ms);
    report.latency.rpcCached = Math.round(median(t.slice(1)));
    info(`cached RPC method (getGenesisHash): ${report.latency.rpcCached} ms warm — proxy overhead upper bound`);
  }

  // ------------------------------------------------------------------------------------------ dev route
  head('/api/dev/airdrop (H6)');
  checkDevRoute({ res: await post('/api/dev/airdrop', { address: 'not-an-address' }), cluster, checks });

  // ------------------------------------------------------------------------------------------ reads
  head('read endpoints');
  const coins = await latency('coins', () => call('/api/coins?sort=new&limit=5'));
  checks.check(coins.status === 200 && Array.isArray(coins.json?.coins), '/api/coins?sort=new', `${coins.json?.coins?.length ?? '—'} coin(s)`);
  const top = await latency('top', () => call('/api/top?by=mcap&limit=5'));
  checks.check(top.status === 200 && Array.isArray(top.json?.coins), '/api/top?by=mcap', `${top.json?.coins?.length ?? '—'} coin(s)`);
  const feed = await latency('feed', () => call('/api/feed?limit=5'));
  checks.check(feed.status === 200 && Array.isArray(feed.json?.events), '/api/feed', `${feed.json?.events?.length ?? '—'} event(s)`);
  const first = coins.json?.coins?.[0];
  if (first) {
    const m = await latency('market', () => call(`/api/market?mints=${first.mint}`));
    checks.check(m.status === 200 && m.json?.quotes?.[first.mint], '/api/market', `${first.ticker} ${m.json?.quotes?.[first.mint]?.priceLamports ?? '—'} lamports/token`);
    const d = await latency('detail', () => call(`/api/coins/${first.mint}`));
    checks.check(d.status === 200 && d.json?.mint === first.mint && Array.isArray(d.json?.history), '/api/coins/:mint', `${d.json?.trades?.length ?? '—'} trade(s), ${d.json?.history?.length ?? '—'} history buckets`);
    for (const [k, v] of Object.entries({ mcap: d.json?.market?.mcapLamports, waiting: d.json?.fees?.waitingLamports, earned: d.json?.fees?.earnedLamports })) {
      checks.check(typeof v === 'string' && /^\d+$/.test(v), `u64 ${k} is a decimal string`, String(v));
    }
    const pl = await call(`/api/place/${encodeURIComponent(first.placeId)}`);
    checks.check(pl.status === 200 && pl.json?.coin?.mint === first.mint, '/api/place/:placeId', first.placeId);
  } else info('registry is empty: /api/market, /api/coins/:mint and /api/place skipped');
  const nf = await call('/api/coins/11111111111111111111111111111111');
  checks.check(nf.status === 404 || nf.status === 400, 'unknown mint → 404/400', `HTTP ${nf.status}`);

  // ------------------------------------------------------------------------------------------ static
  head('static assets');
  const root = await call('/', { raw: true });
  checks.check(root.status === 200 && /<div id="root"|<html/i.test(root.text), 'GET / serves the app shell', `HTTP ${root.status}`);
  const asset = /\/assets\/[A-Za-z0-9._-]+\.js/.exec(root.text)?.[0];
  if (asset) {
    const a = await call(asset, { raw: true });
    const cc = a.headers.get('cache-control') ?? '';
    if (/immutable/.test(cc)) checks.pass('/assets/* immutable', cc);
    else checks.warn('/assets/* cache-control', cc || '(none) — public/_headers missing?');
  }

  // ------------------------------------------------------------------------------------------ canonical host
  await checkCanonical({ call, origin, cluster, checks });

  // ------------------------------------------------------------------------------------------ leaks
  head('leak scan of every response (in memory)');
  const all = bodies.join('\n\n');
  const leaks = findLeaks(Buffer.from(all), knownSecrets(), knownSeeds());
  checks.check(!leaks.length, 'no secret value in any response', leaks.length ? leaks.join(', ') : `${bodies.length} responses`);
  for (const u of ['g.alchemy.com', 'helius-rpc.com']) checks.check(!all.includes(u), `no ${u} in any response`);

  report.checks = checks.toJSON();
  return { checks, report };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['json', 'strict-latency']);
  const { origin, cluster } = smokeTarget(args);
  if (!origin || !originOk(origin) || !['devnet', 'mainnet'].includes(cluster)) {
    console.error('usage: node scripts/smoke.mjs [<https://atlaspad.online | https://…workers.dev | http://127.0.0.1:8787>] --cluster devnet|mainnet [--json] [--strict-latency]');
    process.exit(64);
  }
  head(`smoke · ${origin} · ${cluster}`);
  const { checks, report } = await smoke({ origin: new URL(origin).origin, cluster, strictLatency: !!args['strict-latency'] });
  const green = checks.summary('smoke');
  if (args.json) {
    mkdirSync(OUT_DIR, { recursive: true });
    const p = join(OUT_DIR, `smoke-${cluster}-${report.at.replace(/[-:]/g, '').slice(0, 15)}.json`);
    writeFileSync(p, JSON.stringify(report, null, 2));
    info(`report: ${p}`);
  }
  process.exit(green ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fatal(e.message));
}
