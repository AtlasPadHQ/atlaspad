/**
 * CORNERSHOP app store (zustand v5 + subscribeWithSelector). Single source of truth.
 * SHARED file — only the scaffold / integrator / fixer edits it. API documented in CONTRACTS.md.
 *
 * Rules for module code:
 *  - Read with selectors: `const coin = useStore((s) => s.coins[id])`.
 *  - Derived arrays MUST use `useShallow` (zustand v5 throws on unstable selector results):
 *      `const list = useStore(useShallow((s) => topByMc(s.coins, 50)))`
 *    or the ready-made hooks at the bottom of this file (useCoinList, useTopCoins…).
 *  - Outside React: `useStore.getState().openPlace(...)`, `useStore.subscribe(sel, cb)`.
 *  - Demo mode: everything chain-related is SIMULATED (userBuy/userSell/launchCoin/claimFees).
 *  - Real mode (src/mode IS_REAL): the coin registry, prices, feed and wallet balances are written
 *    by src/realdata (upsertCoins / mergeFeed / setWalletChain …) from the Worker API + chain; the
 *    simulated actions are never called. Nothing in the store signs or sends a transaction.
 *  - Never put Google place content (names, addresses, photos, phones) in persisted state.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import {
  DEMO_BALANCE_SOL,
  DEMO_SOL_USD,
  FOCUS_ZOOM,
  HERO_CAMERA,
  INITIAL_CAMERA,
  LIMITS,
  STORAGE_KEYS,
  resolveProvider,
} from './config';
import { categoryLabel } from './lib/categories';
import { fakeMint, randomSignature, randomWallet } from './lib/fakeSolana';
import { shortAddr, solNumber, tokenAmount, usdCompactFloor } from './lib/format';
import { solFloor } from './realdata/units';
import { boundsContains, GeoError, isLatLng, requestPosition } from './lib/geo';
import { buildCoin, quoteBuy, quoteSell, quoteSellForSol, withPrice, type Quote } from './lib/market';
import { coinPlaceFrom, isGooglePlaceId, isLaunchableSource, knownIneligibility, sourceFromId } from './lib/place';
import { loadJSON, loadString, removeKey, saveJSON, saveString, storageAvailable } from './lib/storage';
import { TICKER_RE } from './lib/ticker';
import { CLUSTER, IS_REAL } from './mode';
import type { ConfigResponse } from '../worker/wire';
import type {
  Bounds,
  ChipFilter,
  Coin,
  FeedEvent,
  FlyTarget,
  HelpSection,
  LatLng,
  LaunchDraft,
  LaunchResult,
  LayersState,
  ListPanelMode,
  LocateStatus,
  MapProvider,
  ModalState,
  PanelMode,
  Place,
  PlaceTab,
  ProviderReason,
  SheetSnap,
  Toast,
  ToastAction,
  ToastKind,
  Trade,
  TradeResult,
  TradeSide,
  TxState,
  UserLocation,
  UserTradeResult,
  Viewport,
  WalletData,
  WalletState,
} from './types';

/* ===================================================================== types */

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SelectedState {
  place: Place | null;
  status: LoadStatus;
  error?: string;
  /** While loading without a place yet: the place is known to have no coin (launchable skeleton, §13.3). */
  launchable?: boolean;
}

export interface OpenPlaceOptions {
  /** Fly the camera to the place (lists, search, deep links). Map clicks pass false. Default false. */
  fly?: boolean;
  /** Zoom for `fly` (default FOCUS_ZOOM = 16). */
  zoom?: number;
  /** Initial tab (default 'overview'). */
  tab?: PlaceTab;
  /** Back-chip target. Defaults to the list panel currently open (if any). Pass null for none. */
  from?: ListPanelMode | null;
  /** Also open the launch modal (launchable places only). */
  launch?: boolean;
}

export interface SimTrade {
  placeId: string;
  side: TradeSide;
  sol: number;
  wallet?: string;
}

export interface TopShopsState {
  sort: 'mcap' | 'fees';
  scope: 'everywhere' | 'area';
}

export interface SearchFocusRequest {
  nonce: number;
  /** Prefill the input. */
  text?: string;
  /** Open the dropdown with the "Paste a Google Maps link" tip. */
  tip?: boolean;
}

/** Real-mode chain/config status (INTEGRATION.md §5.3). 'off' = demo mode. */
export interface ChainState {
  status: 'off' | 'loading' | 'ready' | 'mismatch' | 'error';
  config: ConfigResponse | null;
}

export interface WalletChainData {
  /** Exact confirmed balance (u64 string), or null when unknown. */
  lamports: string | null;
  /** placeId → token base units (u64 string) of coins the wallet holds. */
  holdingsRaw: Record<string, string>;
}

export type ClaimResult =
  | { ok: true; amountUsd: number; coin: Coin }
  | { ok: false; reason: 'no-coin' | 'no-wallet' | 'already-claimed'; message: string };

export interface AppState {
  /* ---------------- map provider */
  provider: MapProvider;
  providerReason: ProviderReason;

  /* ---------------- data */
  coins: Record<string, Coin>;
  /** Recent trades per placeId, newest first (cap LIMITS.tradesPerCoin). */
  trades: Record<string, Trade[]>;
  /** Live feed, newest first (cap LIMITS.feed). */
  feed: FeedEvent[];
  /** SOL price in USD: the constant DEMO_SOL_USD (DESIGN §3.4). */
  solUsd: number;
  /** ms timestamp of the last simulated/real trade or tick (feed health). */
  simLastTickAt: number;

  /* ---------------- panels & selection */
  selected: SelectedState;
  panel: PanelMode;
  /** Back-chip stack: list panels the current place was opened from (top = last). */
  panelHistory: ListPanelMode[];
  /** How the current panel was reached ('back' → PanelShell restores scroll). */
  panelNav: 'push' | 'back';
  /** Desktop collapse tab state (selection is kept while collapsed). */
  panelCollapsed: boolean;
  placeTab: PlaceTab;
  helpSection: HelpSection | null;
  results: Place[];
  resultsQuery: string;
  resultsStatus: LoadStatus;
  topShops: TopShopsState;

  /* ---------------- map */
  category: ChipFilter | null;
  flyTarget: FlyTarget | null;
  viewport: Viewport | null;
  userLocation: UserLocation | null;
  locateStatus: LocateStatus;
  layers: LayersState;

  /* ---------------- chrome */
  modal: ModalState | null;
  heroDismissed: boolean;
  sheetSnap: SheetSnap;
  /** Mobile navigation drawer open. */
  railOpen: boolean;
  /** Search dropdown open (mobile: full-screen search mode). */
  searchOpen: boolean;
  searchFocus: SearchFocusRequest | null;
  /** At most one toast (DESIGN §13.1: a new one replaces the old). */
  toasts: Toast[];
  online: boolean;
  /** Recently opened place IDs (newest first, max 5) — IDs only (localStorage cs_recent). */
  recent: string[];
  /** Launched-panel "seen" timestamp (localStorage cs_launched_seen_at). */
  launchedSeenAt: number;

  /* ---------------- real mode (Phase 2) */
  chain: ChainState;
  /** The transaction flow in progress (one at a time), or null. */
  tx: TxState | null;
  /** placeId → exact token base units held by the connected wallet (sell 100% uses these). */
  holdingsRaw: Record<string, string>;
  /** Connected wallet's exact SOL balance in lamports (u64 string); null = unknown / demo. */
  balanceLamports: string | null;
  /** ms when solUsd was last refreshed from the Worker (null in demo mode: the constant rate). */
  solUsdAt: number | null;
  /** First registry/feed load finished (lists stop showing skeletons). Demo: after seeding. */
  dataReady: boolean;
  /** placeId → ms of the last registry lookup (real mode: Launch waits for it). */
  placeChecks: Record<string, number>;

  /* ---------------- wallet (simulated balances in demo mode) */
  wallet: WalletState;
  /** Name of the wallet currently being connected ("Phantom"), for the pill's Connecting… state. */
  walletConnecting: string | null;
  solBalance: number;
  /** placeId → token balance of the connected wallet. */
  holdings: Record<string, number>;
  /** Watched place IDs of the connected wallet. */
  watch: string[];

  /* =============================== actions =============================== */

  setProvider(provider: MapProvider, reason: ProviderReason): void;

