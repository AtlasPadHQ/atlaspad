/**
 * CORNERSHOP Phase 2 wire contract: every real-mode HTTP shape between the browser (src/realdata, src/chain) and the
 * Worker, plus the launch/claim rules both sides must apply identically.
 *
 * CONTRACT FILE (INTEGRATION.md §3). BACKEND owns it. Builders may ADD optional fields; renaming, removing or
 * re-typing anything needs the integrator. Pure module: types + small pure functions/constants, no runtime imports,
 * no Worker globals (the browser imports it too, type-only or for the constants).
 *
 * Conventions
 *  - u64 values (lamports, token base units, reserves) travel as decimal strings (`U64`). Never JSON numbers.
 *  - Token amounts are base units; every pump coin has 6 decimals (TOKEN_DECIMALS).
 *  - Timestamps: `…At` / `ts` = unix MILLISECONDS; `…Ts` from the chain (unlockTs, probationUntil) = unix SECONDS.
 *  - Addresses / signatures are base58 strings.
 *  - Every non-2xx response body is `ApiErrorBody`.
 */
/**
 * Same union as `CategoryKey` in src/types.ts (re-declared so the Worker does not compile DOM-typed app code;
 * src/chain/types.ts asserts at compile time that the two stay identical).
 */
export type CategoryKey = 'cafe' | 'barber' | 'kebab' | 'pizza' | 'bakery' | 'pub' | 'corner' | 'restaurant' | 'other';

/* ============================================================================================ primitives */

export type Cluster = 'devnet' | 'mainnet';
/** Decimal string of an unsigned 64-bit integer. */
export type U64 = string;
export type Base58 = string;
export type Base64 = string;

export const TOKEN_DECIMALS = 6;
export const LAMPORTS_PER_SOL = 1_000_000_000;

/* ============================================================================================ errors */

export type ApiErrorCode =
  // generic
  | 'bad_request'
  | 'not_found'
  | 'method_not_allowed'
  | 'rate_limited'
  | 'unavailable'
  | 'upstream'
  | 'not_enabled' // route exists but not in this Worker/cluster (e.g. /api/dev/* on mainnet, real routes on the demo Worker)
  | 'not_configured' // a required secret/integration is missing (e.g. Twilio on mainnet)
  | 'forbidden_origin'
  | 'payload_too_large'
  | 'unsupported_media'
  // compliance (worker/geo.ts, worker/sanctions.ts), all HTTP 451
  | 'region_blocked' // the visitor's country or region is blocked
  | 'place_region_blocked' // the business is in a blocked country or region (or, for a launch, we can't tell where)
  | 'wallet_blocked' // a wallet on the sanctions list
  // launch
  | 'not_launchable'
  | 'taken'
  | 'reserved'
  | 'reservation_expired'
  | 'policy_violation'
  | 'launches_paused'
  | 'not_confirmed'
  | 'chain_mismatch'
  | 'moderation'
  | 'place_opted_out' // the business asked not to be listed (scripts/moderate.mjs --optout): no coin can be launched
  // claim
  | 'no_coin'
  | 'no_phone'
  | 'premium'
  | 'claim_active'
  | 'claim_pending'
  | 'already_owner'
  | 'too_many_attempts'
  | 'claim_not_verified'
  | 'claim_expired'
  | 'wrong_owner'
  | 'not_own_domain'
  // devnet faucet
  | 'faucet_cap'
  | 'faucet_empty';

export interface ApiErrorBody {
  error: ApiErrorCode;
  /** Human-readable, safe to show (never contains secrets, upstream URLs or raw phone numbers). */
  message?: string;
  retryAfterSec?: number;
  /** policy_violation: the SPEC §8.4 violations (shop-vault client checkLaunchMessage/checkClaimMessage output). */
  violations?: string[];
  /** taken: the coin that already owns this place. */
  existing?: CoinRef;
  /** not_launchable: why. */
  reason?: LaunchIneligibleReason;
}

/* ============================================================================================ config / health */

