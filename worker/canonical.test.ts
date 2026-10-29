/**
 * Canonical host (worker/canonical.ts): www, workers.dev, plain http and other ports 301 page requests to PUBLIC_ORIGIN
 * with path and query kept (never anywhere else), API calls there get a JSON 421 wrong_host, and the canonical origin,
 * local dev hosts and the demo Worker (no PUBLIC_ORIGIN) pass through. Plus the hook's place in worker/index.ts.
 */
import { setBuild } from './test/globals';
import { describe, expect, it, vi } from 'vitest';
import { canonicalHostResponse, canonicalOrigin, isLocalHost } from './canonical';
import { publicOrigin, type Env } from './env';
import worker from './index';

setBuild('demo', false); // the hook must not depend on the cluster

const MAIN = 'https://atlaspad.online';
const WWW = 'https://www.atlaspad.online';
const WD = 'https://cornershop.tiejiucai.workers.dev';
const DEVNET = 'https://cornershop-devnet.tiejiucai.workers.dev';

const env = (over: Partial<Env> = {}): Env => ({
  ASSETS: { fetch: vi.fn(async () => new Response('<!doctype html><title>x</title>', { headers: { 'content-type': 'text/html' } })) } as unknown as Fetcher,
  PUBLIC_ORIGIN: MAIN,
  ...over,
});
const get = (url: string, method = 'GET', body?: string) => new Request(url, { method, body, headers: body ? { 'content-type': 'application/json' } : {} });