  /** Open a place in the panel (launched or launchable variant is decided by `coins[place.id]`). */
  openPlace(place: Place, opts?: OpenPlaceOptions): void;
  /** Show the place panel in its loading state (skeleton) while details resolve. */
  setPlaceLoading(partial?: Place | null, hint?: { launchable?: boolean }): void;
  /** Show the place panel error state. */
  setPlaceError(message: string): void;
  setPlaceTab(tab: PlaceTab): void;
  /** Open a panel (list panels, help) — 'none' closes. Keeps the selection; clears the back stack. */
  setPanel(mode: PanelMode): void;
  /** Rail behaviour: open `mode`, or close the panel if it is already open. */
  togglePanel(mode: PanelMode): void;
  /** Back chip: return to the previous list panel. Returns false when there is nothing to go back to. */
  back(): boolean;
  /** Close any panel, clear selection, results and the back stack. */
  closePanel(): void;
  setPanelCollapsed(collapsed: boolean): void;
  /** Show a results list for a search. */
  showResults(query: string, places: Place[]): void;
  /** Results panel in loading / error state. */
  setResultsStatus(status: LoadStatus, query?: string): void;
  openHelp(section?: HelpSection | null): void;
  setTopShops(patch: Partial<TopShopsState>): void;

  setCategory(filter: ChipFilter | null): void;
  /** Chip behaviour: on → off when tapped again; single-select. */
  toggleCategory(filter: ChipFilter): void;
  flyTo(center: LatLng, zoom?: number): void;
  fitBounds(bounds: Bounds): void;
  /** Published by the map on idle/moveend (also persisted to sessionStorage cs_viewport). */
  setViewport(v: Viewport): void;
  setUserLocation(loc: UserLocation | null): void;
  setLocateStatus(s: LocateStatus): void;
  /** Near me: ask for geolocation (user tap only), show the dot, fly to zoom 16; toasts on error. */
  locate(): Promise<void>;
  setLayers(patch: Partial<LayersState>): void;

  openModal(m: ModalState): void;
  closeModal(): void;
  /**
   * Run `action` now if a wallet is connected, else open the wallet modal and run it after a
   * successful connect (cancel = nothing). Returns true when it ran immediately.
   */
  requireWallet(action: () => void): boolean;
  /** Show a toast (replaces the current one). Returns its id. */
  toast(msg: string, kind?: ToastKind, action?: ToastAction, icon?: string): number;
  dismissToast(id?: number): void;
  dismissHero(): void;
  setSheetSnap(s: SheetSnap): void;
  setRailOpen(open: boolean): void;
  setSearchOpen(open: boolean): void;
  /** Ask the search bar to focus (optionally prefilled / with the link tip). */
  focusSearch(opts?: { text?: string; tip?: boolean }): void;
  setOnline(online: boolean): void;
  addRecent(placeId: string): void;
  markLaunchedSeen(): void;

  /** Load demo seed coins (replaces previous seeds; user-launched coins are kept). */
  seedCoins(coins: Coin[]): void;
  /** Backfill trades/feed for seeded coins (simulator start). */
  seedActivity(activity: { trades?: Trade[]; feed?: FeedEvent[] }): void;
  /** Restore user-launched coins, local claims and an email wallet from localStorage. */
  hydrateUserCoins(): void;
  /**
   * Merge user-launched coins saved by another tab (the `storage` event): coins this tab doesn't
   * know are added; for a place both tabs launched, the earlier launch wins (one coin per place).
   */
  mergeUserCoins(coins: Coin[]): void;
  /** Re-apply locally stored claims (another tab claimed / submitted a review). */
  syncClaims(): void;
  /** Add a coin launched by someone else (simulator). Returns false if the place already has a coin. */
  addCoin(coin: Coin, opts?: { feed?: boolean }): boolean;
  /** Launch a coin as the connected wallet (one coin per placeId — first launch wins). */
  launchCoin(draft: LaunchDraft): LaunchResult;
  /** Simulated trade by a (random) trader. Buys spend `sol`; sells return about `sol`. */
  applySimulatedTrade(placeId: string, side: TradeSide, sol: number, wallet?: string): TradeResult | null;
  /** Apply many simulated trades in one state update. */
  applyTickBatch(batch: SimTrade[]): TradeResult[];
  /** The connected wallet buys `sol` SOL of a coin (simulated). */
  userBuy(placeId: string, sol: number): UserTradeResult;
  /** The connected wallet sells `tokens` of a coin (simulated). */
  userSell(placeId: string, tokens: number): UserTradeResult;
  /** Owner claim (after verification). `owner` defaults to the connected wallet. */
  claimFees(placeId: string, payoutWallet: string, opts?: { owner?: string }): ClaimResult;
  /** Manual-review claim pending flag ("Owner verification in progress"). */
  setClaimPending(placeId: string, pending: boolean): void;
  /** Owner changes the payout wallet. */
  setPayoutWallet(placeId: string, payoutWallet: string): boolean;
  pushFeed(event: FeedEvent): void;
  setSolUsd(v: number): void;
  /** Toggle watching a place (requires wallet). Returns the new state, or null without a wallet. */
  toggleWatch(placeId: string): boolean | null;

  setWallet(w: WalletState): void;
  setWalletConnecting(name: string | null): void;
  disconnectWallet(): void;

  /* ---------------- real mode (written by src/realdata) */
  setChain(patch: Partial<ChainState>): void;
  setTx(tx: TxState | null): void;
  /** Insert / replace registry coins (keyed by placeId). */
  upsertCoins(coins: Coin[]): void;
  /** Merge feed events (dedup by id, newest first). `replace` swaps the whole feed. */
  mergeFeed(events: FeedEvent[], opts?: { replace?: boolean }): void;
  /** Replace the recent trades of one coin (newest first), keeping newer local rows. */
  setCoinTrades(placeId: string, trades: Trade[]): void;
  /** Real wallet balance + holdings (exact) for the connected wallet. */
  setWalletChain(d: WalletChainData): void;
  markPlaceChecked(placeId: string): void;
  setDataReady(ready: boolean): void;
}

/* ===================================================================== helpers */

const now = () => Date.now();
let idSeq = 0;
const uid = (p: string) => `${p}_${now().toString(36)}_${(++idSeq).toString(36)}`;
let toastSeq = 0;

const LIST_PANELS: readonly PanelMode[] = ['results', 'live', 'top', 'launched', 'mine'];
const isListPanel = (m: PanelMode): m is ListPanelMode => LIST_PANELS.includes(m);

const DEFAULT_LAYERS: LayersState = { mapType: 'roadmap', coins: true, feeDots: true, flashes: true, ticks: true };
/** Launch rows rebuilt for restored coins after a reload: launches from the last 6 hours (as the seeded backfill). */
const RESTORED_LAUNCH_ROWS_MS = 6 * 3_600_000;

function emptyWallet(): WalletState {
  return { address: null, kind: null };
}

function feedBase(coin: Coin, ts: number) {
  return {
    id: uid('ev'),
    ts,
    placeId: coin.placeId,
    ticker: coin.ticker,
    name: coin.name,
    emoji: coin.logo.emoji,
    bg: coin.logo.bg,
  };
}

function capFeed(feed: FeedEvent[]): FeedEvent[] {
  return feed.length > LIMITS.feed ? feed.slice(0, LIMITS.feed) : feed;
}

/**
 * Fees waiting for the shop, in USD. Demo: unclaimed shops only (a claim pays everything out).
 * Real mode: everything not yet withdrawn by the owner (claimed or not), from the vault's exact
 * lamports, rounded down (src/realdata/mapping).
 */
export function feesWaiting(coin: Coin): number {
  if (coin.real) return coin.real.feesWaitingUsd;
  return coin.claimed ? 0 : Math.max(0, coin.feesEarnedUsd - coin.feesClaimedUsd);
}

/** SOL/USD older than this hides USD in real mode (INTEGRATION.md §9; same rule as realdata `usdFresh`). */
const USD_STALE_MS = 10 * 60_000;

export interface FeesTotal {
  /** USD, rounded DOWN to the cent (real coins: exact lamports summed first, converted once). */
  usd: number;
  /** Exact lamports of the real coins in the list. */
  lamports: bigint;
  /** False in real mode while SOL/USD is unknown or stale: show `lamports` as SOL instead of USD. */
  usdKnown: boolean;
}

