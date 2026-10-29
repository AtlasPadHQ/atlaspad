/**
 * Real-mode data layer (INTEGRATION.md §5). App calls `startRealData()` INSTEAD of the demo
 * simulator when `IS_REAL`; nothing here runs in demo mode.
 *
 * Sources (all through our own Worker, never an RPC URL — H3):
 *   /api/config            boot + every 60 s (cluster check, SOL/USD, features, explorer templates)
 *   /api/coins?bbox        viewport registry (snapped 0.01°, 300 ms debounce, 30 s cover cache);
 *                          below zoom 11: /api/top?by=mcap&limit=300
 *   /api/market?mints      visible + selected + held coins (≤ 100 by mcap) every 5 s → pin flashes
 *   /api/coins/:mint       selected coin detail every 15 s (?fresh=1 after an own tx)
 *   /api/feed?since        every 5 s while Live / This area shows, otherwise every 20 s
 *   /api/top, sort=new, launcher/owner   while Top shops / Launched / My coins are open
 *   /api/rpc (src/chain/rpc)  wallet balance + Token-2022 holdings — only with a wallet connected
 * Everything pauses while the tab is hidden or offline and polls once on resume.
 */
import type { CoinDTO, ConfigResponse, EligibilityResponse, FeedEventDTO, PlaceResponse } from '../../worker/wire';
import { AREA_MIN_ZOOM, LIMITS } from '../config';
import { flashLabel } from '../lib/format';
import { flashPin } from '../map/mapBridge';
import { BUILD_CLUSTER, IS_REAL } from '../mode';
import { coinsInBounds, useStore } from '../store';
import type { Coin, FeedEvent, Trade } from '../types';
import { api, isApiError } from './api';
import { getWallet, prefetchChain, setChainConfig } from './chain';
import { setExplorerConfig } from './explorer';
import { applyMarket, bboxCovers, coinFromDTO, feedEventFromDTO, launchPriceFromConfig, snapBbox, tradeFromDTO, withUsdRate } from './mapping';
import { pageActive, Poller } from './poller';
import { lamportsToSol, u64 } from './units';

export { api, apiErrorMessage, ApiError, isApiError } from './api';

/* ================================================================== constants */

const CONFIG_MS = 60_000;
const MARKET_MS = 5_000;
const DETAIL_MS = 15_000;
const FEED_FAST_MS = 5_000;
const FEED_SLOW_MS = 20_000;
const TOP_MS = 30_000;
const LIST_MS = 30_000;
const WALLET_MS = 30_000;
const VIEWPORT_DEBOUNCE_MS = 300;
const COVER_TTL_MS = 30_000;
const MARKET_MAX = 100;
const MAX_COINS = 2_000;
/** SOL/USD older than this → USD hidden (INTEGRATION.md §9). */
export const USD_STALE_MS = 10 * 60_000;

/* ================================================================== shared state */

let config: ConfigResponse | null = null;
let launchPriceLamports = 0;
/** placeId → ms it was last touched (LRU for the 2,000-coin cap). */
const seenAt = new Map<string, number>();
/** mint → placeId (feed / holdings lookups). */
const mintToPlace = new Map<string, string>();
let running = false;

const st = () => useStore.getState();

/** The current `/api/config` (null until it loaded). */
export function realConfig(): ConfigResponse | null {
  return config;
}

/** Context for coinFromDTO with the SOL/USD of a given response. */
function ctx(solUsd: number | null | undefined) {
  return { solUsd: solUsd ?? config?.solUsd ?? null, launchPriceLamports };
}

/** DTOs → store (keeps detail history of coins we already know; LRU stamp). */
export function ingestCoins(dtos: readonly CoinDTO[], solUsd: number | null | undefined): Coin[] {
  if (dtos.length === 0) return [];
  const s = st();
  const out: Coin[] = [];
  const t = Date.now();
  for (const d of dtos) {
    if (!d || typeof d.placeId !== 'string' || typeof d.mint !== 'string') continue;
    const prev = s.coins[d.placeId];
    // a stale list row must not roll back a fresher market read we already applied
    const c = prev?.real && prev.mint === d.mint && prev.real.marketAt > d.market.at ? mergeOlderRow(prev, d, solUsd) : coinFromDTO(d, ctx(solUsd), prev?.mint === d.mint ? prev : undefined);
    out.push(c);
    seenAt.set(d.placeId, t);
    mintToPlace.set(d.mint, d.placeId);
  }
  s.upsertCoins(out);
  pruneCoins();
  return out;
}

