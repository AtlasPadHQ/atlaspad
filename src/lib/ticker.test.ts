import { describe, expect, it } from 'vitest';
import { isTickerTaken, sanitizeTicker, TICKER_RE, tickerFromName, validateTicker, withDollar } from './ticker';

describe('tickerFromName (DESIGN §12.2 prefill)', () => {
  it('takes the first word, letters/digits only, uppercased', () => {
    expect(tickerFromName('Crumb & Co. Bakery')).toBe('CRUMB');
    expect(tickerFromName('Bosphorus Grill')).toBe('BOSPHORU');
    expect(tickerFromName("Nonna Pepi's Pizza")).toBe('NONNA');
  });
  it('strips accents and skips a leading article', () => {
    expect(tickerFromName('Café Lumière')).toBe('CAFE');
    expect(tickerFromName('The Kettle & Crow')).toBe('KETTLE');
  });
  it('falls back to initials for one-letter first words', () => {
    expect(tickerFromName('A1 Barbers')).toBe('A1');
    expect(tickerFromName('K Town Kebabs')).toBe('KTK');
  });
  it('returns empty for empty names', () => {
    expect(tickerFromName('   ')).toBe('');
    expect(tickerFromName('&&&')).toBe('');
  });
  it('always produces a valid ticker or empty', () => {
    for (const n of ['Bean', 'Simit House', '24/7 Late Shop', 'Ö Döner', 'Lucky Noodle Bar']) {
      const t = tickerFromName(n);
      expect(t === '' || TICKER_RE.test(t)).toBe(true);
    }
  });
});

describe('sanitizeTicker', () => {
  it('forces uppercase A–Z0–9 and max 8 chars', () => {
    expect(sanitizeTicker('kebab')).toBe('KEBAB');
    expect(sanitizeTicker('$ke-ba b!')).toBe('KEBAB');
    expect(sanitizeTicker('abcdefghijkl')).toBe('ABCDEFGH');
    expect(sanitizeTicker('döner')).toBe('DONER');
  });
});

describe('validateTicker', () => {
  it('accepts 2–8 uppercase letters or digits', () => {
    expect(validateTicker('KEBAB')).toBeNull();
    expect(validateTicker('A1')).toBeNull();
    expect(validateTicker('ABCDEFGH')).toBeNull();
  });
  it('rejects empty, wrong length or bad characters', () => {
    expect(validateTicker('')).toBe('empty');
    expect(validateTicker('A')).toBe('length');
    expect(validateTicker('ABCDEFGHI')).toBe('length');
    expect(validateTicker('keb')).toBe('chars');
    expect(validateTicker('KE B')).toBe('chars');
  });
});

describe('isTickerTaken / withDollar', () => {
  const coins = [
    { ticker: 'KEBAB', placeId: 'demo-kebab' },
    { ticker: 'BEAN', placeId: 'demo-bean' },
  ];
  it('warns on duplicates across shops (not the same place)', () => {
    expect(isTickerTaken('kebab', coins)).toBe(true);
    expect(isTickerTaken('KEBAB', coins, 'demo-kebab')).toBe(false);
    expect(isTickerTaken('CRUMB', coins)).toBe(false);
  });
  it('prefixes a dollar sign', () => {
    expect(withDollar('KEBAB')).toBe('$KEBAB');
  });
});