/**
 * Fees waiting for owners over a set of coins (This area, the Fees chip, the hero). Money owed is never overstated
 * (INTEGRATION.md §9): real coins add their exact lamports and convert ONCE, rounded down to the cent; demo coins add
 * their simulated USD. Nothing is rounded to whole dollars here; display rounding is the formatter's (also down).
 */
export function feesWaitingTotal(list: readonly Coin[], solUsd: number, solUsdAt: number | null, at = Date.now()): FeesTotal {
  let lamports = 0n;
  let demoUsd = 0;
  for (const c of list) {
    if (c.real) {
      const v = c.real.feesWaitingLamports;
      if (typeof v === 'string' && /^\d{1,20}$/.test(v)) lamports += BigInt(v);
    } else demoUsd += feesWaiting(c);
  }
  const usdKnown = !IS_REAL || (solUsd > 0 && solUsdAt != null && at - solUsdAt <= USD_STALE_MS);
  let usd = demoUsd;
  if (lamports > 0n && solUsd > 0) {
    // cents = lamports × µUSD/SOL / 1e9 / 1e4, integer maths (same as realdata/units lamportsToUsdFloor)
    const microUsdPerSol = BigInt(Math.floor(solUsd * 1_000_000));
    usd += Number((lamports * microUsdPerSol) / 10_000_000_000_000n) / 100;
  }
  return { usd: Math.floor(usd * 100 + 1e-6) / 100, lamports, usdKnown };
}

/** Display string for a FeesTotal (rounded down everywhere), or null when nothing is waiting. */
export function feesTotalLabel(t: FeesTotal): string | null {
  if (!t.usdKnown) {
    if (t.lamports <= 0n) return t.usd > 0 ? usdCompactFloor(t.usd) : null;
    const sol = solFloor(t.lamports, 4);
    return sol === '0' ? '<0.0001 SOL' : `${sol} SOL`;
  }
  if (t.usd > 0) return usdCompactFloor(t.usd);
  return t.lamports > 0n ? '<$0.01' : null;
}

/** cs_wallet: the wallet name (+ the mocked address for email wallets) only — never the email (DESIGN §12.4). */
interface StoredWallet {
  kind: 'standard' | 'email';
  walletName?: string;
  address?: string;
}

/**
 * cornershop:v1:claims, keyed by place ID. A claim belongs to ONE coin (`mint`): a place can get a
 * new coin later (the old one expired after Google's 30-day limit, or a simulator coin is gone
 * after a reload), and that new coin must stay `Unclaimed · not affiliated` until someone
 * verifies it (DESIGN §17). Records saved by older builds have no `mint`; see claimMatchesCoin.
 */
interface StoredClaim {
  /** Mint of the coin that was claimed. */
  mint?: string;
  owner?: string;
  payoutWallet?: string;
  claimedAt?: number;
  /** USD paid out at the claim (Live feed claim row). */
  amountUsd?: number;
  pending?: boolean;
}

function walletKey(address: string) {
  // real mode keeps only the watch list, per cluster (balances and holdings come from the chain)
  return IS_REAL ? `${STORAGE_KEYS.walletData}${CLUSTER ?? 'real'}:watch:${address}` : `${STORAGE_KEYS.walletData}${address}`;
}

function loadWalletData(address: string): WalletData {
  const d = loadJSON<Partial<WalletData> | null>(walletKey(address), null);
  if (IS_REAL) {
    return { sol: 0, holdings: {}, watch: Array.isArray(d?.watch) ? d.watch.filter((x): x is string => typeof x === 'string') : [], trades: [] };
  }
  return {
    sol: typeof d?.sol === 'number' && Number.isFinite(d.sol) ? d.sol : DEMO_BALANCE_SOL,
    holdings: d?.holdings && typeof d.holdings === 'object' ? d.holdings : {},
    watch: Array.isArray(d?.watch) ? d.watch.filter((x): x is string => typeof x === 'string') : [],
    trades: Array.isArray(d?.trades) ? d.trades : [],
  };
}

function loadClaims(): Record<string, StoredClaim> {
  const c = loadJSON<Record<string, StoredClaim> | null>(STORAGE_KEYS.claims, null);
  return c && typeof c === 'object' ? c : {};
}

/**
 * Does a stored claim belong to this coin? Claims carry the mint they were made for. Records from
 * older builds (no mint) only apply to seeded demo coins, whose place can never get another coin;
 * for any other coin we can't tell it from an earlier coin on the same place, so they're ignored
 * (a user-launched coin saves its own claim fields in its stored record anyway).
 */
function claimMatchesCoin(coin: Coin, c: StoredClaim): boolean {
  if (c.mint) return c.mint === coin.mint;
  return !!coin.isDemoSeed;
}

/** True when this browser submitted the pending (manual review) claim for the coin on `placeId`. */
export function isOwnPendingClaim(placeId: string): boolean {
  const c = loadClaims()[placeId];
  const coin = useStore.getState().coins[placeId];
  return c?.pending === true && !!coin && claimMatchesCoin(coin, c);
}

function applyClaim(coin: Coin, c: StoredClaim | undefined): Coin {
  if (!c || !claimMatchesCoin(coin, c)) return coin;
  if (c.pending && !coin.claimed) return { ...coin, claimPending: true };
  if (c.owner && c.payoutWallet) {
    return {
      ...coin,
      claimed: true,
      ownerVerified: true,
      claimPending: false,
      claimedAt: c.claimedAt ?? coin.claimedAt,
      claimedUsd: typeof c.amountUsd === 'number' && Number.isFinite(c.amountUsd) ? c.amountUsd : coin.claimedUsd,
      owner: c.owner,
      payoutWallet: c.payoutWallet,
      feesClaimedUsd: coin.feesEarnedUsd,
    };
  }
  return coin;
}

function isCoinLike(v: unknown): v is Coin {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<Coin>;
  return (
    typeof c.placeId === 'string' &&
    typeof c.ticker === 'string' &&
    typeof c.mint === 'string' &&
    typeof c.priceUsd === 'number' &&
    !!c.place &&
    isLatLng(c.place.location) &&
    !!c.logo
  );
}

/** A coin restored from storage (or another tab): user-launched, with a ticks array. */
function normalizeStoredCoin(c: Coin): Coin {
  const ticks = Array.isArray(c.ticks) ? c.ticks : [];
  const tickTimes = Array.isArray(c.tickTimes) && c.tickTimes.length === ticks.length ? c.tickTimes : undefined;
  const out: Coin = { ...c, isUserLaunched: true, ticks, tickTimes };
  // Older builds copied a claim made for an EARLIER coin on the same place into a new coin. A claim
  // can't predate its coin, so such a record is unclaimed: drop the borrowed owner fields.
  if (out.claimed && typeof out.claimedAt === 'number' && out.claimedAt < out.launchedAt) {
    out.claimed = false;
    out.ownerVerified = false;
    out.feesClaimedUsd = 0;
    delete out.claimedAt;
    delete out.claimedUsd;
    delete out.owner;
    delete out.payoutWallet;
  }
  return out;
}

/** Google SST §14.3: cached coordinates of Google places expire after 30 days. */
function userCoinExpired(c: Coin, t: number): boolean {
  return c.place.source === 'google' && t - c.launchedAt >= LIMITS.googleCoordTtlMs;
}

/** User-launched coins saved in localStorage (valid and not expired). */
function readStoredUserCoins(raw?: unknown): Coin[] {
  const stored = raw === undefined ? loadJSON<unknown>(STORAGE_KEYS.userCoins, []) : raw;
  const t = now();
  return (Array.isArray(stored) ? stored : []).filter(isCoinLike).filter((c) => !userCoinExpired(c, t)).map(normalizeStoredCoin);
}

/** For one place, the coin that keeps the slot: the earlier launch wins (one coin per place). */
function firstLaunch(a: Coin, b: Coin): Coin {
  if (a.mint === b.mint) return a;
  return b.launchedAt < a.launchedAt ? b : a;
}

function readHeroDismissed(): boolean {
  // If storage is unavailable, show the hero once per page session (DESIGN §11).
  if (!storageAvailable()) return false;
  return loadString(STORAGE_KEYS.heroSeen) === '1';
}

function readLaunchedSeenAt(): number {
  const v = Number(loadString(STORAGE_KEYS.launchedSeenAt));
  if (Number.isFinite(v) && v > 0) return v;
  // First visit: count launches from the last hour only.
  return now() - 3_600_000;
}

