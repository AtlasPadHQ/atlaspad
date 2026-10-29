/**
 * Cluster-aware explorer links for real mode (INTEGRATION.md §7.6). Thin wrapper over CHAIN's light
 * `src/chain/explorer` (Solscan, `?cluster=devnet` on devnet, `/api/config` templates when loaded),
 * so links work before the heavy chain chunk is loaded.
 */
import type { ConfigResponse } from '../../worker/wire';
import { explorerAddress, explorerToken, explorerTx, setExplorerTemplates } from '../chain/explorer';
import { BUILD_CLUSTER, IS_REAL } from '../mode';

export { explorerAddress, explorerToken, explorerTx };

let cluster: ConfigResponse['cluster'] | null = null;

/** Called by the real-data layer whenever /api/config loads. */
export function setExplorerConfig(c: Pick<ConfigResponse, 'explorer' | 'cluster'> | null): void {
  cluster = c?.cluster ?? null;
  if (c) setExplorerTemplates(c.explorer);
}

/** DexScreener and pump.fun don't support devnet (INTEGRATION.md §7.6): hide those rows there. */
export function thirdPartyCoinLinksSupported(): boolean {
  if (!IS_REAL) return true;
  return (cluster ?? BUILD_CLUSTER) === 'mainnet';
}
