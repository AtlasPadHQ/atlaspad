/**
 * CORNERSHOP runtime configuration and constants.
 * SHARED file (scaffold / integrator only). See CONTRACTS.md.
 */
import { explorerAddress, explorerToken, explorerTx } from './chain/explorer';
import { IS_REAL } from './mode';
import type { LatLng, MapProvider, ProviderReason } from './types';

/* ------------------------------------------------------------- keys / provider */

/** Browser key (referrer-restricted). Empty → demo (MapLibre + OpenFreeMap) provider. */
export const GOOGLE_KEY: string = (import.meta.env.VITE_GOOGLE_MAPS_KEY ?? '').trim();

/**
 * Initial map provider: 'google' when a key is present, else 'demo'.
 * `?map=demo` forces the MapLibre fallback; `?map=google` forces Google (still needs a key).
 * The store can switch to 'demo' at runtime when Google fails (store.setProvider).
 */
export function resolveProvider(search: string = typeof location !== 'undefined' ? location.search : ''): {
  provider: MapProvider;
  reason: ProviderReason;
} {
  let forced: string | null = null;
  try {
    forced = new URLSearchParams(search).get('map');
  } catch {
    forced = null;
  }
  if (forced === 'demo') return { provider: 'demo', reason: 'forced' };
  if (!GOOGLE_KEY) return { provider: 'demo', reason: 'no-key' };
  return { provider: 'google', reason: 'key' };
}

/**
 * Demo mode: every price/trade/launch/claim is simulated (DEMO chip always visible). False in real
 * mode (src/mode.ts: a devnet/mainnet build without `?mode=demo`), where everything comes from
 * the chain + registry (INTEGRATION.md H5).
 */
export const DEMO = !IS_REAL;

/* ------------------------------------------------------------- economics (simulated) */

/** 0.5% of volume goes to the shop's vault (BRIEF: pump.fun creator fees ~0.05–0.95%). */
export const CREATOR_FEE_RATE = 0.005;
/** Demo FX: 1 SOL = $150.00 (DESIGN §3.4), constant for the whole session. */
export const DEMO_SOL_USD = 150;
/** Back-compat alias used in the brief / task text. */
export const SOL_USD = DEMO_SOL_USD;
/** Demo wallet balance for a freshly connected wallet ("Balance 2.41 SOL"). */
export const DEMO_BALANCE_SOL = 2.41;
/** pump.fun token supply. */
export const PUMP_SUPPLY = 1_000_000_000;
/** Market cap a fresh pump.fun coin starts at, in SOL (~$4.2k at $150). */
export const PUMP_INITIAL_MCAP_SOL = 28;
/** Quick amounts in the buy box and the launch "First buy" options (SOL). */
export const QUICK_BUY_SOL = [0.1, 0.5, 1] as const;
export const FIRST_BUY_OPTIONS_SOL = [0, 0.1, 0.5, 1] as const;
export const SLIPPAGE_PCT = 2;
/** Simulated network fee shown on the launch review. */
export const NETWORK_FEE_SOL = 0.02;
/** Simulated durations (ms). */
export const SIM_TRADE_MS = 1200;
export const SIM_LAUNCH_STEP_MS = 1000;
/** Demo codes (DESIGN §12.3 / §12.4). */
export const DEMO_CLAIM_CODE = '482913';
export const DEMO_EMAIL_CODE = '271604';
/** Resend / call-again cooldown (s). */
export const RESEND_COOLDOWN_S = 45;

/* ------------------------------------------------------------- limits */

export const LIMITS = {
  /** store.feed cap. */
  feed: 150,
  /** Recent trades kept per coin. */
  tradesPerCoin: 100,
  /** Wallet's own trades persisted. */
  walletTrades: 50,
  /** Price ticks kept per coin (1H chart). */
  ticks: 60,
  /** History points (24h at 30-min buckets). */
  history: 48,
  /** Recent search entries. */
  recent: 5,
  /** Coin name max length. */
  nameMax: 32,
  /** Ticker length bounds (DESIGN §12.2: ^[A-Z0-9]{2,8}$). */
  tickerMin: 2,
  tickerMax: 8,
  /** Upload limit for coin art (DESIGN §12.2). */
  artMaxBytes: 2 * 1024 * 1024,
  /** Uploaded art is resized to at most this many px before it is stored. */
  artMaxPx: 512,
  /** Coordinates of Google places may be cached for at most 30 days (Google SST §14.3). */
  googleCoordTtlMs: 30 * 24 * 60 * 60 * 1000,
} as const;

/* ------------------------------------------------------------- map / camera */

/** Dalston demo cluster (DESIGN §4.5). */
export const INITIAL_CAMERA: { center: LatLng; zoom: number } = {
  center: { lat: 51.5469, lng: -0.0712 },
  zoom: 15,
};
/** Hero state camera (DESIGN §4.5). */
export const HERO_CAMERA: { center: LatLng; zoom: number } = {
  center: { lat: 51.5468, lng: -0.0745 },
  zoom: 15,
};
/** Demo user-location point (DESIGN §19.2) — only for QA states, never auto-used. */
export const DEMO_USER_LOCATION: LatLng = { lat: 51.5433, lng: -0.0688 };
/** Below this zoom pins render as dots (`body.lowzoom`). */
export const LOW_ZOOM = 14;
/** Below this zoom the "This area" card says "Zoom in to see shops". */
export const AREA_MIN_ZOOM = 11;
/** Zoom used when flying to a coin/place from lists, search and deep links. */
export const FOCUS_ZOOM = 16;
/** Google map language / region. */
export const MAP_LANGUAGE = 'en-GB';
export const MAP_REGION = 'GB';
/** MapLibre fallback style (BRIEF). */
export const OSM_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
/** Photon geocoder (fallback search). */
export const PHOTON_URL = 'https://photon.komoot.io';