function readLayers(): LayersState {
  const l = loadJSON<Partial<LayersState> | null>(STORAGE_KEYS.layers, null);
  return { ...DEFAULT_LAYERS, ...(l && typeof l === 'object' ? l : {}) };
}

/** Recent ids worth keeping across reloads: Google place IDs and demo shops (DESIGN §6.2). */
function isReopenableId(id: string): boolean {
  const src = sourceFromId(id);
  return src === 'demo' || (src === 'google' && isGooglePlaceId(id));
}

function readRecent(): string[] {
  const r = loadJSON<unknown>(STORAGE_KEYS.recent, []);
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string' && isReopenableId(x)).slice(0, LIMITS.recent) : [];
}

/** Camera to start the map with: last viewport this tab session → hero camera on first visit → Dalston. */
export function initialCamera(heroVisible: boolean): { center: LatLng; zoom: number } {
  const v = loadJSON<{ center?: LatLng; zoom?: number } | null>(STORAGE_KEYS.viewport, null, 'session');
  if (v && isLatLng(v.center) && typeof v.zoom === 'number') return { center: v.center, zoom: v.zoom };
  return heroVisible ? HERO_CAMERA : INITIAL_CAMERA;
}

let viewportTimer: ReturnType<typeof setTimeout> | undefined;
function persistViewport(v: Viewport): void {
  clearTimeout(viewportTimer);
  viewportTimer = setTimeout(() => saveJSON(STORAGE_KEYS.viewport, { center: v.center, zoom: v.zoom }, 'session'), 500);
}

/* ===================================================================== store */

const initialProvider = resolveProvider();

