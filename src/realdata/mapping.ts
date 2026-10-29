/**
 * Wire DTO → app model mapping for real mode (INTEGRATION.md §5.3). Pure.
 *
 * Rules:
 *  - USD = SOL × the `solUsd` of the SAME response (never a constant). Money owed to a shop (fees
 *    waiting / earned / withdrawn) rounds DOWN to the cent.
 *  - Unknown values stay unknown: `change24hKnown` / `holdersKnown` drive a `—` in the UI.
 *  - No Google content is ever in a Coin; the place snapshot is id + coordinates + the launcher's
 *    category/emoji.
 */
import type { CoinDTO, CoinDetailDTO, ConfigResponse, FeedEventDTO, MarketDTO, TradeDTO } from '../../worker/wire';
import { LIMITS } from '../config';
import { categoryLabel } from '../lib/categories';
import type { Coin, FeedEvent, LatLng, RealCoinFacts, Trade } from '../types';
import { lamportsToSol, lamportsToUsdFloor, u64, unitsToTokens } from './units';

const LAMPORTS = 1_000_000_000;
const HISTORY_POINTS = LIMITS.history;

export interface MapCtx {
  /** SOL/USD from the same response (null/0 = unknown → USD values 0, UI shows SOL). */
  solUsd: number | null;
  /** Launch price (lamports per whole token) from the pump Global initial reserves; 0 if unknown. */
  launchPriceLamports: number;
  /** Last known coordinates for places the registry has none for yet (e.g. a coin we just launched). */
  fallbackLocation?: LatLng | null;
}

/** Lamports per whole token of a fresh curve: vQuote × 10^6 / vToken (bigint with 6 extra digits). */
export function launchPriceFromConfig(cfg: Pick<ConfigResponse, 'curve'> | null | undefined): number {
  if (!cfg) return 0;
  const vq = u64(cfg.curve.initialVirtualQuoteReserves);
  const vt = u64(cfg.curve.initialVirtualTokenReserves);
  if (vt === 0n) return 0;
  return Number((vq * 1_000_000n * 1_000_000n) / vt) / 1_000_000;
}

function rate(solUsd: number | null | undefined): number {
  return solUsd && solUsd > 0 && Number.isFinite(solUsd) ? solUsd : 0;
}

function lamportsPerTokenToUsd(lpt: number, r: number): number {
  return Number.isFinite(lpt) && lpt > 0 ? (lpt / LAMPORTS) * r : 0;
}

function isDetail(dto: CoinDTO | CoinDetailDTO): dto is CoinDetailDTO {
  return Array.isArray((dto as CoinDetailDTO).history);
}

function flat(price: number): number[] {
  return Array.from({ length: HISTORY_POINTS }, () => price);
}

