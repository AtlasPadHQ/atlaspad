/**
 * Mainnet build, launch configuration (no dev endpoints, H6): phone verification is optional (mainnet starts without
 * Twilio), the website code is how owners verify meanwhile, manual review is closed until its tooling exists, and every
 * claim still alerts the site owner.
 */
import './test/globalsMainnet';
import { beforeAll, describe, expect, it } from 'vitest';
import { placeAddresses } from './addresses';
import { b58encode } from './bytes';
import { __resetHealthCache } from './configRoute';
import { CONFIG_PDA, GENESIS, PUMP_GLOBAL, PUMP_PROGRAM, SHOP_VAULT_PROGRAM_ID } from './consts';
import type { Deps } from './ctx';
import { manualReviewEnabled, type Env } from './env';
import { phoneMode, twilioPartlyConfigured } from './phone';
import { handlePhase2 } from './router';
import { altData, configData, FakeWorld, pumpGlobalData, vaultStateData } from './test/fakeChain';
import { FakeD1 } from './test/fakeD1';
import { NodeBuffer, web3 } from './test/launchFixture';
import type { ClaimWebsiteResponse, ConfigResponse, HealthResponse } from './wire';

const ORIGIN = 'https://atlaspad.online';
const HOOK = 'https://discord.com/api/webhooks/42/mainnet-hook-token';
const world = new FakeWorld();
world.chain.genesis = GENESIS.mainnet;
const db = new FakeD1();
const attestor = web3.Keypair.generate();
const ALT = web3.Keypair.generate().publicKey.toBase58();
const b64 = (u: Uint8Array) => NodeBuffer.from(u).toString('base64');
const PLACE = 'ChIJmainnetwebsite01';

/** The mainnet launch setup: no TWILIO_* secrets, website verification on, an alert webhook. */
const base: Env = {
  ASSETS: { fetch: async () => new Response('x') } as unknown as Fetcher,
  DB: db.asD1(),
  CLUSTER: 'mainnet',
  PUBLIC_ORIGIN: ORIGIN,
  PROGRAM_ID: SHOP_VAULT_PROGRAM_ID,
  ALT_ADDRESS: ALT,
  FEATURE_WEBSITE_VERIFY: '1',
  GOOGLE_SERVER_KEY: 'google-server-key-test-0004',
  ALCHEMY_API_KEY: 'alchemy-mainnet-secret-0004',
  ATTESTOR_SECRET: b64(attestor.secretKey),
  CRANK_SECRET: b64(web3.Keypair.generate().secretKey),
  HMAC_KEY: b64(crypto.getRandomValues(new Uint8Array(32))),
  ALERT_WEBHOOK_URL: HOOK,
};
const posts: string[] = [];
const clock = Date.UTC(2026, 9, 27, 12);
const deps: Deps = {
  fetch: async (input, init) => {
    if (input.startsWith('https://discord.com/')) {
      posts.push((JSON.parse(String(init?.body)) as { content: string }).content);
      return new Response(null, { status: 204 });
    }
    return world.fetch(input, init);
  },
  now: () => clock,
};
const pending: Promise<unknown>[] = [];
const exec = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };

async function call<T>(env: Env, method: string, path: string, body?: unknown, ip = '203.0.113.7'): Promise<{ status: number; body: T }> {
  const init: RequestInit = { method, headers: { 'cf-connecting-ip': ip, ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}) } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = (await handlePhase2(new Request(`${ORIGIN}${path}`, init), env, exec, deps)) ?? new Response('{"error":"fallthrough"}', { status: 599 });
  const text = await res.text();
  while (pending.length) await Promise.allSettled(pending.splice(0));
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

beforeAll(async () => {
  const c = world.chain;
  c.set(CONFIG_PDA, { lamports: 1n, owner: SHOP_VAULT_PROGRAM_ID, data: configData({ attestor: attestor.publicKey.toBase58(), guardian: web3.Keypair.generate().publicKey.toBase58(), governance: web3.Keypair.generate().publicKey.toBase58(), window: 259_200, flavor: 0 }) });
  c.set(ALT, { lamports: 1n, owner: 'AddressLookupTab1e1111111111111111111111111', data: altData() });
  c.set(PUMP_GLOBAL, { lamports: 1n, owner: PUMP_PROGRAM, data: pumpGlobalData() });
  world.places.set(PLACE, { id: PLACE, businessStatus: 'OPERATIONAL', primaryType: 'cafe', types: ['cafe'], internationalPhoneNumber: '+44 20 7946 0777', websiteUri: 'https://www.mainnetcafe.co.uk/' });
  const a = await placeAddresses(PLACE, SHOP_VAULT_PROGRAM_ID);
  const mint = web3.Keypair.generate().publicKey.toBase58();
  db.raw.prepare("INSERT INTO assets(id, content_type, bytes, width, height, created_at) VALUES ('a', 'image/png', x'00', 1, 1, 0)").run();
  db.raw.prepare("INSERT INTO metadata(id, json, name, symbol, description, image_id, place_id, created_at) VALUES ('m', '{}', 'Main Cafe', 'MAIN', '', 'a', ?, 0)").run(PLACE);
  db.raw
    .prepare(
      `INSERT INTO coins(place_id, place_hash, mint, vault, vault_state, bonding_curve, ticker, name, category, emoji, bg, metadata_id, launcher, created_at, launch_sig, launch_slot, cluster, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'MAIN', 'Main Cafe', 'cafe', '☕', '#000000', 'm', ?, ?, ?, 1, 'mainnet', ?)`,
    )
    .run(PLACE, a.placeHashHex, mint, a.vault, a.vaultState, web3.Keypair.generate().publicKey.toBase58(), web3.Keypair.generate().publicKey.toBase58(), clock, b58encode(new Uint8Array(64).fill(4)), clock);
  c.set(a.vaultState, { lamports: 1n, owner: SHOP_VAULT_PROGRAM_ID, data: vaultStateData({ placeHashHex: a.placeHashHex, mint, launcher: web3.Keypair.generate().publicKey.toBase58() }) });
});

