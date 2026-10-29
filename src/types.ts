/**
 * CORNERSHOP shared types — the contract between all modules.
 * SHARED file: only the scaffold / integrator / fixer may edit it. See CONTRACTS.md.
 *
 * Google ToS reminders (BRIEF.md, DESIGN.md §17):
 *  - Google place content (name, address, rating, photos, phone, hours) is DISPLAY-ONLY and
 *    lives in memory only. Never persist it (localStorage, share images, our DB).
 *  - Persist only Google place IDs (+ coordinates for at most 30 days).
 *  - Coin name / ticker / category are always the launcher's typed values.
 */

import type { TxError, TxProgress } from './chain/types';

/* ------------------------------------------------------------------ geo */

export interface LatLng {
  lat: number;
  lng: number;
}

/** Axis-aligned bounds. `east < west` means the box crosses the antimeridian. */
export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/** Map camera snapshot, published by the map on idle (see store.setViewport). */
export interface Viewport {
  center: LatLng;
  zoom: number;
  bounds: Bounds | null;
}

export interface UserLocation {
  location: LatLng;
  /** Reported accuracy radius in metres (drives the halo size, DESIGN §7.3). */
  accuracy: number;
  ts: number;
}

/* --------------------------------------------------------------- places */

/**
 * Where a place came from.
 *  - 'google': a real Google POI (id = Google place ID, e.g. "ChIJ…").
 *  - 'osm':    MapLibre/OpenFreeMap fallback POI or Photon result (id = "osm:<type>/<id>"). Never launchable.
 *  - 'demo':   a seeded FICTIONAL shop (id = "demo-<slug>"). Never a real business.
 *  - 'link':   a pasted Maps link that is not resolved to a place ID yet (id = "link:<hash>"). Never launchable.
 */
export type PlaceSource = 'google' | 'osm' | 'demo' | 'link';

/** Coin / shop categories (launcher-picked for coins; mapped from Google/OSM types for prefill). */
export type CategoryKey =
  | 'cafe'
  | 'barber'
  | 'kebab'
  | 'pizza'
  | 'bakery'
  | 'pub'
  | 'corner'
  | 'restaurant'
  | 'other';

/** Category chips filter (DESIGN §6.3): 'live' = traded in the last 60 min, 'fees' = unclaimed with fees > 0. */
export type ChipFilter = Exclude<CategoryKey, 'restaurant' | 'other'> | 'live' | 'fees';

export type BusinessStatus = 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';

/** A Google place photo — display only, never stored, never used as coin art. */
export interface PlacePhoto {
  url: string;
  authorName?: string;
  authorUri?: string;
  googleMapsUri?: string;
}

/**
 * Data for the FICTIONAL demo shops' lookalike info block (`.gblock`, DESIGN §9.6).
 * Fictional values only: `.example` websites, Ofcom drama-range phone numbers `020 7946 0xxx`.
 */
export interface DemoPlaceInfo {
  rating: number;
  reviews: number;
  /** e.g. "££" */
  price: string;
  /** e.g. "Closes 2 am" */
  hours: string;
  /** Seven lines, Monday first, shown when the hours row is expanded. */
  hoursList: string[];
  address: string;
  /** Fictional national-format number, e.g. "020 7946 0123". */
  phone: string;
  /** Fictional host, e.g. "bosphorusgrill.example". */
  website: string;
  /** Unsplash photo ids for the 3-photo collage. */
  photos: string[];
  photoCount: number;
}

/** OSM metadata for the fallback info block (DESIGN §9.4 "Fallback map mode"). */
export interface OsmPlaceInfo {
  osmType: 'node' | 'way' | 'relation';
  osmId: number;
  /** OSM key/value, e.g. amenity=cafe */
  key?: string;
  value?: string;
}

/**
 * A place the user can open in the panel.
 * For source 'google' every field except id/source/location/category/emoji is DISPLAY-ONLY
 * and must never be persisted. `name` may be '' when unknown (POI clicks: Google's own UI Kit
 * element renders the name inside the panel, we do not fetch it).
 */