/** A list row older than our market read: take its registry/vault facts, keep our market fields. */
function mergeOlderRow(prev: Coin, d: CoinDTO, solUsd: number | null | undefined): Coin {
  const fresh = coinFromDTO({ ...d, market: { ...d.market } }, ctx(solUsd), prev);
  return {
    ...fresh,
    priceUsd: prev.priceUsd,
    priceSol: prev.priceSol,
    marketCapUsd: prev.marketCapUsd,
    volume24h: prev.volume24h,
    change24h: prev.change24h,
    history: prev.history,
    historyAt: prev.historyAt,
    ticks: prev.ticks,
    tickTimes: prev.tickTimes,
    real: fresh.real && prev.real ? { ...fresh.real, ...pickMarket(prev.real) } : fresh.real,
  };
}

function pickMarket(r: NonNullable<Coin['real']>) {
  return {
    priceLamports: r.priceLamports,
    mcapLamports: r.mcapLamports,
    vol24hLamports: r.vol24hLamports,
    realSolLamports: r.realSolLamports,
    progressPct: r.progressPct,
    change24hKnown: r.change24hKnown,
    marketAt: r.marketAt,
    usdRate: r.usdRate,
  };
}

/** Keep ≤ 2,000 coins: drop the least recently seen, never the selected / held / owned / launched-by-me ones. */
function pruneCoins(): void {
  const s = st();
  const ids = Object.keys(s.coins);
  if (ids.length <= MAX_COINS) return;
  const keep = new Set<string>();
  if (s.selected.place) keep.add(s.selected.place.id);
  for (const id of Object.keys(s.holdingsRaw)) keep.add(id);
  const me = s.wallet.address;
  for (const c of Object.values(s.coins)) if (me && (c.owner === me || c.launcher === me || c.real?.pendingOwner === me)) keep.add(c.placeId);
  const victims = ids
    .filter((id) => !keep.has(id))
    .sort((a, b) => (seenAt.get(a) ?? 0) - (seenAt.get(b) ?? 0))
    .slice(0, ids.length - MAX_COINS);
  if (victims.length === 0) return;
  const coins = { ...s.coins };
  for (const id of victims) {
    const c = coins[id];
    if (c) mintToPlace.delete(c.mint);
    delete coins[id];
    seenAt.delete(id);
  }
  useStore.setState({ coins });
}

function touch(placeId: string): void {
  seenAt.set(placeId, Date.now());
}

/** placeId for a mint we know (store or lookup map). */
export function placeIdForMint(mint: string): string | null {
  const hit = mintToPlace.get(mint);
  if (hit && st().coins[hit]?.mint === mint) return hit;
  for (const c of Object.values(st().coins)) {
    if (c.mint === mint) {
      mintToPlace.set(mint, c.placeId);
      return c.placeId;
    }
  }
  return null;
}

/* ================================================================== config */

function applyConfig(cfg: ConfigResponse): void {
  config = cfg;
  launchPriceLamports = launchPriceFromConfig(cfg);
  setChainConfig(cfg);
  setExplorerConfig(cfg);
  const s = st();
  if (BUILD_CLUSTER && cfg.cluster !== BUILD_CLUSTER) {
    s.setChain({ status: 'mismatch', config: cfg });
    return;
  }
  s.setChain({ status: 'ready', config: cfg });
  if (cfg.solUsd && cfg.solUsd > 0) {
    const changed = cfg.solUsd !== s.solUsd;
    useStore.setState({ solUsd: cfg.solUsd, solUsdAt: cfg.solUsdAt ?? Date.now() });
    if (changed) rescaleAll(cfg.solUsd);
  }
}

/** Re-derive every coin's USD fields at a new SOL/USD (one state update). */
function rescaleAll(solUsd: number): void {
  const s = st();
  let coins: Record<string, Coin> | null = null;
  for (const [id, c] of Object.entries(s.coins)) {
    const n = withUsdRate(c, solUsd);
    if (n === c) continue;
    coins ??= { ...s.coins };
    coins[id] = n;
  }
  if (coins) useStore.setState({ coins });
}

