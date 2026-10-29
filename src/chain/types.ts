/**
 * Chain-layer types (src/chain). CONTRACT FILE (INTEGRATION.md §4). CHAIN owns it; APP codes against it.
 * Builders may ADD optional fields; anything else goes through the integrator.
 * Dependency-free on purpose (no @solana/web3.js types): the UI imports these without pulling the chain chunk.
 */
import type { CoinDTO, CategoryKey as WireCategoryKey } from '../../worker/wire';
import type { CategoryKey } from '../types';
import type { Cluster } from '../mode';

export type { Cluster };

/** Compile-time guard: worker/wire.ts re-declares CategoryKey; the two unions must stay identical. */
type SameCategory = [CategoryKey] extends [WireCategoryKey] ? ([WireCategoryKey] extends [CategoryKey] ? true : never) : never;
export const CATEGORY_CONTRACT_OK: SameCategory = true;

/* ------------------------------------------------------------------------------------------- progress + errors */

/** One tx flow, in order. `registering` = the Worker confirm step (launch/claim) after the chain confirmed. */
export type TxPhase =
  | 'preparing' // uploading metadata, prepare, quote, building, co-signing, simulating
  | 'awaiting-signature' // the wallet prompt is open
  | 'sending'
  | 'confirming'
  | 'registering'
  | 'done';

export interface TxProgress {
  phase: TxPhase;
  /** e.g. 'Phantom' — for "Approve in Phantom…". */
  walletName?: string;
  /** Set from 'sending' on. */
  signature?: string;
  explorerUrl?: string;
  /** ms since 'confirming' started (show "Confirming… 6s" after 5 s). */
  elapsedMs?: number;
  /** Sub-step label for multi-step flows, e.g. 'metadata' | 'prepare' | 'cosign' | 'simulate'. */
  step?: string;
}
export type OnProgress = (p: TxProgress) => void;

export type TxErrorCode =
  | 'rejected' // user cancelled in the wallet
  | 'insufficient-sol'
  | 'insufficient-tokens'
  | 'slippage'
  | 'price-impact' // quote impact above MAX_PRICE_IMPACT_PCT; refused before signing
  | 'expired' // blockhash expired before landing; nothing was charged
  | 'taken' // place already has a coin (AlreadyRegistered / 409 taken)
  | 'reserved' // another launch for this place is mid-flight
  | 'not-launchable'
  | 'paused' // LaunchesPaused
  | 'graduated' // curve completed between quote and send
  | 'policy' // the Worker refused to co-sign (violations)
  | 'wallet-modified' // the wallet changed the message after co-signing
  | 'wallet-unsupported' // no solana:signTransaction
  | 'wrong-network'
  | 'rate-limited'
  | 'network' // our API / RPC unreachable
  | 'unconfirmed' // sent, but not confirmed within the timeout: check the explorer
  | 'onchain' // landed and failed (program error)
  | 'claim' // claim-specific refusal (see message)
  | 'uneconomic' // withdraw: the network fee is at least what it would pay out; refused before signing
  | 'unknown';

export interface TxError {
  code: TxErrorCode;
  /** Human message in DESIGN tone, ready for `.tf-help.err` / toast. Never contains secrets or raw RPC URLs. */
  message: string;
  retryable: boolean;
  /** True once sendTransaction returned a signature. Then NEVER say "nothing was sent". */
  sent: boolean;
  signature?: string;
  explorerUrl?: string;
  /** insufficient-sol: lamports needed in total (string u64). */
  needLamports?: string;
  /** Program error code when known (e.g. 110 AlreadyRegistered, 6002 TooMuchSolRequired). */
  programError?: { program: 'shop_vault' | 'pump' | 'pump_amm' | 'system' | 'other'; code: number; name?: string };
  /** taken: the existing coin. */
  existing?: { mint: string; ticker: string; placeId: string };
  logs?: string[];
}

export type TxOutcome<T> =
  | { ok: true; signature: string; explorerUrl: string; value: T }
  | { ok: false; error: TxError };

/* ------------------------------------------------------------------------------------------- wallet signing */

/**
 * Built by src/wallet/solanaWallets.ts `getSigner()` from the connected Wallet Standard wallet
 * (`solana:signTransaction`), or by the devnet test wallet. Bytes in, bytes out: no web3.js types here.
 */
export interface WalletSigner {
  address: string;
  walletName: string;
  chain: `solana:${Cluster}`;
  /** Serialized VersionedTransaction (with any signatures already present) → signed serialized tx. */
  signTransaction(serializedTx: Uint8Array): Promise<Uint8Array>;
  signMessage?(message: Uint8Array): Promise<Uint8Array>;
}

/* ------------------------------------------------------------------------------------------- market math */

