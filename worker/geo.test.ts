/**
 * The sanctions geo-block (worker/geo.ts): list parsing, visitor and place matching (Cloudflare `cf` codes, Google
 * addressComponents incl. the UA region names), and the 451 responses of the Worker entry (JSON for /api/*, the
 * static page for pages; /api/health, /api/config, /terms, /privacy and static files stay open).
 */
import './test/globals';
import { describe, expect, it } from 'vitest';
import type { Env } from './env';
import {
  assertPlaceAllowed,
  DEFAULT_BLOCKED_COUNTRIES,
  DEFAULT_BLOCKED_REGIONS,
  geoBlock,
  geoRules,
  isBlocked,
  placeRegion,
  REGION_BLOCKED_HTML,
  visitorGateOn,
  visitorLocation,
} from './geo';
import worker from './index';
import { setBuild } from './test/globals';
import { GB_ADDRESS } from './test/fakeChain';

const ORIGIN = 'https://cornershop-devnet.tiejiucai.workers.dev';
const PAGE = '<!doctype html><title>app</title>';
const env: Env = {
  ASSETS: { fetch: async () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }) } as unknown as Fetcher,
  CLUSTER: 'devnet',
  PUBLIC_ORIGIN: ORIGIN,
};

/** A request as Cloudflare delivers it: `cf.country` / `cf.regionCode` (Node's Request has no `cf`). */
function req(path: string, cf?: { country?: string; regionCode?: string }, init: RequestInit = {}): Request {
  const r = new Request(`${ORIGIN}${path}`, init);
  if (cf) Object.defineProperty(r, 'cf', { value: cf });
  return r;
}

const ac = (country: string | null, level1?: { longText: string; shortText?: string }) => [
  ...(level1 ? [{ longText: level1.longText, shortText: level1.shortText ?? level1.longText, types: ['administrative_area_level_1', 'political'] }] : []),
  ...(country ? [{ longText: country, shortText: country, types: ['country', 'political'] }] : []),
];

describe('blocked lists', () => {
  it('defaults: KP IR SY CU RU BY and Crimea, Sevastopol, Donetsk, Luhansk; the UK is not blocked', () => {
    const r = geoRules({})!;
    expect([...r.countries]).toEqual([...DEFAULT_BLOCKED_COUNTRIES]);
    expect([...r.regions]).toEqual([...DEFAULT_BLOCKED_REGIONS]);
    expect([...r.countries].sort()).toEqual(['BY', 'CU', 'IR', 'KP', 'RU', 'SY']);
    expect([...r.regions].sort()).toEqual(['UA-09', 'UA-14', 'UA-40', 'UA-43']);
    expect(isBlocked(r, 'GB')).toBe(false);
    expect(isBlocked(r, 'UA')).toBe(false);
    expect(isBlocked(r, 'UA', ['UA-46'])).toBe(false);
    expect(isBlocked(r, 'UA', ['UA-43'])).toBe(true);
    expect(isBlocked(r, 'IR')).toBe(true);
    expect(isBlocked(r, null)).toBe(false);
  });

  it('configurable by env (CSV, any case, junk ignored); blank keeps the defaults; "none" empties a list', () => {
    const r = geoRules({ BLOCKED_COUNTRIES: ' ve, kp ,x,USA', BLOCKED_REGIONS: 'us-ca,UA-43, bogus' })!;
    expect([...r.countries]).toEqual(['VE', 'KP']);
    expect([...r.regions]).toEqual(['US-CA', 'UA-43']);
    expect([...geoRules({ BLOCKED_COUNTRIES: '  ', BLOCKED_REGIONS: '' })!.countries]).toEqual([...DEFAULT_BLOCKED_COUNTRIES]);
    expect([...geoRules({ BLOCKED_COUNTRIES: 'x,yy1' })!.countries]).toEqual([...DEFAULT_BLOCKED_COUNTRIES]); // a typo never unblocks
    const none = geoRules({ BLOCKED_COUNTRIES: 'none', BLOCKED_REGIONS: 'NONE' })!;
    expect(none.countries.size + none.regions.size).toBe(0);
    expect(geoRules({ GEO_BLOCK: 'off' })).toBeNull();
    expect(geoRules({ GEO_BLOCK: ' OFF ' })).toBeNull();
  });

  it('the visitor gate: on for devnet/mainnet by default, off on the demo Worker unless GEO_BLOCK=on', () => {
    expect(visitorGateOn(env)).toBe(true);
    expect(visitorGateOn({ ...env, GEO_BLOCK: 'off' })).toBe(false);
    expect(visitorGateOn({ ASSETS: env.ASSETS })).toBe(false); // demo: no CLUSTER
    expect(visitorGateOn({ ASSETS: env.ASSETS, GEO_BLOCK: 'on' })).toBe(true);
  });
});

