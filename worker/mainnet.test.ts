/**
 * Mainnet-build behaviour (no dev endpoints compiled in, H6) + the Twilio Verify adapter (INTEGRATION §3.5) with a
 * fake fetch: call start, code check by verification sid, error mapping, /api/health code_length check.
 */
import './test/globalsMainnet';
import { beforeAll, describe, expect, it } from 'vitest';
import { b58encode } from './bytes';
import { CONFIG_PDA, PUMP_GLOBAL, PUMP_PROGRAM, SHOP_VAULT_PROGRAM_ID } from './consts';
import type { Deps } from './ctx';
import type { Env } from './env';
import { handlePhase2 } from './router';
import { phoneMode } from './phone';
import { mapError, TwilioVerifier } from './twilio';
import { altData, configData, curveData, FakeWorld, pumpGlobalData, vaultStateData } from './test/fakeChain';
import { FakeD1 } from './test/fakeD1';
import { NodeBuffer, web3 } from './test/launchFixture';
import { GENESIS } from './consts';
import type { ClaimCallResponse, ClaimCheckResponse, ConfigResponse } from './wire';

const ORIGIN = 'https://atlaspad.online'; // env.mainnet PUBLIC_ORIGIN (wrangler.jsonc)
const world = new FakeWorld();
world.chain.genesis = GENESIS.mainnet;
const db = new FakeD1();
const attestor = web3.Keypair.generate();
const ALT = web3.Keypair.generate().publicKey.toBase58();
const b64 = (u: Uint8Array) => NodeBuffer.from(u).toString('base64');
const TWILIO = { TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'twilio-auth-token-secret', TWILIO_VERIFY_SID: `VA${'2'.repeat(32)}` };

const base: Env = {
  ASSETS: { fetch: async () => new Response('x') } as unknown as Fetcher,
  DB: db.asD1(),
  CLUSTER: 'mainnet',
  PUBLIC_ORIGIN: ORIGIN,
  PROGRAM_ID: SHOP_VAULT_PROGRAM_ID,
  ALT_ADDRESS: ALT,
  MAX_DEV_BUY_LAMPORTS: '1000000000',
  PRIORITY_FEE_DEFAULT: '50000',
  FEATURE_WEBSITE_VERIFY: '1',
  GOOGLE_SERVER_KEY: 'google-server-key-test-0002',
  ALCHEMY_API_KEY: 'alchemy-mainnet-secret-999',
  ATTESTOR_SECRET: b64(attestor.secretKey),
  CRANK_SECRET: b64(web3.Keypair.generate().secretKey),
  HMAC_KEY: b64(crypto.getRandomValues(new Uint8Array(32))),
  // a stray faucet secret must change nothing on mainnet
  DEV_FAUCET_SECRET: b64(web3.Keypair.generate().secretKey),
};
const deps: Deps = { fetch: world.fetch, now: () => Date.UTC(2026, 9, 8, 12) };
const exec = { waitUntil: () => undefined };

async function call<T>(env: Env, method: string, path: string, body?: unknown): Promise<{ status: number; body: T; text: string }> {
  const init: RequestInit = { method, headers: { 'cf-connecting-ip': '203.0.113.5', ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}) } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = (await handlePhase2(new Request(`${ORIGIN}${path}`, init), env, exec, deps)) ?? new Response('{"error":"fallthrough"}', { status: 404 });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as T, text };
}

const PLACE = 'ChIJmainnetcafe000001';
let mint = '';