/** Registry coin → Coin. `prev` keeps history/ticks/location when the DTO is a list row. */
export function coinFromDTO(dto: CoinDTO | CoinDetailDTO, ctx: MapCtx, prev?: Coin): Coin {
  const r = rate(ctx.solUsd) || prev?.real?.usdRate || 0;
  const m = dto.market;
  const priceLamports = Number.isFinite(m.priceLamports) && m.priceLamports > 0 ? m.priceLamports : 0;
  const priceSol = priceLamports / LAMPORTS;
  const priceUsd = priceSol * r;
  const location = dto.location ?? prev?.place.location ?? ctx.fallbackLocation ?? null;
  const detail = isDetail(dto);

  let history: number[];
  let historyAt: number;
  let ticks: number[];
  let tickTimes: number[];
  if (detail) {
    const h = dto.history.length >= 2 ? dto.history : [priceLamports];
    history = h.map((p) => lamportsPerTokenToUsd(p, r));
    if (history.length < 2) history = flat(priceUsd);
    history[history.length - 1] = priceUsd;
    historyAt = dto.historyAt || Date.now();
    const n = Math.min(dto.ticks.length, dto.tickTimes.length);
    ticks = dto.ticks.slice(-n).map((p) => lamportsPerTokenToUsd(p, r));
    tickTimes = dto.tickTimes.slice(-n);
  } else if (prev && prev.real?.historyKnown) {
    // the chart in USD at THIS response's SOL/USD, so its last point meets `priceUsd` (no fake jump at "now")
    const base = rescale(prev, r);
    history = base.history;
    historyAt = prev.historyAt ?? Date.now();
    ticks = base.ticks;
    tickTimes = prev.tickTimes ?? [];
  } else {
    history = flat(priceUsd);
    historyAt = Date.now();
    ticks = [];
    tickTimes = [];
  }

  const ownerStatus = dto.owner.status;
  const claimed = ownerStatus === 'claimed';
  const owner = dto.owner.owner ?? undefined;
  const real: RealCoinFacts = {
    feesWaitingLamports: dto.fees.waitingLamports,
    feesWithdrawnLamports: dto.fees.withdrawnLamports,
    feesEarnedLamports: dto.fees.earnedLamports,
    feesWaitingUsd: lamportsToUsdFloor(dto.fees.waitingLamports, r),
    ownerStatus,
    pendingOwner: dto.owner.pendingOwner,
    unlockTs: dto.owner.unlockTs,
    inProbation: dto.owner.inProbation,
    graduated: dto.graduated,
    progressPct: Number.isFinite(m.progressPct) ? m.progressPct : 0,
    imageUrl: dto.imageUrl,
    change24hKnown: m.change24hPct != null && Number.isFinite(m.change24hPct),
    holdersKnown: dto.holders != null,
    marketAt: m.at,
    priceLamports,
    mcapLamports: m.mcapLamports,
    vol24hLamports: m.vol24hLamports,
    realSolLamports: m.realSol,
    launchPriceLamports: ctx.launchPriceLamports || prev?.real?.launchPriceLamports || priceLamports,
    vault: dto.vault,
    vaultState: dto.vaultState,
    launchSig: dto.launchSig,
    metadataUri: dto.metadataUri,
    located: !!location,
    usdRate: r,
    historyKnown: detail || !!prev?.real?.historyKnown,
  };

  return {
    placeId: dto.placeId,
    place: {
      id: dto.placeId,
      source: 'google',
      location: location ?? { lat: 0, lng: 0 },
      category: dto.category,
      emoji: dto.emoji,
    },
    mint: dto.mint,
    ticker: dto.ticker,
    name: dto.name,
    description: dto.description,
    logo: dto.imageUrl ? { kind: 'upload', dataUrl: dto.imageUrl, emoji: dto.emoji, bg: dto.bg } : { kind: 'sticker', emoji: dto.emoji, bg: dto.bg },
    launchedAt: dto.createdAt,
    launcher: dto.launcher,
    priceUsd,
    priceSol,
    marketCapUsd: lamportsToSol(m.mcapLamports) * r,
    supply: unitsToTokens(m.supply),
    change24h: real.change24hKnown ? (m.change24hPct as number) : 0,
    volume24h: lamportsToSol(m.vol24hLamports) * r,
    holders: dto.holders ?? 0,
    feesEarnedUsd: lamportsToUsdFloor(dto.fees.earnedLamports, r),
    feesClaimedUsd: lamportsToUsdFloor(dto.fees.withdrawnLamports, r),
    claimed,
    ownerVerified: claimed,
    claimPending: ownerStatus === 'pending',
    ...(dto.owner.ownerSince ? { claimedAt: dto.owner.ownerSince * 1000 } : {}),
    ...(owner ? { owner, payoutWallet: owner } : {}),
    history,
    historyAt,
    ticks,
    tickTimes,
    ...(m.lastTradeAt ? { lastTradeAt: m.lastTradeAt } : {}),
    real,
  };
}

/** Roll the 24h buckets forward to `ts` (closed buckets keep their last price) and set the live one. */
function rollHistory(coin: Coin, priceUsd: number, ts: number): { history: number[]; historyAt: number } {
  let history = coin.history.length >= 2 ? [...coin.history] : flat(priceUsd);
  let historyAt = coin.historyAt ?? ts;
  const step = (24 * 3_600_000) / Math.max(1, history.length - 1);
  const roll = Math.floor((ts - historyAt) / step);
  if (roll > 0) {
    const carry = history[history.length - 1] as number;
    const k = Math.min(roll, history.length);
    history = [...history.slice(k), ...Array.from({ length: k }, () => carry)];
    historyAt += roll * step;
  }
  history[history.length - 1] = priceUsd;
  return { history, historyAt };
}

/**
 * Apply a `/api/market` quote to a coin. Returns the SAME object when nothing changed (so selectors
 * don't re-render). A changed price appends a chart tick.
 */