describe('mainnet without Twilio (phone verification optional)', () => {
  it('any missing TWILIO_* secret: config says phoneVerification "none", and health reports it as off, not broken', async () => {
    for (const partial of [{}, { TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'twilio-auth-token-x' }, { TWILIO_VERIFY_SID: `VA${'2'.repeat(32)}` }]) {
      const env = { ...base, ...partial };
      expect(phoneMode(env, 'mainnet'), JSON.stringify(Object.keys(partial))).toBe('none');
      const cfg = await call<ConfigResponse>(env, 'GET', '/api/config');
      expect(cfg.body.features.phoneVerification).toBe('none');
      expect(cfg.body.features.websiteVerification).toBe(true);
    }
    __resetHealthCache();
    const off = await call<HealthResponse>(base, 'GET', '/api/health');
    expect(off.body.checks.phone).toBe('n/a');
    // only some of the three: a setup mistake, shown as missing
    expect(twilioPartlyConfigured({ ...base, TWILIO_AUTH_TOKEN: 'twilio-auth-token-x' })).toBe(true);
    expect(twilioPartlyConfigured(base)).toBe(false);
    __resetHealthCache();
    const partial = await call<HealthResponse>({ ...base, TWILIO_AUTH_TOKEN: 'twilio-auth-token-x' }, 'GET', '/api/health');
    expect(partial.body.checks.phone).toBe('missing');
  });

  it('a phone claim answers 503 not_configured; the website code works', async () => {
    const r = await call<{ error: string }>(base, 'POST', '/api/claim/call', { placeId: PLACE });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('not_configured');
    const w = await call<ClaimWebsiteResponse>(base, 'POST', '/api/claim/website', { placeId: PLACE });
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ status: 'code', host: 'www.mainnetcafe.co.uk' });
  });
});

describe('manual review (FEATURE_MANUAL_REVIEW)', () => {
  it('is off on mainnet by default: hidden in config, refused by the API on both routes', async () => {
    expect(manualReviewEnabled(base, 'mainnet')).toBe(false);
    expect((await call<ConfigResponse>(base, 'GET', '/api/config')).body.features.manualReview).toBe(false);
    const body = { placeId: PLACE, reason: 'manual_claim', details: 'Code CS-ABCD posted at https://instagram.com/p/x' };
    const a = await call<{ error: string }>(base, 'POST', '/api/claim/manual', body);
    expect(a.status).toBe(404);
    expect(a.body.error).toBe('not_enabled');
    const b = await call<{ error: string }>(base, 'POST', '/api/report', { ...body, kind: 'manual_claim' });
    expect(b.body.error).toBe('not_enabled');
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM reports WHERE kind = 'manual_claim'")!.n).toBe(0);
    // reports and opt-outs are not affected
    expect((await call(base, 'POST', '/api/report', { kind: 'report', placeId: PLACE, reason: 'scam' })).status).toBe(204);
  });

  it('FEATURE_MANUAL_REVIEW=1 opens it (and =0 closes it on devnet)', async () => {
    const on = { ...base, FEATURE_MANUAL_REVIEW: '1' };
    expect((await call<ConfigResponse>(on, 'GET', '/api/config')).body.features.manualReview).toBe(true);
    expect((await call(on, 'POST', '/api/claim/manual', { placeId: PLACE, reason: 'manual_claim', wallet: web3.Keypair.generate().publicKey.toBase58() }, '203.0.113.8')).status).toBe(204);
    expect(posts.at(-1)).toMatch(/^\[AtlasPad mainnet\] Manual-review claim requested\n/);
    expect(manualReviewEnabled({ FEATURE_MANUAL_REVIEW: '0' } as Env, 'devnet')).toBe(false);
    expect(manualReviewEnabled({} as Env, 'devnet')).toBe(true);
  });
});

describe('owner alerts on mainnet', () => {
  it('links use the public origin and mainnet Solscan (no cluster parameter)', async () => {
    expect((await call(base, 'POST', '/api/report', { kind: 'optout', placeId: PLACE, reason: 'optout', contact: 'me@mainnetcafe.co.uk' }, '203.0.113.9')).status).toBe(204);
    const text = posts.at(-1)!;
    expect(text).toMatch(/^\[AtlasPad mainnet\] Opt-out requested/);
    expect(text).toMatch(new RegExp(`Coin: <${ORIGIN}/c/[1-9A-HJ-NP-Za-km-z]+>`));
    expect(text).toMatch(/Explorer: <https:\/\/solscan\.io\/token\/[1-9A-HJ-NP-Za-km-z]+>/);
    expect(text).toContain('--env mainnet --optout ChIJmainnetwebsite01 --execute');
    expect(text).not.toContain('mainnetcafe');
  });
});