/** Decoded pump BondingCurve (offsets in INTEGRATION.md §4.3; all u64 as bigint). */
export interface CurveState {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: string;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  quoteMint: string;
  isHolderReward: boolean;
  /** v3 creator-fee bucket (@125); 0n if the account is shorter. */
  creatorFeeBucket: bigint;
}

export interface PriceView {
  /** Lamports per 1 whole token (10^6 base units). */
  lamportsPerToken: number;
  solPerToken: number;
  mcapLamports: bigint;
  progressPct: number;
}

export interface BuyQuote {
  mint: string;
  venue: 'curve' | 'amm';
  lamportsIn: bigint;
  tokensOut: bigint;
  minTokensOut: bigint;
  slippageBps: number;
  priceImpactPct: number;
  /** Protocol + LP + creator fees in lamports (display). */
  feeLamports: bigint;
  creatorFeeLamports: bigint;
  /** Lamports per whole token before / after (display). */
  priceBefore: number;
  priceAfter: number;
  at: number;
}

export interface SellQuote {
  mint: string;
  venue: 'curve' | 'amm';
  tokensIn: bigint;
  lamportsOut: bigint;
  minLamportsOut: bigint;
  slippageBps: number;
  priceImpactPct: number;
  feeLamports: bigint;
  creatorFeeLamports: bigint;
  priceBefore: number;
  priceAfter: number;
  at: number;
}

/** `collectAndWithdraw` result (INTEGRATION.md §4.6). */
export interface WithdrawValue {
  /**
   * What the owner actually received: their lamport delta in the tx meta (the payout minus the network fee and any
   * one-time rent the tx paid, e.g. pump's creator-vault rent on a first withdraw). Null when the tx could not be read.
   */
  lamports: bigint | null;
  /** The vault payout itself (the shop-vault `Withdrawn` event), or null when the logs could not be read. */
  withdrawnLamports: bigint | null;
  /**
   * What the tx cost the owner: the network fee, plus any one-time rent it paid (payout − received when both are
   * known, else the tx meta fee). Null when the tx could not be read.
   */
  feeLamports: bigint | null;
}

/** What actually happened (parsed from the confirmed tx; falls back to the quote with `estimated: true`). */
export interface TradeFill {
  side: 'buy' | 'sell';
  lamports: bigint;
  tokens: bigint;
  priceLamportsPerToken: number;
  estimated: boolean;
}

/* ------------------------------------------------------------------------------------------- launch */

export interface LaunchInput {
  placeId: string;
  name: string;
  ticker: string; // no '$'
  description: string;
  category: CategoryKey;
  emoji: string;
  bg: string;
  /** Square PNG/JPEG/WebP ≤ 200 KB (the UI re-encodes uploads, and renders stickers to a 512×512 PNG). */
  image: Blob;
  devBuyLamports: bigint;
}

export interface LaunchValue {
  coin: CoinDTO;
  mint: string;
  devBuy: TradeFill | null;
}

/** Cost preview for the Review step (rent + fees + dev buy). */
export interface LaunchCostEstimate {
  rentLamports: bigint;
  feeLamports: bigint;
  devBuyLamports: bigint;
  totalLamports: bigint;
  /** Display only: tokens the dev buy gets on a fresh curve (pump SDK quote). Absent when the SDK isn't loaded. */
  devBuyTokensEstimate?: bigint;
}

/* ------------------------------------------------------------------------------------------- vault + claims */

export interface VaultView {
  placeId: string;
  placeHash: string;
  vault: string;
  vaultState: string;
  exists: boolean;
  mint: string | null;
  launcher: string | null;
  owner: string | null;
  pendingOwner: string | null;
  /** Unix seconds. */
  unlockTs: number | null;
  inProbation: boolean;
  claimNonce: bigint;
  totalWithdrawn: bigint;
  fees: { withdrawableNow: bigint; collectable: bigint; total: bigint };
  /**
   * What the owner's collect + withdraw tx costs them (lamports): the tx fee + priority, plus a ONE-TIME rent for
   * pump's creator_vault PDA when the first sweep has to create it (0.00089 SOL on mainnet; the Worker's fee crank
   * usually pays it first). Display: "Network fee ≈ x SOL". At or above `fees.total` the withdraw is refused before
   * signing (`uneconomic`) and the UI disables it with an explanation.
   */
  withdrawCostLamports?: bigint;
  at: number;
}

export interface ClaimRequestValue {
  unlockTs: number;
  inProbation: boolean;
  claimWindowSecs: number;
}

/* ------------------------------------------------------------------------------------------- wallet data */

export interface Holding {
  mint: string;
  tokenAccount: string;
  /** Base units (6 decimals). */
  amount: bigint;
}
