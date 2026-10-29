import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ---------------------------------------------------------------- fake Places (New) library */

interface FakeRecord {
  id: string;
  lat: number;
  lng: number;
  displayName?: string;
  shortFormattedAddress?: string;
  types?: string[];
  primaryType?: string;
}

// Google "moves" ids: asking for OLD returns NEW (always key coins on the returned id).
const DB: Record<string, FakeRecord> = {
  ChIJN1t_tDeuEmsRUsoyG83frY4: {
    id: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
    lat: -33.8670522,
    lng: 151.1957362,
    displayName: 'Google Sydney',
    shortFormattedAddress: '48 Pirrama Rd, Pyrmont',
    types: ['corporate_office', 'establishment', 'point_of_interest'],
  },
  ChIJOldIdThatMovedXXXXXX: {
    id: 'ChIJNewCanonicalIdYYYYYY',
    lat: 51.549,
    lng: -0.075,
    displayName: 'Bosphorus Kebab House',
    shortFormattedAddress: 'Kingsland High St',
    primaryType: 'kebab_shop',
    types: ['kebab_shop', 'restaurant'],
  },
};
const fetchFieldsCalls: string[][] = [];

class FakePlace {
  id: string;
  location?: { lat: () => number; lng: () => number };
  displayName?: string;
  shortFormattedAddress?: string;
  types?: string[];
  primaryType?: string;
  constructor({ id }: { id: string }) {
    this.id = id;
  }
  async fetchFields({ fields }: { fields: string[] }) {
    fetchFieldsCalls.push(fields);
    const r = DB[this.id];
    if (!r) throw new Error('NOT_FOUND: Place not found');
    this.id = r.id;
    this.location = { lat: () => r.lat, lng: () => r.lng };
    if (fields.includes('displayName')) this.displayName = r.displayName;
    if (fields.includes('shortFormattedAddress')) this.shortFormattedAddress = r.shortFormattedAddress;
    if (fields.includes('types')) this.types = r.types;
    if (fields.includes('primaryType')) this.primaryType = r.primaryType;
    return { place: this };
  }
  static async searchByText(req: { textQuery: string; fields: string[] }) {
    const hit = Object.values(DB).find((r) => r.displayName?.toLowerCase().includes(req.textQuery.toLowerCase()));
    return { places: hit ? [Object.assign(new FakePlace({ id: hit.id }), { id: hit.id })] : [] };
  }
}

vi.mock('../lib/google', () => ({
  importLibrary: async () => ({ Place: FakePlace }),
  onGoogleFailure: () => () => {},
  googleFailure: () => null,
  isGoogleLoaded: () => true,
  reportGoogleFailure: () => {},
}));

const { resolveMapsLink, openResolvedLink, resolveErrorMessage } = await import('./resolveLink');
const { useStore } = await import('../store');
const { getLaunchPrefill } = await import('../places');

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  fetchFieldsCalls.length = 0;
  useStore.setState({ provider: 'google', coins: {}, panel: 'none', modal: null, selected: { place: null, status: 'idle' } });
});
afterEach(() => vi.unstubAllGlobals());

describe('resolveMapsLink — errors', () => {
  it('not a link / directions / unsupported', async () => {
    expect(await resolveMapsLink('kebab dalston')).toEqual({ status: 'error', error: 'not-a-link' });
    expect(await resolveMapsLink('https://www.google.com/maps/dir/?api=1&destination=x')).toEqual({ status: 'error', error: 'directions' });
    expect(await resolveMapsLink('https://share.google/abc')).toEqual({ status: 'error', error: 'unsupported' });
    expect(resolveErrorMessage('not-a-link')).toBe("That doesn't look like a Google Maps link.");
    expect(resolveErrorMessage('not-found')).toBe("Couldn't find that place. Copy the link from Share in Google Maps.");
  });

  it('short link without the Worker (HTML fallback / offline) → network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })));
    expect(await resolveMapsLink('https://maps.app.goo.gl/abc')).toEqual({ status: 'error', error: 'network' });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await resolveMapsLink('https://maps.app.goo.gl/abc')).toEqual({ status: 'error', error: 'network' });
  });

  it('Worker 404 → not-found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ error: 'not_found' }, 404)));
    expect(await resolveMapsLink('https://goo.gl/maps/expired')).toEqual({ status: 'error', error: 'not-found' });
  });
});