export interface Place {
  id: string;
  source: PlaceSource;
  name: string;
  category: CategoryKey;
  /** Human label for `category`, e.g. "Kebab shop". */
  categoryLabel: string;
  /** Default sticker for the category. */
  emoji: string;
  address?: string;
  city?: string;
  location: LatLng;
  /** Link to the place on Google Maps (for google places) or the original pasted link. */
  mapsUrl?: string;
  rating?: number;
  ratingCount?: number;
  photos?: PlacePhoto[];
  businessStatus?: BusinessStatus;
  /** Google primaryType (e.g. "cafe") when known — used for category prefill only. */
  primaryType?: string;
  types?: string[];
  /** Only for source 'demo'. */
  demo?: DemoPlaceInfo;
  /** Only for source 'osm'. */
  osm?: OsmPlaceInfo;
}

/* ---------------------------------------------------------------- coins */

/**
 * Coin art. `sticker` = emoji on a pastel bg; `upload` = launcher-uploaded image
 * (data: URL, resized to <= 512px before saving; seeded demo coins may use an https URL).
 * `emoji` is always present on uploads too: pins and avatars fall back to it.
 * `bg` is the coin's pastel colour (`--bg` in DESIGN: pin face, avatars, sticker hero).
 */
export type LogoSpec =
  | { kind: 'sticker'; emoji: string; bg: string }
  | {
      kind: 'upload';
      dataUrl: string;
      emoji: string;
      bg: string;
      /** Hero credit, e.g. "Uploaded by launcher · Photo: Unsplash". */
      credit?: { text: string; href?: string };
    };

/**
 * Minimal place snapshot stored with a coin. NEVER contains Google's name/address/photos.
 * `category` is the LAUNCHER's pick. `city` is never Google-derived.
 * `demo` is present only for fictional demo shops.
 */
export interface CoinPlace {
  id: string;
  source: PlaceSource;
  location: LatLng;
  category: CategoryKey;
  emoji: string;
  city?: string;
  demo?: DemoPlaceInfo;
}

export interface TopHolder {
  address: string;
  /** Percent of supply, e.g. 4.2 */
  pct: number;
}

/**
 * One official coin per place (keyed by placeId). All prices simulated in the prototype.
 * Owner/claim fields:
 *  - `claimed` + `ownerVerified` become true together when a verified owner claims the shop.
 *  - `claimPending` = a manual review is in progress ("Owner verification in progress").
 *  - Invariant: claimed ⇒ feesClaimedUsd === feesEarnedUsd (new fees follow automatically).
 *  - Fees waiting for the shop = claimed ? 0 : feesEarnedUsd − feesClaimedUsd (see selectors.feesWaiting).
 */
export interface Coin {
  placeId: string;
  place: CoinPlace;
  /** base58 pump.fun-style mint, 44 chars, ends with "pump". */
  mint: string;
  /** Uppercase A–Z0–9, 2–8 chars, without the "$". */
  ticker: string;
  /** Launcher-typed coin name (never Google's displayName). */
  name: string;
  description: string;
  logo: LogoSpec;
  launchedAt: number;
  /** base58 wallet of the launcher. */
  launcher: string;
  priceUsd: number;
  priceSol: number;
  marketCapUsd: number;
  supply: number;
  /** Percent, e.g. 12.4 for +12.4% over 24h. */
  change24h: number;
  volume24h: number;
  holders: number;
  feesEarnedUsd: number;
  feesClaimedUsd: number;
  claimed: boolean;
  ownerVerified: boolean;
  claimPending?: boolean;
  claimedAt?: number;
  /** USD paid out by the owner claim (the fees waiting at `claimedAt`); the Live feed's claim row. */
  claimedUsd?: number;
  /** Wallet that completed the owner claim. "You own this shop" ⇔ owner === connected wallet. */
  owner?: string;
  /** Where the shop's fees are paid. */
  payoutWallet?: string;
  /** 48 USD price points covering the last 24h (oldest → newest; last = current price). */
  history: number[];
  /**
   * ms time the newest `history` bucket opened; the buckets roll forward every ~30 min from here
   * (lib/market withPrice). Missing on coins saved by older builds (treated as "now").
   */
  historyAt?: number;
  /** Up to 60 most recent trade prices (for the 1H chart range). */
  ticks: number[];
  /** ms timestamps of `ticks` (same length). Missing on coins saved by older builds. */
  tickTimes?: number[];
  lastTradeAt?: number;
  isUserLaunched?: boolean;
  isDemoSeed?: boolean;
  /**
   * Real mode only (Phase 2, INTEGRATION.md §5.3): the chain/registry facts behind this coin. Absent on
   * demo coins. Lamport / base-unit values are exact u64 decimal strings; USD fields are derived with
   * the SOL/USD rate of the response they came from and are display-only.
   */
  real?: RealCoinFacts;
}