beforeAll(async () => {
  const c = world.chain;
  c.set(CONFIG_PDA, { lamports: 1n, owner: SHOP_VAULT_PROGRAM_ID, data: configData({ attestor: attestor.publicKey.toBase58(), guardian: web3.Keypair.generate().publicKey.toBase58(), governance: web3.Keypair.generate().publicKey.toBase58(), window: 259_200, flavor: 0 }) });
  c.set(ALT, { lamports: 1n, owner: 'AddressLookupTab1e1111111111111111111111111', data: altData() });
  c.set(PUMP_GLOBAL, { lamports: 1n, owner: PUMP_PROGRAM, data: pumpGlobalData() });
  world.places.set(PLACE, { id: PLACE, businessStatus: 'OPERATIONAL', primaryType: 'cafe', types: ['cafe'], internationalPhoneNumber: '+44 20 7946 0999' });
  // a registered coin for the claim tests
  const { placeAddresses } = await import('./addresses');
  const a = await placeAddresses(PLACE, SHOP_VAULT_PROGRAM_ID);
  mint = web3.Keypair.generate().publicKey.toBase58();
  const now = Date.UTC(2026, 9, 8, 12);
  db.raw.prepare("INSERT INTO assets(id, content_type, bytes, width, height, created_at) VALUES ('a', 'image/png', x'00', 1, 1, 0)").run();
  db.raw.prepare("INSERT INTO metadata(id, json, name, symbol, description, image_id, place_id, created_at) VALUES ('m', '{}', 'Main Cafe', 'MAIN', '', 'a', ?, 0)").run(PLACE);
  db.raw
    .prepare(
      `INSERT INTO coins(place_id, place_hash, mint, vault, vault_state, bonding_curve, ticker, name, category, emoji, bg, metadata_id, launcher, created_at, launch_sig, launch_slot, cluster, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'MAIN', 'Main Cafe', 'cafe', '☕', '#000000', 'm', ?, ?, ?, 1, 'mainnet', ?)`,
    )
    .run(PLACE, a.placeHashHex, mint, a.vault, a.vaultState, web3.Keypair.generate().publicKey.toBase58(), web3.Keypair.generate().publicKey.toBase58(), now, b58encode(new Uint8Array(64).fill(3)), now);
  c.set(a.vaultState, { lamports: 1n, owner: SHOP_VAULT_PROGRAM_ID, data: vaultStateData({ placeHashHex: a.placeHashHex, mint, launcher: web3.Keypair.generate().publicKey.toBase58() }) });
  void curveData;
});

describe('mainnet build (H6: no dev endpoints)', () => {
  it('/api/dev/airdrop does not exist; config hides the test wallet', async () => {
    const r = await call<{ error: string }>(base, 'POST', '/api/dev/airdrop', { address: web3.Keypair.generate().publicKey.toBase58() });
    expect(r.status).toBe(404);
    const cfg = await call<ConfigResponse>(base, 'GET', '/api/config');
    expect(cfg.body.cluster).toBe('mainnet');
    expect(cfg.body.publicOrigin).toBe('https://atlaspad.online');
    expect(cfg.body.features.testWallet).toBe(false);
    expect(cfg.body.explorer.tx).toBe('https://solscan.io/tx/{sig}');
    expect(cfg.body.claimWindowSecs).toBe(259_200);
  });

  it('synthetic devnet test places are refused on mainnet', async () => {
    const r = await call<{ error: string }>(base, 'GET', '/api/place/cornershop-test:e2e-1');
    expect(r.status).toBe(400);
  });

  it('a devnet-compiled var mismatch is refused: CLUSTER=devnet on a mainnet bundle → not enabled', async () => {
    const r = await call<{ error: string }>({ ...base, CLUSTER: 'devnet' }, 'GET', '/api/config');
    expect(r.body.error).toBe('not_enabled');
  });

  it('without Twilio: phone verification is "none" and claims answer 503 not_configured', async () => {
    expect(phoneMode(base, 'mainnet')).toBe('none');
    const r = await call<{ error: string }>(base, 'POST', '/api/claim/call', { placeId: PLACE });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('not_configured');
  });

  it('with Twilio: a real call is started (no devCode), the code is checked by verification sid', async () => {
    const env = { ...base, ...TWILIO };
    expect(phoneMode(env, 'mainnet')).toBe('call');
    const r = await call<ClaimCallResponse>(env, 'POST', '/api/claim/call', { placeId: PLACE });
    expect(r.status).toBe(200);
    expect(r.body.channel).toBe('call');
    expect(r.body.devCode).toBeUndefined();
    expect(r.text).not.toContain('7946');
    expect(world.twilio.started.at(-1)).toEqual({ To: '+442079460999', Channel: 'call', Locale: 'en' });
    const wrong = await call<ClaimCheckResponse>(env, 'POST', '/api/claim/check', { claimId: r.body.claimId, code: '000000' });
    expect(wrong.body).toEqual({ approved: false, attemptsLeft: 2 });
    expect(world.twilio.checks.at(-1)).toEqual({ VerificationSid: `VE${'a'.repeat(32)}`, Code: '000000' });
    const ok = await call<ClaimCheckResponse>(env, 'POST', '/api/claim/check', { claimId: r.body.claimId, code: '123456' });
    expect(ok.body.approved).toBe(true);
  });
});

