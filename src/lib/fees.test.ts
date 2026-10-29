/**
 * Round-1 QA fixes: money owed is never overstated (INTEGRATION.md §9), and limit messages carry the real wait.
 */
import { describe, expect, it } from 'vitest';
import { coinFromDTO } from '../realdata/mapping';
import { ApiError, limitMessage } from '../realdata/api';
import { coinDto } from '../realdata/testFixtures';
import { feesTotalLabel, feesWaitingTotal } from '../store';
import { usdCompactFloor, waitFor } from './format';

const coin = (placeId: string, waitingLamports: string) =>
  coinFromDTO(coinDto({ placeId, mint: `${placeId}Mint`, fees: { ...coinDto().fees, waitingLamports } }), { solUsd: 110.36, launchPriceLamports: 28 });

describe('fees waiting in view', () => {
  it('sums exact lamports and rounds DOWN once (the QA case: $0.61, not $1.00)', () => {
    const list = [148149, 629195, 296297, 915524, 0, 0, 1777780, 1185187, 592594, 0].map((l, i) => coin(`P${i}`, String(l)));
    const t = feesWaitingTotal(list, 110.36, Date.now());
    expect(t.lamports).toBe(5_544_726n);
    expect(t.usd).toBe(0.61);
    expect(feesTotalLabel(t)).toBe('$0.61');
  });

  it('small sums are shown, never "No fees waiting" (the QA case: $0.22)', () => {
    const list = [1303707, 592594, 148149].map((l, i) => coin(`Q${i}`, String(l)));
    const t = feesWaitingTotal(list, 110.36, Date.now());
    expect(feesTotalLabel(t)).toBe('$0.22');
    expect(feesTotalLabel(feesWaitingTotal([coin('R', '5000')], 110.36, Date.now()))).toBe('<$0.01');
    expect(feesTotalLabel(feesWaitingTotal([coin('S', '0')], 110.36, Date.now()))).toBeNull();
  });

  it('usdCompactFloor never rounds up', () => {
    expect(usdCompactFloor(0.999)).toBe('$0.99');
    expect(usdCompactFloor(9.999)).toBe('$9.99');
    expect(usdCompactFloor(12.9)).toBe('$12');
    expect(usdCompactFloor(1_299)).toBe('$1.2k');
    expect(usdCompactFloor(999_999)).toBe('$999k');
    expect(usdCompactFloor(1_999_999)).toBe('$1.9M');
    expect(usdCompactFloor(0.004)).toBe('<$0.01');
    expect(usdCompactFloor(0)).toBe('$0');
  });
});

describe('limit messages', () => {
  it('waitFor rounds up to a human unit', () => {
    expect(waitFor(39)).toBe('39 seconds');
    expect(waitFor(1)).toBe('1 second');
    expect(waitFor(600)).toBe('10 minutes');
    expect(waitFor(3600)).toBe('60 minutes');
    expect(waitFor(22 * 3600)).toBe('22 hours');
  });

  it("keeps the Worker's reason and uses the real retry-after", () => {
    const e = (message: string, retryAfterSec?: number) => new ApiError(429, { error: 'too_many_attempts', message, ...(retryAfterSec ? { retryAfterSec } : {}) });
    expect(limitMessage(e('Too many calls to this number today.', 22 * 3600))).toBe('Too many calls to this number today. Try again in 22 hours.');
    expect(limitMessage(e('Too many attempts from your network.', 39))).toBe('Too many attempts from your network. Try again in 39 seconds.');
    expect(limitMessage(e('Wait a moment before calling again.', 12))).toBe('Too many attempts. Wait a few seconds and try again.');
    expect(limitMessage(e('Too many attempts for this shop today. Try again tomorrow.'))).toBe('Too many attempts for this shop today. Try again later.');
  });
});
