/**
 * Simulated market math (prototype — no chain is touched).
 * SHARED (src/lib). Pure.
 *
 * Price impact model: every coin trades against a virtual constant-product pool whose USD depth
 * L = max(12% of market cap, $2,500). For a buy of Δ USD:
 *   priceAfter = price · ((L + Δ) / L)²,  tokensOut = Δ / (price · (L + Δ) / L)
 * and for a sell of T tokens (x = L / price tokens in the pool):
 *   usdOut = L · T / (x + T),             priceAfter = price · (x / (x + T))²
 * This is exact x·y=k maths, so buy-then-sell round trips are consistent.
 * Creator fees: CREATOR_FEE_RATE (0.5%) of each trade's USD volume, 100% to the shop.
 */
import { CREATOR_FEE_RATE, DEMO_SOL_USD, LIMITS, PUMP_INITIAL_MCAP_SOL, PUMP_SUPPLY } from '../config';
import type { Coin, CoinPlace, LogoSpec, TopHolder, TradeSide } from '../types';
import { fakeMint, fakeWallet } from './fakeSolana';
import { createRng, type Rng } from './rand';

export const MIN_POOL_DEPTH_USD = 2500;
export const POOL_DEPTH_FRACTION = 0.12;

export interface Quote {
  side: TradeSide;
  sol: number;
  usd: number;
  tokens: number;
  priceBefore: number;
  priceAfter: number;
  /** Signed price impact in percent. */
  impactPct: number;
  /** Creator fee in USD that this trade sends to the shop. */
  feeUsd: number;
}

type Priced = Pick<Coin, 'priceUsd' | 'marketCapUsd'>;

export function poolDepthUsd(marketCapUsd: number): number {
  return Math.max(marketCapUsd * POOL_DEPTH_FRACTION, MIN_POOL_DEPTH_USD);
}

/** Quote a buy of `sol` SOL. */
export function quoteBuy(coin: Priced, sol: number, solUsd: number): Quote {
  const usd = Math.max(0, sol) * solUsd;
  const L = poolDepthUsd(coin.marketCapUsd);
  const p0 = coin.priceUsd;
  const ratio = (L + usd) / L;
  const p1 = p0 * ratio * ratio;
  const tokens = usd > 0 && p0 > 0 ? usd / (p0 * ratio) : 0;
  return { side: 'buy', sol, usd, tokens, priceBefore: p0, priceAfter: p1, impactPct: (p1 / p0 - 1) * 100, feeUsd: usd * CREATOR_FEE_RATE };
}

/** Quote a sell of `tokens`. */
export function quoteSell(coin: Priced, tokens: number, solUsd: number): Quote {
  const T = Math.max(0, tokens);
  const L = poolDepthUsd(coin.marketCapUsd);
  const p0 = coin.priceUsd;
  const x = p0 > 0 ? L / p0 : 0;
  const usd = x + T > 0 ? (L * T) / (x + T) : 0;
  const p1 = x + T > 0 ? p0 * (x / (x + T)) ** 2 : p0;
  return {
    side: 'sell',
    sol: solUsd > 0 ? usd / solUsd : 0,
    usd,
    tokens: T,
    priceBefore: p0,
    priceAfter: p1,
    impactPct: p0 > 0 ? (p1 / p0 - 1) * 100 : 0,
    feeUsd: usd * CREATOR_FEE_RATE,
  };
}

/** Quote a sell that should return about `sol` SOL (used by the simulator). Capped at half the pool. */
export function quoteSellForSol(coin: Priced, sol: number, solUsd: number): Quote {
  const L = poolDepthUsd(coin.marketCapUsd);
  const usd = Math.min(Math.max(0, sol) * solUsd, L * 0.5);
  const x = coin.priceUsd > 0 ? L / coin.priceUsd : 0;
  const T = L - usd > 0 ? (usd * x) / (L - usd) : 0;
  return quoteSell(coin, T, solUsd);
}

/** Generic quote: buys take SOL, sells take tokens. */
export function quote(coin: Priced, side: TradeSide, amount: number, solUsd: number): Quote {
  return side === 'buy' ? quoteBuy(coin, amount, solUsd) : quoteSell(coin, amount, solUsd);
}

export function priceFromMcap(marketCapUsd: number, supply: number = PUMP_SUPPLY): number {
  return supply > 0 ? marketCapUsd / supply : 0;
}

/** Launch price of a fresh pump.fun coin in USD. */
export function initialPriceUsd(solUsd: number): number {
  return (PUMP_INITIAL_MCAP_SOL * solUsd) / PUMP_SUPPLY;
}

