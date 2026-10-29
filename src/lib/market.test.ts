import { describe, expect, it } from 'vitest';
import { fakeMint, fakeWallet, isValidSolanaAddress } from './fakeSolana';
import { buildCoin, launchPriceUsd, quoteBuy, quoteSell, seriesFor, withPrice } from './market';
import { categoryFromGoogle, categoryFromOsm, chipFromQuery } from './categories';

describe('fake Solana identifiers', () => {
  it('mints are 44-char base58 ending in "pump" that decode to 32 bytes, deterministically', () => {
    const m = fakeMint('demo-kebab');
    expect(m).toHaveLength(44);
    expect(m.endsWith('pump')).toBe(true);
    expect(isValidSolanaAddress(m)).toBe(true);
    expect(fakeMint('demo-kebab')).toBe(m);
    expect(isValidSolanaAddress('BkT7yM3cQ9xX1rLqTzF4nH8pVwJdUe2sGa5KcR6tpump')).toBe(true);
  });
  it('wallets are valid base58 addresses', () => {
    const w = fakeWallet('x');
    expect(isValidSolanaAddress(w)).toBe(true);
    expect(isValidSolanaAddress('0xabc')).toBe(false);
    expect(isValidSolanaAddress('not a wallet at all, sorry')).toBe(false);
  });
});

describe('constant-product quotes', () => {
  const coin = buildCoin(
    {
      placeId: 'demo-test',
      place: { id: 'demo-test', source: 'demo', location: { lat: 51.5, lng: -0.07 }, category: 'kebab', emoji: '🥙' },
      ticker: 'TEST',
      name: 'Test',
      logo: { kind: 'sticker', emoji: '🥙', bg: '#ffe4cc' },
      launchedAt: 0,
      marketCapUsd: 212_000,
      change24h: 12.4,
    },
    150,
  );
  it('buys raise the price, sells lower it', () => {
    const b = quoteBuy(coin, 1, 150);
    expect(b.priceAfter).toBeGreaterThan(coin.priceUsd);
    expect(b.tokens).toBeGreaterThan(0);
    const s = quoteSell(coin, b.tokens, 150);
    expect(s.priceAfter).toBeLessThan(coin.priceUsd);
  });
  it('a small buy on a $212k coin moves the price about 1%', () => {
    const b = quoteBuy(coin, 1, 150);
    expect(b.impactPct).toBeGreaterThan(0.5);
    expect(b.impactPct).toBeLessThan(2);
    expect(b.feeUsd).toBeCloseTo(150 * 0.005, 6);
  });
  it('chart series end at the current price', () => {
    for (const r of ['1h', '24h', '7d', 'all'] as const) {
      const s = seriesFor(coin, r, 1_000_000_000_000);
      expect(s.prices.at(-1)).toBe(coin.priceUsd);
      expect(s.prices.length).toBe(s.times.length);
      expect(s.prices.every((p) => p > 0)).toBe(true);
    }
  });
});

describe('category mapping', () => {
  it('maps Google types', () => {
    expect(categoryFromGoogle('coffee_shop')).toBe('cafe');
    expect(categoryFromGoogle('turkish_restaurant')).toBe('kebab');
    expect(categoryFromGoogle(null, ['point_of_interest', 'pizza_restaurant'])).toBe('pizza');
    expect(categoryFromGoogle('thai_restaurant')).toBe('restaurant');
    expect(categoryFromGoogle('museum')).toBe('other');
  });
  it('maps OSM tags with name hints', () => {
    expect(categoryFromOsm('shop', 'hairdresser')).toBe('barber');
    expect(categoryFromOsm('fast_food', 'fast_food', 'Best Kebab')).toBe('kebab');
    expect(categoryFromOsm('shop', 'convenience')).toBe('corner');
  });
  it('detects category queries', () => {
    expect(chipFromQuery('kebab')).toBe('kebab');
    expect(chipFromQuery('bar')).toBe('pub');
    expect(chipFromQuery('coffee near me')).toBe('cafe');
    expect(chipFromQuery('xy')).toBeNull();
  });
});

describe('chart ranges are clipped to the coin\'s life', () => {
  const T0 = 1_800_000_000_000;
  const fresh = () =>
    buildCoin(
      {
        placeId: 'demo-young',
        place: { id: 'demo-young', source: 'demo', location: { lat: 51.5, lng: -0.07 }, category: 'kebab', emoji: '🥙' },
        ticker: 'YOUNG',
        name: 'Young',
        logo: { kind: 'sticker', emoji: '🥙', bg: '#ffe4cc' },
        launchedAt: T0,
        historyAt: T0,
      },
      150,
    );

  it('a 3-minute-old coin shows the same lifetime for 1H, 24H, 7D and All', () => {
    let coin = fresh();
    for (let i = 1; i <= 30; i++) coin = withPrice(coin, coin.priceUsd * (1 + (i % 3 === 0 ? -0.01 : 0.04)), 150, T0 + i * 6000);
    const now = T0 + 3 * 60_000;
    const all = seriesFor(coin, 'all', now);
    for (const r of ['1h', '24h', '7d'] as const) {
      const s = seriesFor(coin, r, now);
      expect(s.times[0]).toBe(T0);
      expect(s.prices).toEqual(all.prices);
      expect(s.changePct).toBeCloseTo(all.changePct, 9);
    }
    expect(all.prices[0]).toBeCloseTo(launchPriceUsd(), 12);
    expect(all.times.every((t) => t >= T0)).toBe(true);
    // the 24H label (coin.change24h) agrees with the chart for a coin younger than a day
    expect(coin.change24h).toBeCloseTo(all.changePct, 6);
  });

  it('never starts before the launch for a 3-day-old coin; 7D equals All', () => {
    const coin = { ...buildCoin({ placeId: 'demo-old', place: { id: 'demo-old', source: 'demo', location: { lat: 51.5, lng: -0.07 }, category: 'pub', emoji: '🍺' }, ticker: 'OLD', name: 'Old', logo: { kind: 'sticker', emoji: '🍺', bg: '#fff1c7' }, launchedAt: T0 - 3 * 86_400_000, historyAt: T0, marketCapUsd: 63_000, change24h: 1.8 }, 150) };
    const d7 = seriesFor(coin, '7d', T0);
    const all = seriesFor(coin, 'all', T0);
    expect(d7.prices).toEqual(all.prices);
    expect(d7.times[0]).toBe(coin.launchedAt);
    const d1 = seriesFor(coin, '24h', T0);
    expect(d1.times[0]).toBe(T0 - 86_400_000);
    expect(d1.changePct).toBeCloseTo(coin.change24h, 6);
  });

  it('rolls the 24h history forward as time passes', () => {
    let coin = fresh();
    const p0 = coin.priceUsd;
    coin = withPrice(coin, p0 * 2, 150, T0 + 1000);
    coin = withPrice(coin, p0 * 3, 150, T0 + 25 * 3_600_000);
    // a day later the launch price has rolled out of the 24h window
    expect(coin.history[0]).toBeCloseTo(p0 * 2, 12);
    expect(coin.change24h).toBeCloseTo(50, 6);
    expect(coin.tickTimes).toEqual([T0 + 1000, T0 + 25 * 3_600_000]);
  });
});