/** GET /api/config  (cache-control: public, max-age=30) */
export interface ConfigResponse {
  cluster: Cluster;
  genesisHash: string;
  publicOrigin: string; // e.g. https://cornershop-devnet.tiejiucai.workers.dev
  programId: Base58;
  configPda: Base58;
  /** The frozen CORNERSHOP address lookup table of this cluster (SPEC §8.1). */
  alt: Base58;
  /** Attestor public key (the Worker co-signs register_launch / request_claim with it). */
  attestor: Base58;
  /** From on-chain Config (60 on devnet, 259200 on mainnet). */
  claimWindowSecs: number;
  launchesPaused: boolean;
  /** Unix seconds; 0 = none. While in the future, show the probation banner (SPEC §8.6). */
  probationUntil: number;
  maxDevBuyLamports: U64;
  /** Recommended compute-unit price for user txs (µlamports). */
  priorityFeeMicroLamports: number;
  /** pump Global values (for progress %, initial price). */
  curve: {
    initialVirtualTokenReserves: U64;
    initialVirtualQuoteReserves: U64;
    initialRealTokenReserves: U64;
    tokenTotalSupply: U64;
  };
  solUsd: number | null;
  solUsdAt: number | null;
  features: {
    /** Devnet builds with dev endpoints only. A local keypair: it never depends on the faucet's balance. */
    testWallet: boolean;
    /** Devnet only: the Worker faucet can pay out (holds ≥ 0.3 SOL), so `/api/dev/airdrop` may succeed. */
    faucet: boolean;
    privy: boolean; // PRIVY_APP_ID configured (email login); false in this phase
    phoneVerification: 'call' | 'screen' | 'none'; // mainnet 'call' (Twilio) · devnet 'screen' · 'none' = not configured
    turnstileSiteKey: string | null;
    jupiter: boolean; // mainnet fallback route for graduated coins
    websiteVerification: boolean;
    /**
     * The manual-review claim route (POST /api/claim/manual) is open. FEATURE_MANUAL_REVIEW; default on for devnet,
     * off for mainnet. Absent on older Workers: treat as devnet → true, mainnet → false.
     */
    manualReview?: boolean;
  };
  /** Explorer URL templates for this cluster: replace {sig} / {address} / {mint}. */
  explorer: { tx: string; address: string; token: string };
  buildId: string;
}

export type HealthCheck = 'ok' | 'missing' | 'mismatch' | 'error' | 'stale' | 'n/a';

/** GET /api/health  (no-store). Never contains a secret value. */
export interface HealthResponse {
  ok: boolean;
  service: 'cornershop-api';
  cluster: Cluster | 'demo';
  buildId: string;
  checks: {
    google: HealthCheck;
    /** The RPC provider (Alchemy since 2026-10-08): reachable with the Worker's key. */
    alchemy: HealthCheck;
    genesis: HealthCheck; // RPC genesis hash == expected for CLUSTER
    program: HealthCheck; // program account exists + executable
    config: HealthCheck; // Config PDA decodes; flavor matches the cluster
    attestor: HealthCheck; // pubkey derived from ATTESTOR_SECRET == Config.attestor
    alt: HealthCheck; // ALT exists, frozen, holds exactly ALT_KEYS
    d1: HealthCheck;
    phone: HealthCheck; // twilio (mainnet) / screen (devnet)
    turnstile: HealthCheck;
    priceFeed: HealthCheck;
    indexer: HealthCheck; // last run < 3 min ago
    faucet: HealthCheck; // devnet: 'ok' when the faucet can pay out (≥ 0.3 SOL), else 'stale'; mainnet: 'n/a' (no route)
  };
  solUsd: number | null;
  solUsdAgeSec: number | null;
  indexerLagSec: number | null;
  slot: number | null;
}

/* ============================================================================================ coins */

export interface CoinRef {
  placeId: string;
  mint: Base58;
  ticker: string;
  name: string;
}

export interface MarketDTO {
  venue: 'curve' | 'amm';
  /** Lamports per 1 whole token (10^6 base units). Float; display only. */
  priceLamports: number;
  /** Market cap in lamports = price × total supply (pump: vQuote × supply / vToken). */
  mcapLamports: U64;
  /** Curve fields (venue 'curve'); for 'amm' the pool reserves are reported in vSol/vTok. */
  vSol: U64;
  vTok: U64;
  realSol: U64;
  realTok: U64;
  supply: U64;
  /** 0..100, token-based like pump.fun (100 when complete). */
  progressPct: number;
  complete: boolean;
  vol24hLamports: U64;
  /** null when there is no price 24h ago and no initial price. */
  change24hPct: number | null;
  lastTradeAt: number | null;
  slot: number;
  at: number;
}

