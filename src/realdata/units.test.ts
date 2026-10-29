import { describe, expect, it } from 'vitest';
import { formatUnits, lamportsToSol, lamportsToUsdFloor, parseSol, parseTokens, pctOf, solCeil, solCeilSig, solFloor, solFloorSig, u64, unitsToTokens } from './units';
import { shortfall, withdrawLossWarning, withdrawToast } from './tx';
import { formatWindow } from '../claim/window';

describe('real-mode money units (INTEGRATION.md §9)', () => {
  it('parses SOL / token strings to exact base units, no floats', () => {
    expect(parseSol('0.1')).toBe(100_000_000n);
    expect(parseSol('1')).toBe(1_000_000_000n);
    expect(parseSol('0.000000001')).toBe(1n);
    expect(parseSol('0,5')).toBe(500_000_000n);
    expect(parseSol('0.0000000001')).toBeNull(); // > 9 dp
    expect(parseSol('abc')).toBeNull();
    expect(parseSol('')).toBeNull();
    expect(parseTokens('1234.5')).toBe(1_234_500_000n);
    expect(parseTokens('0.0000001')).toBeNull(); // > 6 dp
    // 0.1 + 0.2 style float traps do not exist in bigint parsing
    expect(parseSol('0.3')).toBe(300_000_000n);
  });

  it('u64 accepts only clean decimal strings', () => {
    expect(u64('18446744073709551615')).toBe(18446744073709551615n);
    expect(u64('-1')).toBe(0n);
    expect(u64('1e9')).toBe(0n);
    expect(u64(undefined)).toBe(0n);
  });

  it('rounds money owed DOWN and costs UP', () => {
    expect(solFloor(123_456_789n, 4)).toBe('0.1234');
    expect(solCeil(123_456_789n, 4)).toBe('0.1235');
    expect(solCeil(100_000_000n, 4)).toBe('0.1');
    expect(solFloor(0n, 4)).toBe('0');
    expect(formatUnits(1_500_000_000n, 9)).toBe('1.5');
    // $ owed to a shop: 1.23456789 SOL × $150.129 = $185.344... → $185.34 (never $185.35)
    expect(lamportsToUsdFloor(1_234_567_890n, 150.129)).toBe(185.34);
    expect(lamportsToUsdFloor('5', 150)).toBe(0);
    expect(lamportsToUsdFloor(1_000_000_000n, null)).toBe(0);
  });

  it('display conversions keep precision for large values', () => {
    expect(lamportsToSol(1_000_000_001n)).toBeCloseTo(1.000000001, 9);
    expect(unitsToTokens('1000000000000000')).toBe(1_000_000_000);
  });

  it('sell 100% is the exact raw holding; other % round down', () => {
    const held = 123_456_789_123n;
    expect(pctOf(held, 100)).toBe(held);
    expect(pctOf(held, 50)).toBe(61_728_394_561n);
    expect(pctOf(held, 25)).toBe(30_864_197_280n);
    expect(pctOf(held, 0)).toBe(0n);
  });

  it('insufficient SOL: balance must cover cost + 0.005 SOL', () => {
    expect(shortfall(100_000_000n, '105000000')).toBeNull();
    const s = shortfall(100_000_000n, '104999999');
    expect(s).not.toBeNull();
    expect(s?.message).toBe('Not enough SOL — you need about 0.105 SOL (you have 0.1049)');
    expect(shortfall(100_000_000n, null)).toBeNull(); // unknown balance: never block on a guess
  });

  it('formats the claim window from the on-chain seconds', () => {
    expect(formatWindow(259_200)).toBe('72-hour');
    expect(formatWindow(60)).toBe('1-minute');
    expect(formatWindow(3600)).toBe('1-hour');
    expect(formatWindow(90)).toBe('90-second');
  });
});

