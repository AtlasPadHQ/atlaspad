import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { formatLamports, formatTokenUnits, formatUnits, lamportsToSol, parseSol, parseTokens, portion } from './amounts';
import { base58Decode, base58Encode, isAddress } from './base58';

describe('amounts: strings ↔ base units without floats', () => {
  test('parseSol', () => {
    expect(parseSol('0.1')).toBe(100_000_000n);
    expect(parseSol('1')).toBe(1_000_000_000n);
    expect(parseSol('.5')).toBe(500_000_000n);
    expect(parseSol('1.')).toBe(1_000_000_000n);
    expect(parseSol(' 2.000000001 ')).toBe(2_000_000_001n);
    expect(parseSol('1,000.25')).toBe(1_000_250_000_000n);
    expect(parseSol('0.0000000001')).toBeNull(); // 10 dp
    expect(parseSol('-1')).toBeNull();
    expect(parseSol('1e3')).toBeNull();
    expect(parseSol('abc')).toBeNull();
    expect(parseSol('')).toBeNull();
    // A float would get this wrong: 0.1 + 0.2.
    expect(parseSol('0.3')).toBe(300_000_000n);
  });
  test('parseTokens (6 dp)', () => {
    expect(parseTokens('1.5')).toBe(1_500_000n);
    expect(parseTokens('1.0000001')).toBeNull();
    expect(parseTokens('2', 9)).toBe(2_000_000_000n);
  });
  test('format rounds DOWN (never overstates money)', () => {
    expect(formatLamports(123_456_789n)).toBe('0.1234');
    expect(formatLamports(999_999_999n)).toBe('0.9999');
    expect(formatLamports(1_000_000_000n)).toBe('1');
    expect(formatLamports(0n)).toBe('0');
    expect(formatUnits(-1_500_000n, 6)).toBe('-1.5');
    expect(formatTokenUnits(1_234_567n, 2)).toBe('1.23');
    expect(lamportsToSol(1_500_000_000n)).toBe(1.5);
  });
  test('portion for 25/50/100% sells uses exact bigint', () => {
    const raw = 49_534_082_702_551n;
    expect(portion(raw, 10_000n)).toBe(raw);
    expect(portion(raw, 5_000n)).toBe(raw / 2n);
    expect(portion(raw, 2_500n)).toBe((raw * 2_500n) / 10_000n);
    expect(portion(raw, 0n)).toBe(0n);
  });
});

describe('base58 (environment-free)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const bs58 = createRequire(import.meta.url)('bs58').default ?? createRequire(import.meta.url)('bs58');
  test('round-trips and matches bs58 on keys and signatures', () => {
    for (let i = 0; i < 50; i++) {
      const bytes = new Uint8Array(i % 2 ? 32 : 64).map(() => Math.floor(Math.random() * 256));
      if (i % 5 === 0) bytes[0] = 0;
      if (i % 7 === 0) bytes.fill(0, 0, 3);
      const s = base58Encode(bytes);
      expect(s).toBe(bs58.encode(bytes));
      expect(Array.from(base58Decode(s))).toEqual(Array.from(bytes));
    }
  });
  test('isAddress', () => {
    expect(isAddress('6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x')).toBe(true);
    expect(isAddress('11111111111111111111111111111111')).toBe(true);
    expect(isAddress('0OIl')).toBe(false);
    expect(isAddress('abc')).toBe(false);
  });
});