export interface FeesDTO {
  /** Lifetime creator fees that reached (or wait for) the shop = totalWithdrawn + waiting. */
  earnedLamports: U64;
  /** Everything not yet paid out: withdrawableNow + collectable (shop-vault client `feesWaiting().total`). */
  waitingLamports: U64;
  withdrawableNowLamports: U64;
  collectableLamports: U64;
  withdrawnLamports: U64;
  at: number;
}

export interface OwnerDTO {
  status: 'unclaimed' | 'pending' | 'claimed';
  owner: Base58 | null;
  pendingOwner: Base58 | null;
  /** Unix seconds; when the pending claim can be finalized. */
  unlockTs: number | null;
  inProbation: boolean;
  /** Unix seconds. */
  ownerSince: number | null;
}

export interface CoinDTO {
  placeId: string;
  placeHash: string; // hex sha256(placeId)
  mint: Base58;
  vault: Base58;
  vaultState: Base58;
  bondingCurve: Base58;
  ticker: string; // no '$'
  name: string;
  description: string;
  category: CategoryKey;
  emoji: string;
  bg: string; // '#rrggbb'
  imageUrl: string | null; // https://<origin>/img/<id>.<ext>
  metadataUri: string;
  launcher: Base58;
  createdAt: number;
  launchSig: string;
  /** Google coordinates, cached ≤ 30 days (ToS) and refreshed by the cron; null while unknown. */
  location: { lat: number; lng: number } | null;
  graduated: boolean;
  pool: Base58 | null;
  market: MarketDTO;
  fees: FeesDTO;
  owner: OwnerDTO;
  holders: number | null;
  holdersAt: number | null;
}

export interface TradeDTO {
  id: string; // `${sig}:${ix}`
  sig: string;
  mint: Base58;
  placeId: string;
  side: 'buy' | 'sell';
  /** Curve-side amount before pump's fees (the TradeEvent `sol_amount`; AMM: the user's quote amount). */
  solLamports: U64;
  /** What the trader paid (buy) / received (sell), fees included; null on rows not yet backfilled. */
  userLamports: U64 | null;
  tokens: U64;
  trader: Base58;
  /** Lamports per whole token after the trade. */
  priceLamports: number;
  venue: 'curve' | 'amm';
  ts: number;
}

export interface CoinDetailDTO extends CoinDTO {
  trades: TradeDTO[]; // newest first, ≤ 50
  /** 48 × 30-min buckets of lamports-per-token, oldest → newest (last = current). */
  history: number[];
  historyAt: number; // ms start of the newest bucket
  /** Up to 60 most recent trade prices (lamports per token) + their times. */
  ticks: number[];
  tickTimes: number[];
}

/**
 * GET /api/coins?bbox=w,s,e,n&limit=300            map viewport (bbox snapped outward to 0.01°)
 * GET /api/coins?mints=a,b,c                       ≤ 100 mints (holdings lookup, deep links)
 * GET /api/coins?launcher=<addr> | owner=<addr>    My coins
 * GET /api/coins?sort=new&limit=50                 Launched panel
 * (cache-control: public, max-age=5, stale-while-revalidate=25)
 */
export interface CoinsResponse {
  coins: CoinDTO[];
  solUsd: number | null;
  at: number;
}

/** GET /api/coins/:mint[?fresh=1]  (fresh=1 re-reads curve + vault accounts from chain; rate-limited) */
export type CoinDetailResponse = CoinDetailDTO;

/** GET /api/market?mints=a,b,c (≤ 100)  — price poll for visible + selected coins (max-age=2) */
export interface MarketResponse {
  quotes: Record<Base58, MarketDTO>;
  solUsd: number | null;
  slot: number;
  at: number;
}

/** GET /api/top?by=mcap|fees&limit=20[&bbox=w,s,e,n] */
export interface TopResponse {
  by: 'mcap' | 'fees';
  coins: CoinDTO[];
  solUsd: number | null;
  at: number;
}