async function loadConfig(): Promise<void> {
  try {
    applyConfig(await api.config());
  } catch (e) {
    // keep the last good config; only report an error before the first one arrived
    if (!config) st().setChain({ status: 'error', config: null });
    throw e;
  }
}

/** Resolves with the config once it loaded (or null after `timeoutMs`). */
export function whenConfig(timeoutMs = 15_000): Promise<ConfigResponse | null> {
  if (config) return Promise.resolve(config);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      unsub();
      resolve(config);
    }, timeoutMs);
    const unsub = useStore.subscribe(
      (s) => s.chain.status,
      () => {
        if (!config) return;
        clearTimeout(t);
        unsub();
        resolve(config);
      },
    );
  });
}

/* ================================================================== viewport registry */

let lastCover: { key: string; at: number } | null = null;
let lastTopAt = 0;

async function loadViewport(): Promise<void> {
  const v = st().viewport;
  if (!v) return;
  if (v.zoom < AREA_MIN_ZOOM || !v.bounds) {
    if (Date.now() - lastTopAt < COVER_TTL_MS) return;
    const r = await api.top('mcap', 300);
    lastTopAt = Date.now();
    ingestCoins(r.coins, r.solUsd);
    return;
  }
  const b = v.bounds;
  // antimeridian: split into two non-wrapping boxes
  const boxes = b.west > b.east ? [{ ...b, east: 180 }, { ...b, west: -180 }] : [b];
  for (const box of boxes) {
    const key = snapBbox(box);
    if (lastCover && Date.now() - lastCover.at < COVER_TTL_MS && bboxCovers(lastCover.key, key)) continue;
    const r = await api.coinsInBbox(key, 300);
    ingestCoins(r.coins, r.solUsd);
    if (boxes.length === 1) lastCover = { key, at: Date.now() };
  }
}

/* ================================================================== market (prices + flashes) */

function marketMints(): string[] {
  const s = st();
  const set = new Map<string, Coin>();
  const sel = s.selected.place ? s.coins[s.selected.place.id] : undefined;
  if (sel?.real) set.set(sel.mint, sel);
  for (const id of Object.keys(s.holdingsRaw)) {
    const c = s.coins[id];
    if (c?.real) set.set(c.mint, c);
  }
  const v = s.viewport;
  if (v?.bounds && v.zoom >= AREA_MIN_ZOOM) {
    const visible = coinsInBounds(s.coins, v.bounds)
      .filter((c) => c.real && c.real.located)
      .sort((a, b) => b.marketCapUsd - a.marketCapUsd);
    for (const c of visible) {
      if (set.size >= MARKET_MAX) break;
      set.set(c.mint, c);
    }
  }
  return [...set.keys()].slice(0, MARKET_MAX);
}

async function loadMarket(): Promise<void> {
  const mints = marketMints();
  if (mints.length === 0) return;
  const r = await api.market(mints);
  const s = st();
  const flashes = s.layers.flashes && !document.hidden;
  let coins: Record<string, Coin> | null = null;
  for (const [mint, m] of Object.entries(r.quotes ?? {})) {
    const placeId = placeIdForMint(mint);
    const cur = placeId ? (coins ?? s.coins)[placeId] : undefined;
    if (!placeId || !cur?.real) continue;
    const before = u64(cur.real.realSolLamports);
    const next = applyMarket(cur, m, r.solUsd);
    if (next === cur) continue;
    coins ??= { ...s.coins };
    coins[placeId] = next;
    touch(placeId);
    // net SOL that went in (buy) / out (sell) of the curve since the last poll
    const after = u64(m.realSol);
    if (flashes && m.venue === 'curve' && after !== before && cur.real.marketAt > 0) {
      const side = after > before ? 'buy' : 'sell';
      const delta = lamportsToSol(after > before ? after - before : before - after);
      if (delta >= 0.001) flashPin(placeId, side, flashLabel(side, delta), true);
    }
  }
  if (coins) useStore.setState({ coins });
  if (r.solUsd && r.solUsd > 0 && r.solUsd !== s.solUsd) useStore.setState({ solUsd: r.solUsd, solUsdAt: r.at || Date.now() });
}