describe('Twilio Verify adapter', () => {
  const env = { ...base, ...TWILIO };
  it('maps Twilio errors and never forwards them raw', async () => {
    expect(mapError({ code: 60203 }, 'start').code).toBe('too_many_attempts');
    expect(mapError({ code: 60202 }, 'check').code).toBe('too_many_attempts');
    expect(mapError({ code: 60410 }, 'start').code).toBe('premium');
    expect(mapError({ code: 60605 }, 'start').code).toBe('premium');
    expect(mapError({ code: 99999, message: 'internal detail' }, 'start')).toMatchObject({ code: 'upstream' });
    expect(mapError({ code: 99999, message: 'internal detail' }, 'start').message).not.toContain('internal detail');
    world.twilio.startError = { status: 429, code: 60203 };
    await expect(new TwilioVerifier(env, deps).start('+442079460999')).rejects.toMatchObject({ code: 'too_many_attempts' });
    world.twilio.startError = null;
  });

  it('uses Basic auth and a form body; health requires code_length 6', async () => {
    const seen: RequestInit[] = [];
    const d: Deps = { now: deps.now, fetch: async (u, init) => (seen.push(init ?? {}), world.fetch(u, init)) };
    const v = new TwilioVerifier(env, d);
    await v.start('+442079460999');
    const h = new Headers(seen[0]!.headers);
    expect(h.get('authorization')).toBe(`Basic ${btoa(`${TWILIO.TWILIO_ACCOUNT_SID}:${TWILIO.TWILIO_AUTH_TOKEN}`)}`);
    expect(h.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(await v.health()).toBe('ok');
    world.twilio.codeLength = 4;
    expect(await v.health()).toBe('mismatch');
    world.twilio.codeLength = 6;
    expect(await v.check(`VE${'a'.repeat(32)}`, '', '123456')).toBe('approved');
    expect(await v.check(`VE${'a'.repeat(32)}`, '', '654321')).toBe('pending');
  });

  it('refuses a malformed service sid', async () => {
    await expect(new TwilioVerifier({ ...env, TWILIO_VERIFY_SID: 'nope' }, deps).start('+15550100000')).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('genesis guard (H1)', () => {
  it('a mainnet Worker whose RPC answers with the devnet genesis fails closed', async () => {
    // fresh module state is per test file; this file's isolate has already verified mainnet, so simulate a new cluster
    const { Rpc, __resetSolanaCaches } = await import('./solana');
    __resetSolanaCaches();
    world.chain.genesis = GENESIS.devnet;
    const rpc = new Rpc(base, 'mainnet', deps, 5);
    await expect(rpc.call('getSlot')).rejects.toMatchObject({ code: 'chain_mismatch' });
    const h = await call<{ ok: boolean; checks: { genesis: string } }>(base, 'GET', '/api/health');
    expect(h.body.ok).toBe(false);
    expect(h.body.checks.genesis).toBe('mismatch');
    const r = await call<{ jsonrpc: string; error: { message: string } }>(base, 'POST', '/api/rpc', { jsonrpc: '2.0', id: 1, method: 'getSlot' });
    expect(r.body.error.message).toBe('chain mismatch');
    __resetSolanaCaches();
    world.chain.genesis = GENESIS.mainnet;
  });
});
