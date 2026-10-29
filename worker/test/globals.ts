/**
 * Compile-time constants for unit tests (wrangler `define` is not applied under vitest). Import this FIRST in a test
 * file that exercises real-mode routes; tests model the devnet build (dev endpoints compiled in) unless they override.
 */
const g = globalThis as unknown as { __CS_CLUSTER__?: string; __CS_DEV_ENDPOINTS__?: boolean };
g.__CS_CLUSTER__ = 'devnet';
g.__CS_DEV_ENDPOINTS__ = true;

export function setBuild(cluster: 'demo' | 'devnet' | 'mainnet', devEndpoints: boolean): void {
  g.__CS_CLUSTER__ = cluster;
  g.__CS_DEV_ENDPOINTS__ = devEndpoints;
}