describe('resolveMapsLink — Google map', () => {
  it('direct place id → Place keyed on the id Google returns, link fields only', async () => {
    const r = await resolveMapsLink('https://www.google.com/maps/place/?q=place_id:ChIJOldIdThatMovedXXXXXX');
    expect(r.status).toBe('place');
    if (r.status !== 'place') return;
    expect(r.place.id).toBe('ChIJNewCanonicalIdYYYYYY');
    expect(r.place.source).toBe('google');
    expect(r.place.name).toBe('Bosphorus Kebab House');
    expect(r.place.address).toBe('Kingsland High St');
    expect(r.place.category).toBe('kebab');
    expect(r.place.location).toEqual({ lat: 51.549, lng: -0.075 });
    expect(fetchFieldsCalls[0]).not.toContain('rating'); // never Enterprise fields
    expect(fetchFieldsCalls[0]).not.toContain('reviews'); // never Atmosphere fields
    // the launch prefill reuses the name already fetched (no second billed call)
    const before = fetchFieldsCalls.length;
    expect(await getLaunchPrefill('ChIJNewCanonicalIdYYYYYY')).toEqual({ displayName: 'Bosphorus Kebab House', category: 'kebab' });
    expect(fetchFieldsCalls.length).toBe(before);
  });

  it('short link → Worker place id → details', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`/api/resolve?url=${encodeURIComponent('https://maps.app.goo.gl/ExampleShortLink1')}`);
      return jsonRes({ kind: 'place', placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4', verified: true, via: 'resolveMapsUrls' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await resolveMapsLink('Google Sydney\nhttps://maps.app.goo.gl/ExampleShortLink1');
    expect(r).toMatchObject({ status: 'place', place: { id: 'ChIJN1t_tDeuEmsRUsoyG83frY4', name: 'Google Sydney' } });
  });

  it('bad candidate → name search fallback', async () => {
    const r = await resolveMapsLink('https://www.google.com/maps/place/Google+Sydney/data=!4m2!3m1!1s0x6b12ae37b47f5b37:0x0000000000000001');
    expect(r).toMatchObject({ status: 'place', place: { id: 'ChIJN1t_tDeuEmsRUsoyG83frY4' } });
  });

  it('unknown place with coordinates → coords (fly there, tap a shop)', async () => {
    const r = await resolveMapsLink('https://www.google.com/maps/place/Nowhere+Cafe/@51.5,-0.1,17z');
    expect(r).toEqual({ status: 'coords', location: { lat: 51.5, lng: -0.1 }, zoom: 17 });
  });

  it('search and map-view links', async () => {
    expect(await resolveMapsLink('https://www.google.com/maps/search/?api=1&query=pizza+dalston')).toEqual({
      status: 'search',
      query: 'pizza dalston',
    });
    expect(await resolveMapsLink('https://www.google.com/maps/@52.5,13.26,6z')).toEqual({
      status: 'coords',
      location: { lat: 52.5, lng: 13.26 },
      zoom: 6,
    });
  });
});

describe('resolveMapsLink — fallback (OSM) map: no Google content', () => {
  beforeEach(() => useStore.setState({ provider: 'demo' }));

  it('uses the link’s own name + coordinates, never a Google fetch', async () => {
    const r = await resolveMapsLink(
      'https://www.google.com/maps/place/Googleplex/@37.4220041,-122.0862515,17z/data=!3m1!4b1!4m6!3m5!1s0x808fba02425dad8f:0x6c296c66619367e0!8m2!3d37.4219998!4d-122.0840575',
    );
    expect(r).toMatchObject({ status: 'place', place: { source: 'link', name: 'Googleplex', location: { lat: 37.4219998, lng: -122.0840575 } } });
    expect(fetchFieldsCalls.length).toBe(0);
  });

  it('asks the Worker to follow redirects (follow=1)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('&follow=1');
      return jsonRes({
        kind: 'place',
        via: 'redirects',
        verified: false,
        finalUrl: 'https://www.google.com/maps/place/Kebab+Hut/@51.5,-0.1,16z',
        name: 'Kebab Hut',
        location: { lat: 51.5, lng: -0.1 },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await resolveMapsLink('https://maps.app.goo.gl/abc');
    expect(r).toMatchObject({ status: 'place', place: { source: 'link', name: 'Kebab Hut', location: { lat: 51.5, lng: -0.1 } } });
  });
});

describe('openResolvedLink', () => {
  it('place → fly + panel; launch opens the modal only for launchable coin-less places', async () => {
    const r = await resolveMapsLink('https://www.google.com/maps/place/?q=place_id:ChIJN1t_tDeuEmsRUsoyG83frY4');
    expect(openResolvedLink(r)).toBe(true);
    let s = useStore.getState();
    expect(s.panel).toBe('place');
    expect(s.selected.place?.id).toBe('ChIJN1t_tDeuEmsRUsoyG83frY4');
    expect(s.flyTarget?.center).toEqual({ lat: -33.8670522, lng: 151.1957362 });
    expect(s.modal).toBeNull();
    openResolvedLink(r, { launch: true });
    s = useStore.getState();
    expect(s.modal?.kind).toBe('launch');
  });

  it('coords → fly + toast; errors → false', () => {
    expect(openResolvedLink({ status: 'coords', location: { lat: 1, lng: 2 }, zoom: 12 })).toBe(true);
    const s = useStore.getState();
    expect(s.flyTarget).toMatchObject({ center: { lat: 1, lng: 2 }, zoom: 12 });
    expect(s.toasts[0]?.msg).toBe('Tap any shop on the map to launch one');
    expect(openResolvedLink({ status: 'error', error: 'not-found' })).toBe(false);
  });
});
