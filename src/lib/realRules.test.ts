/**
 * Phase-1 minors as rules: non-business places are not launchable (#4), only the business's own
 * domain can verify (#3), Report without a coin needs a coin link or mint (#5), hit areas (#1).
 */
import { describe, expect, it } from 'vitest';
import { isOwnBusinessHost, launchIneligibility } from '../../worker/wire';
import { effectiveSize } from '../ui/hitAudit';
import { mintFromCoinRef } from './coinRef';
import { knownIneligibility } from './place';

const g = (over: { primaryType?: string; types?: string[]; businessStatus?: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY' }) => ({ source: 'google' as const, ...over });

describe('launchability (#4)', () => {
  it('plus codes, cities, roads and regions are never launchable', () => {
    expect(knownIneligibility(g({ types: ['plus_code'] }))).toBe('not_business');
    expect(knownIneligibility(g({ types: ['locality', 'political'] }))).toBe('not_business');
    expect(knownIneligibility(g({ primaryType: 'route', types: ['route'] }))).toBe('not_business');
    expect(knownIneligibility(g({ types: ['administrative_area_level_1', 'political'] }))).toBe('not_business');
    expect(knownIneligibility(g({ primaryType: 'park', types: ['park', 'point_of_interest', 'establishment'] }))).toBe('not_business');
  });

  it('open businesses pass; closed ones are "closed"; unknown facts are not a reason', () => {
    expect(knownIneligibility(g({ primaryType: 'cafe', types: ['cafe', 'food', 'point_of_interest', 'establishment'], businessStatus: 'OPERATIONAL' }))).toBeNull();
    expect(knownIneligibility(g({ types: ['cafe', 'point_of_interest', 'establishment'] }))).toBeNull();
    expect(knownIneligibility(g({ primaryType: 'cafe', businessStatus: 'CLOSED_PERMANENTLY' }))).toBe('closed');
    expect(knownIneligibility(g({}))).toBeNull(); // POI click without types: the full check decides
    expect(knownIneligibility({ source: 'demo' })).toBeNull();
  });

  it('the full rule (server + demo facts) needs an OPERATIONAL business status', () => {
    expect(launchIneligibility({ businessStatus: 'OPERATIONAL', primaryType: 'barber_shop', types: ['barber_shop'] })).toBeNull();
    expect(launchIneligibility({ businessStatus: null, primaryType: null, types: ['locality'] })).toBe('not_business');
    expect(launchIneligibility({ businessStatus: null, primaryType: 'cafe', types: ['cafe'] })).toBe('not_business');
    expect(launchIneligibility({ businessStatus: 'CLOSED_TEMPORARILY', primaryType: 'cafe' })).toBe('closed');
  });
});

describe('website / email verification hosts (#3)', () => {
  it('platform hosts are refused, the business domain is accepted', () => {
    expect(isOwnBusinessHost('www.tripadvisor.co.uk')).toBe(false);
    expect(isOwnBusinessHost('facebook.com')).toBe(false);
    expect(isOwnBusinessHost('m.facebook.com')).toBe(false);
    expect(isOwnBusinessHost('bosphorusgrill.co.uk')).toBe(true);
    expect(isOwnBusinessHost('www.bosphorusgrill.co.uk')).toBe(true);
    expect(isOwnBusinessHost(null)).toBe(false);
  });
});

describe('Report a coin without a coin selected (#5)', () => {
  const mint = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  it('accepts a /c/<mint> link or a bare mint', () => {
    expect(mintFromCoinRef(mint)).toBe(mint);
    expect(mintFromCoinRef(`https://cornershop-devnet.tiejiucai.workers.dev/c/${mint}`)).toBe(mint);
    expect(mintFromCoinRef(`https://cornershop.tiejiucai.workers.dev/c/${mint}?ref=x`)).toBe(mint);
  });
  it('refuses anything else', () => {
    expect(mintFromCoinRef('')).toBeNull();
    expect(mintFromCoinRef('kebab')).toBeNull();
    expect(mintFromCoinRef('https://example.com/c/not-a-mint')).toBeNull();
    expect(mintFromCoinRef('0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl')).toBeNull(); // not base58
  });
});

describe('hit areas (#1)', () => {
  it('counts the ::after extender of .hit / .btn / text links', () => {
    expect(effectiveSize({ width: 60, height: 20 }, { content: '""', position: 'absolute', width: '60px', height: '44px' })).toEqual({ w: 60, h: 44 });
    expect(effectiveSize({ width: 60, height: 20 }, { content: 'none', position: 'static', width: 'auto', height: 'auto' })).toEqual({ w: 60, h: 20 });
    expect(effectiveSize({ width: 30, height: 30 }, { content: '""', position: 'relative', width: '44px', height: '44px' })).toEqual({ w: 30, h: 30 });
  });
});
