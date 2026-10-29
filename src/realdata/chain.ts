/**
 * APP's single doorway into the chain layer (src/chain, CHAIN builder; INTEGRATION.md §4).
 *
 *  - Light modules (`load`, `rpc`) are imported statically: they carry no web3.js / SDK.
 *  - The heavy API (`src/chain/index.ts`: web3.js + shop-vault client + pump SDK) is reached only
 *    through `loadChain()`, memoised, and initialised once with the current `/api/config`.
 *  - Signing goes through `getSigner()` from src/wallet/solanaWallets.ts (CHAIN). It returns null for
 *    the mocked email wallet or a wallet without `solana:signTransaction` → `wallet-unsupported`.
 *
 * Every function here is safe to call from UI code: expected failures come back as TxError values.
 */
import type { ConfigResponse } from '../../worker/wire';
import { loadChain as loadChainModule, prefetchChain as prefetchChainModule, prefetchPump as prefetchPumpModule } from '../chain/load';
import { getBalance as rpcGetBalance, getToken2022Holdings as rpcGetHoldings, getWalletSnapshot as rpcGetWallet } from '../chain/rpc';
import type {
  BuyQuote,
  ClaimRequestValue,
  Holding,
  LaunchCostEstimate,
  LaunchInput,
  LaunchValue,
  OnProgress,
  SellQuote,
  TradeFill,
  TxError,
  TxOutcome,
  VaultView,
  WalletSigner,
  WithdrawValue,
} from '../chain/types';
import { IS_REAL } from '../mode';
import * as wallets from '../wallet/solanaWallets';

/** The §4.2 surface APP uses (structurally checked against src/chain/index.ts at the load site). */
export interface ChainApi {
  initChain(cfg: ConfigResponse): void;
  estimateLaunchCost(devBuyLamports: bigint, meta?: { name?: string; symbol?: string; uri?: string; launcher?: string }): Promise<LaunchCostEstimate>;
  launchCoin(input: LaunchInput, signer: WalletSigner, onProgress: OnProgress): Promise<TxOutcome<LaunchValue>>;
  quoteBuy(mint: string, lamportsIn: bigint, slippageBps?: number): Promise<BuyQuote>;
  quoteSell(mint: string, tokensIn: bigint, slippageBps?: number): Promise<SellQuote>;
  buy(q: BuyQuote, signer: WalletSigner, onProgress: OnProgress): Promise<TxOutcome<TradeFill>>;
  sell(q: SellQuote, signer: WalletSigner, onProgress: OnProgress): Promise<TxOutcome<TradeFill>>;
  getVault(placeId: string, mint?: string): Promise<VaultView>;
  requestClaim(
    a: { placeId: string; claimId: string; claimToken: string },
    signer: WalletSigner,
    onProgress: OnProgress,
  ): Promise<TxOutcome<ClaimRequestValue>>;
  finalizeClaim(placeId: string, signer: WalletSigner, onProgress: OnProgress): Promise<TxOutcome<void>>;
  collectAndWithdraw(placeId: string, signer: WalletSigner, onProgress: OnProgress, mint?: string): Promise<TxOutcome<WithdrawValue>>;
  toTxError(e: unknown, ctx: { sent: boolean; signature?: string; walletName?: string }): TxError;
  readonly MAX_PRICE_IMPACT_PCT: number;
}

/** Default slippage (INTEGRATION.md §7.3: `Slippage 2%`). */
export const SLIPPAGE_BPS = 200;
/** Fallback when the chain module isn't loaded yet (same rule as src/chain/constants MAX_PRICE_IMPACT_PCT). */
export const MAX_PRICE_IMPACT_PCT = import.meta.env?.VITE_CLUSTER === 'devnet' ? 60 : 15;

let config: ConfigResponse | null = null;
let loaded: Promise<ChainApi> | null = null;
let ready: ChainApi | null = null;
let initialised = false;

/**
 * The real-data layer hands every fresh `/api/config` here. The chain is initialised on first load
 * and re-initialised on every refresh (initChain is idempotent), so priority fee / pause / claim
 * window changes reach it within a minute.
 */
export function setChainConfig(cfg: ConfigResponse): void {
  config = cfg;
  if (ready) {
    ready.initChain(cfg);
    initialised = true;
  }
}

/** Load + initialise the chain API (memoised; a failed load can be retried). */
export function chain(): Promise<ChainApi> {
  if (!IS_REAL) return Promise.reject(new Error('The chain is not available in demo mode'));
  loaded ??= loadChainModule()
    .then((m) => {
      const api: ChainApi = m;
      ready = api;
      if (!initialised && config) {
        api.initChain(config);
        initialised = true;
      }
      return api;
    })
    .catch((e: unknown) => {
      loaded = null;
      throw e;
    });
  return loaded.then((api) => {
    if (!initialised && config) {
      api.initChain(config);
      initialised = true;
    }
    return api;
  });
}

/** Warm the chain chunk on idle (wallet connected, launch/trade UI opened). */
export function prefetchChain(): void {
  if (IS_REAL) prefetchChainModule();
}

/** Warm the pump SDK chunk (launch Details → Continue, trade box focus). */
export function prefetchPump(): void {
  if (IS_REAL) prefetchPumpModule();
}

/* ------------------------------------------------------------------ wallet */

type GetSigner = () => WalletSigner | null;

/** The connected wallet as a signer, or null (mocked email wallet / no `solana:signTransaction`). */
export function currentSigner(): WalletSigner | null {
  if (!IS_REAL) return null;
  const fn = (wallets as unknown as { getSigner?: GetSigner }).getSigner;
  try {
    return typeof fn === 'function' ? fn() : null;
  } catch {
    return null;
  }
}

/** TxError for "this wallet can't sign here" (final copy, INTEGRATION.md §4.8). */
export function walletUnsupportedError(): TxError {
  return {
    code: 'wallet-unsupported',
    message: "This wallet can't sign here. Try Phantom, Solflare or Backpack.",
    retryable: false,
    sent: false,
  };
}

/** TxError for a failure before anything was sent (chunk load, network). */
export function preSendError(e: unknown): TxError {
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return {
    code: 'network',
    message: offline ? "You're offline. Nothing was sent." : "We couldn't reach the network. Nothing was sent.",
    retryable: true,
    sent: false,
    ...(e instanceof Error && /rate|429/i.test(e.message) ? { code: 'rate-limited', message: 'Too many requests. Wait a few seconds and try again.' } : {}),
  };
}

/** Map anything thrown by a chain call to a TxError, using the chain's own mapper when it's loaded. */
export async function toTxError(e: unknown, ctx: { sent: boolean; signature?: string; walletName?: string }): Promise<TxError> {
  try {
    const api = await chain();
    return api.toTxError(e, ctx);
  } catch {
    return preSendError(e);
  }
}

/* ------------------------------------------------------------------ light reads (no chain chunk) */

/** Wallet SOL balance in lamports (confirmed), through /api/rpc. */
export function getBalance(address: string): Promise<bigint> {
  return rpcGetBalance(address);
}

/** Token-2022 holdings of `owner` (base units), through /api/rpc. */
export function getHoldings(owner: string): Promise<Holding[]> {
  return rpcGetHoldings(owner);
}

/** SOL balance + Token-2022 holdings in one /api/rpc request (batched). */
export function getWallet(owner: string): Promise<{ lamports: bigint; holdings: Holding[] }> {
  return rpcGetWallet(owner);
}