export function applyMarket(coin: Coin, m: MarketDTO, solUsd: number | null): Coin {
  const real = coin.real;
  if (!real) return coin;
  const r = rate(solUsd) || real.usdRate;
  // `at` is when the Worker read the accounts (its market cache serves reads up to 6 s old): a quote older than what
  // the coin already shows (e.g. a fresh detail read right after the viewer's own trade) must never roll it back.
  // A SOL/USD change alone is picked up by the next newer quote (≤ 5 s).
  if (m.at < real.marketAt) return coin;
  if (m.at === real.marketAt && m.realSol === real.realSolLamports && r === real.usdRate) return coin;
  const priceLamports = Number.isFinite(m.priceLamports) && m.priceLamports > 0 ? m.priceLamports : real.priceLamports;
  const priceSol = priceLamports / LAMPORTS;
  const priceUsd = priceSol * r;
  const priceChanged = priceLamports !== real.priceLamports;
  const ts = m.at || Date.now();
  const base = rescale(coin, r);
  const { history, historyAt } = rollHistory(base, priceUsd, ts);
  const ticks = priceChanged ? [...base.ticks, priceUsd].slice(-LIMITS.ticks) : base.ticks;
  const tickTimes = priceChanged ? [...(base.tickTimes ?? []), ts].slice(-LIMITS.ticks) : base.tickTimes;
  const change24hKnown = m.change24hPct != null && Number.isFinite(m.change24hPct);
  return {
    ...coin,
    priceSol,
    priceUsd,
    marketCapUsd: lamportsToSol(m.mcapLamports) * r,
    supply: unitsToTokens(m.supply) || coin.supply,
    volume24h: lamportsToSol(m.vol24hLamports) * r,
    change24h: change24hKnown ? (m.change24hPct as number) : 0,
    history,
    historyAt,
    ticks,
    tickTimes,
    ...(m.lastTradeAt ? { lastTradeAt: m.lastTradeAt } : {}),
    real: {
      ...real,
      priceLamports,
      mcapLamports: m.mcapLamports,
      vol24hLamports: m.vol24hLamports,
      realSolLamports: m.realSol,
      progressPct: Number.isFinite(m.progressPct) ? m.progressPct : real.progressPct,
      graduated: real.graduated || m.venue === 'amm',
      change24hKnown,
      marketAt: m.at,
      usdRate: r,
      feesWaitingUsd: lamportsToUsdFloor(real.feesWaitingLamports, r),
    },
    feesEarnedUsd: lamportsToUsdFloor(real.feesEarnedLamports, r),
    feesClaimedUsd: lamportsToUsdFloor(real.feesWithdrawnLamports, r),
  };
}

/** Re-express a coin's USD chart series (history + ticks) at a new SOL/USD rate. */
function rescale(coin: Coin, r: number): Coin {
  const old = coin.real?.usdRate ?? 0;
  if (!(old > 0) || !(r > 0) || old === r) return coin;
  const k = r / old;
  return { ...coin, history: coin.history.map((p) => p * k), ticks: coin.ticks.map((p) => p * k) };
}

/** Re-derive every USD field of a real coin at a new SOL/USD rate (config refresh). Same object if unchanged. */
export function withUsdRate(coin: Coin, solUsd: number | null): Coin {
  const real = coin.real;
  const r = rate(solUsd);
  if (!real || !(r > 0) || r === real.usdRate) return coin;
  const k = real.usdRate > 0 ? r / real.usdRate : 0;
  const priceUsd = coin.priceSol * r;
  return {
    ...coin,
    priceUsd,
    marketCapUsd: lamportsToSol(real.mcapLamports) * r,
    volume24h: lamportsToSol(real.vol24hLamports) * r,
    feesEarnedUsd: lamportsToUsdFloor(real.feesEarnedLamports, r),
    feesClaimedUsd: lamportsToUsdFloor(real.feesWithdrawnLamports, r),
    history: k > 0 ? coin.history.map((p) => p * k) : coin.history,
    ticks: k > 0 ? coin.ticks.map((p) => p * k) : coin.ticks,
    real: { ...real, usdRate: r, feesWaitingUsd: lamportsToUsdFloor(real.feesWaitingLamports, r) },
  };
}