export const useStore = create<AppState>()(
  subscribeWithSelector((set, get) => {
    /* -------- internal: apply one quote to the state (pure-ish transition) -------- */
    interface Draft {
      coins: Record<string, Coin>;
      trades: Record<string, Trade[]>;
      feed: FeedEvent[];
    }

    function transition(
      d: Draft,
      coin: Coin,
      q: Quote,
      wallet: string,
      isUser: boolean,
      holdersDelta: number,
      ts: number,
    ): TradeResult {
      const fee = q.feeUsd;
      let next = withPrice(coin, q.priceAfter, get().solUsd, ts);
      next = {
        ...next,
        volume24h: coin.volume24h + q.usd,
        feesEarnedUsd: coin.feesEarnedUsd + fee,
        feesClaimedUsd: coin.claimed ? coin.feesClaimedUsd + fee : coin.feesClaimedUsd,
        holders: Math.max(1, coin.holders + holdersDelta),
        lastTradeAt: ts,
      };
      const trade: Trade = {
        id: uid('tr'),
        placeId: coin.placeId,
        ticker: coin.ticker,
        side: q.side,
        usd: q.usd,
        sol: q.sol,
        tokens: q.tokens,
        wallet,
        ts,
        signature: randomSignature(),
        ...(isUser ? { isUser: true } : {}),
      };
      d.coins = { ...d.coins, [coin.placeId]: next };
      const list = d.trades[coin.placeId] ?? [];
      d.trades = { ...d.trades, [coin.placeId]: [trade, ...list].slice(0, LIMITS.tradesPerCoin) };
      d.feed = capFeed([
        { ...feedBase(next, ts), kind: 'trade', side: q.side, sol: q.sol, usd: q.usd, wallet, ...(isUser ? { isUser: true } : {}) },
        ...d.feed,
      ]);
      return { side: q.side, sol: q.sol, usd: q.usd, tokens: q.tokens, priceBefore: q.priceBefore, priceAfter: q.priceAfter, trade };
    }

    function simTrade(d: Draft, t: SimTrade, ts: number): TradeResult | null {
      const coin = d.coins[t.placeId];
      if (!coin || !(t.sol > 0)) return null;
      const solUsd = get().solUsd;
      const q = t.side === 'buy' ? quoteBuy(coin, t.sol, solUsd) : quoteSellForSol(coin, t.sol, solUsd);
      if (!(q.usd > 0)) return null;
      const r = Math.random();
      const holdersDelta = t.side === 'buy' ? (r < 0.35 ? 1 : 0) : r < 0.15 ? -1 : 0;
      return transition(d, coin, q, t.wallet ?? randomWallet(), false, holdersDelta, ts);
    }

    function persistWallet(): void {
      const s = get();
      if (!s.wallet.address) return;
      if (IS_REAL) {
        saveJSON(walletKey(s.wallet.address), { watch: s.watch });
        return;
      }
      const own: Trade[] = [];
      for (const list of Object.values(s.trades)) for (const t of list) if (t.isUser && t.wallet === s.wallet.address) own.push(t);
      own.sort((a, b) => b.ts - a.ts);
      const data: WalletData = { sol: s.solBalance, holdings: s.holdings, watch: s.watch, trades: own.slice(0, LIMITS.walletTrades) };
      saveJSON(walletKey(s.wallet.address), data);
    }

    function persistClaim(placeId: string, c: StoredClaim | null): void {
      const all = loadClaims();
      if (c) all[placeId] = c;
      else if (placeId in all) delete all[placeId];
      else return;
      saveJSON(STORAGE_KEYS.claims, all);
    }

    function selectPanelState(mode: PanelMode): Partial<AppState> {
      return {
        panel: mode,
        panelHistory: [],
        panelNav: 'push',
        panelCollapsed: false,
        sheetSnap: 'half',
        railOpen: false,
      };
    }

    return {
      provider: initialProvider.provider,
      providerReason: initialProvider.reason,

      coins: {},
      trades: {},
      feed: [],
      solUsd: DEMO_SOL_USD,
      simLastTickAt: 0,

      selected: { place: null, status: 'idle' },
      panel: 'none',
      panelHistory: [],
      panelNav: 'push',
      panelCollapsed: false,
      placeTab: 'overview',
      helpSection: null,
      results: [],
      resultsQuery: '',
      resultsStatus: 'idle',
      topShops: { sort: 'mcap', scope: 'everywhere' },

      category: null,
      flyTarget: null,
      viewport: null,
      userLocation: null,
      locateStatus: 'idle',
      layers: readLayers(),

      modal: null,
      heroDismissed: readHeroDismissed(),
      sheetSnap: 'half',
      railOpen: false,
      searchOpen: false,
      searchFocus: null,
      toasts: [],
      online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
      recent: readRecent(),
      launchedSeenAt: readLaunchedSeenAt(),

      chain: { status: IS_REAL ? 'loading' : 'off', config: null },
      tx: null,
      holdingsRaw: {},
      balanceLamports: null,
      solUsdAt: null,
      dataReady: false,
      placeChecks: {},

      wallet: emptyWallet(),
      walletConnecting: null,
      solBalance: 0,
      holdings: {},
      watch: [],

      /* ------------------------------------------------------------ provider */
      setProvider(provider, reason) {
        if (get().provider === provider && get().providerReason === reason) return;
        set({ provider, providerReason: reason });
      },

      /* ------------------------------------------------------------ panels */
      openPlace(place, opts = {}) {
        const s = get();
        let history = s.panelHistory;
        if (opts.from === null) history = [];
        else if (opts.from) history = [...s.panelHistory.filter((m) => m !== opts.from), opts.from];
        else if (isListPanel(s.panel)) history = [...s.panelHistory.filter((m) => m !== s.panel), s.panel];
        else if (s.panel !== 'place') history = [];
        set({
          selected: { place, status: 'ready' },
          panel: 'place',
          panelHistory: history,
          panelNav: 'push',
          panelCollapsed: false,
          placeTab: opts.tab ?? 'overview',
          sheetSnap: s.sheetSnap === 'full' && s.panel === 'place' ? 'full' : 'half',
          railOpen: false,
          searchOpen: false,
        });
        if (!s.heroDismissed) get().dismissHero();
        get().addRecent(place.id);
        if (opts.fly) get().flyTo(place.location, opts.zoom ?? FOCUS_ZOOM);
        if (opts.launch && !get().coins[place.id] && isLaunchableSource(place.source) && !knownIneligibility(place)) {
          get().openModal({ kind: 'launch', place });
        }
      },

      setPlaceLoading(partial = null, hint = {}) {
        const s = get();
        set({
          selected: { place: partial, status: 'loading', ...(hint.launchable ? { launchable: true } : {}) },
          panel: 'place',
          panelHistory: isListPanel(s.panel) ? [...s.panelHistory.filter((m) => m !== s.panel), s.panel] : s.panel === 'place' ? s.panelHistory : [],
          panelNav: 'push',
          panelCollapsed: false,
          placeTab: 'overview',
          sheetSnap: 'half',
        });
        if (!s.heroDismissed) get().dismissHero();
      },

      setPlaceError(message) {
        set((s) => ({ selected: { place: s.selected.place, status: 'error', error: message }, panel: 'place' }));
      },

      setPlaceTab(tab) {
        set({ placeTab: tab });
      },

      setPanel(mode) {
        if (mode === 'none') {
          get().closePanel();
          return;
        }
        set({ ...selectPanelState(mode), ...(mode !== 'help' ? { helpSection: null } : {}) });
        if (mode === 'launched') get().markLaunchedSeen();
        if (!get().heroDismissed) get().dismissHero();
      },

      togglePanel(mode) {
        const s = get();
        if (s.panel === mode && !s.panelCollapsed) get().closePanel();
        else get().setPanel(mode);
      },

      back() {
        const s = get();
        const prev = s.panelHistory[s.panelHistory.length - 1];
        if (!prev) return false;
        set({ panel: prev, panelHistory: s.panelHistory.slice(0, -1), panelNav: 'back', panelCollapsed: false });
        if (prev === 'launched') get().markLaunchedSeen();
        return true;
      },

      closePanel() {
        set({
          panel: 'none',
          selected: { place: null, status: 'idle' },
          panelHistory: [],
          panelNav: 'push',
          panelCollapsed: false,
          placeTab: 'overview',
          helpSection: null,
          results: [],
          resultsQuery: '',
          resultsStatus: 'idle',
          sheetSnap: 'half',
        });
      },

      setPanelCollapsed(collapsed) {
        set({ panelCollapsed: collapsed });
      },

      showResults(query, places) {
        set({
          ...selectPanelState('results'),
          results: places,
          resultsQuery: query,
          resultsStatus: 'ready',
          selected: { place: null, status: 'idle' },
          searchOpen: false,
        });
        if (!get().heroDismissed) get().dismissHero();
      },

      setResultsStatus(status, query) {
        set((s) => ({
          ...(s.panel !== 'results' ? selectPanelState('results') : {}),
          resultsStatus: status,
          ...(query != null ? { resultsQuery: query } : {}),
          ...(status === 'loading' ? { results: [] } : {}),
        }));
      },

      openHelp(section = null) {
        set({ ...selectPanelState('help'), helpSection: section });
        if (!get().heroDismissed) get().dismissHero();
      },

      setTopShops(patch) {
        set((s) => ({ topShops: { ...s.topShops, ...patch } }));
      },

      /* ------------------------------------------------------------ map */
      setCategory(filter) {
        set({ category: filter });
      },

      toggleCategory(filter) {
        set((s) => ({ category: s.category === filter ? null : filter }));
      },

      flyTo(center, zoom) {
        set((s) => ({ flyTarget: { center, zoom, nonce: (s.flyTarget?.nonce ?? 0) + 1 } }));
      },

      fitBounds(bounds) {
        set((s) => ({ flyTarget: { bounds, nonce: (s.flyTarget?.nonce ?? 0) + 1 } }));
      },

      setViewport(v) {
        set({ viewport: v });
        persistViewport(v);
      },

      setUserLocation(loc) {
        set({ userLocation: loc });
      },

      setLocateStatus(s) {
        set({ locateStatus: s });
      },

      async locate() {
        if (get().locateStatus === 'locating') return;
        set({ locateStatus: 'locating' });
        try {
          const loc = await requestPosition();
          set({ userLocation: loc, locateStatus: 'located' });
          get().flyTo(loc.location, FOCUS_ZOOM);
        } catch (err) {
          set({ locateStatus: 'idle' });
          const denied = err instanceof GeoError && (err.code === 'denied' || err.code === 'unsupported');
          get().toast(denied ? 'Location is off. Search for a shop instead.' : "Couldn't find your location.", 'error');
        }
      },

      setLayers(patch) {
        const layers = { ...get().layers, ...patch };
        set({ layers });
        saveJSON(STORAGE_KEYS.layers, layers);
      },

      /* ------------------------------------------------------------ chrome */
      openModal(m) {
        set({ modal: m, railOpen: false });
      },

      closeModal() {
        set({ modal: null });
      },

      requireWallet(action) {
        if (get().wallet.address) {
          action();
          return true;
        }
        get().openModal({ kind: 'wallet', then: action });
        return false;
      },

      toast(msg, kind = 'info', action, icon) {
        const t: Toast = { id: ++toastSeq, msg, kind, ...(action ? { action } : {}), ...(icon ? { icon } : {}) };
        set({ toasts: [t] });
        return t.id;
      },

      dismissToast(id) {
        set((s) => ({ toasts: id == null ? [] : s.toasts.filter((t) => t.id !== id) }));
      },

      dismissHero() {
        saveString(STORAGE_KEYS.heroSeen, '1');
        set({ heroDismissed: true });
      },

      setSheetSnap(snap) {
        set({ sheetSnap: snap });
      },

      setRailOpen(open) {
        set({ railOpen: open });
      },

      setSearchOpen(open) {
        set({ searchOpen: open });
      },

      focusSearch(opts = {}) {
        set((s) => ({ searchFocus: { nonce: (s.searchFocus?.nonce ?? 0) + 1, ...opts }, railOpen: false }));
      },

      setOnline(online) {
        if (get().online === online) return;
        set({ online });
        if (!online) get().toast("You're offline. Prices will update when you're back.", 'error', undefined, 'wifi_off');
      },

      addRecent(placeId) {
        const recent = [placeId, ...get().recent.filter((x) => x !== placeId)].slice(0, LIMITS.recent);
        set({ recent });
        // Persist only IDs that reopen from the ID alone (Google place IDs, demo shops). OSM / link
        // places live in this session's memory only, so after a reload they couldn't be shown.
        saveJSON(STORAGE_KEYS.recent, recent.filter(isReopenableId));
      },

      markLaunchedSeen() {
        const t = now();
        saveString(STORAGE_KEYS.launchedSeenAt, String(t));
        set({ launchedSeenAt: t });
      },

      /* ------------------------------------------------------------ data */
      seedCoins(seeds) {
        const claims = loadClaims();
        set((s) => {
          const coins: Record<string, Coin> = {};
          for (const c of Object.values(s.coins)) if (c.isUserLaunched) coins[c.placeId] = c;
          for (const c of seeds) if (!coins[c.placeId]) coins[c.placeId] = applyClaim(c, claims[c.placeId]);
          return { coins };
        });
      },

      seedActivity({ trades = [], feed = [] }) {
        set((s) => {
          const byCoin: Record<string, Trade[]> = { ...s.trades };
          for (const t of trades) {
            const list = byCoin[t.placeId] ?? [];
            if (!list.some((x) => x.id === t.id)) byCoin[t.placeId] = [...list, t];
          }
          for (const k of Object.keys(byCoin)) {
            byCoin[k] = (byCoin[k] ?? []).sort((a, b) => b.ts - a.ts).slice(0, LIMITS.tradesPerCoin);
          }
          const ids = new Set(s.feed.map((e) => e.id));
          const merged = [...s.feed, ...feed.filter((e) => !ids.has(e.id))].sort((a, b) => b.ts - a.ts);
          return { trades: byCoin, feed: capFeed(merged) };
        });
      },

      hydrateUserCoins() {
        const claims = loadClaims();
        const userCoins = readStoredUserCoins().map((c) => applyClaim(c, claims[c.placeId]));
        set((s) => {
          const coins = { ...s.coins };
          for (const c of userCoins) coins[c.placeId] = c;
          return { coins };
        });
        // The Live feed isn't stored: rebuild the launch / claim rows of restored coins from their
        // own records (real amounts, never made-up numbers). Same 6-hour launch window as the
        // seeded backfill (data/mockCoins createMockActivity).
        const t = now();
        const feed: FeedEvent[] = [];
        for (const c of userCoins) {
          if (t - c.launchedAt <= RESTORED_LAUNCH_ROWS_MS) feed.push({ ...feedBase(c, c.launchedAt), id: `ev_launch_${c.mint}`, kind: 'launch', wallet: c.launcher });
          if (c.claimed && c.claimedAt && c.owner && typeof c.claimedUsd === 'number') {
            feed.push({ ...feedBase(c, c.claimedAt), id: `ev_claim_${c.mint}`, kind: 'claim', usd: c.claimedUsd, wallet: c.owner });
          }
        }
        if (feed.length) get().seedActivity({ feed });
        // Restore a mocked email wallet directly; Wallet Standard wallets reconnect silently in
        // src/wallet (ConnectWalletPill) using cs_wallet.walletName.
        const w = loadJSON<StoredWallet | null>(STORAGE_KEYS.wallet, null);
        if (w?.kind === 'email' && typeof w.address === 'string' && !get().wallet.address) {
          get().setWallet({ address: w.address, kind: 'email', walletName: 'Email' });
        }
      },

      mergeUserCoins(incoming) {
        if (incoming.length === 0) return;
        const claims = loadClaims();
        set((s) => {
          let coins: Record<string, Coin> | null = null;
          for (const raw of incoming) {
            const c = applyClaim(normalizeStoredCoin(raw), claims[raw.placeId]);
            const cur = (coins ?? s.coins)[c.placeId];
            if (cur && firstLaunch(cur, c) === cur) continue;
            coins ??= { ...s.coins };
            coins[c.placeId] = c;
          }
          return coins ? { coins } : s;
        });
      },

      syncClaims() {
        const claims = loadClaims();
        set((s) => {
          let coins: Record<string, Coin> | null = null;
          for (const [placeId, c] of Object.entries(claims)) {
            const cur = s.coins[placeId];
            if (!cur) continue;
            const next = applyClaim(cur, c);
            if (next === cur || (next.claimed === cur.claimed && !!next.claimPending === !!cur.claimPending)) continue;
            coins ??= { ...s.coins };
            coins[placeId] = next;
          }
          return coins ? { coins } : s;
        });
      },

      addCoin(coin, opts = {}) {
        if (get().coins[coin.placeId]) return false;
        const ts = now();
        set((s) => ({
          coins: { ...s.coins, [coin.placeId]: coin },
          feed: opts.feed === false ? s.feed : capFeed([{ ...feedBase(coin, ts), kind: 'launch', wallet: coin.launcher }, ...s.feed]),
          simLastTickAt: ts,
        }));
        return true;
      },

      launchCoin(draft) {
        const s = get();
        const wallet = s.wallet.address;
        if (!wallet) return { ok: false, reason: 'no-wallet', message: 'Connect a wallet to launch.' };
        if (!isLaunchableSource(draft.place.source)) {
          return { ok: false, reason: 'not-launchable', message: 'Launching needs Google Maps. Try again later.' };
        }
        const existing = s.coins[draft.place.id];
        if (existing) return { ok: false, reason: 'taken', existing };
        const name = draft.name.trim();
        const ticker = draft.ticker.trim().toUpperCase();
        if (!name) return { ok: false, reason: 'invalid', message: 'Give your coin a name' };
        if (name.length > LIMITS.nameMax) return { ok: false, reason: 'invalid', message: 'Coin name is too long' };
        if (!TICKER_RE.test(ticker)) return { ok: false, reason: 'invalid', message: 'Ticker must be 2–8 letters or numbers' };

        const ts = now();
        const coin = buildCoin(
          {
            placeId: draft.place.id,
            place: coinPlaceFrom(draft.place, draft.category, draft.logo.emoji),
            ticker,
            name,
            description: draft.description.trim(),
            logo: draft.logo,
            launchedAt: ts,
            historyAt: ts,
            launcher: wallet,
            mint: fakeMint(`${draft.place.id}:${ts}`),
            holders: 1,
            isUserLaunched: true,
          },
          s.solUsd,
        );
        set((st) => ({
          coins: { ...st.coins, [coin.placeId]: coin },
          feed: capFeed([{ ...feedBase(coin, ts), kind: 'launch', wallet, isUser: true }, ...st.feed]),
          simLastTickAt: ts,
        }));
        // A claim stored for an earlier coin on this place (expired, or gone after a reload) is not
        // this coin's: drop it so the new coin starts `Unclaimed · not affiliated` (DESIGN §17).
        // (A verified owner's pre-claim lives in claim/preclaims and is applied by LaunchFlow.)
        persistClaim(coin.placeId, null);

        let firstBuy: TradeResult | null = null;
        const buySol = Math.min(Math.max(0, draft.devBuySol), get().solBalance);
        if (buySol > 0) {
          const r = get().userBuy(coin.placeId, buySol);
          if (r.ok) firstBuy = r;
        }
        return { ok: true, coin: get().coins[coin.placeId] ?? coin, firstBuy };
      },

      applySimulatedTrade(placeId, side, sol, wallet) {
        const s = get();
        const d: Draft = { coins: s.coins, trades: s.trades, feed: s.feed };
        const ts = now();
        const r = simTrade(d, { placeId, side, sol, wallet }, ts);
        if (!r) return null;
        set({ coins: d.coins, trades: d.trades, feed: d.feed, simLastTickAt: ts });
        return r;
      },

      applyTickBatch(batch) {
        if (batch.length === 0) return [];
        const s = get();
        const d: Draft = { coins: s.coins, trades: s.trades, feed: s.feed };
        const ts = now();
        const out: TradeResult[] = [];
        batch.forEach((t, i) => {
          const r = simTrade(d, t, ts + i);
          if (r) out.push(r);
        });
        set({ coins: d.coins, trades: d.trades, feed: d.feed, simLastTickAt: ts });
        return out;
      },

      userBuy(placeId, sol) {
        const s = get();
        const wallet = s.wallet.address;
        if (!wallet) return { ok: false, reason: 'no-wallet', message: 'Connect wallet to buy' };
        const coin = s.coins[placeId];
        if (!coin) return { ok: false, reason: 'no-coin', message: 'This shop has no coin yet' };
        if (!(sol > 0) || !Number.isFinite(sol)) return { ok: false, reason: 'invalid', message: 'Enter an amount' };
        if (sol > s.solBalance + 1e-9) return { ok: false, reason: 'insufficient', message: 'Not enough SOL' };
        const d: Draft = { coins: s.coins, trades: s.trades, feed: s.feed };
        const ts = now();
        const q = quoteBuy(coin, sol, s.solUsd);
        const had = (s.holdings[placeId] ?? 0) > 0;
        const r = transition(d, coin, q, wallet, true, had ? 0 : 1, ts);
        set({
          coins: d.coins,
          trades: d.trades,
          feed: d.feed,
          simLastTickAt: ts,
          solBalance: Math.max(0, s.solBalance - sol),
          holdings: { ...s.holdings, [placeId]: (s.holdings[placeId] ?? 0) + q.tokens },
        });
        persistWallet();
        return { ok: true, ...r };
      },

      userSell(placeId, tokens) {
        const s = get();
        const wallet = s.wallet.address;
        if (!wallet) return { ok: false, reason: 'no-wallet', message: 'Connect wallet to sell' };
        const coin = s.coins[placeId];
        if (!coin) return { ok: false, reason: 'no-coin', message: 'This shop has no coin yet' };
        const held = s.holdings[placeId] ?? 0;
        if (!(tokens > 0) || !Number.isFinite(tokens)) return { ok: false, reason: 'invalid', message: 'Enter an amount' };
        if (tokens > held * (1 + 1e-9)) return { ok: false, reason: 'insufficient', message: `Not enough $${coin.ticker}` };
        const amount = Math.min(tokens, held);
        const d: Draft = { coins: s.coins, trades: s.trades, feed: s.feed };
        const ts = now();
        const q = quoteSell(coin, amount, s.solUsd);
        const left = held - amount;
        const soldOut = left <= held * 1e-9;
        const r = transition(d, coin, q, wallet, true, soldOut ? -1 : 0, ts);
        const holdings = { ...s.holdings };
        if (soldOut) delete holdings[placeId];
        else holdings[placeId] = left;
        set({ coins: d.coins, trades: d.trades, feed: d.feed, simLastTickAt: ts, solBalance: s.solBalance + q.sol, holdings });
        persistWallet();
        return { ok: true, ...r };
      },

      claimFees(placeId, payoutWallet, opts = {}) {
        const s = get();
        const coin = s.coins[placeId];
        if (!coin) return { ok: false, reason: 'no-coin', message: 'This shop has no coin yet' };
        const owner = opts.owner ?? s.wallet.address;
        if (!owner) return { ok: false, reason: 'no-wallet', message: 'Connect a wallet to claim' };
        if (coin.claimed) return { ok: false, reason: 'already-claimed', message: 'This shop is already claimed' };
        const amountUsd = feesWaiting(coin);
        const ts = now();
        const next: Coin = {
          ...coin,
          claimed: true,
          ownerVerified: true,
          claimPending: false,
          claimedAt: ts,
          claimedUsd: amountUsd,
          owner,
          payoutWallet,
          feesClaimedUsd: coin.feesEarnedUsd,
        };
        const isUser = owner === s.wallet.address;
        set((st) => ({
          coins: { ...st.coins, [placeId]: next },
          feed: capFeed([{ ...feedBase(next, ts), kind: 'claim', usd: amountUsd, wallet: owner, ...(isUser ? { isUser: true } : {}) }, ...st.feed]),
          simLastTickAt: ts,
        }));
        if (isUser) persistClaim(placeId, { mint: coin.mint, owner, payoutWallet, claimedAt: ts, amountUsd });
        return { ok: true, amountUsd, coin: next };
      },

      setClaimPending(placeId, pending) {
        const coin = get().coins[placeId];
        if (!coin || coin.claimed) return;
        set((s) => ({ coins: { ...s.coins, [placeId]: { ...coin, claimPending: pending } } }));
        persistClaim(placeId, pending ? { mint: coin.mint, pending: true } : null);
      },

      setPayoutWallet(placeId, payoutWallet) {
        const s = get();
        const coin = s.coins[placeId];
        if (!coin || !coin.claimed || !s.wallet.address || coin.owner !== s.wallet.address) return false;
        set((st) => ({ coins: { ...st.coins, [placeId]: { ...coin, payoutWallet } } }));
        persistClaim(placeId, { mint: coin.mint, owner: coin.owner, payoutWallet, claimedAt: coin.claimedAt, amountUsd: coin.claimedUsd });
        return true;
      },

      pushFeed(event) {
        set((s) => ({ feed: capFeed([event, ...s.feed]), simLastTickAt: event.ts }));
      },

      setSolUsd(v) {
        if (Number.isFinite(v) && v > 0) set({ solUsd: v });
      },

      toggleWatch(placeId) {
        const s = get();
        if (!s.wallet.address) return null;
        const on = !s.watch.includes(placeId);
        set({ watch: on ? [...s.watch, placeId] : s.watch.filter((x) => x !== placeId) });
        persistWallet();
        return on;
      },

      /* ------------------------------------------------------------ wallet */
      setWallet(w) {
        if (!w.address) {
          get().disconnectWallet();
          return;
        }
        const data = loadWalletData(w.address);
        set((s) => {
          // restore this wallet's own trades into the per-coin lists
          const trades = { ...s.trades };
          for (const t of data.trades) {
            if (!s.coins[t.placeId]) continue;
            const list = trades[t.placeId] ?? [];
            if (!list.some((x) => x.id === t.id)) {
              trades[t.placeId] = [...list, t].sort((a, b) => b.ts - a.ts).slice(0, LIMITS.tradesPerCoin);
            }
          }
          if (IS_REAL) {
            // a new account: forget the previous wallet's balance until src/realdata reads this one
            const same = s.wallet.address === w.address;
            return {
              wallet: w,
              walletConnecting: null,
              watch: data.watch,
              ...(same ? {} : { solBalance: 0, balanceLamports: null, holdings: {}, holdingsRaw: {} }),
            };
          }
          return { wallet: w, walletConnecting: null, solBalance: data.sol, holdings: data.holdings, watch: data.watch, trades };
        });
        const stored: StoredWallet =
          w.kind === 'email'
            ? { kind: 'email', walletName: 'Email', address: w.address }
            : { kind: 'standard', walletName: w.walletName };
        saveJSON(STORAGE_KEYS.wallet, stored);
        persistWallet();
      },

      setWalletConnecting(name) {
        set({ walletConnecting: name });
      },

      disconnectWallet() {
        removeKey(STORAGE_KEYS.wallet);
        set({ wallet: emptyWallet(), walletConnecting: null, solBalance: 0, holdings: {}, watch: [], holdingsRaw: {}, balanceLamports: null });
      },

      /* ------------------------------------------------------------ real mode */
      setChain(patch) {
        set((s) => ({ chain: { ...s.chain, ...patch } }));
      },

      setTx(tx) {
        set({ tx });
      },

      upsertCoins(list) {
        if (list.length === 0) return;
        set((s) => {
          let coins: Record<string, Coin> | null = null;
          for (const c of list) {
            if (s.coins[c.placeId] === c) continue;
            coins ??= { ...s.coins };
            coins[c.placeId] = c;
          }
          return coins ? { coins } : s;
        });
      },

      mergeFeed(events, opts = {}) {
        set((s) => {
          if (opts.replace) return { feed: capFeed([...events].sort((a, b) => b.ts - a.ts)), simLastTickAt: now() };
          if (events.length === 0) return { simLastTickAt: now() };
          const ids = new Set(s.feed.map((e) => e.id));
          const fresh = events.filter((e) => !ids.has(e.id));
          if (fresh.length === 0) return { simLastTickAt: now() };
          return { feed: capFeed([...fresh, ...s.feed].sort((a, b) => b.ts - a.ts)), simLastTickAt: now() };
        });
      },

      setCoinTrades(placeId, list) {
        set((s) => {
          const cur = s.trades[placeId] ?? [];
          const ids = new Set(list.map((t) => t.id));
          const newest = list[0]?.ts ?? 0;
          // keep rows we learned about after this snapshot (feed / own tx), drop the rest
          const keep = cur.filter((t) => !ids.has(t.id) && t.ts > newest);
          const merged = [...keep, ...list].sort((a, b) => b.ts - a.ts).slice(0, LIMITS.tradesPerCoin);
          if (merged.length === cur.length && merged.every((t, i) => t.id === cur[i]?.id)) return s;
          return { trades: { ...s.trades, [placeId]: merged } };
        });
      },

      setWalletChain(d) {
        set((s) => {
          const holdings: Record<string, number> = {};
          for (const [id, raw] of Object.entries(d.holdingsRaw)) {
            const n = Number(raw) / 1_000_000; // display only; sells use holdingsRaw
            if (n > 0) holdings[id] = n;
          }
          const lamports = d.lamports ?? s.balanceLamports;
          return {
            holdingsRaw: d.holdingsRaw,
            holdings,
            balanceLamports: lamports,
            solBalance: lamports ? Number(lamports) / 1e9 : 0,
          };
        });
      },

      markPlaceChecked(placeId) {
        set((s) => ({ placeChecks: { ...s.placeChecks, [placeId]: now() } }));
      },

      setDataReady(ready) {
        if (get().dataReady !== ready) set({ dataReady: ready });
      },
    };
  }),
);