/* ================================================================== selected coin detail */

let detailFresh = false;

function selectedCoin(): Coin | undefined {
  const s = st();
  return s.selected.place ? s.coins[s.selected.place.id] : undefined;
}

/** Load one coin's detail (history, ticks, trades) into the store. */
export async function loadCoinDetail(mint: string, fresh = false): Promise<Coin | null> {
  const d = await api.coin(mint, fresh);
  const [c] = ingestCoins([d], config?.solUsd);
  if (!c) return null;
  const me = st().wallet.address;
  st().setCoinTrades(
    c.placeId,
    (d.trades ?? []).map((t) => tradeFromDTO(t, c.ticker, config?.solUsd ?? null, me)),
  );
  return c;
}

async function loadDetail(): Promise<void> {
  const c = selectedCoin();
  if (!c?.real) return;
  const fresh = detailFresh;
  detailFresh = false;
  try {
    await loadCoinDetail(c.mint, fresh);
  } catch (e) {
    if (fresh) detailFresh = true; // try the fresh read again next time
    throw e;
  }
}

/* ================================================================== feed */

let feedSince = 0;
let feedLoaded = false;

function feedFast(): boolean {
  const s = st();
  return s.panel === 'live' || (s.panel === 'none' && s.heroDismissed);
}

/** Feed trade events become Recent-trade rows of their coin (same ids as the detail's trades). */
function tradesFromFeed(events: readonly FeedEventDTO[]): void {
  const s = st();
  const me = s.wallet.address;
  const byPlace = new Map<string, Trade[]>();
  for (const e of events) {
    if (e.kind !== 'trade') continue;
    // the event carries its own ticker: rows can attach before the coin itself has loaded
    const list = byPlace.get(e.placeId) ?? [];
    list.push(
      tradeFromDTO(
        { id: e.id, sig: e.sig, mint: e.mint, placeId: e.placeId, side: e.side, solLamports: e.solLamports, userLamports: e.userLamports ?? null, tokens: e.tokens, trader: e.wallet, priceLamports: 0, venue: 'curve', ts: e.ts },
        e.ticker,
        s.solUsd,
        me,
      ),
    );
    byPlace.set(e.placeId, list);
  }
  if (byPlace.size === 0) return;
  useStore.setState((cur) => {
    const trades = { ...cur.trades };
    let changed = false;
    for (const [placeId, list] of byPlace) {
      const have = trades[placeId] ?? [];
      const ids = new Set(have.map((t) => t.id));
      const add = list.filter((t) => !ids.has(t.id));
      if (add.length === 0) continue;
      trades[placeId] = [...add, ...have].sort((a, b) => b.ts - a.ts).slice(0, LIMITS.tradesPerCoin);
      changed = true;
    }
    return changed ? { trades } : cur;
  });
}

let pendingUnknown = new Set<string>();
let unknownTimer: ReturnType<typeof setTimeout> | undefined;

/** Coins mentioned by the feed that we haven't loaded yet (so rows can open them). */
function fetchUnknownMints(mints: string[]): void {
  for (const m of mints) if (!placeIdForMint(m)) pendingUnknown.add(m);
  if (pendingUnknown.size === 0 || unknownTimer) return;
  unknownTimer = setTimeout(() => {
    unknownTimer = undefined;
    const batch = [...pendingUnknown].slice(0, 100);
    pendingUnknown = new Set([...pendingUnknown].slice(100));
    api
      .coinsByMints(batch)
      .then((r) => ingestCoins(r.coins, r.solUsd))
      .catch(() => {
        /* rows still render from the event; opening one retries via /c/<mint> */
      });
  }, 150);
}

async function loadFeed(): Promise<void> {
  const r = await api.feed(feedLoaded && feedSince ? { limit: 50, since: Math.max(0, feedSince - 1_000) } : { limit: 50 });
  const events = r.events ?? [];
  feedLoaded = true;
  const me = st().wallet.address;
  const mapped: FeedEvent[] = events.map((e) => feedEventFromDTO(e, st().solUsd, me));
  for (const e of events) if (e.ts > feedSince) feedSince = e.ts;
  st().mergeFeed(mapped);
  fetchUnknownMints([...new Set(events.map((e) => e.mint))]);
  tradesFromFeed(events);
  st().setDataReady(true);
}

