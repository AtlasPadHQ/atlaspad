// node --test scripts/test/   (the AtlasPad domain and brand in the OPS scripts: no network; reads only repo files)
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { googleReferrerPrompt, MAINNET_ORIGIN, PHRASE } from '../go-mainnet.mjs';
import { Checks } from '../lib/log.mjs';
import { canonicalAlternates, isBareHttpsOrigin, originProblems, publicOrigin, zoneProblems } from '../lib/origin.mjs';
import { ORIGINS, ROOT, WORKERS_DEV_ORIGINS } from '../lib/paths.mjs';
import { readWranglerConfig } from '../lib/wrangler.mjs';
import { CARD, chromeArgs, pngSize } from '../og-card.mjs';
import { checkCanonical, originOk, smokeTarget } from '../smoke.mjs';
import { watchdogOrigin } from '../watchdog.mjs';

const mainnetEnv = (over = {}) => ({
  env: {
    mainnet: {
      vars: { PUBLIC_ORIGIN: 'https://atlaspad.online' },
      routes: [
        { pattern: 'atlaspad.online', custom_domain: true },
        { pattern: 'www.atlaspad.online', custom_domain: true },
      ],
      assets: { run_worker_first: ['/*', '!/assets/*'] },
      ...over,
    },
  },
});

test('go-mainnet: the AtlasPad phrase, origin and Google referrer prompt', () => {
  assert.equal(PHRASE, 'DEPLOY ATLASPAD TO MAINNET');
  assert.equal(MAINNET_ORIGIN, 'https://atlaspad.online');
  assert.equal(googleReferrerPrompt(), 'the Google browser key allows the referrer https://atlaspad.online/*');
  assert.equal(googleReferrerPrompt('https://example.test'), 'the Google browser key allows the referrer https://example.test/*');
});

test('the repo wrangler.jsonc serves mainnet at atlaspad.online and keeps devnet on workers.dev', () => {
  const cfg = readWranglerConfig();
  assert.equal(publicOrigin('mainnet', cfg), 'https://atlaspad.online');
  assert.equal(publicOrigin('devnet', cfg), 'https://cornershop-devnet.tiejiucai.workers.dev');
  assert.deepEqual(originProblems('mainnet', cfg), []);
  assert.deepEqual(originProblems('devnet', cfg), []);
  assert.equal(cfg.env.devnet.routes, undefined, 'devnet has no custom domain');
  // every page (and /meta, /img) runs the Worker first on both real Workers: the sanctions geo-block (worker/geo.ts) and,
  // on mainnet, the canonical-host redirect; only plain static files skip it
  for (const env of ['devnet', 'mainnet']) {
    const rwf = cfg.env[env].assets.run_worker_first;
    assert.equal(rwf[0], '/*', `${env}: pages reach the Worker`);
    assert.ok(rwf.includes('!/assets/*'), `${env}: hashed bundles stay static`);
    assert.ok(!rwf.some((r) => /meta|img|api/.test(r)), `${env}: /meta, /img and /api are not excluded`);
  }
  assert.equal(cfg.env.mainnet.workers_dev, true, 'workers.dev stays on (it redirects to the domain)');
});

test('publicOrigin: wrangler PUBLIC_ORIGIN when it is a bare https origin, else the default', () => {
  assert.equal(ORIGINS.mainnet, 'https://atlaspad.online');
  assert.equal(publicOrigin('mainnet', mainnetEnv()), 'https://atlaspad.online');
  assert.equal(publicOrigin('mainnet', mainnetEnv({ vars: { PUBLIC_ORIGIN: 'https://shop.example' } })), 'https://shop.example');
  assert.equal(publicOrigin('mainnet', mainnetEnv({ vars: { PUBLIC_ORIGIN: 'https://shop.example/' } })), 'https://atlaspad.online'); // not bare
  assert.equal(publicOrigin('mainnet', mainnetEnv({ vars: {} })), 'https://atlaspad.online');
  assert.equal(publicOrigin('devnet', {}), ORIGINS.devnet);
  assert.equal(isBareHttpsOrigin('https://atlaspad.online'), true);
  assert.equal(isBareHttpsOrigin('http://atlaspad.online'), false);
  assert.equal(isBareHttpsOrigin('https://atlaspad.online/x'), false);
});

test('canonical alternates: workers.dev and www redirect to the apex; devnet has none', () => {
  assert.deepEqual(canonicalAlternates('https://atlaspad.online', 'mainnet'), [WORKERS_DEV_ORIGINS.mainnet, 'https://www.atlaspad.online']);
  assert.deepEqual(canonicalAlternates(WORKERS_DEV_ORIGINS.devnet, 'devnet'), []);
  assert.deepEqual(canonicalAlternates(WORKERS_DEV_ORIGINS.mainnet, 'mainnet'), []);
  assert.deepEqual(canonicalAlternates('https://app.example.com', 'mainnet'), [WORKERS_DEV_ORIGINS.mainnet]);
});

