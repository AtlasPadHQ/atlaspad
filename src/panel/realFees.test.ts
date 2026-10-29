// Server-render checks for the real-mode Fees card at mainnet scale (no DOM here): long countdowns read in days and
// hours, and sub-cent fees never read "$0". The live vault read (and so the withdraw-cost guard) runs in an effect,
// which SSR skips: tx.ts withdrawLossWarning and chain/vault.test.ts cover that part.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../mode', async (importOriginal) => ({ ...(await importOriginal<typeof import('../mode')>()), BUILD_CLUSTER: 'mainnet', APP_MODE: 'real', IS_REAL: true, CLUSTER: 'mainnet' }));
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  const hook = ((sel: (s: ReturnType<typeof actual.useStore.getState>) => unknown) => sel(actual.useStore.getState())) as unknown as typeof actual.useStore;
  Object.assign(hook, actual.useStore);
  return { ...actual, useStore: hook };
});

import { coinFromDTO } from '../realdata/mapping';
import { coinDto } from '../realdata/testFixtures';
import { useStore } from '../store';
import type { CoinDTO } from '../../worker/wire';
import { RealFeeMini, RealFeesCard } from './RealFees';
import type { OwnerState } from './util';

const OWNER = 'Owner1111111111111111111111111111111111';
const H = 3600;

function coin(over: Partial<CoinDTO>) {
  return coinFromDTO(coinDto(over), { solUsd: 200, launchPriceLamports: 28 });
}
function html(c: ReturnType<typeof coin>, owner: OwnerState, mini = false): string {
  useStore.setState({ solUsd: 200, solUsdAt: Date.now() });
  return renderToStaticMarkup(createElement(mini ? RealFeeMini : RealFeesCard, { coin: c, owner }));
}
const pending = (unlockTs: number, inProbation = false): Partial<CoinDTO> => ({
  owner: { status: 'pending', owner: null, pendingOwner: OWNER, unlockTs, inProbation, ownerSince: null },
});

describe('RealFeesCard at mainnet scale', () => {
  it('a 72-hour public window counts down in days and hours, never m:ss', () => {
    const now = Math.floor(Date.now() / 1000);
    const card = html(coin(pending(now + 71 * H + 59 * 60 + 30)), 'pending');
    expect(card).toContain('unlocks in 2 d 23 h.');
    expect(card).not.toMatch(/\d{3,}:\d\d/);
    expect(html(coin(pending(now + 71 * H + 59 * 60 + 30)), 'pending', true)).toContain('Claim pending · 2 d 23 h');
  });

  it('a claim requested in a 7-day probation (probation + window) reads "9 d 23 h"', () => {
    const now = Math.floor(Date.now() / 1000);
    const card = html(coin(pending(now + 10 * 24 * H - H, true)), 'pending');
    expect(card).toContain('unlocks in 9 d 23 h (longer: our signing key changed recently)');
  });

  it('the last minutes read "m s"', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(html(coin(pending(now + 59 * 60 + 12)), 'pending')).toMatch(/unlocks in 59 m 1[12] s\./);
  });

  it('sub-cent fees read <$0.01 and their exact SOL, never $0 or 0 SOL', () => {
    const fees = { earnedLamports: '1000', waitingLamports: '1000', withdrawableNowLamports: '1000', collectableLamports: '0', withdrawnLamports: '0', at: 1 };
    const unclaimed = html(coin({ fees }), 'unclaimed');
    expect(unclaimed).toContain('&lt;$0.01</b> waiting for this shop');
    expect(unclaimed).toContain('≈ 0.000001 SOL');
    const yours = html(coin({ fees, owner: { status: 'claimed', owner: OWNER, pendingOwner: null, unlockTs: null, inProbation: false, ownerSince: 1 } }), 'yours');
    expect(yours).toContain('Withdraw &lt;$0.01');
    expect(yours).not.toContain('$0<');
  });

  it('10 SOL of fees', () => {
    const fees = { earnedLamports: '10000000000', waitingLamports: '10000000000', withdrawableNowLamports: '0', collectableLamports: '10000000000', withdrawnLamports: '0', at: 1 };
    const card = html(coin({ fees }), 'unclaimed');
    expect(card).toContain('$2,000</b> waiting for this shop');
    expect(card).toContain('≈ 10 SOL');
  });
});
