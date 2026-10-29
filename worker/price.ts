/**
 * SOL/USD (INTEGRATION §1.8): Jupiter Price v3 (lite-api, or api.jup.ag with JUPITER_API_KEY), Pyth Hermes as
 * fallback and cross-check (> 2% apart → keep Jupiter, alert). Stored in kv_meta('sol_usd') by the cron; the client
 * never calls a price API.
 *
 * Integrator note (2026-10-08): the public Hermes endpoint now answers 401 "unauthorized" without a key, so Coinbase's
 * keyless spot price is a second fallback / cross-check, fetched only when Pyth does not answer (one extra subrequest).
 */
import type { Deps } from './ctx';
import type { Env } from './env';

const WSOL = 'So11111111111111111111111111111111111111112';
const PYTH_SOL_USD = '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

export async function jupiterSolUsd(env: Env, deps: Deps): Promise<number | null> {
  const key = env.JUPITER_API_KEY?.trim();
  const url = key ? `https://api.jup.ag/price/v3?ids=${WSOL}` : `https://lite-api.jup.ag/price/v3?ids=${WSOL}`;
  try {
    const res = await deps.fetch(url, { headers: { accept: 'application/json', ...(key ? { 'x-api-key': key } : {}) }, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, { usdPrice?: number }>;
    const p = j[WSOL]?.usdPrice;
    return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

export async function pythSolUsd(deps: Deps): Promise<number | null> {
  try {
    const res = await deps.fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_SOL_USD}&parsed=true`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { parsed?: { price?: { price?: string; expo?: number } }[] };
    const p = j.parsed?.[0]?.price;
    if (!p || typeof p.price !== 'string' || typeof p.expo !== 'number') return null;
    const v = Number(p.price) * 10 ** p.expo;
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function coinbaseSolUsd(deps: Deps): Promise<number | null> {
  try {
    const res = await deps.fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { amount?: string; base?: string; currency?: string } };
    if (j.data?.base !== 'SOL' || j.data?.currency !== 'USD' || typeof j.data.amount !== 'string') return null;
    const v = Number(j.data.amount);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export interface SolUsd {
  usd: number;
  at: number;
  src: 'jupiter' | 'pyth' | 'coinbase';
  /** Relative difference between the sources when both answered. */
  spread: number | null;
}

export async function fetchSolUsd(env: Env, deps: Deps): Promise<SolUsd | null> {
  const [jup, pyth] = await Promise.all([jupiterSolUsd(env, deps), pythSolUsd(deps)]);
  const cb = pyth ? null : await coinbaseSolUsd(deps);
  const at = deps.now();
  const ref = pyth ?? cb;
  const spread = jup && ref ? Math.abs(jup - ref) / ref : null;
  if (jup) return { usd: round4(jup), at, src: 'jupiter', spread };
  if (pyth) return { usd: round4(pyth), at, src: 'pyth', spread };
  if (cb) return { usd: round4(cb), at, src: 'coinbase', spread };
  return null;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
