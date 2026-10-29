import { describe, expect, it } from 'vitest';
import {
  countdown,
  curvePct,
  flashLabel,
  int,
  launchedAgo,
  maskPhone,
  pct,
  pctPin,
  pctSpoken,
  shortAddr,
  solAmount,
  solApprox,
  solPrice,
  timeAgo,
  timeAgoLong,
  tokenAmount,
  tokenAmountFloor,
  usdCompact,
  usdCompactFloor,
  usdFull,
  usdOwed,
  usdPrice,
} from './format';

describe('usdPrice (DESIGN §3.4)', () => {
  it('formats the spec examples', () => {
    expect(usdPrice(0.000212)).toBe('$0.000212');
    expect(usdPrice(0.0184)).toBe('$0.0184');
    expect(usdPrice(1.27)).toBe('$1.27');
  });
  it('uses subscript zeros when 3 sig figs need more than 6 decimals', () => {
    expect(usdPrice(0.000000123)).toBe('$0.0₆123');
    expect(usdPrice(0.0000042)).toBe('$0.0₅42');
  });
  it('handles rounding into the next magnitude', () => {
    expect(usdPrice(0.0000009996)).toBe('$0.0₅1');
  });
  it('handles zero and large values', () => {
    expect(usdPrice(0)).toBe('$0');
    expect(usdPrice(1234.5)).toBe('$1,235');
  });
});

describe('solPrice (USD unknown / stale, INTEGRATION §9)', () => {
  it('never uses scientific notation for pump-curve prices', () => {
    expect(solPrice(1.11e-9)).toBe('0.0₈111');
    expect(solPrice(2.8e-8)).toBe('0.0₇28');
    expect(solPrice(1.11e-9)).not.toMatch(/e/i);
  });
  it('matches the usdPrice style without a currency sign', () => {
    expect(solPrice(0.000212)).toBe('0.000212');
    expect(solPrice(1.27)).toBe('1.27');
    expect(solPrice(0)).toBe('0');
    expect(solPrice(1234.5)).toBe('1,235');
  });
});

describe('usdCompact', () => {
  it('uses lowercase k and uppercase M/B with ≤3 significant figures', () => {
    expect(usdCompact(212_000)).toBe('$212k');
    expect(usdCompact(48_100)).toBe('$48.1k');
    expect(usdCompact(1240)).toBe('$1.2k');
    expect(usdCompact(18_400)).toBe('$18.4k');
    expect(usdCompact(1_200_000)).toBe('$1.2M');
    expect(usdCompact(3_400_000_000)).toBe('$3.4B');
    expect(usdCompact(8_000)).toBe('$8k');
  });
  it('keeps small values readable', () => {
    expect(usdCompact(412)).toBe('$412');
    expect(usdCompact(75)).toBe('$75');
    expect(usdCompact(7.5)).toBe('$7.50');
    expect(usdCompact(0)).toBe('$0');
  });
  it('promotes 999,950 to $1M instead of $1000k', () => {
    expect(usdCompact(999_950)).toBe('$1M');
  });
});

describe('usdFull', () => {
  it('uses en-GB separators', () => {
    expect(usdFull(1240)).toBe('$1,240');
    expect(usdFull(3410.4)).toBe('$3,410');
    expect(usdFull(84.2)).toBe('$84.20');
  });
});

describe('SOL formatting', () => {
  it('trims trailing zeros, max 3 decimals', () => {
    expect(solAmount(1.2)).toBe('1.2 SOL');
    expect(solAmount(0.05)).toBe('0.05 SOL');
    expect(solAmount(2.41)).toBe('2.41 SOL');
    expect(solAmount(1)).toBe('1 SOL');
    expect(solAmount(0.12345)).toBe('0.123 SOL');
    expect(solAmount(0.0004)).toBe('<0.001 SOL');
  });
  it('formats the secondary approx figure', () => {
    expect(solApprox(8.2667)).toBe('≈ 8.27 SOL');
    expect(solApprox(22.733)).toBe('≈ 22.73 SOL');
    expect(solApprox(123.4)).toBe('≈ 123 SOL');
    expect(solApprox(0.42 / 150)).toBe('< 0.01 SOL');
    expect(solApprox(0)).toBe('0 SOL');
    expect(solApprox(0.006)).toBe('≈ 0.01 SOL');
  });
  it('formats flash tags with U+2212 for sells', () => {
    expect(flashLabel('buy', 1.2)).toBe('+1.2 SOL');
    expect(flashLabel('sell', 2.5)).toBe('−2.5 SOL');
  });
});