/** Launch price of a real coin in USD at its current rate (chart start, DESIGN §8.10). */
export function launchPriceUsdOf(coin: Coin): number | null {
  const real = coin.real;
  if (!real || !(real.usdRate > 0) || !(real.launchPriceLamports > 0)) return null;
  return (real.launchPriceLamports / LAMPORTS) * real.usdRate;
}

/** Registry trade → Trade row (real signature → the explorer link). */
export function tradeFromDTO(t: TradeDTO, ticker: string, solUsd: number | null, me?: string | null): Trade {
  // what the trader paid / received, fees included (INTEGRATION.md §9); the curve-side amount for rows not backfilled
  const lamports = t.userLamports ?? t.solLamports;
  const sol = lamportsToSol(lamports);
  return {
    lamports,
    id: t.id,
    placeId: t.placeId,
    ticker,
    side: t.side,
    usd: sol * rate(solUsd),
    sol,
    tokens: unitsToTokens(t.tokens),
    wallet: t.trader,
    ts: t.ts,
    signature: t.sig,
    real: true,
    ...(me && t.trader === me ? { isUser: true } : {}),
  };
}

/** Registry feed event → FeedEvent. Dust trades are already dropped by the Worker. */
export function feedEventFromDTO(e: FeedEventDTO, solUsd: number | null, me?: string | null): FeedEvent {
  const base = { id: e.id, ts: e.ts, placeId: e.placeId, ticker: e.ticker, name: e.name, emoji: e.emoji, bg: e.bg };
  const isUser = !!me && e.wallet === me;
  switch (e.kind) {
    case 'trade': {
      const lamports = e.userLamports ?? e.solLamports;
      const sol = lamportsToSol(lamports);
      return { ...base, kind: 'trade', side: e.side, sol, lamports, usd: sol * rate(solUsd), wallet: e.wallet, signature: e.sig, ...(isUser ? { isUser } : {}) };
    }
    case 'launch':
      return { ...base, kind: 'launch', wallet: e.wallet, signature: e.sig, ...(isUser ? { isUser } : {}) };
    case 'claim':
    default: {
      const c = e as Extract<FeedEventDTO, { kind: 'claim' }>;
      const paid = c.stage === 'withdrawn' && c.feesLamports ? c.feesLamports : null;
      return {
        ...base,
        kind: 'claim',
        // ownership events move no money; a payout row carries the exact withdrawn amount (rounded down)
        usd: paid ? lamportsToUsdFloor(paid, solUsd) : 0,
        ...(paid ? { lamports: paid } : {}),
        wallet: c.wallet,
        stage: c.stage,
        ...(c.sig ? { signature: c.sig } : {}),
        ...(isUser ? { isUser } : {}),
      };
    }
  }
}

/** "Kebab shop" for a real coin (launcher's category). */
export function realCategoryLabel(coin: Coin): string {
  return categoryLabel(coin.place.category);
}

/** Snap a bbox outward to 0.01° (shared cache keys, INTEGRATION.md §3.2): "w,s,e,n". */
export function snapBbox(b: { west: number; south: number; east: number; north: number }): string {
  const down = (v: number) => Math.floor(v * 100) / 100;
  const up = (v: number) => Math.ceil(v * 100) / 100;
  const clampLat = (v: number) => Math.max(-90, Math.min(90, v));
  const clampLng = (v: number) => Math.max(-180, Math.min(180, v));
  const w = clampLng(down(b.west));
  const e = clampLng(up(b.east));
  const s = clampLat(down(b.south));
  const n = clampLat(up(b.north));
  return [w, s, e, n].map((v) => v.toFixed(2)).join(',');
}

/** Parse a snapped bbox key back into numbers. */
export function parseBbox(key: string): { west: number; south: number; east: number; north: number } | null {
  const parts = key.split(',').map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  const [west, south, east, north] = parts as [number, number, number, number];
  return { west, south, east, north };
}

/** True when bbox `outer` fully covers `inner` (both non-wrapping). Antimeridian boxes never "cover". */
export function bboxCovers(outer: string, inner: string): boolean {
  const o = parseBbox(outer);
  const i = parseBbox(inner);
  if (!o || !i || o.west > o.east || i.west > i.east) return false;
  return o.west <= i.west && o.south <= i.south && o.east >= i.east && o.north >= i.north;
}