describe('canonicalHostResponse', () => {
  it('301s page requests on www and workers.dev to the same path and query on PUBLIC_ORIGIN', () => {
    for (const [from, to] of [
      [`${WWW}/`, `${MAIN}/`],
      [`${WWW}/c/9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin?ref=x&y=%20z`, `${MAIN}/c/9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin?ref=x&y=%20z`],
      [`${WD}/p/ChIJcafe0000000000001`, `${MAIN}/p/ChIJcafe0000000000001`],
      [`${WD}/meta/0123456789abcdef0123456789abcdef.json`, `${MAIN}/meta/0123456789abcdef0123456789abcdef.json`],
      [`${WD}/terms.html`, `${MAIN}/terms.html`],
      [`${WD}/apix`, `${MAIN}/apix`], // only /api and /api/* are API paths
    ]) {
      const res = canonicalHostResponse(get(from!), env());
      expect(res?.status, from).toBe(301);
      expect(res?.headers.get('location'), from).toBe(to);
      expect(res?.headers.get('cache-control')).toMatch(/max-age=86400/);
    }
    const head = canonicalHostResponse(get(`${WWW}/og.png`, 'HEAD'), env());
    expect(head?.status).toBe(301);
    expect(head?.headers.get('location')).toBe(`${MAIN}/og.png`);
  });

  it('the canonical host over plain http or another port is not the canonical origin either', async () => {
    for (const [from, to] of [
      ['http://atlaspad.online/c/kebab?x=1', `${MAIN}/c/kebab?x=1`],
      ['https://atlaspad.online:8443/', `${MAIN}/`],
      ['http://www.atlaspad.online/p/ChIJcafe0000000000001', `${MAIN}/p/ChIJcafe0000000000001`],
      [DEVNET.replace('https:', 'http:') + '/c/x', `${DEVNET}/c/x`],
    ]) {
      const res = canonicalHostResponse(get(from!), env({ PUBLIC_ORIGIN: from!.includes('devnet') ? DEVNET : MAIN }));
      expect(res?.status, from).toBe(301);
      expect(res?.headers.get('location'), from).toBe(to);
    }
    const api = canonicalHostResponse(get('http://atlaspad.online/api/rpc', 'POST', '{}'), env());
    expect(api?.status).toBe(421);
    expect(((await api!.json()) as { origin: string }).origin).toBe(MAIN);
  });

  it('never redirects off PUBLIC_ORIGIN, whatever the path looks like (no open redirect)', () => {
    for (const path of ['//evil.example/x', '/\\evil.example', '/%2F%2Fevil.example', '/@evil.example', '/..//evil.example']) {
      const res = canonicalHostResponse(get(`${WWW}${path}`), env());
      expect(res?.status, path).toBe(301);
      const loc = res!.headers.get('location')!;
      expect(loc.startsWith(`${MAIN}/`), `${path} → ${loc}`).toBe(true);
      expect(new URL(loc).origin, `${path} → ${loc}`).toBe(MAIN);
    }
  });

  it('coin metadata and art redirects stay readable cross-origin (wallets fetch them with CORS)', () => {
    expect(canonicalHostResponse(get(`${WD}/meta/0123456789abcdef0123456789abcdef.json`), env())?.headers.get('access-control-allow-origin')).toBe('*');
    expect(canonicalHostResponse(get(`${WD}/img/0123456789abcdef0123456789abcdef.png`), env())?.headers.get('access-control-allow-origin')).toBe('*');
    expect(canonicalHostResponse(get(`${WD}/c/kebab`), env())?.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers API calls (and other methods) on a non-canonical host with a JSON 421 wrong_host', async () => {
    for (const req of [get(`${WD}/api/health`), get(`${WWW}/api`), get(`${WD}/api/og/c/kebab.png`), get(`${WD}/api/rpc`, 'POST', '{}'), get(`${WWW}/c/x`, 'POST', '{}')]) {
      const res = canonicalHostResponse(req, env());
      expect(res?.status, req.url).toBe(421);
      expect(res?.headers.get('content-type')).toContain('application/json');
      expect(res?.headers.get('location')).toBeNull();
      const body = (await res!.json()) as { error: string; message: string; origin: string };
      expect(body).toEqual({ error: 'wrong_host', message: `AtlasPad answers only at ${MAIN}. Use that address.`, origin: MAIN });
    }
  });

  it('passes the canonical host, local dev hosts and the demo Worker through', () => {
    expect(canonicalHostResponse(get(`${MAIN}/`), env())).toBeNull();
    expect(canonicalHostResponse(get(`${MAIN}/api/config`), env())).toBeNull();
    expect(canonicalHostResponse(get(`${MAIN}/api/rpc`, 'POST', '{}'), env())).toBeNull();
    for (const local of ['http://127.0.0.1:8787/api/config', 'http://localhost:5173/', 'http://[::1]:8787/', 'http://app.localhost:8787/c/x']) {
      expect(canonicalHostResponse(get(local), env()), local).toBeNull();
    }
    expect(canonicalHostResponse(get(`${WD}/`), env({ PUBLIC_ORIGIN: undefined }))).toBeNull(); // Phase-1 demo Worker
    expect(canonicalHostResponse(get(`${WD}/`), env({ PUBLIC_ORIGIN: 'https://atlaspad.online/' }))).toBeNull(); // not a bare origin
    // devnet: PUBLIC_ORIGIN is its own workers.dev host
    expect(canonicalHostResponse(get(`${DEVNET}/api/config`), env({ PUBLIC_ORIGIN: DEVNET }))).toBeNull();
    expect(canonicalHostResponse(get(`${DEVNET}/c/x`), env({ PUBLIC_ORIGIN: DEVNET }))).toBeNull();
    expect(canonicalHostResponse(get(`${DEVNET}/api/rpc`, 'POST', '{}'), env({ PUBLIC_ORIGIN: DEVNET }))).toBeNull();
  });

  it('helpers', () => {
    expect(canonicalOrigin({ PUBLIC_ORIGIN: ' https://atlaspad.online ' })).toBe(MAIN);
    expect(canonicalOrigin({ PUBLIC_ORIGIN: 'http://atlaspad.online' })).toBeNull();
    expect(canonicalOrigin({})).toBeNull();
    expect(isLocalHost('LOCALHOST')).toBe(true);
    expect(isLocalHost('atlaspad.online')).toBe(false);
    expect(isLocalHost('localhost.atlaspad.online')).toBe(false);
    // the mainnet fallback origin (PUBLIC_ORIGIN missing) is the domain too; the demo keeps workers.dev
    expect(publicOrigin({ ASSETS: env().ASSETS }, 'mainnet')).toBe(MAIN);
    expect(publicOrigin({ ASSETS: env().ASSETS }, 'devnet')).toBe(DEVNET);
    expect(publicOrigin({ ASSETS: env().ASSETS }, null)).toBe(WD);
  });
});

describe('worker/index.ts runs the canonical-host check first', () => {
  it('redirects a www share page without touching the assets or the database', async () => {
    const e = env();
    const res = await worker.fetch(get(`${WWW}/c/kebab?utm=x`), e);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`${MAIN}/c/kebab?utm=x`);
    expect(e.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('refuses the share-image API on workers.dev before the og handler, and serves pages on the canonical host', async () => {
    const e = env();
    expect((await worker.fetch(get(`${WD}/api/og/c/kebab.png`), e)).status).toBe(421);
    const page = await worker.fetch(get(`${MAIN}/terms`), e);
    expect(page.status).toBe(200);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(e.ASSETS.fetch).toHaveBeenCalledTimes(1);
  });
});