/** 24h change in percent from a history series and the current price. */
export function changeFromHistory(history: readonly number[], price: number): number {
  const first = history[0];
  return first && first > 0 ? (price / first - 1) * 100 : 0;
}

/* ------------------------------------------------------------------ series */

export type ChartRange = '1h' | '24h' | '7d' | 'all';

export const CHART_RANGES: readonly { key: ChartRange; label: string; sub: string }[] = [
  { key: '1h', label: '1H', sub: 'past hour' },
  { key: '24h', label: '24H', sub: 'past 24h' },
  { key: '7d', label: '7D', sub: 'past 7 days' },
  { key: 'all', label: 'All', sub: 'all time' },
];

/**
 * Seeded log-space Brownian bridge from `start` to `end` with `points` samples.
 * `vol` ≈ per-step relative volatility. Always positive, exact endpoints.
 */
export function bridgeSeries(seed: string, start: number, end: number, points: number, vol = 0.03): number[] {
  const n = Math.max(2, points);
  const rng = createRng(seed);
  const walk: number[] = [0];
  for (let i = 1; i < n; i++) walk.push((walk[i - 1] as number) + rng.normal() * vol);
  const last = walk[n - 1] as number;
  const a = Math.log(Math.max(start, 1e-12));
  const b = Math.log(Math.max(end, 1e-12));
  return walk.map((w, i) => {
    const t = i / (n - 1);
    return Math.exp(a + (b - a) * t + (w - t * last));
  });
}

/** 48-point 24h history ending at `price` with the given 24h change (seeded, deterministic). */
export function seedHistory(seed: string, price: number, change24hPct: number, points: number = LIMITS.history): number[] {
  const start = price / (1 + change24hPct / 100);
  const s = bridgeSeries(`h24:${seed}`, start, price, points, 0.035);
  s[s.length - 1] = price;
  return s;
}

/** Flat history for a brand-new coin. */
export function flatHistory(price: number, points: number = LIMITS.history): number[] {
  return Array.from({ length: points }, () => price);
}

