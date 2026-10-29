import { describe, expect, it } from 'vitest';
import type { CoinDetailDTO, FeedEventDTO } from '../../worker/wire';
import { coinDto, market } from './testFixtures';
import { applyMarket, bboxCovers, coinFromDTO, feedEventFromDTO, launchPriceFromConfig, snapBbox, tradeFromDTO, withUsdRate } from './mapping';

describe('coinFromDTO (INTEGRATION.md §5.3)', () => {
  it('derives USD from the SOL/USD of the same response; fees round down', () => {
    const c = coinFromDTO(coinDto(), { solUsd: 150, launchPriceLamports: 28 });
    expect(c.priceSol).toBeCloseTo(28e-9, 15);
    expect(c.priceUsd).toBeCloseTo(28e-9 * 150, 15);
    expect(c.marketCapUsd).toBeCloseTo(28 * 150, 6);
    expect(c.supply).toBe(1_000_000_000);
    // 1.23456789 SOL × $150 = $185.185… → $185.18 (never rounded up)
    expect(c.real?.feesWaitingUsd).toBe(185.18);
    expect(c.feesEarnedUsd).toBe(185.18);
    expect(c.claimed).toBe(false);
    expect(c.real?.change24hKnown).toBe(false);
    expect(c.real?.holdersKnown).toBe(false);
    expect(c.logo.kind).toBe('upload');
    expect(c.place).toEqual({ id: 'ChIJtestplace0001', source: 'google', location: { lat: 51.5469, lng: -0.0712 }, category: 'kebab', emoji: '🥙' });
  });

  it('maps owner states', () => {
    const pending = coinFromDTO(
      coinDto({ owner: { status: 'pending', owner: null, pendingOwner: 'Owner1111111111111111111111111111111111', unlockTs: 2000, inProbation: false, ownerSince: null } }),
      { solUsd: 150, launchPriceLamports: 28 },
    );
    expect(pending.claimPending).toBe(true);
    expect(pending.claimed).toBe(false);
    const owned = coinFromDTO(
      coinDto({ owner: { status: 'claimed', owner: 'Owner1111111111111111111111111111111111', pendingOwner: null, unlockTs: null, inProbation: false, ownerSince: 1500 } }),
      { solUsd: 150, launchPriceLamports: 28 },
    );
    expect(owned.claimed).toBe(true);
    expect(owned.ownerVerified).toBe(true);
    expect(owned.owner).toBe('Owner1111111111111111111111111111111111');
    expect(owned.claimedAt).toBe(1_500_000);
  });

  it('uses the detail history (lamports → USD) and keeps it on later list rows', () => {
    const detail: CoinDetailDTO = { ...coinDto(), trades: [], history: [28, 30, 32], historyAt: 900, ticks: [30, 32], tickTimes: [800, 900] };
    const c = coinFromDTO(detail, { solUsd: 100, launchPriceLamports: 28 });
    expect(c.history.length).toBe(3);
    expect(c.history[0]).toBeCloseTo(28e-9 * 100, 15);
    expect(c.history[2]).toBeCloseTo(c.priceUsd, 15); // last bucket = live price
    expect(c.ticks).toHaveLength(2);
    expect(c.real?.historyKnown).toBe(true);
    const later = coinFromDTO(coinDto(), { solUsd: 100, launchPriceLamports: 28 }, c);
    expect(later.history).toBe(c.history);
    expect(later.real?.historyKnown).toBe(true);
  });

  it('a list row at a new SOL/USD re-expresses the kept history and ticks, so the last point meets the price', () => {
    const detail: CoinDetailDTO = { ...coinDto(), trades: [], history: [28, 30, 32], historyAt: 900, ticks: [30, 28], tickTimes: [800, 900] };
    const c = coinFromDTO(detail, { solUsd: 100, launchPriceLamports: 28 });
    const later = coinFromDTO(coinDto(), { solUsd: 120, launchPriceLamports: 28 }, c);
    expect(later.priceUsd).toBeCloseTo(28e-9 * 120, 15);
    expect(later.history.map((p) => p / 1.2)).toEqual(c.history.map((p) => expect.closeTo(p, 15)));
    expect(later.history[later.history.length - 1]).toBeCloseTo(later.priceUsd, 15);
    expect(later.ticks[later.ticks.length - 1]).toBeCloseTo(later.priceUsd, 15);
    expect(later.ticks[0]).toBeCloseTo(30e-9 * 120, 15);
    expect(later.historyAt).toBe(c.historyAt);
    expect(later.tickTimes).toEqual(c.tickTimes);
    // no SOL/USD in the response: the coin's own rate, nothing rescaled
    const noRate = coinFromDTO(coinDto(), { solUsd: null, launchPriceLamports: 28 }, c);
    expect(noRate.history).toBe(c.history);
    expect(noRate.ticks).toBe(c.ticks);
  });

  it('applyMarket: same object when nothing changed; ticks on price moves', () => {
    const c = coinFromDTO(coinDto(), { solUsd: 150, launchPriceLamports: 28 });
    expect(applyMarket(c, market(), 150)).toBe(c);
    const moved = applyMarket(c, market({ priceLamports: 35, realSol: '100000000', at: 2_000, change24hPct: 25 }), 150);
    expect(moved).not.toBe(c);
    expect(moved.priceSol).toBeCloseTo(35e-9, 15);
    expect(moved.ticks.length).toBe(c.ticks.length + 1);
    expect(moved.change24h).toBe(25);
    expect(moved.real?.realSolLamports).toBe('100000000');
    expect(moved.real?.change24hKnown).toBe(true);
    // a quote read from chain BEFORE what the coin shows (Worker cache, ≤ 6 s) never rolls it back
    const older = applyMarket(moved, market({ priceLamports: 30, realSol: '90000000', at: 1_500 }), 150);
    expect(older).toBe(moved);
  });

  it('withUsdRate rescales USD fields at a new SOL/USD and floors fees', () => {
    const c = coinFromDTO(coinDto(), { solUsd: 150, launchPriceLamports: 28 });
    const r = withUsdRate(c, 200);
    expect(r.priceUsd).toBeCloseTo(c.priceSol * 200, 15);
    expect(r.real?.feesWaitingUsd).toBe(246.91); // 1.23456789 × 200 = 246.913… → 246.91
    expect(withUsdRate(r, 200)).toBe(r);
  });

  it('launch price from the pump Global initial reserves (bigint maths)', () => {
    const p = launchPriceFromConfig({
      curve: { initialVirtualTokenReserves: '1073000000000000', initialVirtualQuoteReserves: '30000000000', initialRealTokenReserves: '793100000000000', tokenTotalSupply: '1000000000000000' },
    });
    expect(p).toBeCloseTo(27.958993, 6); // 30e9 × 1e6 / 1.073e15
  });
});