interface FeedBaseDTO {
  id: string;
  ts: number;
  mint: Base58;
  placeId: string;
  ticker: string;
  name: string;
  emoji: string;
  bg: string;
}
export type FeedEventDTO =
  | (FeedBaseDTO & { kind: 'trade'; side: 'buy' | 'sell'; solLamports: U64; userLamports: U64 | null; tokens: U64; wallet: Base58; sig: string })
  | (FeedBaseDTO & { kind: 'launch'; wallet: Base58; sig: string })
  /**
   * Owner events. `requested` = a claim went pending on-chain (public window, can still be disputed); `finalized` = the
   * claimant became the verified owner. Neither moves money, so `feesLamports` is null for both. `withdrawn` = the owner
   * was paid: `feesLamports` is the amount of that withdrawal (the shop-vault `Withdrawn` event), `wallet` the owner.
   */
  | (FeedBaseDTO & { kind: 'claim'; stage: 'requested' | 'finalized' | 'withdrawn'; wallet: Base58; feesLamports: U64 | null; sig: string | null });

/** GET /api/feed?limit=50[&since=<ms>][&before=<ms>][&bbox=…][&kinds=trade,launch,claim]  (max-age=3) */
export interface FeedResponse {
  events: FeedEventDTO[]; // newest first
  now: number;
}

/** GET /api/place/:placeId — registry lookup only (no Google call, cheap). */
export interface PlaceResponse {
  placeId: string;
  coin: CoinDTO | null;
  /** Another launch for this place is mid-flight (co-signed, not yet confirmed). */
  launchInProgress: boolean;
  /** The business asked not to be listed: no coin can be launched for it. Absent = false. */
  optedOut?: boolean;
  /**
   * This place has a coin, but it is hidden from discovery (moderation or opt-out; `coin` is null). Its fees are still
   * kept for the verified owner, who can claim and withdraw them. Absent = false.
   */
  hidden?: boolean;
}

export type LaunchIneligibleReason = 'not_business' | 'closed' | 'not_found' | 'unsupported_place' | 'taken' | 'opted_out';

/** GET /api/place/:placeId/eligibility — server-side Google lookup (Places API (New), server key). */
export interface EligibilityResponse {
  placeId: string;
  launchable: boolean;
  reason: 'ok' | LaunchIneligibleReason;
  /** Prefill only (from Google primaryType); the launcher's choice is what gets saved. */
  category: CategoryKey | null;
}

/* ============================================================================================ launch */

/**
 * POST /api/metadata  multipart/form-data: name, symbol, description, placeId, image (PNG/JPEG/WebP, ≤ IMAGE_MAX_BYTES,
 * square, ≤ 1024 px; the client re-encodes to 512×512). Stores the image + JSON in D1 (content-addressed).
 */
export interface MetadataUploadResponse {
  metadataId: string; // 32 hex chars
  uri: string; // `${publicOrigin}/meta/${metadataId}.json` (≤ URI_MAX_BYTES)
  imageUrl: string; // `${publicOrigin}/img/${imageId}.${ext}`
  name: string; // as stored (moderated, NFC-normalised)
  symbol: string;
}

/** POST /api/launch/prepare */
export interface LaunchPrepareRequest {
  placeId: string;
  launcher: Base58;
  /** Fresh mint public key; the browser holds its keypair and adds the mint signature. */
  mint: Base58;
  metadataId: string;
  category: CategoryKey;
  emoji: string;
  bg: string;
  devBuyLamports: U64; // "0" = no dev buy
}
export interface LaunchPrepareResponse {
  reservationId: string;
  placeId: string;
  placeHash: string;
  vault: Base58;
  vaultState: Base58;
  /** The tx MUST use exactly these (they come from the stored metadata). */
  name: string;
  symbol: string;
  uri: string;
  attestor: Base58;
  alt: Base58;
  programId: Base58;
  configPda: Base58;
  maxDevBuyLamports: U64;
  computeUnitLimit: number; // 400_000 (policy max 600_000)
  priorityFeeMicroLamports: number; // policy max 5_000_000
  blockhash: string;
  lastValidBlockHeight: number;
  expiresAt: number; // cosign before this (prepare + 120 s)
}

/** POST /api/launch/cosign — the browser-built v0 message (base64 of message.serialize()). */
export interface LaunchCosignRequest {
  reservationId: string;
  messageBase64: Base64;
}
export interface LaunchCosignResponse {
  attestor: Base58;
  /** base64 ed25519 signature over exactly the submitted message bytes. */
  attestorSignature: Base64;
  /** The place stays locked for this launcher until then (blockhash validity + margin). */
  lockedUntil: number;
}

