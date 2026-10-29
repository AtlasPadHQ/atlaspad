/**
 * CORNERSHOP Worker (Cloudflare Workers + static assets). One codebase, three deployments (wrangler.jsonc):
 * the Phase-1 demo `cornershop` (top level), `cornershop-devnet` (env.devnet) and the future mainnet flip
 * (env.mainnet). See INTEGRATION.md §1.4 / §3.
 *
 * `run_worker_first` sends /api/*, /c/*, /p/* here on the demo Worker, and every path except plain static files on the
 * real Workers (the sanctions geo-block, worker/geo.ts, then the canonical-host redirect, worker/canonical.ts, run
 * first); everything else is served from the static assets with SPA fallback.
 *  - Phase-2 routes (real mode: registry, market, launch, claims, RPC proxy, metadata) → worker/router.ts
 *  - Phase-1 routes (/api/resolve, /api/claim/phone, simulated claims, …)              → worker/api.ts
 *  - /api/og/(c|p)/<id>.png share image, /c/<id> and /p/<id> share pages               → worker/share.ts
 *  - scheduled(): the indexer cron (worker/indexer.ts), real Workers only
 *
 * Secrets never leave the Worker (INTEGRATION H2); see worker/env.ts for who reads which.
 */
import { handleApi, type Env as Phase1Env } from './api';
import { canonicalHostResponse } from './canonical';
import { defaultDeps } from './ctx';
import { realCluster, type Env } from './env';
import { geoBlock } from './geo';
import { runIndexer } from './indexer';
import { errMsg, makeLogger } from './log';
import { buildCtx, handlePhase2 } from './router';
import { coinShareMeta, handleOgImage, handleSharePage, setPageSecurityHeaders } from './share';

export type { Env };

/** HTML from the static assets (the SPA and its fallback) gets the anti-framing headers too (worker/share.ts). */
function withPageSecurity(res: Response): Response {
  if (!(res.headers.get('content-type') ?? '').includes('text/html')) return res;
  const out = new Response(res.body, res);
  setPageSecurityHeaders(out.headers);
  return out;
}

export default {
  async fetch(request: Request, env: Env, exec?: ExecutionContext): Promise<Response> {
    const blocked = geoBlock(request, env); // sanctions geo-block first: 451 for blocked visitors (worker/geo.ts)
    if (blocked) return blocked;
    const wrongHost = canonicalHostResponse(request, env); // www / workers.dev → PUBLIC_ORIGIN (worker/canonical.ts)
    if (wrongHost) return wrongHost;
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/og/')) return handleOgImage(request, env.ASSETS);
    const p2 = await handlePhase2(request, env, exec ?? { waitUntil: () => undefined });
    if (p2) return p2;
    if (pathname === '/api' || pathname.startsWith('/api/')) return handleApi(request, env as Phase1Env);
    if (request.method === 'GET' || request.method === 'HEAD') {
      const meta = await coinShareMeta(env, pathname);
      if (meta) return handleSharePage(request, env.ASSETS, meta);
    }
    return withPageSecurity(await env.ASSETS.fetch(request));
  },

  async scheduled(_controller: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    if (!realCluster(env) || !env.DB) return;
    const ctx = await buildCtx(env, exec, defaultDeps(), 'cron');
    if (!ctx) return;
    try {
      await runIndexer(ctx, { reason: 'cron' });
    } catch (e) {
      makeLogger(env).error('indexer.crashed', { error: errMsg(e) });
    }
  },
} satisfies ExportedHandler<Env>;