/** Exact on-chain facts of a real-mode coin (src/realdata/mapping.ts builds it). */
export interface RealCoinFacts {
  /** Everything not yet paid out to the shop (withdrawable now + collectable), lamports. */
  feesWaitingLamports: string;
  feesWithdrawnLamports: string;
  feesEarnedLamports: string;
  /** fees waiting in USD, rounded DOWN to the cent (never overstate money owed). */
  feesWaitingUsd: number;
  ownerStatus: 'unclaimed' | 'pending' | 'claimed';
  pendingOwner: string | null;
  /** Unix seconds (chain clock) when a pending claim can be finalized. */
  unlockTs: number | null;
  inProbation: boolean;
  graduated: boolean;
  progressPct: number;
  imageUrl: string | null;
  change24hKnown: boolean;
  holdersKnown: boolean;
  /** ms of the market read behind the price. */
  marketAt: number;
  /** Lamports per whole token (display only; float). */
  priceLamports: number;
  mcapLamports: string;
  vol24hLamports: string;
  /** Curve real SOL reserves (lamports), used for the buy/sell pin flashes between polls. */
  realSolLamports: string;
  /** Launch price in lamports per whole token (from the pump Global initial reserves). */
  launchPriceLamports: number;
  vault: string;
  vaultState: string;
  launchSig: string;
  metadataUri: string;
  /** False while the registry has no coordinates for the place (no map pin; lists still show it). */
  located: boolean;
  /** The SOL/USD rate the USD fields (and history/ticks) were converted with (0 = unknown). */
  usdRate: number;
  /** History/ticks came from the coin detail (false = placeholder until the detail loads). */
  historyKnown: boolean;
}

export type TradeSide = 'buy' | 'sell';

export interface Trade {
  id: string;
  placeId: string;
  ticker: string;
  side: TradeSide;
  usd: number;
  sol: number;
  tokens: number;
  /** base58 trader wallet. */
  wallet: string;
  ts: number;
  /** base58 tx signature: fake in demo mode (rows are not links), the real one in real mode (rows link to the explorer). */
  signature: string;
  isUser?: boolean;
  /** Real mode: a confirmed on-chain trade. */
  real?: boolean;
  /** Real mode: exact lamports the trader paid / received, fees included (shown at 4 dp, rounded down). */
  lamports?: string;
}

interface FeedBase {
  id: string;
  ts: number;
  placeId: string;
  ticker: string;
  /** Launcher-typed coin name (snapshot). */
  name: string;
  emoji: string;
  bg: string;
}