/* ================================================================== list panels */

async function loadTop(): Promise<void> {
  const s = st();
  if (s.panel !== 'top' && s.panel !== 'live') return; // only while Top shops / Live shows
  const by = s.topShops.sort;
  const r = await api.top(by, 50);
  ingestCoins(r.coins, r.solUsd);
  // the Live panel's preview shows the other ranking too
  if (s.panel === 'live') {
    const other = await api.top(by === 'mcap' ? 'fees' : 'mcap', 5);
    ingestCoins(other.coins, other.solUsd);
  }
}

async function loadLaunched(): Promise<void> {
  if (st().panel !== 'launched') return;
  const r = await api.newestCoins(50);
  ingestCoins(r.coins, r.solUsd);
}

async function loadMine(): Promise<void> {
  const me = st().wallet.address;
  if (!me || st().panel !== 'mine') return;
  const [a, b] = await Promise.all([api.coinsByLauncher(me), api.coinsByOwner(me)]);
  ingestCoins([...a.coins, ...b.coins], a.solUsd ?? b.solUsd);
}

/* ================================================================== wallet (balance + holdings) */

let walletUsers = 0;
let walletGen = 0;
/** In-flight wallet read (shared) and when the last one finished, per address (de-duplication, INTEGRATION.md §8). */
let walletInflight: { addr: string; p: Promise<void> } | null = null;
let walletReadAt: { addr: string; at: number } | null = null;
/** A non-forced read within this window of the last one is skipped (the poller, the trade box remounting, …). */
const WALLET_DEDUPE_MS = 2_500;

/**
 * Read the connected wallet's SOL balance + Token-2022 holdings (exact) into the store. Concurrent calls share one
 * read; a non-`force` call right after a read is skipped, so the after-tx refreshes, the 30 s poller and components
 * that start polling on mount never read the same wallet twice in a row (≤ 12 /api/rpc per trade).
 */
export async function loadWallet(opts: { force?: boolean } = {}): Promise<void> {
  const s = st();
  const addr = s.wallet.address;
  if (!addr || s.wallet.kind !== 'standard' || !IS_REAL) return;
  if (walletInflight && walletInflight.addr === addr) {
    if (!opts.force) return walletInflight.p;
    await walletInflight.p.catch(() => {});
  }
  if (!opts.force && walletReadAt && walletReadAt.addr === addr && Date.now() - walletReadAt.at < WALLET_DEDUPE_MS) return;
  const p = readWallet(addr).finally(() => {
    walletReadAt = { addr, at: Date.now() };
    if (walletInflight?.p === p) walletInflight = null;
  });
  walletInflight = { addr, p };
  return p;
}

async function readWallet(addr: string): Promise<void> {
  const gen = ++walletGen;
  const { lamports, holdings } = await getWallet(addr); // one batched /api/rpc request
  if (gen !== walletGen || st().wallet.address !== addr) return;
  // holdings of registry coins only (intersect with known mints; look up the unknown ones once)
  const unknown = holdings.filter((h) => !placeIdForMint(h.mint)).map((h) => h.mint);
  if (unknown.length) {
    try {
      const r = await api.coinsByMints(unknown.slice(0, 100));
      ingestCoins(r.coins, r.solUsd);
    } catch {
      /* show what we know */
    }
  }
  const raw: Record<string, string> = {};
  for (const h of holdings) {
    const id = placeIdForMint(h.mint);
    if (id && h.amount > 0n) raw[id] = (u64(raw[id]) + h.amount).toString();
  }
  if (st().wallet.address !== addr) return;
  st().setWalletChain({ lamports: lamports.toString(), holdingsRaw: raw });
}

/**
 * Components that show the balance / holdings (trade box, My coins, account menu) call this while
 * mounted: the wallet is then re-read every 30 s. Returns the release function.
 */
export function holdWalletPolling(): () => void {
  walletUsers++;
  walletPoller?.kick(0);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    walletUsers = Math.max(0, walletUsers - 1);
  };
}

/* ================================================================== pollers */