export interface Series {
  prices: number[];
  /** ms timestamps, same length as prices. */
  times: number[];
  /** Percent change over the range. */
  changePct: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const RANGE_MS: Record<ChartRange, number> = { '1h': HOUR_MS, '24h': DAY_MS, '7d': 7 * DAY_MS, all: Infinity };

/** Every pump.fun coin starts at the same launch market cap (DEMO_SOL_USD is constant). */
export function launchPriceUsd(): number {
  return initialPriceUsd(DEMO_SOL_USD);
}

/** Spacing of the 24h `history` buckets (48 points → 47 gaps of ~30.6 min). */
function bucketMs(n: number): number {
  return DAY_MS / Math.max(1, n - 1);
}

/**
 * Timestamps of `coin.ticks`. Coins saved before tick times existed (or with a mismatched array)
 * get their ticks spread over the last 5 minutes (never before the launch).
 */
export function tickTimesOf(coin: Pick<Coin, 'ticks' | 'tickTimes' | 'launchedAt'>, end: number = Date.now()): number[] {
  const n = coin.ticks.length;
  if (coin.tickTimes && coin.tickTimes.length === n) return coin.tickTimes;
  const from = Math.min(end, Math.max(coin.launchedAt, end - 5 * 60_000));
  return Array.from({ length: n }, (_, i) => (n > 1 ? from + ((end - from) * i) / (n - 1) : end));
}

type Knot = readonly [t: number, price: number];

/**
 * The coin's price over its whole life as (time, price) knots, oldest first, never before
 * `launchedAt`: the launch price at the launch → (coins older than the 24h history) a seeded
 * bridge from the launch price to the oldest history bucket → the 24h history buckets after the
 * launch → the recent trade ticks → the current price at `end`.
 */
function priceKnots(coin: Coin, end: number): Knot[] {
  const launchAt = Math.min(coin.launchedAt, end);
  // real coins: the launch price from the pump Global initial reserves at the coin's SOL/USD; no
  // seeded bridge (real mode never draws made-up prices — older than 24h is a straight line)
  const real = coin.real;
  const realLaunchP = real && real.launchPriceLamports > 0 && real.usdRate > 0 ? (real.launchPriceLamports / 1e9) * real.usdRate : null;
  const launchP = real ? (realLaunchP ?? coin.history[0] ?? coin.priceUsd) : launchPriceUsd();
  const hist = coin.history.length >= 2 ? coin.history : flatHistory(coin.priceUsd);
  const n = hist.length;
  const step = bucketMs(n);
  // the newest bucket is the live price; older buckets close every `step` before `historyAt`
  const lastClosed = Math.min(coin.historyAt ?? end, end);
  const bucketAt = (i: number) => lastClosed - (n - 1 - i) * step;
  const tickAt = tickTimesOf(coin, end);
  const firstTickAt = coin.ticks.length ? Math.max(launchAt, tickAt[0] as number) : end;

  const knots: Knot[] = [[launchAt, launchP]];
  const histStart = bucketAt(0);
  if (launchAt < histStart && !real) {
    const k = LIMITS.history;
    const b = bridgeSeries(`life:${coin.mint}`, launchP, hist[0] as number, k, 0.06);
    for (let i = 1; i < k - 1; i++) knots.push([launchAt + ((histStart - launchAt) * i) / (k - 1), b[i] as number]);
  }
  for (let i = 0; i < n - 1; i++) {
    const t = bucketAt(i);
    if (t > launchAt && t < firstTickAt && t < end) knots.push([t, hist[i] as number]);
  }
  coin.ticks.forEach((p, i) => {
    const t = Math.min(end, Math.max(launchAt, tickAt[i] as number));
    if (t >= (knots[knots.length - 1] as Knot)[0]) knots.push([t, p]);
  });
  knots.push([end, coin.priceUsd]);
  return knots;
}

/** Linear interpolation of the knots at `t` (knots sorted by time; equal times → the later knot). */
function priceAt(knots: readonly Knot[], t: number): number {
  const first = knots[0] as Knot;
  if (t <= first[0]) return first[1];
  let lo = 0;
  let hi = knots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((knots[mid] as Knot)[0] <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = knots[lo] as Knot;
  const b = knots[lo + 1];
  if (!b || b[0] <= a[0]) return a[1];
  return a[1] + ((b[1] - a[1]) * (t - a[0])) / (b[0] - a[0]);
}

/**
 * Chart series for a range (DESIGN §8.10), `points` samples evenly spaced in time from the range
 * start to now. Every range is clipped to the coin's life: it never starts before `launchedAt`,
 * so a coin younger than a range shows its whole life (launch price → now), and all such ranges
 * show the same curve and change. Deterministic per coin.
 */
export function seriesFor(coin: Coin, range: ChartRange, now: number = Date.now(), points = 48): Series {
  const price = coin.priceUsd;
  const lastTick = coin.tickTimes?.length ? (coin.tickTimes[coin.tickTimes.length - 1] as number) : 0;
  // the newest trade can be a little newer than a cached `now` (CoinSummary refreshes it every 30s)
  const end = Math.max(now, lastTick, coin.launchedAt);
  const launchAt = Math.min(coin.launchedAt, end);
  const from = Math.max(launchAt, end - RANGE_MS[range]);
  const knots = priceKnots(coin, end);
  const n = Math.max(2, points);
  const times = Array.from({ length: n }, (_, i) => from + ((end - from) * i) / (n - 1));
  const prices = times.map((t) => priceAt(knots, t));
  // a range that starts at the launch starts at the launch price, even if the first trade shares its ms
  if (from <= launchAt) prices[0] = (knots[0] as Knot)[1];
  prices[n - 1] = price;
  const first = prices[0] ?? price;
  return { prices, times, changePct: first > 0 ? (price / first - 1) * 100 : 0 };
}

/* ------------------------------------------------------------------ holders */

/** Deterministic "Top holders" list (DESIGN §8.5 Coin tab), 10 rows, % of supply descending. */
export function topHoldersFor(coin: Pick<Coin, 'mint' | 'holders' | 'launcher'>, n = 10): TopHolder[] {
  const rng = createRng(`holders:${coin.mint}`);
  const count = Math.max(1, Math.min(n, coin.holders || 1));
  let pct = rng.range(4.5, 9.5);
  const out: TopHolder[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ address: i === 0 ? coin.launcher : fakeWallet(`${coin.mint}:${i}`), pct: Math.round(pct * 10) / 10 });
    pct *= rng.range(0.62, 0.9);
  }
  return out.sort((a, b) => b.pct - a.pct);
}

/* ------------------------------------------------------------------ coin factory */

