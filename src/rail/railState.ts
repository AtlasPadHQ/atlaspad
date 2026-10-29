/**
 * Shared state for the desktop rail and the mobile drawer (DESIGN §6.1, §6.9).
 * OWNED BY RAIL+FEED.
 */
import { useTicker } from '../feed/useTicker';
import { u64 } from '../realdata/units';
import { feedHealth, isOwner, launchedUnseenCount, useStore } from '../store';
import type { Coin, PanelMode } from '../types';

export type RailMode = Extract<PanelMode, 'live' | 'top' | 'launched' | 'mine'>;

export const RAIL_ITEMS: readonly { mode: RailMode; icon: string; label: string }[] = [
  { mode: 'live', icon: 'bolt', label: 'Live' },
  { mode: 'top', icon: 'leaderboard', label: 'Top shops' },
  { mode: 'launched', icon: 'rocket_launch', label: 'Launched' },
  { mode: 'mine', icon: 'account_balance_wallet', label: 'My coins' },
];

/** Launches since the user last opened Launched (excludes their own). */
export function useLaunchedBadge(): number {
  return useStore((s) => launchedUnseenCount(s.coins, s.launchedSeenAt, s.wallet.address));
}

/** Without a SOL/USD rate, fees under this many lamports (0.00001 SOL) are dust, not worth a badge. */
export const BADGE_MIN_LAMPORTS = 10_000n;

/**
 * Fees worth the My coins badge. Real mode: what the owner can still withdraw, only when My coins shows money for it
 * (at least a cent, or BADGE_MIN_LAMPORTS while there is no SOL/USD), so dust never lights it next to `$0 available`.
 * Demo: everything follows the claim.
 */
export function hasBadgeFees(c: Coin): boolean {
  if (!c.real) return c.feesEarnedUsd > 0;
  return c.real.usdRate > 0 ? c.real.feesWaitingUsd > 0 : u64(c.real.feesWaitingLamports) >= BADGE_MIN_LAMPORTS;
}

/** My coins amber badge: shops the connected wallet owns that have fees for the owner. */
export function useMyCoinsBadge(): number {
  return useStore((s) => {
    const a = s.wallet.address;
    if (!a) return 0;
    let n = 0;
    for (const c of Object.values(s.coins)) if (isOwner(c, a) && hasBadgeFees(c)) n++;
    return n;
  });
}

/** Feed health for live dots, re-evaluated every 5s so a stall shows even without new data. */
export function useLiveHealth(): 'live' | 'paused' | 'stalled' {
  useTicker(5000);
  const simLastTickAt = useStore((s) => s.simLastTickAt);
  const online = useStore((s) => s.online);
  return feedHealth({ simLastTickAt, online });
}

export function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n);
}

/** Active rail panel (none while the side panel is collapsed). */
export function useActivePanel(): PanelMode {
  return useStore((s) => (s.panelCollapsed ? 'none' : s.panel));
}
