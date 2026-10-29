/**
 * React hooks over the real-data layer. All of them are inert in demo mode.
 */
import { useEffect, useState } from 'react';
import type { ConfigResponse } from '../../worker/wire';
import { CLUSTER, IS_REAL } from '../mode';
import { useStore } from '../store';
import type { TxKind, TxState } from '../types';
import { holdWalletPolling, usdFresh } from './index';

/** While mounted (and a wallet is connected), re-read balance + holdings every 30 s (§5.2). */
export function useWalletPolling(enabled = true): void {
  const address = useStore((s) => s.wallet.address);
  useEffect(() => {
    if (!IS_REAL || !enabled || !address) return;
    return holdWalletPolling();
  }, [enabled, address]);
}

/** The loaded `/api/config` (null in demo mode or before it loaded). */
export function useChainConfig(): ConfigResponse | null {
  return useStore((s) => s.chain.config);
}

/** Devnet build in real mode (network chip, faucet links, on-screen codes). */
export const IS_DEVNET = IS_REAL && CLUSTER === 'devnet';

/** The store's tx when it belongs to this flow (kind + place), else null. */
export function useTx(kind: TxKind | readonly TxKind[], placeId: string | null | undefined): TxState | null {
  return useStore((s) => {
    const t = s.tx;
    if (!t || !placeId || t.placeId !== placeId) return null;
    return (typeof kind === 'string' ? t.kind === kind : kind.includes(t.kind)) ? t : null;
  });
}

/** Seconds left until `unixSecs` (chain clock), ticking every second; 0 when passed. */
export function useCountdown(unixSecs: number | null | undefined): number {
  const target = unixSecs ? unixSecs * 1000 : 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!target || target <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [target]);
  return target ? Math.max(0, Math.ceil((target - now) / 1000)) : 0;
}

/** USD is shown only while SOL/USD is fresh (≤ 10 min); otherwise SOL only (INTEGRATION.md §9). */
export function useUsdFresh(): boolean {
  const at = useStore((s) => s.solUsdAt);
  const [, force] = useState(0);
  useEffect(() => {
    if (!IS_REAL) return;
    const t = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  return usdFresh({ solUsdAt: at });
}