let configPoller: Poller | null = null;
let viewportPoller: Poller | null = null;
let marketPoller: Poller | null = null;
let detailPoller: Poller | null = null;
let feedPoller: Poller | null = null;
let topPoller: Poller | null = null;
let launchedPoller: Poller | null = null;
let minePoller: Poller | null = null;
let walletPoller: Poller | null = null;
let walletRetry: ReturnType<typeof setTimeout> | undefined;

function allPollers(): Poller[] {
  return [configPoller, viewportPoller, marketPoller, detailPoller, feedPoller, topPoller, launchedPoller, minePoller, walletPoller].filter(
    (p): p is Poller => !!p,
  );
}

/**
 * Start real-mode data. Returns the cleanup. Safe to call once; a second call returns a no-op.
 */
export function startRealData(): () => void {
  if (!IS_REAL || running) return () => {};
  running = true;
  const s0 = st();
  s0.setChain({ status: 'loading', config: null });

  configPoller = new Poller(loadConfig, () => CONFIG_MS, { backoff: true });
  viewportPoller = new Poller(loadViewport, () => null);
  marketPoller = new Poller(loadMarket, () => (config ? MARKET_MS : null), { backoff: true });
  detailPoller = new Poller(loadDetail, () => (selectedCoin()?.real ? DETAIL_MS : null), { backoff: true });
  feedPoller = new Poller(loadFeed, () => (feedFast() ? FEED_FAST_MS : FEED_SLOW_MS), { backoff: true });
  topPoller = new Poller(loadTop, () => (st().panel === 'top' || st().panel === 'live' ? TOP_MS : null), { backoff: true });
  launchedPoller = new Poller(loadLaunched, () => (st().panel === 'launched' ? LIST_MS : null), { backoff: true });
  minePoller = new Poller(loadMine, () => (st().panel === 'mine' && st().wallet.address ? LIST_MS : null), { backoff: true });
  walletPoller = new Poller(loadWallet, () => (walletUsers > 0 && st().wallet.address ? WALLET_MS : null), { backoff: true });

  // boot: config first (cluster check), everything else in parallel
  configPoller.kick(0);
  feedPoller.kick(0);
  viewportPoller.kick(0);
  // first visit: the hero shows registry-wide numbers — one snapshot of the top 300 coins
  if (!s0.heroDismissed) {
    void api
      .top('mcap', 300)
      .then((r) => {
        lastTopAt = Date.now();
        ingestCoins(r.coins, r.solUsd);
      })
      .catch(() => {});
  }
  const afterConfig = useStore.subscribe(
    (s) => s.chain.status,
    (status) => {
      if (status === 'ready') {
        marketPoller?.kick(0);
        if (st().wallet.address) walletPoller?.kick(0);
      }
    },
  );

  const unsubs: (() => void)[] = [afterConfig];
  let vpTimer: ReturnType<typeof setTimeout> | undefined;
  unsubs.push(
    useStore.subscribe(
      (s) => s.viewport,
      () => {
        clearTimeout(vpTimer);
        vpTimer = setTimeout(() => {
          viewportPoller?.kick(0);
          marketPoller?.kick(400);
        }, VIEWPORT_DEBOUNCE_MS);
      },
    ),
  );
  // selection: detail now; a launchable place → registry check (has someone launched it?)
  unsubs.push(
    useStore.subscribe(
      (s) => (s.selected.status === 'ready' ? (s.selected.place?.id ?? null) : null),
      (id) => {
        if (!id) return;
        const coin = st().coins[id];
        if (coin?.real) {
          touch(id);
          detailPoller?.kick(0);
          marketPoller?.kick(0);
        } else if (!st().placeChecks[id] || Date.now() - (st().placeChecks[id] ?? 0) > 30_000) {
          void ensurePlace(id).catch(() => {});
        }
      },
    ),
  );
  unsubs.push(
    useStore.subscribe(
      (s) => s.panel,
      (panel, prev) => {
        if (panel === 'top' || panel === 'live') topPoller?.kick(0);
        if (panel === 'launched') launchedPoller?.kick(0);
        if (panel === 'mine') minePoller?.kick(0);
        // Live / This area visibility changes the feed cadence: poll now when it speeds up
        if (feedFast() && (prev === 'place' || prev === 'top' || prev === 'launched' || prev === 'mine' || prev === 'results' || prev === 'help')) feedPoller?.kick(0);
      },
    ),
  );
  unsubs.push(
    useStore.subscribe(
      (s) => s.topShops.sort,
      () => {
        if (st().panel === 'top' || st().panel === 'live') topPoller?.kick(0);
      },
    ),
  );
  unsubs.push(
    useStore.subscribe(
      (s) => `${s.wallet.address ?? ''}|${s.wallet.kind ?? ''}`,
      () => {
        const s = st();
        walletGen++;
        clearTimeout(walletRetry);
        if (s.wallet.address && s.wallet.kind === 'standard') {
          prefetchChain();
          walletPoller?.kick(0);
          if (s.panel === 'mine') minePoller?.kick(0);
        }
      },
    ),
  );

  const resume = () => {
    if (!pageActive()) return;
    for (const p of allPollers()) p.resume();
  };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('online', resume);

  return () => {
    running = false;
    clearTimeout(vpTimer);
    clearTimeout(walletRetry);
    for (const u of unsubs) u();
    for (const p of allPollers()) p.stop();
    configPoller = viewportPoller = marketPoller = detailPoller = feedPoller = topPoller = launchedPoller = minePoller = walletPoller = null;
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('online', resume);
  };
}