test('originProblems: custom domains and page routing are required for a custom domain', () => {
  assert.deepEqual(originProblems('mainnet', mainnetEnv()), []);
  assert.ok(originProblems('mainnet', mainnetEnv({ routes: [{ pattern: 'atlaspad.online', custom_domain: true }] })).some((p) => /www\.atlaspad\.online/.test(p)));
  assert.ok(originProblems('mainnet', mainnetEnv({ routes: [{ pattern: 'atlaspad.online/*', zone_name: 'atlaspad.online' }] })).some((p) => /"atlaspad.online", "custom_domain": true/.test(p)));
  assert.ok(originProblems('mainnet', mainnetEnv({ assets: { run_worker_first: ['/api/*'] } })).some((p) => /run_worker_first/.test(p)));
  assert.deepEqual(originProblems('mainnet', mainnetEnv({ assets: { run_worker_first: true } })), []);
  assert.match(originProblems('mainnet', mainnetEnv({ vars: { PUBLIC_ORIGIN: 'https://atlaspad.online/app' } }))[0], /bare https origin/);
  assert.deepEqual(originProblems('mainnet', mainnetEnv({ vars: { PUBLIC_ORIGIN: WORKERS_DEV_ORIGINS.mainnet }, routes: undefined })), []);
  assert.match(originProblems('mainnet', {})[0], /no env.mainnet/);
});

test('zoneProblems: the custom domain must be a live Cloudflare zone before go-mainnet deploys (fake DNS)', async () => {
  const dns = (table) => {
    const asked = [];
    const resolveNs = async (h) => {
      asked.push(h);
      if (table[h]) return table[h];
      throw Object.assign(new Error('queryNs ENODATA'), { code: 'ENODATA' });
    };
    return { resolveNs, asked };
  };
  const cf = dns({ 'atlaspad.online': ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] });
  assert.deepEqual(await zoneProblems('https://atlaspad.online', cf.resolveNs), []);
  const sub = dns({ 'example.com': ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] });
  assert.deepEqual(await zoneProblems('https://app.example.com', sub.resolveNs), []);
  assert.deepEqual(sub.asked, ['app.example.com', 'example.com'], 'walks up to the zone apex, never to the TLD');
  const parked = await zoneProblems('https://atlaspad.online', dns({ 'atlaspad.online': ['dns1.registrar-servers.com', 'dns2.registrar-servers.com'] }).resolveNs);
  assert.match(parked[0], /atlaspad\.online is not on Cloudflare yet: its nameservers are dns1\.registrar-servers\.com/);
  const mixed = await zoneProblems('https://atlaspad.online', dns({ 'atlaspad.online': ['ada.ns.cloudflare.com', 'dns2.registrar-servers.com'] }).resolveNs);
  assert.equal(mixed.length, 1);
  const none = dns({});
  assert.match((await zoneProblems('https://atlaspad.online', none.resolveNs))[0], /no nameservers found for atlaspad\.online \(ENODATA\)/);
  assert.deepEqual(none.asked, ['atlaspad.online']);
  assert.deepEqual(await zoneProblems(WORKERS_DEV_ORIGINS.devnet, none.resolveNs), [], 'workers.dev needs no zone');
});

test('smoke: defaults to the cluster PUBLIC_ORIGIN; atlaspad.online is an allowed target', () => {
  const cfg = mainnetEnv();
  assert.deepEqual(smokeTarget({ _: [], cluster: 'mainnet' }, cfg), { origin: 'https://atlaspad.online', cluster: 'mainnet' });
  assert.deepEqual(smokeTarget({ _: ['https://atlaspad.online'] }, cfg), { origin: 'https://atlaspad.online', cluster: 'mainnet' });
  assert.deepEqual(smokeTarget({ _: [WORKERS_DEV_ORIGINS.devnet] }, cfg), { origin: WORKERS_DEV_ORIGINS.devnet, cluster: 'devnet' });
  assert.deepEqual(smokeTarget({ _: ['http://127.0.0.1:8787'], cluster: 'devnet' }, cfg), { origin: 'http://127.0.0.1:8787', cluster: 'devnet' });
  assert.deepEqual(smokeTarget({ _: [] }, cfg), { origin: undefined, cluster: undefined });
  assert.equal(originOk('https://atlaspad.online'), true);
  assert.equal(originOk('https://www.atlaspad.online'), true);
  assert.equal(originOk('https://atlaspad.online.evil.example'), false);
  assert.equal(originOk('https://notatlaspad.online'), false);
});