export type FeedEvent =
  | (FeedBase & { kind: 'trade'; side: TradeSide; sol: number; usd: number; wallet: string; isUser?: boolean; signature?: string; lamports?: string })
  | (FeedBase & { kind: 'launch'; wallet: string; isUser?: boolean; signature?: string })
  | (FeedBase & {
      kind: 'claim';
      usd: number;
      wallet: string;
      isUser?: boolean;
      /**
       * Real mode: `requested` = an ownership claim went pending on-chain (public window, can still be disputed),
       * `finalized` = the claimant became the verified owner (neither moves money: `usd` is 0), `withdrawn` = the owner
       * was paid `usd` (exact lamports in `lamports`). Demo claims omit it (a simulated claim + payout in one row).
       */
      stage?: 'requested' | 'finalized' | 'withdrawn';
      /** Real mode `withdrawn`: the exact payout in lamports (decimal string). */
      lamports?: string;
      /** Real mode: tx signature (rows link to the explorer). */
      signature?: string;
    })
  | (FeedBase & { kind: 'pump'; changePct: number });

export type FeedKind = FeedEvent['kind'];

/** Input to store.launchCoin (built by the launch modal). */
export interface LaunchDraft {
  place: Place;
  name: string;
  ticker: string;
  description: string;
  category: CategoryKey;
  logo: LogoSpec;
  /** Optional first buy in SOL (0 = none). */
  devBuySol: number;
}

export type LaunchResult =
  | { ok: true; coin: Coin; firstBuy: TradeResult | null }
  | { ok: false; reason: 'taken'; existing: Coin }
  | { ok: false; reason: 'no-wallet' | 'not-launchable' | 'invalid'; message: string };

export interface TradeResult {
  side: TradeSide;
  sol: number;
  usd: number;
  tokens: number;
  priceBefore: number;
  priceAfter: number;
  trade: Trade;
}

export type UserTradeResult =
  | ({ ok: true } & TradeResult)
  | { ok: false; reason: 'no-wallet' | 'no-coin' | 'insufficient' | 'invalid'; message: string };

/* --------------------------------------------------------------- wallet */

export interface WalletState {
  /** base58 address, null when disconnected. */
  address: string | null;
  kind: 'standard' | 'email' | null;
  /** e.g. "Phantom". For email wallets: "Email". */
  walletName?: string;
  /** Wallet Standard icon data URI. */
  icon?: string;
  /** Email used for the mocked embedded wallet. */
  email?: string;
}

/** A wallet row in the wallet modal (src/wallet/solanaWallets.ts listWallets()). */
export interface WalletInfo {
  name: string;
  icon?: string;
  /** Detected through Wallet Standard (or a legacy injected provider). */
  installed: boolean;
  /** Phantom / Solflare / Backpack are pinned first in that order. */
  pinned: boolean;
  /** Download page when not installed. */
  installUrl?: string;
  /** Mobile "Open in app" deep link builder result, when supported. */
  openInAppUrl?: string;
}

/** Simulated per-wallet balances (persisted per address). */
export interface WalletData {
  sol: number;
  /** placeId → token amount */
  holdings: Record<string, number>;
  /** Watched place IDs. */
  watch: string[];
  /** The wallet's own recent trades (cap 50), restored into store.trades on reconnect. */
  trades: Trade[];
}

/* --------------------------------------------------------------- search */

export interface MatchRange {
  start: number;
  end: number;
}

export type Suggestion =
  | { kind: 'coin'; placeId: string }
  | {
      kind: 'place';
      /** Google place ID / osm id / demo id. */
      id: string;
      source: PlaceSource;
      main: string;
      secondary?: string;
      matches?: MatchRange[];
      types?: string[];
      location?: LatLng;
      /** Provider-specific handle (e.g. google PlacePrediction) for the search module's own use. */
      raw?: unknown;
    }
  | { kind: 'link'; parsed: ParsedMapsLink }
  | { kind: 'query'; text: string; filter: ChipFilter; area?: string; count?: number };

export type PlaceSuggestion = Extract<Suggestion, { kind: 'place' }>;

/** Location bias for place searches (from store.viewport). */
export interface SearchBias {
  center: LatLng;
  bounds?: Bounds | null;
  /** Circle radius in metres when no bounds are given (default 2000). */
  radiusM?: number;
}