/** POST /api/launch/confirm */
export interface LaunchConfirmRequest {
  reservationId: string;
  signature: string;
}
/** 200 = registered; 202 = { status: 'pending' } (not visible at 'confirmed' yet; retry every 1.5 s, ≤ 30 s). */
export type LaunchConfirmResponse = { status: 'registered'; coin: CoinDTO } | { status: 'pending' };

/* ============================================================================================ claims (real mode) */

/** POST /api/claim/call — start (or repeat, with claimId) the phone verification for a launched place. */
export interface ClaimCallRequest {
  placeId: string;
  claimId?: string; // present = "Call me again" (45 s cooldown, ≤ 3 calls per claim)
  turnstileToken?: string; // required on mainnet when TURNSTILE_SECRET_KEY is set
}
export interface ClaimCallResponse {
  claimId: string;
  channel: 'call' | 'screen';
  masked: string; // "+44 20 •••• ••23"
  expiresAt: number; // code validity (10 min)
  resendAfterSec: number; // 45
  callsLeft: number;
  /** DEVNET ONLY ('screen' channel): the code to show on screen. Never present on mainnet. */
  devCode?: string;
}

/** POST /api/claim/check */
export interface ClaimCheckRequest {
  claimId: string;
  code: string; // 6 digits
}
export type ClaimCheckResponse =
  | { approved: true; claimToken: string; tokenExpiresAt: number } // token valid 30 min
  | { approved: false; attemptsLeft: number };

/** POST /api/claim/cosign — request_claim tx (no ALT), fee payer = newOwner. */
export interface ClaimCosignRequest {
  claimId: string;
  claimToken: string;
  newOwner: Base58; // bound to the claim on first cosign; later cosigns must use the same key
  messageBase64: Base64;
}
export interface ClaimCosignResponse {
  attestor: Base58;
  attestorSignature: Base64;
  expectedNonce: U64;
}

/** POST /api/claim/confirm */
export interface ClaimConfirmRequest {
  claimId: string;
  signature: string;
}
export type ClaimConfirmResponse =
  | { status: 'pending_onchain'; unlockTs: number; inProbation: boolean; claimWindowSecs: number }
  | { status: 'pending' };

/** GET /api/claim/status?placeId=…  public on-chain + registry view used by the fees card / claim modal. */
export interface ClaimStatusResponse {
  placeId: string;
  owner: OwnerDTO;
  /** A phone verification is running for this place right now (someone else's). */
  verificationActive: boolean;
  claimWindowSecs: number;
  /**
   * The place's coin, also when it is hidden from discovery (moderation or opt-out hide a coin from the map and lists,
   * never from its owner): the claim modal uses it when the coin is not in the app's lists.
   */
  coin?: CoinRef & { hidden: boolean };
}

/** POST /api/claim/website — "Code on your website" (only the listing's own domain; see isOwnBusinessHost). */
export interface ClaimWebsiteRequest {
  placeId: string;
  claimId?: string; // omitted = issue a code
}
export type ClaimWebsiteResponse =
  | { status: 'code'; claimId: string; code: string; host: string } // e.g. atlaspad-verify=7KQ2-M9XD
  | { status: 'not_found'; claimId: string } // code not on the site yet
  | { status: 'approved'; claimId: string; claimToken: string; tokenExpiresAt: number };

/* ============================================================================================ misc */

/** POST /api/index/tx — on-demand indexing of the caller's own confirmed trade (the feed shows it in ~2 s). */
export interface IndexTxRequest {
  signature: string;
}
export interface IndexTxResponse {
  indexed: number; // trade events stored from that tx (0 if it touched no registered coin)
}

/** POST /api/report — Report a coin / Business opt-out (stored for ops review). */
export interface ReportRequest {
  /** 'manual_claim' = the manual-review claim route (INTEGRATION §7.5; also accepted at POST /api/claim/manual). */
  kind: 'report' | 'optout' | 'manual_claim';
  placeId?: string;
  mint?: string;
  reason: string; // DESIGN §12.6 reason key
  details?: string; // ≤ 1000 chars
  contact?: string; // ≤ 200 chars (opt-out)
  /** manual_claim: the wallet that should own the shop (shown, shortened, in the owner's alert). */
  wallet?: Base58;
}

/** POST /api/dev/airdrop — DEVNET ONLY (compiled out of mainnet; 404 not_enabled there). */
export interface DevAirdropRequest {
  address: Base58;
}
export interface DevAirdropResponse {
  signature: string;
  lamports: U64;
}

