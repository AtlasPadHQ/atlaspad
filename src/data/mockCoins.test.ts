import { describe, expect, it } from 'vitest';
import { CREATOR_FEE_RATE, LIMITS } from '../config';
import { isValidSolanaAddress } from '../lib/fakeSolana';
import { TICKER_RE } from '../lib/ticker';
import { createRng } from '../lib/rand';
import { createDemoPlaces, createMockActivity, createMockCoins, getDemoPlace, MOCK_PARITY_IDS, tradeSizeSol } from './mockCoins';

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

describe('createMockCoins', () => {
  const coins = createMockCoins(150, NOW);
  const byTicker = Object.fromEntries(coins.map((c) => [c.ticker, c]));

  it('seeds ~40 fictional shops with unique ids, tickers and mints', () => {
    expect(coins.length).toBeGreaterThanOrEqual(38);
    expect(new Set(coins.map((c) => c.placeId)).size).toBe(coins.length);
    expect(new Set(coins.map((c) => c.ticker)).size).toBe(coins.length);
    expect(new Set(coins.map((c) => c.mint)).size).toBe(coins.length);
    for (const c of coins) {
      expect(c.placeId.startsWith('demo-')).toBe(true);
      expect(c.place.source).toBe('demo');
      expect(TICKER_RE.test(c.ticker)).toBe(true);
      expect(c.mint).toHaveLength(44);
      expect(c.mint.endsWith('pump')).toBe(true);
      expect(isValidSolanaAddress(c.launcher)).toBe(true);
      expect(c.place.demo?.website.endsWith('.example')).toBe(true);
    }
  });

  it('keeps the DESIGN §19.2 mock values for the Dalston coins', () => {
    const k = byTicker.KEBAB!;
    expect(k.name).toBe('Bosphorus Grill');
    expect(k.mint).toBe('BkT7yM3cQ9xX1rLqTzF4nH8pVwJdUe2sGa5KcR6tpump');
    expect(Math.round(k.marketCapUsd)).toBe(212_000);
    expect(k.priceUsd).toBeCloseTo(0.000212, 9);
    expect(k.change24h).toBeCloseTo(12.4, 1);
    expect(k.feesEarnedUsd).toBe(1240);
    expect(k.holders).toBe(1284);
    expect(k.claimed).toBe(false);
    expect(byTicker.CROW!.claimed).toBe(true);
    expect(byTicker.CROW!.ownerVerified).toBe(true);
    expect(MOCK_PARITY_IDS.size).toBe(8);
    for (const t of ['KEBAB', 'BEAN', 'FADE', 'PEPI', 'CROW', 'LATE', 'NOODL', 'SIMIT', 'SLATE']) expect(byTicker[t]).toBeTruthy();
  });

  it('spans a power-law range of market caps and is ~25% owner-verified', () => {
    const mcaps = coins.map((c) => c.marketCapUsd);
    expect(Math.min(...mcaps)).toBeGreaterThanOrEqual(3_000 * 0.99);
    expect(Math.max(...mcaps)).toBeLessThanOrEqual(2_400_000 * 1.01);
    expect(Math.max(...mcaps)).toBeGreaterThan(2_000_000);
    const share = coins.filter((c) => c.claimed).length / coins.length;
    expect(share).toBeGreaterThan(0.18);
    expect(share).toBeLessThan(0.32);
  });

  it('has 48-point histories consistent with the 24h change', () => {
    for (const c of coins) {
      expect(c.history).toHaveLength(LIMITS.history);
      expect(c.history[c.history.length - 1]).toBeCloseTo(c.priceUsd, 12);
      const first = c.history[0]!;
      expect(((c.priceUsd / first - 1) * 100)).toBeCloseTo(c.change24h, 4);
      for (const p of c.history) expect(p).toBeGreaterThan(0);
    }
  });

  it('derives fees from volume for the non-mock coins', () => {
    for (const c of coins) {
      if (MOCK_PARITY_IDS.has(c.placeId)) continue;
      const days = Math.max((NOW - c.launchedAt) / 86_400_000, 0.01);
      // fees = rate × cumulative volume, cumulative ≈ 0.45–0.75 × 24h volume × days (+ launch jitter)
      expect(c.feesEarnedUsd).toBeLessThanOrEqual(c.volume24h * days * 0.8 * CREATOR_FEE_RATE + 1);
      expect(c.feesEarnedUsd).toBeGreaterThanOrEqual(0);
      if (c.claimed) expect(c.feesClaimedUsd).toBe(c.feesEarnedUsd);
    }
  });

  it('uses only fiction-reserved phone numbers (or none)', () => {
    for (const c of coins) {
      const phone = c.place.demo?.phone ?? '';
      if (!phone) continue;
      expect(/^(020 7946 0\d{3}|0161 496 0\d{3}|\(\d{3}\) 555-01\d{2}|\(02\) 5550 \d{4})$/.test(phone)).toBe(true);
    }
  });

  it('gives two coins a launch inside the last hour (rail badge on first visit)', () => {
    expect(coins.filter((c) => NOW - c.launchedAt < 3_600_000).length).toBe(2);
  });
});

describe('createMockActivity', () => {
  it('backfills trades, launch and claim events consistent with lastTradeAt', () => {
    const coins = createMockCoins(150, NOW);
    const { trades, feed } = createMockActivity(coins, NOW);
    expect(trades.length).toBeGreaterThan(coins.length * 2);
    expect(feed.some((e) => e.kind === 'launch')).toBe(true);
    expect(feed.some((e) => e.kind === 'claim')).toBe(true);
    for (const c of coins) {
      const latest = trades.filter((t) => t.placeId === c.placeId).sort((a, b) => b.ts - a.ts)[0];
      if (latest) expect(latest.ts).toBe(c.lastTradeAt);
    }
    for (const t of trades) {
      expect(t.sol).toBeGreaterThan(0);
      expect(t.ts).toBeLessThanOrEqual(NOW);
    }
  });
});

describe('tradeSizeSol', () => {
  it('stays within 0.05–25 SOL with a fat tail', () => {
    const rng = createRng('sizes');
    const xs = Array.from({ length: 5000 }, () => tradeSizeSol(rng));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0.05);
    expect(Math.max(...xs)).toBeLessThanOrEqual(25);
    expect(xs.filter((x) => x >= 5).length).toBeGreaterThan(20);
    const median = [...xs].sort((a, b) => a - b)[2500]!;
    expect(median).toBeGreaterThan(0.15);
    expect(median).toBeLessThan(1);
  });
});

describe('demo places', () => {
  it('resolves the unlaunched demo place and seeded coins', () => {
    const coins = Object.fromEntries(createMockCoins(150, NOW).map((c) => [c.placeId, c]));
    expect(createDemoPlaces()[0]?.name).toBe('Crumb & Co. Bakery');
    expect(getDemoPlace('demo-crumb')?.source).toBe('demo');
    expect(getDemoPlace('demo-kebab', coins)?.name).toBe('Bosphorus Grill');
    expect(getDemoPlace('demo-nope', coins)).toBeNull();
  });
});