describe('mainnet-scale SOL amounts: 1e-6 to 10 SOL, never "0"', () => {
  it('solFloorSig (payouts, fees owed) and solCeilSig (costs): 4 dp, or 2 significant figures when smaller', () => {
    const table: [bigint, string, string][] = [
      // lamports, floor, ceil
      [0n, '0', '0'],
      [1n, '0.000000001', '0.000000001'],
      [1_000n, '0.000001', '0.000001'], // 1e-6 SOL
      [5_000n, '0.000005', '0.000005'], // one signature
      [10_300n, '0.00001', '0.000011'], // devnet claim fee
      [12_345n, '0.000012', '0.000013'],
      [99_999n, '0.000099', '0.0001'],
      [896_783n, '0.00089', '0.0009'], // a first withdraw's cost (with pump creator_vault rent)
      [6_312_345n, '0.0063', '0.0064'],
      [123_456_789n, '0.1234', '0.1235'],
      [1_234_567_890n, '1.2345', '1.2346'],
      [10_000_000_000n, '10', '10'], // 10 SOL
    ];
    for (const [v, floor, ceil] of table) {
      expect(solFloorSig(v), `floor ${v}`).toBe(floor);
      expect(solCeilSig(v), `ceil ${v}`).toBe(ceil);
    }
    expect(solFloorSig('6312345')).toBe('0.0063');
    expect(solFloor(1_000n, 4)).toBe('0'); // why: the fixed 4 dp form hides mainnet-small fees
  });
});

describe('withdraw copy', () => {
  const wallet = 'BMAoZ6SzpXcPhzqKqsdRWWGu4UYTr25rRvBxVEpe8JhM';

  it('the toast reports the vault payout and the network fee, never "Withdrew 0 SOL"', () => {
    expect(withdrawToast({ withdrawnLamports: 6_300_000n, feeLamports: 12_000n }, wallet)).toBe('Withdrew 0.0063 SOL to BMAo…8JhM · network fee 0.000012 SOL');
    // a first withdraw: the cost includes the one-time pump creator_vault rent
    expect(withdrawToast({ withdrawnLamports: 253_621n, feeLamports: 896_783n }, wallet)).toBe('Withdrew 0.00025 SOL to BMAo…8JhM · network fee 0.0009 SOL');
    expect(withdrawToast({ withdrawnLamports: 1_000n, feeLamports: 5_903n }, null)).toBe('Withdrew 0.000001 SOL to your wallet · network fee 0.000006 SOL');
    expect(withdrawToast({ withdrawnLamports: 0n, feeLamports: 5_000n }, wallet)).toBe('Withdrawal confirmed to BMAo…8JhM · network fee 0.000005 SOL');
    expect(withdrawToast({ withdrawnLamports: null, feeLamports: 5_000n }, wallet)).toBe('Withdrawal confirmed to BMAo…8JhM · network fee 0.000005 SOL');
    expect(withdrawToast({ withdrawnLamports: null, feeLamports: null }, wallet)).toBe('Withdrawal confirmed to BMAo…8JhM');
    for (const w of [0n, 1n, 999n, null]) expect(withdrawToast({ withdrawnLamports: w, feeLamports: 5_000n }, wallet)).not.toMatch(/Withdrew 0 SOL/);
  });

  it('warns (and the button turns off) only when the network fee is at least the fees waiting', () => {
    expect(withdrawLossWarning(253_621n, 896_783n)).toBe(
      'Network fee ≈ 0.0009 SOL is more than the 0.00025 SOL waiting. Withdrawing now would cost you more than you receive.',
    );
    expect(withdrawLossWarning(6_053n, 6_053n)).toMatch(/^Network fee ≈ 0.0000061 SOL is more than the 0.000006 SOL waiting\./);
    expect(withdrawLossWarning(6_054n, 6_053n)).toBeNull();
    expect(withdrawLossWarning(6_312_345n, 25_000n)).toBeNull();
    expect(withdrawLossWarning(0n, 25_000n)).toBeNull(); // nothing waiting: no Withdraw button at all
    expect(withdrawLossWarning(1_000n, undefined)).toBeNull(); // cost unknown (vault not read): the chain layer still refuses
  });
});
