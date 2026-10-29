/**
 * Phase-2 router (INTEGRATION §3.1). Returns null for paths it does not own, so the Phase-1 routes in worker/api.ts
 * keep working unchanged on every Worker (`?mode=demo` on devnet uses them). On the demo Worker (`vars.CLUSTER` unset,
 * `__CS_CLUSTER__ === 'demo'`) every Phase-2 route answers 404 not_enabled.
 */
import { handleClaimCall, handleClaimCheck, handleClaimConfirm, handleClaimCosign, handleClaimStatus, handleClaimWebsite, handleReport } from './claims';
import { handleConfig, handleHealth, handleIndexTx } from './configRoute';
import { handleApi, listingLookupCallsGoogle, type Env as Phase1Env } from './api';
import { cap, cronPeriodMs, DAY, defaultDeps, limit, makeRpcFactory, type Ctx, type Deps } from './ctx';
import { publicOrigin, realCluster, type Env } from './env';
import { spendGoogleLookup } from './google';
import { ipHash } from './hmac';
import { ApiErr, errorResponse, json, originAllowed } from './http';
import { runIndexer } from './indexer';
import { handleLaunchConfirm, handleLaunchCosign, handleLaunchPrepare } from './launch';
import { errMsg, makeLogger } from './log';
import { handleMetadataUpload, serveImage, serveMeta } from './metadata';
import { metaSnapshot } from './meta';
import { handleCoinDetail, handleCoins, handleEligibility, handleFeed, handleMarket, handlePlace, handleTop } from './reads';
import { handleRpc } from './rpcProxy';
import { BudgetExceeded, RpcError, UpstreamError } from './solana';

type Handler = (ctx: Ctx, request: Request, url: URL, m: RegExpExecArray) => Promise<Response>;

interface Route {
  method: 'GET' | 'POST';
  re: RegExp;
  h: Handler;
}

const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const BASE_ROUTES: Route[] = [
  { method: 'GET', re: /^\/api\/config$/, h: (c) => withFallbackIndexer(c, handleConfig(c)) },
  { method: 'GET', re: /^\/api\/health$/, h: (c) => withFallbackIndexer(c, handleHealth(c)) },
  { method: 'GET', re: /^\/api\/coins$/, h: (c, _r, u) => handleCoins(c, u) },
  { method: 'GET', re: /^\/api\/coins\/([^/]+)$/, h: (c, _r, u, m) => handleCoinDetail(c, m[1]!, u) },
  { method: 'GET', re: /^\/api\/market$/, h: (c, _r, u) => withFallbackIndexer(c, handleMarket(c, u)) },
  { method: 'GET', re: /^\/api\/top$/, h: (c, _r, u) => handleTop(c, u) },
  { method: 'GET', re: /^\/api\/feed$/, h: (c, _r, u) => withFallbackIndexer(c, handleFeed(c, u)) },
  { method: 'GET', re: /^\/api\/place\/([^/]+)\/eligibility$/, h: (c, _r, _u, m) => handleEligibility(c, dec(m[1]!)) },
  { method: 'GET', re: /^\/api\/place\/([^/]+)$/, h: (c, _r, _u, m) => handlePlace(c, dec(m[1]!)) },
  { method: 'GET', re: /^\/api\/claim\/status$/, h: (c, _r, u) => withFallbackIndexer(c, handleClaimStatus(c, u)) },
  { method: 'POST', re: /^\/api\/metadata$/, h: (c, r) => handleMetadataUpload(c, r) },
  { method: 'POST', re: /^\/api\/launch\/prepare$/, h: (c, r) => handleLaunchPrepare(c, r) },
  { method: 'POST', re: /^\/api\/launch\/cosign$/, h: (c, r) => handleLaunchCosign(c, r) },
  { method: 'POST', re: /^\/api\/launch\/confirm$/, h: (c, r) => handleLaunchConfirm(c, r) },
  { method: 'POST', re: /^\/api\/index\/tx$/, h: (c, r) => handleIndexTx(c, r) },
  { method: 'POST', re: /^\/api\/claim\/call$/, h: (c, r) => handleClaimCall(c, r) },
  { method: 'POST', re: /^\/api\/claim\/check$/, h: (c, r) => handleClaimCheck(c, r) },
  { method: 'POST', re: /^\/api\/claim\/cosign$/, h: (c, r) => handleClaimCosign(c, r) },
  { method: 'POST', re: /^\/api\/claim\/confirm$/, h: (c, r) => handleClaimConfirm(c, r) },
  { method: 'POST', re: /^\/api\/claim\/website$/, h: (c, r) => handleClaimWebsite(c, r) },
  { method: 'POST', re: /^\/api\/claim\/manual$/, h: (c, r) => handleReport(c, r, 'manual_claim') },
  { method: 'POST', re: /^\/api\/report$/, h: (c, r) => handleReport(c, r) },
  { method: 'POST', re: /^\/api\/rpc$/, h: (c, r) => handleRpc(c, r) },
  // Phase-1 listing lookups (masked phone + website host; Places API Enterprise fields on the server key): on real
  // Workers they sit behind the Workers rate-limit binding, a durable per-IP daily cap and the global daily Google
  // budget (spent only when the lookup will really call Google), then run unchanged.
  { method: 'GET', re: /^\/api\/(claim\/phone|listing\/[^/]+)$/, h: (c, r) => handleListingLookup(c, r) },
];

