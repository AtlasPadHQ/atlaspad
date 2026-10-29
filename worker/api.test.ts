import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setBuild } from './test/globals';
import { __resetApiState, followRedirects, handleApi, isPremiumNumber, maskPhoneNumber, type Deps, type Env } from './api';
import worker from './index';
import { shareMetaFor } from './share';

// the Phase-1 routes as built for the demo Worker (`__CS_CLUSTER__ === 'demo'`)
setBuild('demo', false);

type FetchMock = ReturnType<typeof vi.fn<Deps['fetch']>>;

function env(key?: string): Env {
  return {
    ASSETS: { fetch: vi.fn(async () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })) } as unknown as Fetcher,
    ...(key ? { GOOGLE_SERVER_KEY: key } : {}),
  };
}

function deps(fetchImpl: Deps['fetch']): Deps & { fetch: FetchMock } {
  return { fetch: vi.fn(fetchImpl), now: () => 1_000_000 };
}

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const req = (path: string, init?: RequestInit & { ip?: string }) =>
  new Request(`https://cornershop.example${path}`, {
    ...init,
    headers: { 'cf-connecting-ip': init?.ip ?? '203.0.113.7', ...(init?.headers as Record<string, string> | undefined) },
  });

const resolveUrl = (u: string, extra = '') => `/api/resolve?url=${encodeURIComponent(u)}${extra}`;

// a fictional place: the short link, its redirect target and the place id its ftid encodes
const SHORT = 'https://maps.app.goo.gl/ExampleShortLink1?g_st=ic';
const AFTER_SHORT =
  'https://maps.google.com?q=9C3X+QXH+Nowhere+Greens+cafe,+1+Example+Road&ftid=0x48760000000000a1:0x00000000000000b2&entry=gps';

beforeEach(() => __resetApiState());

describe('worker routing', () => {
  it('serves non-API paths from ASSETS', async () => {
    const e = env();
    const res = await worker.fetch(req('/c/kebab'), e);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect((e.ASSETS.fetch as unknown as FetchMock).mock.calls.length).toBe(1);
    const res2 = await worker.fetch(req('/terms'), e);
    expect(res2.headers.get('content-type')).toContain('text/html');
    expect((e.ASSETS.fetch as unknown as FetchMock).mock.calls.length).toBe(2);
  });

  it('share URLs get share meta; other paths do not', () => {
    const c = shareMetaFor('/c/kebab', undefined, undefined, true); // the demo Worker
    expect(c?.url).toBe('https://cornershop.tiejiucai.workers.dev/c/kebab');
    expect(c?.title).toContain('$KEBAB');
    // a real Worker never makes a ticker up from the URL (/c/TESCO on our own domain): no registry row → "This coin"
    expect(shareMetaFor('/c/TESCO', 'https://atlaspad.online')?.title).toBe('This coin on AtlasPad — 100% of creator fees held for the shop');
    expect(c?.image).toBe('https://cornershop.tiejiucai.workers.dev/api/og/c/kebab.png');
    const p = shareMetaFor('/p/ChIJoQAAAAAAdkgRsgAAAAAAAAA');
    expect(p?.image).toBe('https://cornershop.tiejiucai.workers.dev/api/og/p/ChIJoQAAAAAAdkgRsgAAAAAAAAA.png');
    expect(p?.title).not.toMatch(/ChIJ/);
    expect(shareMetaFor('/')).toBeNull();
    expect(shareMetaFor('/terms')).toBeNull();
    expect(shareMetaFor('/c/<script>')).toBeNull();
  });

  it('serves the share image for /api/og/*', async () => {
    const e = env();
    const res = await worker.fetch(req('/api/og/c/kebab.png'), e);
    expect(res.headers.get('content-type')).toBe('image/png');
    const call = (e.ASSETS.fetch as unknown as FetchMock).mock.calls[0]?.[0] as unknown as Request;
    expect(new URL(call.url).pathname).toBe('/og.png');
  });

  it('health', async () => {
    const res = await handleApi(req('/api/health'), env('k'), deps(async () => jsonRes({})));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, google: true });
  });

  it('unknown API route → 404 JSON; wrong method → 405', async () => {
    const d = deps(async () => jsonRes({}));
    const a = await handleApi(req('/api/nope'), env(), d);
    expect(a.status).toBe(404);
    expect(a.headers.get('content-type')).toContain('application/json');
    const b = await handleApi(req('/api/resolve?url=x', { method: 'POST' }), env(), d);
    expect(b.status).toBe(405);
    expect(b.headers.get('allow')).toBe('GET');
  });
});