/* ------------------------------------------------------------- breakpoints */

export const BP = {
  /** max-width for mobile */
  mobileMax: 767,
  /** min-width for desktop */
  desktopMin: 1024,
} as const;

/* ------------------------------------------------------------- links */

export const APP_ORIGIN = 'https://cornershop.tiejiucai.workers.dev';
export const APP_HOST = 'cornershop.tiejiucai.workers.dev';

/**
 * Origin of share links. Demo: the public demo Worker. Real mode: the Worker this build is served
 * from (cornershop-devnet… on devnet, the mainnet origin after the flip), so a devnet share opens
 * the devnet app with its devnet coin.
 */
export function shareOrigin(): string {
  if (IS_REAL && typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) return location.origin;
  return APP_ORIGIN;
}

const enc = encodeURIComponent;

export const links = {
  /** Solscan links: cluster-aware in real mode (`?cluster=devnet` on devnet, src/chain/explorer). */
  solscanToken: (mint: string) => (IS_REAL ? explorerToken(mint) : `https://solscan.io/token/${mint}`),
  solscanAccount: (address: string) => (IS_REAL ? explorerAddress(address) : `https://solscan.io/account/${address}`),
  solscanTx: (signature: string) => (IS_REAL ? explorerTx(signature) : `https://solscan.io/tx/${signature}`),
  dexscreener: (mint: string) => `https://dexscreener.com/solana/${mint}`,
  pumpfun: (mint: string) => `https://pump.fun/coin/${mint}`,
  /** Official Maps URL for a Google place ID (DESIGN §18.2 "Open in Maps"). */
  googleMapsPlace: (placeId: string) =>
    `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${enc(placeId)}`,
  googleMapsLatLng: (p: LatLng) => `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`,
  /** Share URLs (DESIGN §12.5). `coinId` = the coin's mint. */
  shareCoin: (coinId: string) => `${shareOrigin()}/c/${enc(coinId)}`,
  sharePlace: (placeId: string) => `${shareOrigin()}/p/${enc(placeId)}`,
  xIntent: (text: string, url: string) => `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}`,
  unsplashPhoto: (id: string, w: number, h: number) =>
    `https://images.unsplash.com/photo-${id}?w=${w}&h=${h}&fit=crop&q=70&auto=format`,
  /** The photo's page on unsplash.com — takes the page id/slug (e.g. `Vq995Fnrw4A`), NOT the CDN id. */
  unsplashPage: (pageId: string) => `https://unsplash.com/photos/${enc(pageId)}`,
  googleMapsTerms: 'https://maps.google.com/help/terms_maps/',
  googlePrivacy: 'https://policies.google.com/privacy',
  /** AtlasPad's own X account (rail, drawer, Help; `twitter:site` in index.html). */
  xProfile: 'https://x.com/AtlasPadx',
  xHandle: '@AtlasPadx',
  /** The public source code (rail, drawer, Help). */
  github: 'https://github.com/AtlasPadHQ/atlaspad',
  terms: '/terms',
  privacy: '/privacy',
  walletInstall: {
    Phantom: 'https://phantom.com/download',
    Solflare: 'https://solflare.com/download',
    Backpack: 'https://backpack.app/downloads',
  } as Record<string, string>,
  /** Mobile "Open in app" deep links (DESIGN §12.4). */
  walletBrowse: {
    Phantom: (url: string, ref: string) => `https://phantom.app/ul/browse/${enc(url)}?ref=${enc(ref)}`,
    Solflare: (url: string, ref: string) => `https://solflare.com/ul/v1/browse/${enc(url)}?ref=${enc(ref)}`,
  } as Record<string, (url: string, ref: string) => string>,
} as const;

/** Pinned wallets, in display order (DESIGN §12.4). */
export const PINNED_WALLETS = ['Phantom', 'Solflare', 'Backpack'] as const;

/* ------------------------------------------------------------- storage keys */

/** localStorage / sessionStorage keys (all access via src/lib/storage.ts, try/catch). */
export const STORAGE_KEYS = {
  heroSeen: 'cs_hero_seen',
  recent: 'cs_recent',
  layers: 'cs_layers',
  wallet: 'cs_wallet',
  launchedSeenAt: 'cs_launched_seen_at',
  /** sessionStorage */
  viewport: 'cs_viewport',
  /** User-launched coins (full Coin objects, no Google content). */
  userCoins: 'cornershop:v1:coins',
  /** Claims made in this browser: placeId → {mint, owner, payoutWallet, claimedAt, amountUsd, pending}; a claim only applies to the coin whose `mint` it names. */
  claims: 'cornershop:v1:claims',
  /** Per-wallet simulated balances: `${walletData}${address}`. */
  walletData: 'cornershop:v1:wallet:',
  /** Owner verifications for places that have no coin yet: placeId → {owner, payoutWallet} (IDs/addresses only). */
  preclaims: 'cornershop:v1:preclaims',
} as const;