describe('percent change', () => {
  it('panel/list form', () => {
    expect(pct(12.4)).toBe('▲ 12.4%');
    expect(pct(-3.2)).toBe('▼ 3.2%');
    expect(pct(0)).toBe('▲ 0.0%');
  });
  it('pin form', () => {
    expect(pctPin(12.4)).toBe('▲12%');
    expect(pctPin(-8.6)).toBe('▼9%');
  });
  it('spoken form', () => {
    expect(pctSpoken(12.4)).toBe('up 12 percent');
    expect(pctSpoken(-3.2)).toBe('down 3 percent');
  });
});

describe('tokens, integers, addresses', () => {
  it('formats token amounts with 3 significant figures', () => {
    expect(tokenAmount(2_360_000)).toBe('2.36M');
    expect(tokenAmount(4_100_000)).toBe('4.1M');
    expect(tokenAmount(812_000)).toBe('812k');
    expect(tokenAmount(1_200_000_000)).toBe('1.2B');
    expect(tokenAmount(950)).toBe('950');
  });
  it('floors a guaranteed minimum to 3 significant figures (never more than promised)', () => {
    expect(tokenAmount(2_369_999)).toBe('2.37M');
    expect(tokenAmountFloor(2_369_999)).toBe('2.36M');
    expect(tokenAmount(999_999)).toBe('1M');
    expect(tokenAmountFloor(999_999)).toBe('999k');
    expect(tokenAmountFloor(1_999_999_999)).toBe('1.99B');
    expect(tokenAmountFloor(812_999.99)).toBe('812k');
    expect(tokenAmountFloor(950.9)).toBe('950');
    expect(tokenAmountFloor(99.99)).toBe('99.9');
    expect(tokenAmountFloor(0.123999)).toBe('0.123');
    expect(tokenAmountFloor(0.000001)).toBe('0.000001');
    // exact values stay exact despite float error (4.1 × 100 = 409.99999999999994)
    expect(tokenAmountFloor(4_100_000)).toBe('4.1M');
    expect(tokenAmountFloor(2_360_000)).toBe('2.36M');
    expect(tokenAmountFloor(1_000)).toBe('1k');
    expect(tokenAmountFloor(1_000_000_000)).toBe('1B');
    expect(tokenAmountFloor(0)).toBe('0');
    expect(tokenAmountFloor(-5)).toBe('0');
    expect(tokenAmountFloor(Number.NaN)).toBe('0');
  });
  it('formats holders with separators', () => {
    expect(int(1284)).toBe('1,284');
  });
  it('shortens base58 addresses and mints', () => {
    expect(shortAddr('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')).toBe('7xKX…gAsU');
    expect(shortAddr('BkT7yM3cQ9xX1rLqTzF4nH8pVwJdUe2sGa5KcR6tpump')).toBe('BkT7…pump');
    expect(shortAddr(null)).toBe('');
  });
});

describe('time', () => {
  const now = 1_760_000_000_000;
  it('relative row time', () => {
    expect(timeAgo(now - 12_000, now)).toBe('12s');
    expect(timeAgo(now - 48_000, now)).toBe('48s');
    expect(timeAgo(now - 2 * 60_000, now)).toBe('2m');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h');
    expect(timeAgo(now - 3 * 86_400_000, now)).toBe('3d');
  });
  it('feed and panel forms', () => {
    expect(timeAgoLong(now - 12_000, now)).toBe('12s ago');
    expect(launchedAgo(now - 3 * 86_400_000, now)).toBe('launched 3d ago');
  });
  it('countdown: call cooldowns to 72-hour claim windows and 7-day probations, never `4320:00`', () => {
    const H = 3600;
    const D = 86_400;
    const table: [number, string][] = [
      [0, '0 s'],
      [-5, '0 s'],
      [0.2, '1 s'], // rounded up: not over until it is
      [45, '45 s'],
      [59, '59 s'],
      [60, '1 m 0 s'],
      [125, '2 m 5 s'],
      [59 * 60 + 12, '59 m 12 s'],
      [H - 1, '59 m 59 s'],
      [H, '1 h 0 m'],
      [23 * H + 59 * 60 + 59, '23 h 59 m'],
      [D, '1 d 0 h'],
      [72 * H, '3 d 0 h'], // a mainnet claim window, just requested
      [72 * H - 1, '2 d 23 h'],
      [71 * H + 59 * 60, '2 d 23 h'],
      [7 * D, '7 d 0 h'], // probation
      [7 * D + 72 * H - 1, '9 d 23 h'], // a claim requested at the start of a probation: probation + window
      [Number.NaN, '0 s'],
    ];
    for (const [s, want] of table) expect(countdown(s), String(s)).toBe(want);
    expect(countdown(72 * H)).not.toMatch(/:/);
  });
});