export interface CoinSeed {
  placeId: string;
  place: CoinPlace;
  ticker: string;
  name: string;
  logo: LogoSpec;
  launchedAt: number;
  description?: string;
  mint?: string;
  launcher?: string;
  /** Provide either priceUsd or marketCapUsd (defaults to a fresh pump.fun launch). */
  priceUsd?: number;
  marketCapUsd?: number;
  change24h?: number;
  volume24h?: number;
  holders?: number;
  feesEarnedUsd?: number;
  feesClaimedUsd?: number;
  claimed?: boolean;
  ownerVerified?: boolean;
  claimPending?: boolean;
  claimedAt?: number;
  owner?: string;
  payoutWallet?: string;
  history?: number[];
  /** When the newest `history` bucket starts (default: now — the history is generated ending now). */
  historyAt?: number;
  lastTradeAt?: number;
  isUserLaunched?: boolean;
  isDemoSeed?: boolean;
}

/** Build a complete, internally consistent Coin from a seed. */
export function buildCoin(seed: CoinSeed, solUsd: number): Coin {
  const supply = PUMP_SUPPLY;
  const priceUsd =
    seed.priceUsd ?? (seed.marketCapUsd != null ? priceFromMcap(seed.marketCapUsd, supply) : initialPriceUsd(solUsd));
  const change24h = seed.change24h ?? 0;
  const history = seed.history ?? (change24h === 0 ? flatHistory(priceUsd) : seedHistory(seed.placeId, priceUsd, change24h));
  const claimed = seed.claimed ?? false;
  const feesEarnedUsd = seed.feesEarnedUsd ?? 0;
  return {
    placeId: seed.placeId,
    place: seed.place,
    mint: seed.mint ?? fakeMint(seed.placeId),
    ticker: seed.ticker,
    name: seed.name,
    description: seed.description ?? '',
    logo: seed.logo,
    launchedAt: seed.launchedAt,
    launcher: seed.launcher ?? fakeWallet(`launcher:${seed.placeId}`),
    priceUsd,
    priceSol: solUsd > 0 ? priceUsd / solUsd : 0,
    marketCapUsd: priceUsd * supply,
    supply,
    change24h,
    volume24h: seed.volume24h ?? 0,
    holders: seed.holders ?? 1,
    feesEarnedUsd,
    feesClaimedUsd: claimed ? feesEarnedUsd : (seed.feesClaimedUsd ?? 0),
    claimed,
    ownerVerified: seed.ownerVerified ?? claimed,
    claimPending: seed.claimPending,
    claimedAt: seed.claimedAt,
    owner: seed.owner,
    payoutWallet: seed.payoutWallet,
    history,
    historyAt: seed.historyAt ?? Date.now(),
    ticks: [],
    tickTimes: [],
    lastTradeAt: seed.lastTradeAt,
    isUserLaunched: seed.isUserLaunched,
    isDemoSeed: seed.isDemoSeed,
  };
}

/**
 * Apply a new price to a coin (immutably) at time `ts`: rolls the 24h history forward by whole
 * buckets since `historyAt` (closed buckets keep the price they ended at), sets the live (last)
 * bucket, appends a timestamped tick, and updates priceSol, market cap and the 24h change.
 */
export function withPrice(coin: Coin, priceUsd: number, solUsd: number, ts: number = Date.now()): Coin {
  let history = coin.history.length >= 2 ? [...coin.history] : flatHistory(coin.history[0] ?? priceUsd);
  let historyAt = coin.historyAt ?? ts;
  const step = bucketMs(history.length);
  const roll = Math.floor((ts - historyAt) / step);
  if (roll > 0) {
    const carry = history[history.length - 1] as number;
    const k = Math.min(roll, history.length);
    history = [...history.slice(k), ...Array.from({ length: k }, () => carry)];
    historyAt += roll * step;
  }
  history[history.length - 1] = priceUsd;
  const ticks = [...coin.ticks, priceUsd].slice(-LIMITS.ticks);
  const tickTimes = [...tickTimesOf(coin, ts), ts].slice(-LIMITS.ticks);
  return {
    ...coin,
    priceUsd,
    priceSol: solUsd > 0 ? priceUsd / solUsd : coin.priceSol,
    marketCapUsd: priceUsd * coin.supply,
    history,
    historyAt,
    ticks,
    tickTimes,
    change24h: changeFromHistory(history, priceUsd),
  };
}

/** Log-uniform simulated trade size in SOL (0.02–3 SOL, mostly small). */
export function randomTradeSol(rng: Rng): number {
  const v = Math.exp(rng.range(Math.log(0.02), Math.log(3)));
  return v < 0.1 ? Math.round(v * 100) / 100 : Math.round(v * 10) / 10;
}