const LISTING_LOOKUPS_PER_DAY = 60;

async function handleListingLookup(ctx: Ctx, request: Request): Promise<Response> {
  await limit(ctx.env.RL_GOOGLE, `google:${ctx.ipHash}`);
  await cap(ctx.db, `listing:ip:${ctx.ipHash}`, LISTING_LOOKUPS_PER_DAY, DAY, ctx.deps.now(), 'rate_limited', 'Too many lookups today. Try again tomorrow.');
  if (listingLookupCallsGoogle(new URL(request.url))) await spendGoogleLookup(ctx);
  return handleApi(request, ctx.env as unknown as Phase1Env);
}
let routeTable: Route[] | null = null;

/**
 * DEVNET ONLY (H6): `/api/dev/airdrop` is registered only in builds with dev endpoints; mainnet bundles do not
 * contain the route at all (the path is unknown there and answers 404).
 */
function routes(): Route[] {
  if (routeTable) return routeTable;
  const t = [...BASE_ROUTES];
  try {
    if (__CS_DEV_ENDPOINTS__) t.push({ method: 'POST', re: /^\/api\/dev\/airdrop$/, h: (c, r) => devAirdrop(c, r) });
  } catch {
    /* unit tests without the compile-time define */
  }
  routeTable = t;
  return t;
}

/** Paths that are Phase-1 routes on the demo Worker (kept there with their Phase-1 behaviour). */
const PHASE1_ON_DEMO = /^\/api\/(health|resolve|claim\/phone|listing\/|claim\/start|claim\/verify|og\/)/;

async function devAirdrop(ctx: Ctx, request: Request): Promise<Response> {
  if (__CS_DEV_ENDPOINTS__) {
    if (ctx.cluster !== 'devnet') throw new ApiErr('not_enabled', 'Not available');
    const m = await import('./dev/airdrop');
    return m.handleDevAirdrop(ctx, request);
  }
  throw new ApiErr('not_enabled', 'Not available');
}

/**
 * When the cron is unavailable (account limit, or a schedule that has not started firing yet), read requests drive the
 * indexer (§3.7): /api/market, /api/feed, /api/config (every open client polls it each minute), /api/health (so an
 * external uptime pinger keeps the indexer alive) and /api/claim/status (pending claims get finalized). Gated by
 * `indexer_last_run` (1.5 cron periods: 90 s on mainnet, 7.5 min on devnet, so a working cron is never doubled) and the
 * indexer's own D1 lock, so concurrent viewers never double-run it.
 */
