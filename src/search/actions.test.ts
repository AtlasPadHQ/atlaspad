import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCoins } from '../data/mockCoins';
import { useStore } from '../store';
import type { Coin } from '../types';
import { applyChip, closeResults, exactTickerCoin, matchCoins, nearbyRadius, nearMe, runCategorySearch, runTextSearch } from './actions';
import { useSearchUi } from './searchState';

// Pinned to the DESIGN §19.2 seeds so other builders' extra demo coins can't change these tests.
const SEEDS = new Set(['KEBAB', 'BEAN', 'FADE', 'PEPI', 'CROW', 'LATE', 'NOODL', 'SIMIT']);
const coins = createMockCoins(150, Date.now()).filter((c) => SEEDS.has(c.ticker) && c.place.location.lat > 51.5 && c.place.location.lat < 51.6);
const byId = Object.fromEntries(coins.map((c) => [c.placeId, c])) as Record<string, Coin>;
const DALSTON = { center: { lat: 51.5469, lng: -0.0712 }, zoom: 15, bounds: { north: 51.556, south: 51.538, east: -0.055, west: -0.088 } };
const REYKJAVIK = { center: { lat: 64.146, lng: -21.94 }, zoom: 15, bounds: { north: 64.156, south: 64.136, east: -21.92, west: -21.96 } };

const photonRes = (features: unknown[]) =>
  new Response(JSON.stringify({ type: 'FeatureCollection', features }), { headers: { 'content-type': 'application/json' } });
const feature = (name: string, lat: number, lng: number, key = 'amenity', value = 'cafe', id = Math.floor(lat * 1e6)) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: { osm_type: 'N', osm_id: id, osm_key: key, osm_value: value, type: 'house', name, street: 'Kingsland Rd', city: 'London' },
});

beforeEach(() => {
  useStore.setState({
    provider: 'demo',
    coins: byId,
    category: null,
    panel: 'none',
    panelHistory: [],
    results: [],
    resultsStatus: 'idle',
    resultsQuery: '',
    viewport: DALSTON,
    flyTarget: null,
    toasts: [],
    selected: { place: null, status: 'idle' },
  });
  useSearchUi.setState({ text: '', origin: null });
});
afterEach(() => vi.unstubAllGlobals());

describe('coin matching', () => {
  it('fixture has the DESIGN seeds', () => {
    expect(coins.length).toBe(8);
  });
  it('ranks exact ticker, ticker prefix, name prefix, word prefix', () => {
    expect(matchCoins(coins, 'kebab').map((c) => c.ticker)[0]).toBe('KEBAB');
    expect(matchCoins(coins, '$PE').map((c) => c.ticker)[0]).toBe('PEPI');
    expect(matchCoins(coins, 'nonna').map((c) => c.ticker)).toEqual(['PEPI']);
    expect(matchCoins(coins, 'grill').map((c) => c.ticker)).toEqual(['KEBAB']);
    expect(matchCoins(coins, 'zzzz')).toEqual([]);
    expect(matchCoins(coins, '')).toEqual([]);
  });
  it('exact ticker', () => {
    expect(exactTickerCoin(coins, '$kebab')?.ticker).toBe('KEBAB');
    expect(exactTickerCoin(coins, 'keba')).toBeUndefined();
  });
  it('nearby radius = inscribed circle, clamped', () => {
    const r = nearbyRadius(DALSTON);
    expect(r).toBeGreaterThan(900);
    expect(r).toBeLessThanOrEqual(3000);
    expect(nearbyRadius(null)).toBe(1000);
    expect(nearbyRadius({ ...DALSTON, bounds: { north: 51.5470, south: 51.5468, east: -0.0711, west: -0.0713 } })).toBe(300);
  });
});