/* ===================================================================== persistence */

/*
 * User-launched coins live in localStorage (Google content is never in a Coin — see CoinPlace —
 * so this is ToS-safe). Several tabs can be open at once, so:
 *  - a write merges with what is stored: coins another tab saved (and this tab hasn't seen yet)
 *    are kept, and for a place launched in two tabs the earlier launch wins;
 *  - the `storage` event brings coins (and claims) saved by other tabs into this tab;
 *  - only changes to user-launched coins schedule a write: a new / removed coin is written within
 *    300 ms, price moves at most every 5 s, and pending changes are flushed when the tab hides.
 */
const COINS_WRITE_FAST_MS = 300;
const COINS_WRITE_SLOW_MS = 5000;
let coinsTimer: ReturnType<typeof setTimeout> | undefined;
let coinsTimerDue = 0;
let coinsDirty = false;
let lastMine = new Map<string, Coin>();

function flushUserCoins(): void {
  clearTimeout(coinsTimer);
  coinsTimer = undefined;
  coinsTimerDue = 0;
  if (!coinsDirty) return;
  coinsDirty = false;
  const t = now();
  const byId = new Map<string, Coin>();
  for (const c of Object.values(useStore.getState().coins)) {
    if (c.isUserLaunched && !userCoinExpired(c, t)) byId.set(c.placeId, c);
  }
  for (const c of readStoredUserCoins()) {
    const own = byId.get(c.placeId);
    byId.set(c.placeId, own ? firstLaunch(own, c) : c);
  }
  saveJSON(STORAGE_KEYS.userCoins, [...byId.values()]);
}