describe('visitor location (request.cf)', () => {
  it('country + regionCode → ISO 3166-2; unknown stays null', () => {
    expect(visitorLocation(req('/', { country: 'UA', regionCode: '43' }))).toEqual({ country: 'UA', region: 'UA-43' });
    expect(visitorLocation(req('/', { country: 'us', regionCode: 'tx' }))).toEqual({ country: 'US', region: 'US-TX' });
    expect(visitorLocation(req('/', { country: 'UA', regionCode: 'UA-14' }))).toEqual({ country: 'UA', region: 'UA-14' });
    expect(visitorLocation(req('/', { country: 'GB' }))).toEqual({ country: 'GB', region: null });
    expect(visitorLocation(req('/'))).toEqual({ country: null, region: null });
    expect(visitorLocation(req('/', { country: 'T1' }))).toEqual({ country: null, region: null }); // Tor
  });
});

describe('place location (Google addressComponents)', () => {
  it('country from the country component; ISO 3166-2 from a short first-level code', () => {
    expect(placeRegion(GB_ADDRESS)).toEqual({ country: 'GB', regions: [] });
    expect(placeRegion(ac('US', { longText: 'California', shortText: 'CA' }))).toEqual({ country: 'US', regions: ['US-CA'] });
    expect(placeRegion(ac('IR', { longText: 'Tehran Province' }))).toEqual({ country: 'IR', regions: [] });
    expect(placeRegion(undefined)).toEqual({ country: null, regions: [] });
    expect(placeRegion([null, 3, { types: 'country' }])).toEqual({ country: null, regions: [] });
  });

  it('the four UA regions by name (English, transliterated, Ukrainian, Russian), with or without a country', () => {
    expect(placeRegion(ac('UA', { longText: 'Donetsk Oblast' })).regions).toEqual(['UA-14']);
    expect(placeRegion(ac('UA', { longText: "Donets'ka oblast" })).regions).toEqual(['UA-14']);
    expect(placeRegion(ac('UA', { longText: 'Luhansk Oblast' })).regions).toEqual(['UA-09']);
    expect(placeRegion(ac('UA', { longText: 'Луганська область' })).regions).toEqual(['UA-09']);
    expect(placeRegion(ac(null, { longText: 'Autonomous Republic of Crimea' }))).toEqual({ country: null, regions: ['UA-43'] });
    expect(placeRegion(ac('RU', { longText: 'Республика Крым' })).regions).toEqual(['UA-43']);
    expect(placeRegion(ac('UA', { longText: 'Sevastopol' })).regions).toEqual(['UA-40']);
    expect(placeRegion(ac('UA', { longText: 'Lviv Oblast' })).regions).toEqual([]);
    // the names only count inside UA / RU / no country: Sevastopol, Wisconsin is fine
    expect(placeRegion(ac('US', { longText: 'Sevastopol' })).regions).toEqual([]);
  });

  it('assertPlaceAllowed: blocked country or region refuses; unknown refuses a launch only; GEO_BLOCK=off allows all', () => {
    const iran = placeRegion(ac('IR'));
    const donetsk = placeRegion(ac('UA', { longText: 'Donetsk Oblast' }));
    const unknown = placeRegion([]);
    expect(() => assertPlaceAllowed(env, iran, 'launch')).toThrow(expect.objectContaining({ code: 'place_region_blocked', status: 451 }));
    expect(() => assertPlaceAllowed(env, iran, 'claim')).toThrow(expect.objectContaining({ code: 'place_region_blocked' }));
    expect(() => assertPlaceAllowed(env, donetsk, 'claim')).toThrow(expect.objectContaining({ code: 'place_region_blocked' }));
    expect(() => assertPlaceAllowed(env, unknown, 'launch')).toThrow(expect.objectContaining({ code: 'place_region_blocked', message: expect.stringMatching(/couldn't confirm/) }));
    expect(() => assertPlaceAllowed(env, null, 'launch')).toThrow(expect.objectContaining({ code: 'place_region_blocked' }));
    expect(() => assertPlaceAllowed(env, unknown, 'claim')).not.toThrow();
    expect(() => assertPlaceAllowed(env, placeRegion(GB_ADDRESS), 'launch')).not.toThrow();
    expect(() => assertPlaceAllowed({ ...env, GEO_BLOCK: 'off' }, iran, 'launch')).not.toThrow();
    expect(() => assertPlaceAllowed({ ...env, BLOCKED_COUNTRIES: 'none' }, iran, 'launch')).not.toThrow();
  });
});

describe('the Worker entry answers 451 to blocked visitors', () => {
  const NK = { country: 'KP' };
  const CRIMEA = { country: 'UA', regionCode: '43' };

  it('API routes: 451 {error:"region_blocked"}, not cacheable', async () => {
    for (const path of ['/api/coins?sort=new', '/api/rpc', '/api/launch/prepare', '/api/resolve?url=x', '/api/og/c/x.png']) {
      const res = await worker.fetch(req(path, NK, path === '/api/rpc' ? { method: 'POST', body: '{}' } : {}), env);
      expect(res.status, path).toBe(451);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ error: 'region_blocked', message: "AtlasPad isn't available in your region." });
    }
  });

  it('pages: the static 451 page (self-contained, no script, never framed), HEAD without a body', async () => {
    for (const path of ['/', '/p/ChIJcafe0000000000001', '/c/somemint', '/anything/else']) {
      const res = await worker.fetch(req(path, CRIMEA), env);
      expect(res.status, path).toBe(451);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(await res.text()).toBe(REGION_BLOCKED_HTML);
    }
    expect(REGION_BLOCKED_HTML).toContain("AtlasPad isn't available in your region");
    expect(REGION_BLOCKED_HTML).toContain('mailto:hello@atlaspad.online');
    expect(REGION_BLOCKED_HTML).not.toMatch(/<script|<link|src="http/);
    const head = await worker.fetch(req('/', NK, { method: 'HEAD' }), env);
    expect(head.status).toBe(451);
    expect(await head.text()).toBe('');
  });

  it('stays open: /api/health, /api/config, /terms, /privacy and static files', () => {
    for (const path of ['/api/health', '/api/config', '/terms', '/privacy.html', '/favicon.svg', '/og.png', '/assets/index-abc.js', '/meta/0123456789abcdef0123456789abcdef.json', '/img/0123456789abcdef0123456789abcdef.png']) {
      expect(geoBlock(req(path, NK), env), path).toBeNull();
    }
    expect(geoBlock(req('/api/healthz', NK), env)).not.toBeNull();
    expect(geoBlock(req('/terms-of-sale', NK), env)).not.toBeNull();
  });

  it('everyone else is served normally: the UK, unblocked Ukraine, unknown location, GEO_BLOCK=off, the demo Worker', async () => {
    for (const cf of [{ country: 'GB' }, { country: 'UA', regionCode: '46' }, undefined]) {
      const res = await worker.fetch(req('/', cf), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(PAGE);
    }
    expect((await worker.fetch(req('/', NK), { ...env, GEO_BLOCK: 'off' })).status).toBe(200);
    expect((await worker.fetch(req('/', { country: 'GB' }), { ...env, BLOCKED_COUNTRIES: 'GB' })).status).toBe(451);
    setBuild('demo', false);
    try {
      expect((await worker.fetch(req('/', NK), { ASSETS: env.ASSETS })).status).toBe(200);
      expect((await worker.fetch(req('/', NK), { ASSETS: env.ASSETS, GEO_BLOCK: 'on' })).status).toBe(451);
    } finally {
      setBuild('devnet', true);
    }
  });

  it('a broken request never takes the site down (fails open)', () => {
    const r = req('/', NK);
    Object.defineProperty(r, 'url', { get: () => 'not a url' });
    expect(geoBlock(r, env)).toBeNull();
  });
});