/** Result of parsing a pasted Google Maps URL locally (research/google.md §6.3). */
export interface ParsedMapsLink {
  /** The URL that was parsed (first URL in the pasted text, cleaned). */
  url: string;
  host: string;
  /**
   *  - 'place':       a single place (placeId / ftid / cid / name+coords present)
   *  - 'short':       maps.app.goo.gl / goo.gl / g.page — must be resolved by the Worker (/api/resolve)
   *  - 'search':      a search/category query (not one place)
   *  - 'coords':      map view only (fly there)
   *  - 'directions':  rejected
   *  - 'unsupported': share.google, g.co/kgs, …
   */
  kind: 'place' | 'short' | 'search' | 'coords' | 'directions' | 'unsupported';
  placeId?: string;
  ftid?: { hi: string; lo: string };
  /** ftid converted offline to a ChIJ… candidate — validate before trusting. */
  candidatePlaceId?: string;
  cid?: string;
  location?: LatLng;
  zoom?: number;
  name?: string;
  query?: string;
}

/** Outcome of resolving a pasted link (src/search/resolveLink.ts). */
export type ResolvedLink =
  | { status: 'place'; place: Place }
  | { status: 'search'; query: string; location?: LatLng }
  | { status: 'coords'; location: LatLng; zoom?: number }
  | { status: 'error'; error: 'not-a-link' | 'directions' | 'not-found' | 'network' | 'unsupported' };

/** Masked listing phone from the server (never the raw number). */
export interface ListingContact {
  /** e.g. "+44 20 •••• ••23"; null when the listing has no phone. */
  masked: string | null;
  /** Website host from the listing (display only), e.g. "bosphorusgrill.example". */
  websiteHost?: string | null;
  /** Why calling is blocked, if it is. */
  blocked?: 'no-phone' | 'premium' | null;
  /**
   * Set when the lookup itself failed (src/places getListedPhoneMasked never rejects):
   * 'unavailable' (Worker/Places down), 'rate-limited' (too many lookups), 'not-found' (bad place ID).
   */
  error?: 'unavailable' | 'rate-limited' | 'not-found';
  /** Google businessStatus === OPERATIONAL, when known (null = unknown). */
  operational?: boolean | null;
}

/* ------------------------------------------------------------- UI state */

export type PanelMode = 'none' | 'place' | 'results' | 'live' | 'top' | 'launched' | 'mine' | 'help';
/** Panels that count as "rail panels" (list panels that a place can be opened from, with a back chip). */
export type ListPanelMode = 'results' | 'live' | 'top' | 'launched' | 'mine';

export type PlaceTab = 'overview' | 'coin' | 'about';
export type SheetSnap = 'peek' | 'half' | 'full';
export type HelpSection = 'launching' | 'fees' | 'claiming' | 'real';
export type ShareVariant = 'coin' | 'place' | 'launched' | 'owner';
export type ReportReason = 'impersonation' | 'offensive' | 'scam' | 'other';

export type ModalState =
  | { kind: 'launch'; place: Place }
  | { kind: 'claim'; placeId: string; step?: 'verify' | 'payout' }
  | { kind: 'share'; placeId: string; variant?: ShareVariant }
  /** `then` runs after a successful connect (cancel = nothing runs). */
  | { kind: 'wallet'; then?: () => void }
  /** Mobile account menu as a bottom sheet (rendered by src/wallet/WalletModal). */
  | { kind: 'account' }
  | { kind: 'demo' }
  /** Real mode: the network explainer (DEVNET chip, INTEGRATION.md §7.1). */
  | { kind: 'network' }
  | { kind: 'report'; placeId?: string; reason?: ReportReason }
  | { kind: 'optout'; placeId?: string }
  | { kind: 'lightbox'; src: string; alt: string; credit?: string };

export type ModalKind = ModalState['kind'];