describe('/api/resolve validation', () => {
  it('400 on missing / junk / non-Google input, 422 on directions', async () => {
    const d = deps(async () => jsonRes({}));
    expect((await handleApi(req('/api/resolve'), env(), d)).status).toBe(400);
    expect((await handleApi(req(resolveUrl('hello')), env(), d)).status).toBe(400);
    expect((await handleApi(req(resolveUrl('https://evil.example/maps/place/x')), env(), d)).status).toBe(400);
    expect((await handleApi(req(resolveUrl('http://169.254.169.254/latest/meta-data')), env(), d)).status).toBe(400);
    expect((await handleApi(req(resolveUrl('https://www.google.com/maps/dir/?api=1&destination=x')), env(), d)).status).toBe(422);
    expect((await handleApi(req(resolveUrl(`https://maps.app.goo.gl/${'a'.repeat(2100)}`)), env(), d)).status).toBe(400);
    expect(d.fetch).not.toHaveBeenCalled();
  });
});

describe('/api/resolve with the server key', () => {
  it('uses the free resolveMapsUrls endpoint first', async () => {
    const d = deps(async (url) => {
      expect(url).toBe('https://mapstools.googleapis.com/v1:resolveMapsUrls');
      return jsonRes({ entities: [{ place: 'places/ChIJoQAAAAAAdkgRsgAAAAAAAAA' }] });
    });
    const res = await handleApi(req(resolveUrl(SHORT)), env('server-key'), d);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=3600');
    expect(await res.json()).toMatchObject({ kind: 'place', placeId: 'ChIJoQAAAAAAdkgRsgAAAAAAAAA', verified: true, via: 'resolveMapsUrls' });
    const init = d.fetch.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('server-key');
    // cached
    const again = await handleApi(req(resolveUrl(SHORT)), env('server-key'), d);
    expect(again.headers.get('x-cache')).toBe('HIT');
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to redirects, then verifies the ftid candidate (free id-only lookup)', async () => {
    const d = deps(async (url) => {
      if (url.startsWith('https://mapstools')) return jsonRes({ entities: [{}], failedRequests: { 0: { code: 3 } } });
      if (url.startsWith('https://maps.app.goo.gl/')) return redirect(AFTER_SHORT);
      if (url.startsWith('https://places.googleapis.com/v1/places/ChIJoQAAAAAAdkgRsgAAAAAAAAA')) return jsonRes({ id: 'ChIJoQAAAAAAdkgRsgAAAAAAAAA' });
      throw new Error(`unexpected ${url}`);
    });
    const res = await handleApi(req(resolveUrl(SHORT)), env('k'), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      kind: 'place',
      placeId: 'ChIJoQAAAAAAdkgRsgAAAAAAAAA',
      verified: true,
      via: 'redirects',
      name: 'Nowhere Greens cafe',
    });
    const hop = d.fetch.mock.calls.find(([u]) => u.startsWith('https://maps.app.goo.gl/'));
    expect(hop?.[1]?.redirect).toBe('manual');
    expect((hop?.[1]?.headers as Record<string, string>)['user-agent']).toBe('AtlasPad-Resolver/1.0 (+https://atlaspad.online)');
  });

  it('name → id via Text Search (ids-only field mask) when no id is in the link', async () => {
    const d = deps(async (url, init) => {
      if (url.startsWith('https://mapstools')) return jsonRes({ entities: [{}] });
      if (url === 'https://places.googleapis.com/v1/places:searchText') {
        expect((init?.headers as Record<string, string>)['X-Goog-FieldMask']).toBe('places.id');
        return jsonRes({ places: [{ id: 'ChIJ_found_by_name_123' }] });
      }
      throw new Error(`unexpected ${url}`);
    });
    const res = await handleApi(req(resolveUrl('https://www.google.com/maps/place/Kebab+Hut/@51.5,-0.1,16z')), env('k'), d);
    expect(await res.json()).toMatchObject({ placeId: 'ChIJ_found_by_name_123', verified: true, location: { lat: 51.5, lng: -0.1 } });
  });

  it('expired goo.gl link → 404', async () => {
    const d = deps(async (url) => (url.startsWith('https://mapstools') ? jsonRes({ entities: [{}] }) : new Response('', { status: 404 })));
    const res = await handleApi(req(resolveUrl('https://goo.gl/maps/abc123xyz')), env('k'), d);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });
});