describe('maskPhone (DESIGN §12.3)', () => {
  it('keeps the country code, first 2 national digits and the last 2', () => {
    expect(maskPhone('+44 20 7946 0123')).toBe('+44 20 •••• ••23');
  });
  it('treats national format as +44', () => {
    expect(maskPhone('020 7946 0123')).toBe('+44 20 •••• ••23');
  });
});

/* Mainnet-scale figures: market caps $2.8k–$1M, prices ~1e-5 USD, curve 0.3–100%, fees 1e-6 to 10 SOL (at $200/SOL). */
describe('mainnet-scale numbers', () => {
  it('coin prices from a $2.8k to a $1M market cap (1B supply)', () => {
    const table: [number, string][] = [
      [0.0000028, '$0.0₅28'], // $2.8k mcap, a fresh mainnet curve
      [0.00001, '$0.0₄1'],
      [0.0000123, '$0.0₄123'],
      [0.0000456, '$0.0₄456'],
      [0.000069, '$0.0₄69'], // graduation, ~$69k
      [0.000099, '$0.0₄99'],
      [0.00012, '$0.000120'],
      [0.001, '$0.00100'], // $1M mcap
      [999.6, '$1,000'], // was `$1.00e+3`
    ];
    for (const [v, want] of table) {
      expect(usdPrice(v), String(v)).toBe(want);
      expect(usdPrice(v)).not.toMatch(/e[+-]/);
    }
  });

  it('market caps', () => {
    const table: [number, string][] = [
      [2_800, '$2.8k'],
      [4_321, '$4.3k'],
      [9_999, '$10k'],
      [69_420, '$69.4k'],
      [99_960, '$100k'],
      [412_345, '$412k'],
      [999_999, '$1M'],
      [1_000_000, '$1M'],
    ];
    for (const [v, want] of table) expect(usdCompact(v), String(v)).toBe(want);
  });

  it('bonding-curve progress never reads 100% before the curve completes', () => {
    const table: [number, string][] = [
      [0, '0%'],
      [0.04, '<0.1%'],
      [0.3, '0.3%'],
      [0.57, '0.5%'],
      [9.96, '9.9%'], // was `10.0%`
      [10, '10%'],
      [42.7, '42%'],
      [98.99, '98%'],
      [99, '99.0%'],
      [99.6, '99.6%'], // was `100%`
      [99.99, '99.9%'],
      [100, '100%'],
      [120, '100%'],
      [-1, '0%'],
      [Number.NaN, '0%'],
    ];
    for (const [v, want] of table) expect(curvePct(v), String(v)).toBe(want);
  });

  it('fees from 1e-6 to 10 SOL in USD: a non-zero amount never reads $0', () => {
    // usdFull: the floats behind demo and UI figures
    expect(usdFull(0.0002)).toBe('<$0.01'); // 1e-6 SOL
    expect(usdFull(0.004)).toBe('<$0.01'); // was `$0.00`
    expect(usdFull(0.01)).toBe('$0.01');
    expect(usdFull(2_000)).toBe('$2,000'); // 10 SOL
    // usdOwed: amounts already floored to the cent (lamportsToUsdFloor), plus whether the lamports are non-zero
    expect(usdOwed(0, true)).toBe('<$0.01');
    expect(usdOwed(0, false)).toBe('$0');
    expect(usdOwed(0.2, true)).toBe('$0.20');
    expect(usdOwed(2_000, true)).toBe('$2,000');
    // compact, rounded down
    expect(usdCompactFloor(0.0002)).toBe('<$0.01');
    expect(usdCompactFloor(0.2)).toBe('$0.20');
    expect(usdCompactFloor(1_999.99)).toBe('$1.9k');
  });
});