describe('feed / trade rows', () => {
  it('trade rows keep the real signature (explorer links)', () => {
    const t = tradeFromDTO(
      { id: 'sig9:0', sig: 'sig9', mint: 'M', placeId: 'P', side: 'buy', solLamports: '100000000', userLamports: null, tokens: '2360000000000', trader: 'Me', priceLamports: 30, venue: 'curve', ts: 5 },
      'KEBAB',
      150,
      'Me',
    );
    expect(t).toMatchObject({ id: 'sig9:0', signature: 'sig9', sol: 0.1, tokens: 2_360_000, usd: 15, real: true, isUser: true });
  });

  it('trade rows show what the trader paid / received (fees included) when known', () => {
    // a 0.1 SOL buy puts 98,765,431 lamports into the curve; the trader paid 100,000,000
    const buy = tradeFromDTO(
      { id: 's:0', sig: 's', mint: 'M', placeId: 'P', side: 'buy', solLamports: '98765431', userLamports: '100000000', tokens: '1', trader: 'T', priceLamports: 1, venue: 'curve', ts: 1 },
      'K',
      100,
    );
    expect(buy).toMatchObject({ sol: 0.1, lamports: '100000000' });
    // a sell: the curve paid 19,753,084 but the trader received 19,506,170 after pump's fees
    const sell = tradeFromDTO(
      { id: 's:1', sig: 's', mint: 'M', placeId: 'P', side: 'sell', solLamports: '19753084', userLamports: '19506170', tokens: '1', trader: 'T', priceLamports: 1, venue: 'curve', ts: 1 },
      'K',
      100,
    );
    expect(sell.lamports).toBe('19506170');
  });

  it('feed events map every kind', () => {
    const base = { id: 'x', ts: 1, mint: 'M', placeId: 'P', ticker: 'K', name: 'N', emoji: 'e', bg: '#fff' };
    const trade = feedEventFromDTO({ ...base, kind: 'trade', side: 'sell', solLamports: '2500000000', tokens: '1', wallet: 'W', sig: 's' } as FeedEventDTO, 100);
    expect(trade).toMatchObject({ kind: 'trade', side: 'sell', sol: 2.5, usd: 250, signature: 's' });
    // an ownership request moves no money: no amount, even if a stale producer sent one
    const claim = feedEventFromDTO({ ...base, kind: 'claim', stage: 'requested', wallet: 'W', feesLamports: null, sig: null } as FeedEventDTO, 100);
    expect(claim).toMatchObject({ kind: 'claim', stage: 'requested', usd: 0 });
    expect(claim).not.toHaveProperty('lamports');
    const stale = feedEventFromDTO({ ...base, kind: 'claim', stage: 'finalized', wallet: 'W', feesLamports: '1999999999', sig: null } as FeedEventDTO, 100);
    expect(stale).toMatchObject({ kind: 'claim', stage: 'finalized', usd: 0 });
    // a payout carries the exact withdrawn lamports, USD rounded down
    const paid = feedEventFromDTO({ ...base, kind: 'claim', stage: 'withdrawn', wallet: 'W', feesLamports: '1999999999', sig: 'S' } as FeedEventDTO, 100);
    expect(paid).toMatchObject({ kind: 'claim', stage: 'withdrawn', usd: 199.99, lamports: '1999999999', signature: 'S' });
  });
});

describe('viewport bbox keys', () => {
  it('snaps outward to 0.01° and detects covering boxes', () => {
    const k = snapBbox({ west: -0.0995, south: 51.5361, east: -0.0431, north: 51.5579 });
    expect(k).toBe('-0.10,51.53,-0.04,51.56');
    expect(bboxCovers(k, snapBbox({ west: -0.09, south: 51.54, east: -0.05, north: 51.55 }))).toBe(true);
    expect(bboxCovers(k, snapBbox({ west: -0.2, south: 51.54, east: -0.05, north: 51.55 }))).toBe(false);
  });
});