test('smoke checkCanonical: www, workers.dev and plain http 301 pages to the domain; www / workers.dev refuse the API', async () => {
  const MAIN = 'https://atlaspad.online';
  const good = (url) => {
    const u = new URL(url);
    if (u.pathname.startsWith('/api/')) return { status: 421, headers: new Headers(), json: { error: 'wrong_host' } };
    return { status: 301, headers: new Headers({ location: `${MAIN}${u.pathname}${u.search}` }), json: null };
  };
  const run = async (respond, origin = MAIN, cluster = 'mainnet') => {
    const asked = [];
    const checks = new Checks();
    await checkCanonical({ call: async (url) => (asked.push(url), respond(url)), origin, cluster, checks });
    return { asked, checks };
  };
  const ok = await run(good);
  assert.deepEqual(ok.asked, [
    `${WORKERS_DEV_ORIGINS.mainnet}/c/smoke?x=1`,
    `${WORKERS_DEV_ORIGINS.mainnet}/api/health`,
    'https://www.atlaspad.online/c/smoke?x=1',
    'https://www.atlaspad.online/api/health',
    'http://atlaspad.online/c/smoke?x=1',
  ]);
  assert.equal(ok.checks.items.length, 5);
  assert.deepEqual(ok.checks.failed, []);
  // www served the app instead of redirecting, and its API answered
  const www = await run((url) => (url.startsWith('https://www.') ? { status: 200, headers: new Headers(), json: { ok: true } } : good(url)));
  assert.deepEqual(www.checks.failed.map((f) => f.what), [`https://www.atlaspad.online page → 301 ${MAIN}`, 'https://www.atlaspad.online/api → 421 wrong_host']);
  // a redirect somewhere else is a failure too
  const elsewhere = await run((url) => (url.startsWith('http://') ? { status: 301, headers: new Headers({ location: 'https://evil.example/c/smoke?x=1' }), json: null } : good(url)));
  assert.deepEqual(elsewhere.checks.failed.map((f) => f.what), [`http://atlaspad.online page → 301 ${MAIN}`]);
  // devnet (its origin IS workers.dev) and local runs check nothing
  for (const [origin, cluster] of [[WORKERS_DEV_ORIGINS.devnet, 'devnet'], ['http://127.0.0.1:8787', 'devnet']]) {
    const r = await run(good, origin, cluster);
    assert.deepEqual(r.asked, [], origin);
    assert.equal(r.checks.items.length, 0, origin);
  }
});

test('share card: public/og.png is the 1200×630 AtlasPad card, index.html points at it on the domain', () => {
  assert.deepEqual(pngSize(readFileSync(join(ROOT, 'public', 'og.png'))), { width: CARD.width, height: CARD.height });
  assert.equal(pngSize(Buffer.from('GIF89a not a png at all')), null);
  const card = readFileSync(join(ROOT, 'design', 'og-card.html'), 'utf8');
  for (const s of ['#0e7c47', '>ATLASPAD<', 'Launch a coin for any business on earth', 'atlaspad.online', 'src/styles/fonts/roboto-flex-wordmark.woff2']) assert.ok(card.includes(s), s);
  assert.doesNotMatch(card, /DEMO|simulated|\$\d|▲|▼/, 'no demo badge, no fake numbers');
  // its local fonts exist and are published: research/, videos/, marketing/ and the rest of design/ are not
  const fonts = [...card.matchAll(/url\("(\.\.\/[^"]+)"\)/g)].map((m) => relative(ROOT, resolve(dirname(join(ROOT, 'design', 'og-card.html')), m[1])));
  assert.deepEqual(fonts, ['src/styles/fonts/roboto-flex-wordmark.woff2', 'brand/x/RobotoFlex-latin.woff2']);
  for (const f of fonts) assert.ok(existsSync(join(ROOT, f)), f);
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const tag of ['property="og:url" content="https://atlaspad.online/"', 'property="og:image" content="https://atlaspad.online/og.png"', 'name="twitter:image" content="https://atlaspad.online/og.png"', 'property="og:site_name" content="AtlasPad"']) {
    assert.ok(html.includes(tag), tag);
  }
  assert.doesNotMatch(html, /tiejiucai\.workers\.dev/);
  const a = chromeArgs('file:///x/og-card.html', '/tmp/og.png', '/tmp/profile');
  assert.ok(a.includes('--window-size=1200,630') && a.includes('--screenshot=/tmp/og.png') && a.includes('--user-data-dir=/tmp/profile'));
  assert.equal(a.at(-1), 'file:///x/og-card.html');
});

test('watchdog: checks the mainnet PUBLIC_ORIGIN unless --origin says otherwise', () => {
  assert.equal(watchdogOrigin({ _: [] }, 'mainnet', mainnetEnv()), 'https://atlaspad.online');
  assert.equal(watchdogOrigin({ _: [] }, 'devnet', {}), ORIGINS.devnet);
  assert.equal(watchdogOrigin({ _: [], origin: 'none' }, 'mainnet'), null);
  assert.equal(watchdogOrigin({ _: [], origin: WORKERS_DEV_ORIGINS.mainnet }, 'mainnet'), WORKERS_DEV_ORIGINS.mainnet);
});