/* ============================================================================================ RPC proxy */

/** POST /api/rpc — JSON-RPC 2.0 (single object or a batch of ≤ 10). Methods outside this list → -32601. */
export const RPC_METHODS = [
  'getAccountInfo',
  'getMultipleAccounts',
  'getBalance',
  'getLatestBlockhash',
  'getBlockHeight',
  'getSlot',
  'getSignatureStatuses',
  'sendTransaction',
  'simulateTransaction',
  'getTokenAccountsByOwner',
  'getTokenAccountBalance',
  'getFeeForMessage',
  'getMinimumBalanceForRentExemption',
  'getSignaturesForAddress',
  'getTransaction',
  'getGenesisHash',
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];

export const RPC_LIMITS = {
  batchMax: 10,
  multipleAccountsMax: 100,
  signatureStatusesMax: 50,
  signaturesForAddressMax: 25,
  txBytesMax: 1232,
  simulateAccountsMax: 10,
  responseBytesMax: 1_000_000,
} as const;

/** JSON-RPC error code /api/rpc returns for a sendTransaction from a sanctioned wallet (worker/sanctions.ts). */
export const RPC_WALLET_BLOCKED = -32051;

/* ============================================================================================ launch rules (shared) */

/** pump create_v2 + our tx-size budget (SPEC §8.1): name ≤ 32 UTF-8 bytes, symbol ≤ 10, uri ≤ 100. */
export const NAME_MAX_BYTES = 32;
export const TICKER_RE = /^[A-Z0-9]{2,8}$/;
export const DESCRIPTION_MAX_CHARS = 280;
export const URI_MAX_BYTES = 100;
export const IMAGE_MAX_BYTES = 200_000;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const IMAGE_MAX_PX = 1024;
export const RESERVATION_TTL_MS = 120_000;
export const DEV_BUY_OPTIONS_LAMPORTS = ['0', '100000000', '500000000', '1000000000'] as const;

/** Google place types that are never a launchable business, even if Google marks them OPERATIONAL. */
export const NON_BUSINESS_TYPES: readonly string[] = [
  'plus_code', 'geocode', 'street_address', 'route', 'intersection', 'premise', 'subpremise', 'postal_code',
  'postal_code_prefix', 'postal_town', 'locality', 'sublocality', 'sublocality_level_1', 'sublocality_level_2',
  'neighborhood', 'colloquial_area', 'political', 'country', 'administrative_area_level_1',
  'administrative_area_level_2', 'administrative_area_level_3', 'administrative_area_level_4',
  'administrative_area_level_5', 'natural_feature', 'continent', 'archipelago', 'park', 'national_park',
  'state_park', 'dog_park', 'playground', 'beach', 'hiking_area', 'city_hall', 'courthouse', 'embassy',
  'local_government_office', 'police', 'fire_station', 'cemetery', 'church', 'mosque', 'synagogue',
  'hindu_temple', 'place_of_worship', 'school', 'primary_school', 'secondary_school', 'university',
  'transit_station', 'train_station', 'subway_station', 'light_rail_station', 'bus_station', 'bus_stop',
  'airport', 'ferry_terminal', 'parking', 'public_bathroom', 'hospital',
];

export interface PlaceFacts {
  businessStatus?: string | null; // Places API (New): OPERATIONAL | CLOSED_TEMPORARILY | CLOSED_PERMANENTLY
  primaryType?: string | null;
  types?: readonly string[] | null;
}

/**
 * The single launchability rule (Worker enforces it at prepare; the UI uses it to hide Launch early).
 * A coin may only be launched for an establishment with businessStatus === 'OPERATIONAL' whose primary type and
 * types are not in NON_BUSINESS_TYPES. Cities, roads, plus codes and regions have no businessStatus → not launchable.
 */
export function launchIneligibility(p: PlaceFacts): LaunchIneligibleReason | null {
  const types = p.types ?? [];
  if (p.primaryType && NON_BUSINESS_TYPES.includes(p.primaryType)) return 'not_business';
  if (!p.primaryType && types.some((t) => NON_BUSINESS_TYPES.includes(t))) return 'not_business';
  if (!p.businessStatus) return 'not_business';
  if (p.businessStatus !== 'OPERATIONAL') return 'closed';
  return null;
}

