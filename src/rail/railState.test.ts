// The My coins badge lights only for fees My coins shows as money: dust never lights it next to `$0 available`.
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { coinFromDTO } from '../realdata/mapping';
import { coinDto } from '../realdata/testFixtures';
import { useStore } from '../store';
import type { Coin } from '../types';
import { BADGE_MIN_LAMPORTS, hasBadgeFees, useMyCoinsBadge } from './railState';

const OWNER = 'Owner1111111111111111111111111111111111';
const owned = (waitingLamports: string, solUsd: number | null, n = 1): Coin =>
  coinFromDTO(
    coinDto({
      placeId: `ChIJtestplace000${n}`,
      mint: `Mint${n}`,
      fees: { ...coinDto().fees, waitingLamports },
      owner: { status: 'claimed', owner: OWNER, pendingOwner: null, unlockTs: null, inProbation: false, ownerSince: 1500 },
    }),
    { solUsd, launchPriceLamports: 28 },
  );

function Badge() {
  return h('i', null, String(useMyCoinsBadge()));
}
function badge(): string {
  // server rendering reads zustand's initial state: copy the live one in first
  Object.assign(useStore.getInitialState(), useStore.getState());
  return renderToString(h(Badge)).replace(/<[^>]+>/g, '');
}

beforeEach(() => {
  useStore.setState({ coins: {}, wallet: { address: OWNER, kind: 'email' } });
});

describe('My coins badge', () => {
  it('real coins: at least a cent with SOL/USD, else a lamport floor', () => {
    expect(hasBadgeFees(owned('6', 150))).toBe(false); // dust: My coins reads `$0 available`
    expect(hasBadgeFees(owned('0', 150))).toBe(false);
    expect(hasBadgeFees(owned('66667', 150))).toBe(true); // $0.0100005 → $0.01
    expect(hasBadgeFees(owned('66666', 150))).toBe(false); // $0.0099999 → $0
    expect(hasBadgeFees(owned('6', null))).toBe(false);
    expect(hasBadgeFees(owned(String(BADGE_MIN_LAMPORTS), null))).toBe(true);
    expect(hasBadgeFees(owned(String(BADGE_MIN_LAMPORTS - 1n), null))).toBe(false);
  });

  it('counts only owned shops with money waiting', () => {
    const dust = owned('6', 150, 1);
    const real = owned('1234567890', 150, 2);
    useStore.setState({ coins: { [dust.placeId]: dust } });
    expect(badge()).toBe('0');
    useStore.setState({ coins: { [dust.placeId]: dust, [real.placeId]: real } });
    expect(badge()).toBe('1');
    useStore.setState({ wallet: { address: null, kind: null } });
    expect(badge()).toBe('0');
  });
});