function scheduleUserCoins(delay: number): void {
  coinsDirty = true;
  const due = now() + delay;
  if (coinsTimer !== undefined && coinsTimerDue <= due) return;
  clearTimeout(coinsTimer);
  coinsTimerDue = due;
  coinsTimer = setTimeout(flushUserCoins, delay);
}

useStore.subscribe(
  (s) => s.coins,
  (coins) => {
    const mine = new Map<string, Coin>();
    for (const c of Object.values(coins)) if (c.isUserLaunched) mine.set(c.placeId, c);
    const prev = lastMine;
    lastMine = mine;
    let added = mine.size !== prev.size;
    let moved = false;
    for (const [id, c] of mine) {
      const p = prev.get(id);
      if (!p) added = true;
      else if (p !== c) moved = true;
      if (added) break;
    }
    if (added) scheduleUserCoins(COINS_WRITE_FAST_MS);
    else if (moved) scheduleUserCoins(COINS_WRITE_SLOW_MS);
  },
);

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    try {
      if (e.storageArea && e.storageArea !== window.localStorage) return;
    } catch {
      return; // storage blocked
    }
    if (e.key === STORAGE_KEYS.userCoins) {
      let parsed: unknown = [];
      try {
        parsed = e.newValue ? JSON.parse(e.newValue) : [];
      } catch {
        return;
      }
      useStore.getState().mergeUserCoins(readStoredUserCoins(parsed));
    } else if (e.key === STORAGE_KEYS.claims) {
      useStore.getState().syncClaims();
    }
  });
  window.addEventListener('pagehide', flushUserCoins);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushUserCoins();
  });
}