describe('/api/resolve without a key (follow=1, redirects only)', () => {
  it('unwraps consent continue= without fetching consent.google.com', async () => {
    const d = deps(async (url) => {
      if (url.startsWith('https://maps.app.goo.gl/')) {
        return redirect(
          'https://consent.google.com/ml?continue=https://www.google.com/maps/place/?q%3Dplace_id:ChIJN1t_tDeuEmsRUsoyG83frY4&gl=GB',
        );
      }
      throw new Error(`must not fetch ${url}`);
    });
    const res = await handleApi(req(resolveUrl(SHORT, '&follow=1')), env(), d);
    expect(await res.json()).toMatchObject({ kind: 'place', placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4', verified: false });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns an unverified ftid candidate for the client to validate', async () => {
    const d = deps(async () => redirect(AFTER_SHORT));
    const res = await handleApi(req(resolveUrl(SHORT)), env(), d);
    expect(await res.json()).toMatchObject({ candidatePlaceId: 'ChIJoQAAAAAAdkgRsgAAAAAAAAA', verified: false, via: 'redirects' });
  });
});

describe('followRedirects (SSRF guard)', () => {
  it('refuses to leave the Google allowlist', async () => {
    const d = deps(async () => redirect('http://169.254.169.254/latest/meta-data'));
    expect(await followRedirects('https://maps.app.goo.gl/x', d)).toEqual({ error: 'upstream' });
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });
  it('refuses non-default ports and credentials in redirect targets', async () => {
    expect(await followRedirects('https://maps.app.goo.gl/x', deps(async () => redirect('https://www.google.com:8080/maps/@1,2,3z')))).toEqual({
      error: 'upstream',
    });
    expect(await followRedirects('https://maps.app.goo.gl/x', deps(async () => redirect('https://a:b@www.google.com/maps/@1,2,3z')))).toEqual({
      error: 'upstream',
    });
  });
  it('stops after 6 hops', async () => {
    let n = 0;
    const d = deps(async () => redirect(`https://maps.app.goo.gl/hop${++n}`));
    expect(await followRedirects('https://maps.app.goo.gl/start', d)).toEqual({ error: 'upstream' });
    expect(d.fetch).toHaveBeenCalledTimes(6);
  });
  it('upgrades http to https and resolves relative Location headers', async () => {
    const d = deps(async (url) => (url === 'https://maps.app.goo.gl/x' ? redirect('/maps/@51.5,-0.1,15z') : redirect('nope')));
    // relative to maps.app.goo.gl → https://maps.app.goo.gl/maps/@… which is still a short host → fetched again
    const out = await followRedirects('http://maps.app.goo.gl/x', d);
    expect(d.fetch.mock.calls[0]?.[0]).toBe('https://maps.app.goo.gl/x');
    expect(out).toHaveProperty('error');
  });
});

describe('/api/claim/phone', () => {
  const place = 'ChIJN1t_tDeuEmsRUsoyG83frY4';

  it('returns only a masked number + website host, never the raw number', async () => {
    const d = deps(async (url, init) => {
      expect(url).toBe(`https://places.googleapis.com/v1/places/${place}`);
      expect((init?.headers as Record<string, string>)['X-Goog-FieldMask']).toContain('internationalPhoneNumber');
      return jsonRes({
        id: place,
        internationalPhoneNumber: '+44 20 7946 0123',
        nationalPhoneNumber: '020 7946 0123',
        websiteUri: 'https://www.bosphorusgrill.example/menu',
        businessStatus: 'OPERATIONAL',
      });
    });
    const res = await handleApi(req(`/api/claim/phone?placeId=${place}`), env('k'), d);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('7946 0123');
    expect(text).not.toContain('79460123');
    expect(JSON.parse(text)).toEqual({
      placeId: place,
      hasPhone: true,
      masked: '+44 20 •••• ••23',
      websiteHost: 'bosphorusgrill.example',
      blocked: null,
      operational: true,
    });
    // cached for repeated opens
    await handleApi(req(`/api/claim/phone?placeId=${place}`), env('k'), d);
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it('flags missing and premium numbers', async () => {
    const none = await handleApi(req(`/api/claim/phone?placeId=${place}`), env('k'), deps(async () => jsonRes({ id: place })));
    expect(await none.json()).toMatchObject({ hasPhone: false, masked: null, blocked: 'no-phone' });
    __resetApiState();
    const prem = await handleApi(
      req(`/api/claim/phone?placeId=${place}`),
      env('k'),
      deps(async () => jsonRes({ id: place, internationalPhoneNumber: '+44 909 879 0000' })),
    );
    expect(await prem.json()).toMatchObject({ blocked: 'premium' });
  });

  it('validates input, needs the key, maps Google errors, rate-limits per IP', async () => {
    const d = deps(async () => jsonRes({ error: { status: 'NOT_FOUND' } }, 404));
    expect((await handleApi(req('/api/claim/phone?placeId=bad id'), env('k'), d)).status).toBe(400);
    expect((await handleApi(req('/api/claim/phone?placeId=demo-kebab123'), env('k'), d)).status).toBe(400);
    expect((await handleApi(req(`/api/claim/phone?placeId=${place}`), env(), d)).status).toBe(503);
    expect((await handleApi(req(`/api/claim/phone?placeId=${place}`), env('k'), d)).status).toBe(404);
    __resetApiState();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await handleApi(req(`/api/claim/phone?placeId=${place}`, { ip: '198.51.100.9' }), env('k'), d)).status;
    expect(last).toBe(429);
  });

  it('/api/listing/:placeId is an alias', async () => {
    const res = await handleApi(req(`/api/listing/${place}`), env('k'), deps(async () => jsonRes({ id: place, internationalPhoneNumber: '+61 2 9374 4000' })));
    expect(await res.json()).toMatchObject({ masked: '+61 2 9••• ••00' });
  });
});

describe('/api/claim/start + /api/claim/verify (simulated)', () => {
  const place = 'ChIJN1t_tDeuEmsRUsoyG83frY4';
  const post = (path: string, body: unknown, ip?: string) =>
    req(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, ...(ip ? { ip } : {}) });
  const d = () => deps(async () => jsonRes({}));

  it('starts a simulated call and locks the place for other claimants', async () => {
    const a = await handleApi(post('/api/claim/start', { placeId: place }), env(), d());
    expect(await a.json()).toMatchObject({ simulated: true, status: 'pending', channel: 'call', codeLength: 6 });
    const b = await handleApi(post('/api/claim/start', { placeId: place }, '192.0.2.44'), env(), d());
    expect(b.status).toBe(409);
    expect(await b.json()).toMatchObject({ error: 'claim_active' });
  });

  it('verifies the demo code; 3 wrong codes lock it', async () => {
    const wrong = await handleApi(post('/api/claim/verify', { placeId: place, code: '000000' }), env(), d());
    expect(await wrong.json()).toMatchObject({ approved: false, attemptsLeft: 2 });
    await handleApi(post('/api/claim/verify', { placeId: place, code: '000001' }), env(), d());
    await handleApi(post('/api/claim/verify', { placeId: place, code: '000002' }), env(), d());
    const locked = await handleApi(post('/api/claim/verify', { placeId: place, code: '482913' }), env(), d());
    expect(locked.status).toBe(429);
    __resetApiState();
    const ok = await handleApi(post('/api/claim/verify', { placeId: place, code: '482 913' }), env(), d());
    expect(await ok.json()).toMatchObject({ simulated: true, approved: true });
  });

  it('rejects bad bodies', async () => {
    expect((await handleApi(post('/api/claim/start', { placeId: 'x' }), env(), d())).status).toBe(400);
    expect((await handleApi(post('/api/claim/verify', { placeId: place, code: '12' }), env(), d())).status).toBe(400);
    expect((await handleApi(req('/api/claim/start', { method: 'POST', body: 'not json' }), env(), d())).status).toBe(400);
  });
});

describe('phone helpers', () => {
  it('masks per DESIGN §12.3', () => {
    expect(maskPhoneNumber('+44 20 7946 0123')).toBe('+44 20 •••• ••23');
    expect(maskPhoneNumber('+1 415-555-0100')).toBe('+1 41• ••• ••00');
    expect(maskPhoneNumber('020 7946 0123')).toBe('02• •••• ••23');
    expect(maskPhoneNumber('')).toBeNull();
  });
  it('detects premium / shared-cost numbers', () => {
    expect(isPremiumNumber('+44 909 879 0000')).toBe(true);
    expect(isPremiumNumber('+44 871 123 4567')).toBe(true);
    expect(isPremiumNumber('+44 20 7946 0123')).toBe(false);
    expect(isPremiumNumber('+1 900 555 0100')).toBe(true);
    expect(isPremiumNumber('+1 415 555 0100')).toBe(false);
  });
});