/**
 * Hosts that are platforms, not the business's own website (website/email verification must refuse them): every host
 * whose pages belong to many people by path (`sites.google.com/view/…`, `linktr.ee/…`, `facebook.com/…`), and cloud
 * storage and compute endpoints, where the customer's label sits at no fixed depth (`rosies.s3.amazonaws.com`,
 * `rosies.s3-website.eu-west-2.amazonaws.com`), and tunnels and dynamic DNS names.
 */
export const PLATFORM_HOSTS: readonly string[] = [
  'google.com', 'goo.gl', 'g.page', 'business.site', 'facebook.com', 'fb.com', 'instagram.com', 'tiktok.com',
  'x.com', 'twitter.com', 'linkedin.com', 'youtube.com', 'linktr.ee', 'linktree.com', 'tripadvisor.com',
  'tripadvisor.co.uk', 'yelp.com', 'yelp.co.uk', 'ubereats.com', 'deliveroo.co.uk', 'deliveroo.com', 'just-eat.co.uk',
  'just-eat.com', 'justeat.com', 'doordash.com', 'grubhub.com', 'opentable.com', 'opentable.co.uk', 'resy.com',
  'thefork.com', 'booksy.com', 'fresha.com', 'treatwell.co.uk', 'square.site', 'squareup.com', 'wix.com',
  'wixsite.com', 'weebly.com', 'wordpress.com', 'blogspot.com', 'carrd.co', 'sites.google.com', 'yell.com',
  'foursquare.com', 'zomato.com', 'menulog.com.au', 'toasttab.com', 'order.online', 'flipdish.com', 'amazon.com',
  'etsy.com', 'ebay.com', 'nhs.uk', 'gov.uk',
  'google.co.uk', 'wa.me', 'whatsapp.com', 'm.me', 'messenger.com', 'threads.net', 'pinterest.com', 'snapchat.com',
  'github.com', 'gitlab.com', 'bit.ly', 'beacons.ai', 'linkin.bio', 'bio.link', 'lnk.bio', 'taplink.cc',
  'booking.com', 'airbnb.com', 'airbnb.co.uk', 'calendly.com', 'about.me',
  'amazonaws.com', 'googleapis.com', 'core.windows.net', 'digitaloceanspaces.com',
  // tunnels and dynamic DNS: anyone gets a name for a few minutes, nobody's own website
  'ngrok.io', 'ngrok.app', 'ngrok-free.app', 'ngrok-free.dev', 'trycloudflare.com', 'loca.lt', 'duckdns.org', 'ddns.net',
  'hopto.org', 'zapto.org',
];

/** Blogger's country domains (`rosies.blogspot.co.uk`, `.de`, `.com.au`), refused as blogspot.com is. */
const BLOGSPOT_RE = /(?:^|\.)blogspot\.(?:com?\.)?[a-z]{2}$/;

/**
 * True when `host` may be the business's own domain: not a platform host. Shared with the claim UI, so it stays small;
 * the Worker also refuses a bare public suffix (`co.uk`, `netlify.app`) with worker/website.ts `isOwnSiteHost`.
 */
export function isOwnBusinessHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) return false;
  return !PLATFORM_HOSTS.some((p) => h === p || h.endsWith(`.${p}`)) && !BLOGSPOT_RE.test(h);
}

/** DEVNET ONLY synthetic places for automated E2E without Google (`/p/cornershop-test:cafe-1`). */
export const DEV_TEST_PLACE_RE = /^cornershop-test:[a-z0-9-]{1,40}$/;

/**
 * DEVNET synthetic places (`cornershop-test:*`): the fictitious NANP number `+1 <area> 555-01xx` (555-0100 to 555-0199
 * is reserved for fiction) derived from `sha256(utf8(placeId))`. Shared so the Worker's "call" (worker/claims.ts
 * devTestPhone) and the claim modal's Verify step (src/lib/place.ts devTestPhoneMasked) always show the same number.
 */
export function devTestPhoneFromHash(h: Uint8Array): { e164: string; masked: string } {
  const area = 200 + (((h[0]! << 8) | h[1]!) % 800); // 200..999
  const line = String(h[2]! % 100).padStart(2, '0');
  return { e164: `+1${area}55501${line}`, masked: `+1 ${area} ••• ••${line}` };
}
