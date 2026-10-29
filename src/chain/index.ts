/**
 * The heavy chain API (INTEGRATION.md §4.2). Reached ONLY through `loadChain()` (src/chain/load.ts) so web3.js, the
 * shop-vault client and the chain code stay out of the initial bundle; the pump SDK and pump-swap-sdk are further
 * dynamic imports (their own chunks).
 *
 * Every signing function calls `assertRealMode()` first (via `assertCanSign`) and never throws for expected failures:
 * it returns `{ ok: false, error: TxError }`.
 */
import './polyfills';
import { loadPump } from './context';
import { pumpGlobals } from './market';

export { initChain, connection, isInitialised } from './context';
export type { ChainInitOptions } from './context';
export { estimateLaunchCost, launchCoin } from './launch';
export { quoteBuy, quoteSell, buy, sell } from './trade';
export { getVault, requestClaim, finalizeClaim, collectAndWithdraw } from './vault';
export { toTxError } from './errors';
export { MAX_PRICE_IMPACT_PCT } from './constants';

/** Warm the pump SDK chunk and pump Global/FeeConfig (prefetchPump). Never throws. */
export async function preloadPump(): Promise<void> {
  try {
    await loadPump();
    await pumpGlobals();
  } catch {
    /* warming only */
  }
}