describe('text search (fallback map → Photon)', () => {
  it('coins first, then places; loading → ready', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('https://photon.komoot.io/api/?q=kebab');
      return photonRes([feature('Super Kebab', 51.548, -0.075, 'amenity', 'fast_food')]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const p = runTextSearch('kebab');
    expect(useStore.getState().resultsStatus).toBe('loading');
    expect(useStore.getState().panel).toBe('results');
    await p;
    const s = useStore.getState();
    expect(s.resultsStatus).toBe('ready');
    expect(s.results[0]?.id).toBe(byId[s.results[0]!.id]?.placeId); // the $KEBAB coin place
    expect(s.results.map((r) => r.name)).toContain('Super Kebab');
    expect(useSearchUi.getState().origin).toMatchObject({ kind: 'text', query: 'kebab' });
  });

  it('failure with no coin matches → error state; with coin matches → coins only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    await runTextSearch('somewhere obscure');
    expect(useStore.getState().resultsStatus).toBe('error');
    await runTextSearch('pepi');
    expect(useStore.getState().resultsStatus).toBe('ready');
    expect(useStore.getState().results.length).toBe(1);
  });

  it('a newer search or closing the panel wins over a slow response', async () => {
    let release: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => (release = res))));
    const p = runTextSearch('cafe');
    closeResults();
    release(photonRes([feature('Late Cafe', 51.547, -0.07)]));
    await p;
    expect(useStore.getState().panel).toBe('none');
  });
});

describe('chips', () => {
  it('category chip: filter on + nearby list; again → off + list closed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('include=osm.amenity.cafe');
        expect(url).toContain('bbox=');
        return photonRes([feature('Cafe Oto', 51.5469, -0.0747), feature('Allpress', 51.547, -0.072)]);
      }),
    );
    applyChip('cafe');
    expect(useStore.getState().category).toBe('cafe');
    await vi.waitFor(() => expect(useStore.getState().resultsStatus).toBe('ready'));
    const s = useStore.getState();
    expect(s.resultsQuery).toBe('Cafés');
    expect(s.results[0]?.name).toBe('Beanstalk Coffee Co.'); // nearby café coin first
    expect(s.results.map((r) => r.name)).toEqual(expect.arrayContaining(['Allpress', 'Cafe Oto']));
    applyChip('cafe');
    expect(useStore.getState().category).toBeNull();
    expect(useStore.getState().panel).toBe('none');
  });

  it('Live coins / Fees waiting only filter; they bring matches into view when none are', () => {
    useStore.setState({ viewport: REYKJAVIK });
    applyChip('fees');
    const s = useStore.getState();
    expect(s.category).toBe('fees');
    expect(s.panel).toBe('none');
    expect(s.flyTarget?.bounds).toBeDefined(); // fit to the Dalston coins with fees waiting
    applyChip('live');
    expect(useStore.getState().category).toBe('live');
  });

  it('switching from a category chip to Live closes the category list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => photonRes([])));
    await runCategorySearch('pub');
    useStore.setState({ category: 'pub' });
    expect(useStore.getState().panel).toBe('results');
    applyChip('live');
    expect(useStore.getState().panel).toBe('none');
    expect(useStore.getState().category).toBe('live');
  });
});

describe('near me', () => {
  it('locates, then toasts the coins within 2 km with a Show action', async () => {
    const getCurrentPosition = vi.fn((ok: PositionCallback) =>
      ok({ coords: { latitude: 51.5433, longitude: -0.0688, accuracy: 30 }, timestamp: Date.now() } as GeolocationPosition),
    );
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition }, onLine: true });
    await nearMe();
    const s = useStore.getState();
    expect(s.locateStatus).toBe('located');
    expect(s.userLocation?.location).toEqual({ lat: 51.5433, lng: -0.0688 });
    expect(s.toasts[0]?.msg).toMatch(/^\d+ coins? within 2 km$/);
    s.toasts[0]?.action?.run();
    expect(useStore.getState().flyTarget?.bounds).toBeDefined();
  });

  it('denied → friendly toast, no summary', async () => {
    const getCurrentPosition = vi.fn((_ok: PositionCallback, fail: PositionErrorCallback) =>
      fail({ code: 1, PERMISSION_DENIED: 1, TIMEOUT: 3, POSITION_UNAVAILABLE: 2, message: 'denied' } as GeolocationPositionError),
    );
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition }, onLine: true });
    useStore.setState({ locateStatus: 'idle', userLocation: null });
    await nearMe();
    expect(useStore.getState().toasts[0]?.msg).toBe('Location is off. Search for a shop instead.');
  });
});