/* ================================================================== on-demand */

/** Registry lookup for a place (place panel: coin or launchable?). Upserts a found coin. */
export async function ensurePlace(placeId: string): Promise<PlaceResponse> {
  const r = await api.place(placeId);
  st().markPlaceChecked(placeId);
  if (r.coin) ingestCoins([r.coin], config?.solUsd);
  return r;
}

/** Server-side launchability (Google lookup). */
export function checkEligibility(placeId: string): Promise<EligibilityResponse> {
  return api.eligibility(placeId);
}

/** Look a coin up by mint (deep links /c/<mint>). Null when the registry doesn't have it. */
export async function findCoinByMint(mint: string): Promise<Coin | null> {
  const known = placeIdForMint(mint);
  if (known) return st().coins[known] ?? null;
  try {
    return await loadCoinDetail(mint);
  } catch (e) {
    if (isApiError(e) && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
}

/**
 * After an own transaction (INTEGRATION.md §5.2): wallet now + again in 3 s, the coin with a
 * fresh chain read, the feed and the lists that show it.
 */
export async function refreshAfterTx(kind: 'launch' | 'trade' | 'claim' | 'withdraw', mint?: string): Promise<void> {
  if (!IS_REAL) return;
  clearTimeout(walletRetry);
  // Every landed tx changes the payer's SOL (fees at least). The read below is `confirmed`, like the tx, so it normally
  // shows the new state; only when it still returns the balance from before the tx (a lagging RPC node) is the wallet
  // read once more, 2.5 s later (INTEGRATION §8: one trade ≤ 12 /api/rpc requests; the unconditional second read cost 1-2).
  const addr = st().wallet.address;
  const before = st().balanceLamports;
  const jobs: Promise<unknown>[] = [
    loadWallet({ force: true })
      .then(() => {
        const s = st();
        if (addr && s.wallet.address === addr && before != null && s.balanceLamports === before) {
          walletRetry = setTimeout(() => void loadWallet({ force: true }).catch(() => {}), 2_500);
        }
      })
      .catch(() => {}),
  ];
  if (mint) {
    jobs.push(loadCoinDetail(mint, true).catch(() => {}));
  } else if (selectedCoin()?.real) {
    detailFresh = true;
    detailPoller?.kick(0);
  }
  feedPoller?.kick(kind === 'launch' ? 0 : 1_500);
  marketPoller?.kick(0);
  if (kind === 'launch') {
    lastCover = null;
    viewportPoller?.kick(0);
  }
  if (st().panel === 'mine') minePoller?.kick(0);
  await Promise.all(jobs);
}

/** Kick the market + detail pollers (trade box opened / quote refresh wants fresh numbers). */
export function pokeMarket(): void {
  marketPoller?.kick(0);
}

/** True while SOL/USD is known and fresh enough to show USD (INTEGRATION.md §9). */
export function usdFresh(s: { solUsdAt: number | null }, at = Date.now()): boolean {
  if (!IS_REAL) return true;
  return s.solUsdAt != null && at - s.solUsdAt <= USD_STALE_MS;
}
