/**
 * Cheap shared values for the read routes, without RPC on the hot path: SOL/USD, pump Global, on-chain Config and the
 * priority fee are refreshed by the cron into D1 `kv_meta`; requests read them through a 5 s per-isolate cache and
 * fall back to one RPC read only when the cron has never run (fresh deploy).
 */
import { CONFIG_PDA, PUMP_GLOBAL } from './consts';
import { cachedGlobal, chainConfig, fallbackGlobal, pumpGlobal, type ConfigView, type PumpGlobalView } from './chainState';
import { cronPeriodMs, kvPutStmt, type Ctx } from './ctx';
import type { Cluster } from './wire';

interface MetaSnapshot {
  at: number;
  solUsd: { usd: number; at: number; src: string } | null;
  global: PumpGlobalView | null;
  config: (ConfigView & { at: number }) | null;
  priorityFee: number | null;
  faucetLamports: number | null;
  indexerLastRun: number | null;
}

const snapCache = new Map<Cluster, MetaSnapshot>();
const SNAP_TTL_MS = 5_000;
export const SOL_USD_MAX_AGE_MS = 10 * 60_000;

function big(v: unknown): bigint {
  try {
    return BigInt(v as string);
  } catch {
    return 0n;
  }
}

export async function metaSnapshot(ctx: Ctx, force = false): Promise<MetaSnapshot> {
  const now = ctx.deps.now();
  const hit = snapCache.get(ctx.cluster);
  if (hit && !force && now - hit.at < SNAP_TTL_MS) return hit;
  const rows = await ctx.db
    .prepare("SELECT key, value, updated_at FROM kv_meta WHERE key IN ('sol_usd','pump_global','chain_config','priority_fee','faucet_balance','indexer_last_run')")
    .all<{ key: string; value: string; updated_at: number }>();
  const m = new Map<string, { v: unknown; at: number }>();
  for (const r of rows.results ?? []) {
    try {
      m.set(r.key, { v: JSON.parse(r.value), at: r.updated_at });
    } catch {
      /* ignore corrupt rows */
    }
  }
  const su = m.get('sol_usd')?.v as { usd?: number; at?: number; src?: string } | undefined;
  const g = m.get('pump_global')?.v as Record<string, string> | undefined;
  const c = m.get('chain_config');
  const snap: MetaSnapshot = {
    at: now,
    solUsd: su && typeof su.usd === 'number' && typeof su.at === 'number' ? { usd: su.usd, at: su.at, src: su.src ?? '' } : null,
    global: g
      ? {
          initialVirtualTokenReserves: big(g.initialVirtualTokenReserves),
          initialVirtualQuoteReserves: big(g.initialVirtualQuoteReserves),
          initialRealTokenReserves: big(g.initialRealTokenReserves),
          tokenTotalSupply: big(g.tokenTotalSupply),
        }
      : null,
    config: c ? ({ ...(c.v as ConfigView), at: c.at } as ConfigView & { at: number }) : null,
    priorityFee: typeof m.get('priority_fee')?.v === 'number' ? (m.get('priority_fee')!.v as number) : null,
    faucetLamports: typeof m.get('faucet_balance')?.v === 'number' ? (m.get('faucet_balance')!.v as number) : null,
    indexerLastRun: typeof m.get('indexer_last_run')?.v === 'number' ? (m.get('indexer_last_run')!.v as number) : null,
  };
  if (snap.global && snap.global.initialVirtualTokenReserves <= 0n) snap.global = null;
  snapCache.set(ctx.cluster, snap);
  return snap;
}

/** SOL/USD for responses; null when unknown or older than 10 minutes (the UI then shows SOL only). */
export function freshSolUsd(s: MetaSnapshot, now: number): number | null {
  if (!s.solUsd) return null;
  return now - s.solUsd.at <= SOL_USD_MAX_AGE_MS ? s.solUsd.usd : null;
}

/** pump Global: kv_meta → isolate cache → hard-coded fallback (never RPC on read routes). */
export function globalFrom(s: MetaSnapshot, cluster: Cluster): PumpGlobalView {
  return s.global ?? cachedGlobal(cluster) ?? fallbackGlobal(cluster);
}

/** Global for paths that may spend one RPC call (launch confirm, fresh=1, cron). */
export async function globalLive(ctx: Ctx): Promise<PumpGlobalView> {
  const s = await metaSnapshot(ctx);
  if (s.global) return s.global;
  return pumpGlobal(ctx.rpc(2), PUMP_GLOBAL, ctx.deps.now());
}

/**
 * On-chain Config: kv_meta if the cron wrote it < 2 cron periods ago (2 min on mainnet, 10 min on devnet), else one RPC
 * read (30 s isolate cache). Pass `fresh: true` on safety-relevant paths (launch prepare/cosign) to bypass kv_meta and
 * use the 30 s isolate cache.
 */
export async function configView(ctx: Ctx, opts: { fresh?: boolean } = {}): Promise<ConfigView | null> {
  const now = ctx.deps.now();
  if (!opts.fresh) {
    const s = await metaSnapshot(ctx);
    if (s.config && now - s.config.at < 2 * cronPeriodMs(ctx.cluster)) return s.config;
  }
  const v = await chainConfig(ctx.rpc(2), CONFIG_PDA, now);
  if (v) ctx.waitUntil(kvPutStmt(ctx.db, 'chain_config', v, now).run());
  return v;
}

/** Test helper. */
export function __resetMetaCache(): void {
  snapCache.clear();
}