export type ToastKind = 'info' | 'ok' | 'error';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  msg: string;
  kind: ToastKind;
  /** Optional leading Material Symbols icon name (defaults: ok → check_circle, error → error). */
  icon?: string;
  action?: ToastAction;
}

export type MapType = 'roadmap' | 'hybrid';

/** Layers popover state (DESIGN §6.7), persisted in localStorage `cs_layers`. */
export interface LayersState {
  mapType: MapType;
  coins: boolean;
  feeDots: boolean;
  flashes: boolean;
  ticks: boolean;
}

export interface FlyTarget {
  center?: LatLng;
  zoom?: number;
  /** Fit these bounds instead of center/zoom. */
  bounds?: Bounds;
  /** Increments on every request so identical targets re-fire. */
  nonce: number;
}

export type MapProvider = 'google' | 'demo';
export type ProviderReason = 'key' | 'no-key' | 'forced' | 'load-failed';

export type LocateStatus = 'idle' | 'locating' | 'located';

/* ------------------------------------------------------------ map layer */

export type Unsubscribe = () => void;

export interface PlaceClickEvent {
  id: string;
  source: PlaceSource;
  location: LatLng;
  /** Present when the adapter already knows the place (e.g. OSM features). */
  place?: Place;
}

/** The selected-pin descriptor for adapter.setSelectedPlace (balloon). */
export interface SelectedPin {
  place: Place;
  /** Present when the place has a coin (green balloon); otherwise the launchable dashed balloon. */
  coin?: Coin;
}

/**
 * Map provider adapter (Google raster + OverlayView pins, or MapLibre + OpenFreeMap).
 * Implemented by the MAP builder in src/map. Only src/map talks to adapters; every other
 * module drives the camera through store.flyTo / store.fitBounds and reads store.viewport.
 */
export interface MapAdapter {
  readonly provider: MapProvider;
  mount(el: HTMLElement, opts: { center: LatLng; zoom: number; mapType: MapType }): Promise<void>;
  destroy(): void;
  flyTo(center: LatLng, zoom?: number, opts?: { animate?: boolean }): void;
  fitBounds?(bounds: Bounds, paddingPx?: number): void;
  setZoom(zoom: number): void;
  getZoomLimits(): { min: number; max: number };
  setMapType?(type: MapType): void;
  setLayers?(layers: LayersState): void;
  /** Full replacement of the coin pin set (already filtered by chips / layers). */
  setCoinPins(coins: Coin[]): void;
  setSelectedPlace(sel: SelectedPin | null): void;
  setResultPins(places: Place[]): void;
  setUserLocation(loc: UserLocation | null): void;
  /** Buy/sell flash on a pin (DESIGN §7.2), label like "+1.2 SOL". */
  flashCoin(placeId: string, side: TradeSide, label: string): void;
  /** Re-measure after the container size changed. */
  resize(): void;
  onPlaceClick(cb: (e: PlaceClickEvent) => void): Unsubscribe;
  onCoinClick(cb: (placeId: string) => void): Unsubscribe;
  onMapClick(cb: (location: LatLng) => void): Unsubscribe;
  /** Fires after pans/zooms settle (Google 'idle', MapLibre 'moveend'). */
  onMoveEnd(cb: (v: Viewport) => void): Unsubscribe;
  /** Fires when the user starts dragging (used to reset the "located" state). */
  onUserGesture?(cb: () => void): Unsubscribe;
  getCenter(): LatLng;
  getZoom(): number;
  getBounds(): Bounds | null;
}

/* ------------------------------------------------------------ real mode (Phase 2) */

export type TxKind = 'launch' | 'buy' | 'sell' | 'claim' | 'finalize' | 'withdraw';

/** The transaction flow in progress (INTEGRATION.md §5.3 `tx`). One at a time. */
export interface TxState {
  kind: TxKind;
  placeId: string;
  progress: TxProgress | null;
  error: TxError | null;
}