async function withFallbackIndexer(ctx: Ctx, res: Promise<Response>): Promise<Response> {
  const out = await res;
  try {
    const snap = await metaSnapshot(ctx);
    const now = ctx.deps.now();
    if ((snap.indexerLastRun ?? 0) < now - 1.5 * cronPeriodMs(ctx.cluster)) ctx.waitUntil(runIndexer(ctx, { budget: 20, reason: 'request-fallback' }).catch(() => undefined));
  } catch {
    /* ignore */
  }
  return out;
}

export interface ExecCtx {
  waitUntil(p: Promise<unknown>): void;
}

export async function buildCtx(env: Env, exec: ExecCtx, deps: Deps, ip: string): Promise<Ctx | null> {
  const cluster = realCluster(env);
  if (!cluster || !env.DB) return null;
  const log = makeLogger(env, { cluster });
  return {
    env,
    cluster,
    db: env.DB,
    deps,
    log,
    origin: publicOrigin(env, cluster),
    ipHash: await ipHash(env, ip),
    waitUntil: (p) => exec.waitUntil(p.catch((e) => log.warn('waitUntil.failed', { error: errMsg(e) }))),
    rpc: makeRpcFactory(env, cluster, deps),
  };
}

/**
 * Handles a Phase-2 path, or returns null (Phase-1 / static). `/meta/*` and `/img/*` are served here too.
 */
export async function handlePhase2(request: Request, env: Env, exec: ExecCtx, deps: Deps = defaultDeps()): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const isMeta = /^\/(meta|img)\//.test(path);
  const route = routes().find((r) => r.re.test(path));
  if (!route && !isMeta) return null;
  const cluster = realCluster(env);
  if (!cluster) {
    if (PHASE1_ON_DEMO.test(path)) return null; // demo Worker: Phase-1 behaviour
    if (isMeta) return new Response('Not found', { status: 404 });
    return errorResponse(new ApiErr('not_enabled', 'Not available on this site'));
  }
  if (!env.DB) return errorResponse(new ApiErr('not_configured', 'Database not configured'));
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const ctx = (await buildCtx(env, exec, deps, ip))!;
  try {
    if (isMeta) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
      const head = request.method === 'HEAD';
      let m = /^\/meta\/([0-9a-f]{32})\.json$/.exec(path);
      if (m) return await serveMeta(ctx.db, m[1]!, head);
      m = /^\/img\/([0-9a-f]{32})\.(png|jpg|webp)$/.exec(path);
      if (m) return await serveImage(ctx.db, m[1]!, m[2]!, head);
      return new Response('Not found', { status: 404 });
    }
    const all = routes().filter((r) => r.re.test(path));
    const r = all.find((x) => x.method === request.method || (x.method === 'GET' && request.method === 'HEAD'));
    if (!r) return json({ error: 'method_not_allowed' }, 405, 'no-store', { allow: [...new Set(all.map((x) => x.method))].join(', ') });
    if ((request.method === 'POST' || path === '/api/rpc') && !originAllowed(request, ctx.origin, devOrigins())) {
      throw new ApiErr('forbidden_origin', 'Forbidden');
    }
    return await r.h(ctx, request, url, r.re.exec(path)!);
  } catch (e) {
    if (e instanceof ApiErr) {
      if (e.status >= 500) ctx.log.warn('api.error', { path, code: e.code });
      return errorResponse(e);
    }
    if (e instanceof BudgetExceeded) return errorResponse(new ApiErr('unavailable', 'Busy. Try again in a moment.', { retryAfterSec: 2 }));
    if (e instanceof UpstreamError || e instanceof RpcError) {
      ctx.log.warn('api.upstream', { path, error: errMsg(e) });
      return errorResponse(new ApiErr('upstream', "We couldn't reach the network. Try again."));
    }
    ctx.log.error('api.unhandled', { path, error: errMsg(e) });
    return errorResponse(new ApiErr('upstream', 'Something went wrong. Try again.'));
  }
}

function devOrigins(): boolean {
  try {
    return __CS_DEV_ENDPOINTS__ === true;
  } catch {
    return false;
  }
}
