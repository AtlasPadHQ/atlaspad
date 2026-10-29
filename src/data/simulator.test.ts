import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../store';
import { createMockCoins } from './mockCoins';
import { startSimulator } from './simulator';

describe('startSimulator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 7, 12, 0, 0));
    useStore.setState({ coins: {}, trades: {}, feed: [], online: true, selected: { place: null, status: 'idle' } });
    useStore.getState().seedCoins(createMockCoins(150, Date.now()));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('backfills, then trades, launches and stops cleanly', () => {
    const stop = startSimulator();
    const backfilled = useStore.getState().feed.length;
    expect(backfilled).toBeGreaterThan(50);
    const coinsBefore = Object.keys(useStore.getState().coins).length;

    vi.advanceTimersByTime(90_000);
    const s = useStore.getState();
    const trades = s.feed.filter((e) => e.kind === 'trade' && e.ts > Date.UTC(2026, 9, 7, 12, 0, 0));
    expect(trades.length).toBeGreaterThan(40); // ~1 tick / 1.25s, 1–3 trades each
    expect(Object.keys(s.coins).length).toBeGreaterThan(coinsBefore); // at least one fictional launch
    expect(s.feed.some((e) => e.kind === 'launch' && e.placeId.startsWith('demo-sim-'))).toBe(true);
    for (const e of trades) if (e.kind === 'trade') expect(e.sol).toBeLessThanOrEqual(25);
    for (const c of Object.values(s.coins)) {
      expect(Number.isFinite(c.priceUsd) && c.priceUsd > 0).toBe(true);
      expect(c.mint.endsWith('pump')).toBe(true);
    }

    stop();
    const frozen = useStore.getState().feed.length;
    vi.advanceTimersByTime(30_000);
    expect(useStore.getState().feed.length).toBe(frozen);
  });

  it('keeps prices from running away over a long session', () => {
    const stop = startSimulator();
    const start = Object.fromEntries(Object.values(useStore.getState().coins).map((c) => [c.placeId, c.priceUsd]));
    vi.advanceTimersByTime(20 * 60_000);
    for (const c of Object.values(useStore.getState().coins)) {
      const p0 = start[c.placeId];
      if (!p0) continue;
      expect(c.priceUsd / p0).toBeLessThan(20);
      expect(c.priceUsd / p0).toBeGreaterThan(0.05);
    }
    stop();
  });

  it('pauses while offline', () => {
    useStore.setState({ online: false });
    const stop = startSimulator();
    const n = useStore.getState().feed.length;
    vi.advanceTimersByTime(20_000);
    expect(useStore.getState().feed.length).toBe(n);
    stop();
  });
});