/* ===================================================================== selectors */

type CoinsInput = Record<string, Coin> | readonly Coin[];
const toList = (c: CoinsInput): Coin[] => (Array.isArray(c) ? [...c] : Object.values(c as Record<string, Coin>));

/** Coin had ≥ 1 trade in the last 60 minutes ("Live coins" chip). */
export function isLiveCoin(coin: Coin, at: number = now()): boolean {
  return !!coin.lastTradeAt && at - coin.lastTradeAt <= 60 * 60_000;
}

/** Apply the chip filter (DESIGN §6.3). Null filter = all coins. */
export function filterCoins(coins: CoinsInput, filter: ChipFilter | null, at: number = now()): Coin[] {
  const list = toList(coins);
  if (!filter) return list;
  switch (filter) {
    case 'live':
      return list.filter((c) => isLiveCoin(c, at));
    case 'fees':
      return list.filter((c) => feesWaiting(c) > 0);
    default:
      return list.filter((c) => c.place.category === filter);
  }
}

/** Coins whose place is inside the bounds. */
export function coinsInBounds(coins: CoinsInput, bounds: Bounds | null | undefined): Coin[] {
  const list = toList(coins);
  return bounds ? list.filter((c) => boundsContains(bounds, c.place.location)) : list;
}

/** Sorted by market cap, descending. */
export function topByMc(coins: CoinsInput, n?: number): Coin[] {
  const s = toList(coins).sort((a, b) => b.marketCapUsd - a.marketCapUsd);
  return n == null ? s : s.slice(0, n);
}

/** Sorted by fees earned, descending. */
export function topByFees(coins: CoinsInput, n?: number): Coin[] {
  const s = toList(coins).sort((a, b) => b.feesEarnedUsd - a.feesEarnedUsd || b.marketCapUsd - a.marketCapUsd);
  return n == null ? s : s.slice(0, n);
}

/** Newest launches first. */
export function newestCoins(coins: CoinsInput, n?: number): Coin[] {
  const s = toList(coins).sort((a, b) => b.launchedAt - a.launchedAt);
  return n == null ? s : s.slice(0, n);
}

export interface Totals {
  /** Number of coins ("shops launched"). */
  shops: number;
  /** Sum of fees waiting for unclaimed shops (USD). */
  feesWaitingUsd: number;
  /** Platform cut of creator fees, always 0 (BRIEF). */
  platformCutPct: 0;
  volume24hUsd: number;
}

export function totals(coins: CoinsInput, solUsd = 0): Totals {
  let volume24hUsd = 0;
  const list = toList(coins);
  for (const c of list) volume24hUsd += c.volume24h;
  // exact, rounded down (real coins: lamports summed, converted once at their own rate when none is given)
  const rate = solUsd > 0 ? solUsd : (list.find((c) => c.real)?.real?.usdRate ?? 0);
  const feesWaitingUsd = feesWaitingTotal(list, rate, Date.now()).usd;
  return { shops: list.length, feesWaitingUsd, platformCutPct: 0, volume24hUsd };
}

/** Coins traded within `windowMs` (This area "<n> trading now"). */
export function tradingNow(coins: CoinsInput, at: number = now(), windowMs = 5 * 60_000): Coin[] {
  return toList(coins).filter((c) => !!c.lastTradeAt && at - c.lastTradeAt <= windowMs);
}

/** Launches since `seenAt`, excluding the user's own (rail badge). */
export function launchedUnseenCount(coins: CoinsInput, seenAt: number, me?: string | null): number {
  return toList(coins).filter((c) => c.launchedAt > seenAt && !c.isUserLaunched && !(me && c.launcher === me)).length;
}

/** USD value of holdings. */
export function holdingsValueUsd(holdings: Record<string, number>, coins: Record<string, Coin>): number {
  let v = 0;
  for (const [id, amt] of Object.entries(holdings)) v += (coins[id]?.priceUsd ?? 0) * amt;
  return v;
}

export function isOwner(coin: Coin | null | undefined, walletAddress: string | null | undefined): boolean {
  return !!coin && !!walletAddress && coin.claimed && coin.owner === walletAddress;
}

/** Feed health for live indicators: 'live' | 'paused' (tab hidden / offline) | 'stalled' (> 30s silent). */
export function feedHealth(s: Pick<AppState, 'simLastTickAt' | 'online'>, at: number = now()): 'live' | 'paused' | 'stalled' {
  if (!s.online) return 'paused';
  if (s.simLastTickAt > 0 && at - s.simLastTickAt > 30_000) return 'stalled';
  return 'live';
}

/* ===================================================================== hooks */

export { useShallow };

/** All coins as a stable array (re-renders only when a coin object changes). */
export function useCoinList(): Coin[] {
  return useStore(useShallow((s) => Object.values(s.coins)));
}

export function useCoin(placeId: string | null | undefined): Coin | undefined {
  return useStore((s) => (placeId ? s.coins[placeId] : undefined));
}

/** The coin of the currently selected place, if it has one. */
export function useSelectedCoin(): Coin | undefined {
  return useStore((s) => (s.selected.place ? s.coins[s.selected.place.id] : undefined));
}

export function useTopCoins(sort: 'mcap' | 'fees', n?: number): Coin[] {
  return useStore(useShallow((s) => (sort === 'mcap' ? topByMc(s.coins, n) : topByFees(s.coins, n))));
}

export function useTrades(placeId: string | null | undefined): Trade[] {
  return useStore((s) => (placeId ? (s.trades[placeId] ?? EMPTY_TRADES) : EMPTY_TRADES));
}
const EMPTY_TRADES: Trade[] = [];

export function useWalletAddress(): string | null {
  return useStore((s) => s.wallet.address);
}

/* ===================================================================== copy helpers */

/** Toast strings for trades (DESIGN §16.11). Real mode drops the `· Demo` suffix. */
export function tradeToast(r: Pick<TradeResult, 'side' | 'tokens' | 'sol'>, ticker: string): string {
  const tail = IS_REAL ? '' : ' · Demo';
  return r.side === 'buy'
    ? `Bought ${tokenAmount(r.tokens)} $${ticker} for ${solNumber(r.sol)} SOL${tail}`
    : `Sold ${tokenAmount(r.tokens)} $${ticker} for ${solNumber(r.sol)} SOL${tail}`;
}

/** "Kebab shop coin" style meta label from a coin. */
export function coinCategoryLabel(coin: Coin): string {
  return categoryLabel(coin.place.category);
}

/** "Connected · 7xKX…3pQa" */
export function connectedToast(address: string): string {
  return `Connected · ${shortAddr(address)}`;
}
