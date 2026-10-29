/**
 * Pre-launch security fixes: per-IP limits key IPv6 on its /64 (worker/ipKey.ts); a global daily budget of paid Google
 * lookups (worker/google.ts), spent and capped before the lookup on every route that pays for one; mainnet /api/rpc
 * relays only transactions that name one of the app's programs (worker/rpcProxy.ts), and every transaction the app
 * builds still passes; HSTS on every page; share cards never make a $TICKER up from the URL on a real Worker
 * (worker/share.ts).
 */
import { setBuild } from './test/globals';
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetApiState } from './api';
import { placeAddresses } from './addresses';
import { b58decode, b58encode, fromB64, toB64 } from './bytes';
import { CONFIG_PDA, GENESIS, PUMP_AMM_PROGRAM, PUMP_GLOBAL, PUMP_PROGRAM, SHOP_VAULT_PROGRAM_ID } from './consts';
import type { Deps } from './ctx';
import type { Env } from './env';
import { REGION_BLOCKED_HTML } from './geo';
import { __resetGoogleCache, GOOGLE_BUSY_MESSAGE, GOOGLE_LOOKUPS_PER_DAY } from './google';
import { ipHash } from './hmac';
import worker from './index';
import { ipKey } from './ipKey';
import { handlePhase2 } from './router';
import { appProgramKeys, namesAppProgram } from './rpcProxy';
import { __setSanctionedWallets } from './sanctions';
import { coinShareMeta, PAGE_SECURITY_HEADERS } from './share';
import { altData, configData, FakeWorld, pumpGlobalData, vaultStateData } from './test/fakeChain';
import { FakeD1 } from './test/fakeD1';
import { altAccount, BN, BUYBACK, buildClaim, buildLaunch, compile, NodeBuffer, pump, sv, web3 } from './test/launchFixture';
import { encodeMessage, encodeTransaction } from './txcodec';
import { RPC_WALLET_BLOCKED } from './wire';

setBuild('mainnet', false);

const ORIGIN = 'https://atlaspad.online';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 27, 12);
const HSTS = 'max-age=31536000; includeSubDomains';
const world = new FakeWorld();
world.chain.genesis = GENESIS.mainnet;
const db = new FakeD1();
const b64 = (u: Uint8Array) => NodeBuffer.from(u).toString('base64');
const ALT = web3.Keypair.generate().publicKey.toBase58();
const someone = () => web3.Keypair.generate().publicKey;
const attestor = web3.Keypair.generate();

const env: Env = {
  ASSETS: { fetch: async () => new Response('<!doctype html><title>app</title>', { headers: { 'content-type': 'text/html' } }) } as unknown as Fetcher,
  DB: db.asD1(),
  CLUSTER: 'mainnet',
  PUBLIC_ORIGIN: ORIGIN,
  PROGRAM_ID: SHOP_VAULT_PROGRAM_ID,
  ALT_ADDRESS: ALT,
  MAX_DEV_BUY_LAMPORTS: '1000000000',
  FEATURE_WEBSITE_VERIFY: '1',
  GOOGLE_SERVER_KEY: 'google-server-key-test-0009',
  ALCHEMY_API_KEY: 'alchemy-mainnet-secret-009',
  ATTESTOR_SECRET: b64(attestor.secretKey),
  CRANK_SECRET: b64(web3.Keypair.generate().secretKey),
  HMAC_KEY: b64(crypto.getRandomValues(new Uint8Array(32))),
};
const deps: Deps = { fetch: world.fetch, now: () => NOW, sleep: async () => {} };
const pending: Promise<unknown>[] = [];
const exec = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };

let ipN = 0;
async function call<T>(method: string, path: string, body?: unknown, e: Env = env, ip = `198.51.100.${++ipN}`): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'cf-connecting-ip': ip };
  if (method === 'POST') Object.assign(headers, { origin: e.PUBLIC_ORIGIN ?? ORIGIN, 'content-type': 'application/json' });
  const res = (await handlePhase2(new Request(`${e.PUBLIC_ORIGIN ?? ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), e, exec, deps))!;
  const text = await res.text();
  await Promise.allSettled(pending.splice(0));
  return { status: res.status, body: JSON.parse(text) as T };
}

const counter = (key: string) => (db.raw.prepare('SELECT count FROM rate_counters WHERE key = ?').get(key) as { count: number } | undefined)?.count ?? 0;
const setCounter = (key: string, n: number, windowMs = DAY) =>
  db.raw.prepare('INSERT INTO rate_counters(key, window_start, count) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET window_start = ?2, count = ?3').run(key, Math.floor(NOW / windowMs) * windowMs, n);

beforeAll(() => {
  world.chain.set(CONFIG_PDA, { lamports: 1n, owner: SHOP_VAULT_PROGRAM_ID, data: configData({ attestor: attestor.publicKey.toBase58(), guardian: someone().toBase58(), governance: someone().toBase58() }) });
  db.raw.prepare("INSERT INTO assets(id, content_type, bytes, width, height, created_at) VALUES ('a', 'image/png', x'00', 1, 1, ?)").run(NOW);
  world.chain.set(ALT, { lamports: 1n, owner: 'AddressLookupTab1e1111111111111111111111111', data: altData() });
  world.chain.set(PUMP_GLOBAL, { lamports: 1n, owner: PUMP_PROGRAM, data: pumpGlobalData() });
});

/* ------------------------------------------------------------------------------------------- IPv6 /64 */

describe('per-IP limits key IPv6 on its /64', () => {
  it('ipKey: IPv4 unchanged, IPv6 cut to the /64 (with :: expanded), IPv4-mapped → IPv4, junk passes through', () => {
    expect(ipKey('198.51.100.7')).toBe('198.51.100.7');
    expect(ipKey(' 198.51.100.7 ')).toBe('198.51.100.7');
    expect(ipKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8:1:2::')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('2001:db8::2:0:0:1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
    expect(ipKey('::')).toBe('0:0:0:0::/64');
    expect(ipKey('[2001:db8:1:2::9]')).toBe('2001:db8:1:2::/64');
    expect(ipKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(ipKey('2001:db8:1:2:3:4:198.51.100.7')).toBe('2001:db8:1:2::/64');
    expect(ipKey('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(ipKey('::FFFF:c633:6407')).toBe('198.51.100.7');
    expect(ipKey('0:0:0:0:0:ffff:198.51.100.7')).toBe('198.51.100.7');
    for (const junk of ['unknown', 'cron', '1::2::3', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', 'gggg::1', '2001:db8:::1', '::ffff:300.1.1.1', ':1::']) expect(ipKey(junk), junk).toBe(junk);
  });

  it('every address of one /64 shares one hash (and one set of caps); other /64s and IPv4 addresses do not', async () => {
    const a = await ipHash(env, '2001:db8:aa:bb:1:2:3:4');
    expect(await ipHash(env, '2001:db8:aa:bb:ffff::1')).toBe(a);
    expect(await ipHash(env, '2001:0db8:00aa:00bb::')).toBe(a);
    expect(await ipHash(env, '2001:db8:aa:bc::1')).not.toBe(a);
    expect(await ipHash(env, '::ffff:198.51.100.7')).toBe(await ipHash(env, '198.51.100.7'));
    expect(await ipHash(env, '198.51.100.8')).not.toBe(await ipHash(env, '198.51.100.7'));
  });

  it('a durable per-IP cap hit from one IPv6 address holds for the rest of its /64', async () => {
    const place = 'ChIJsecurityelig000001';
    world.places.set(place, { id: place, businessStatus: 'OPERATIONAL', primaryType: 'cafe', types: ['cafe'] });
    setCounter(`elig:ip:${await ipHash(env, '2001:db8:77::1')}`, 200);
    const r = await call<{ error: string }>('GET', `/api/place/${place}/eligibility`, undefined, env, '2001:db8:77:0:dead:beef:1:2');
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('rate_limited');
    expect((await call('GET', `/api/place/${place}/eligibility`, undefined, env, '2001:db8:78::1')).status).toBe(200);
  });
});

/* ------------------------------------------------------------------------------ global Google budget */

describe('global daily budget of paid Google lookups', () => {
  const alerts = () => db.raw.prepare("SELECT kind, severity FROM alerts WHERE kind = 'google_budget'").all() as { kind: string }[];
  beforeEach(() => {
    __resetGoogleCache();
    __resetApiState();
    setCounter('google:global', 0);
    vi.stubGlobal('fetch', world.fetch); // the Phase-1 listing lookup (worker/api.ts) calls Google with the global fetch
  });
  afterEach(() => vi.unstubAllGlobals());

  it('eligibility: a Google call spends one; a cached answer, an invalid id and an opted-out place spend nothing', async () => {
    const place = 'ChIJsecurityelig000002';
    world.places.set(place, { id: place, businessStatus: 'OPERATIONAL', primaryType: 'cafe', types: ['cafe'] });
    expect((await call('GET', `/api/place/${place}/eligibility`)).status).toBe(200);
    expect(counter('google:global')).toBe(1);
    expect((await call('GET', `/api/place/${place}/eligibility`)).status).toBe(200); // 10-minute cache
    expect(counter('google:global')).toBe(1);
    expect((await call('GET', '/api/place/bad!/eligibility')).status).toBe(400);
    expect(counter('google:global')).toBe(1);
  });

  it('eligibility over the budget: "Lookups are busy today" (429, fails closed, alerts once); cached answers still work', async () => {
    const cached = 'ChIJsecurityelig000003';
    const fresh = 'ChIJsecurityelig000004';
    for (const id of [cached, fresh]) world.places.set(id, { id, businessStatus: 'OPERATIONAL', primaryType: 'cafe', types: ['cafe'] });
    expect((await call('GET', `/api/place/${cached}/eligibility`)).status).toBe(200);
    setCounter('google:global', GOOGLE_LOOKUPS_PER_DAY);
    const before = world.requests.filter((r) => r.includes('places.googleapis.com')).length;
    const r = await call<{ error: string; message: string }>('GET', `/api/place/${fresh}/eligibility`);
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: 'rate_limited', message: GOOGLE_BUSY_MESSAGE });
    expect(GOOGLE_BUSY_MESSAGE).toBe('Lookups are busy today. Try again tomorrow.');
    expect(world.requests.filter((x) => x.includes('places.googleapis.com')).length).toBe(before); // Google was not called
    expect((await call('GET', `/api/place/${cached}/eligibility`)).status).toBe(200);
    await call('GET', `/api/place/${fresh}/eligibility`);
    expect(alerts()).toHaveLength(1);
    // the operator hears everything that stopped, not only eligibility
    const msg = (db.raw.prepare("SELECT message FROM alerts WHERE kind = 'google_budget'").get() as { message: string }).message;
    expect(msg).toContain('launches, eligibility checks, listing lookups and claim lookups refuse until midnight UTC');
  });

  it('listing lookups (/api/claim/phone, /api/listing/:id): the same budget, spent only on a Google call', async () => {
    const a = 'ChIJsecuritylisting001';
    const b = 'ChIJsecuritylisting002';
    for (const [i, id] of [a, b].entries()) world.places.set(id, { id, businessStatus: 'OPERATIONAL', internationalPhoneNumber: `+44 20 7946 07${i}0` });
    expect((await call('GET', `/api/claim/phone?placeId=${a}`)).status).toBe(200);
    expect(counter('google:global')).toBe(1);
    expect((await call('GET', `/api/listing/${a}`)).status).toBe(200); // the same isolate cache
    expect((await call('GET', '/api/claim/phone?placeId=demo-cafe-1')).status).toBe(400);
    expect(counter('google:global')).toBe(1);
    setCounter('google:global', GOOGLE_LOOKUPS_PER_DAY);
    for (const path of [`/api/claim/phone?placeId=${b}`, `/api/listing/${b}`]) {
      const r = await call<{ error: string; message: string }>('GET', path);
      expect(r.status, path).toBe(429);
      expect(r.body).toMatchObject({ error: 'rate_limited', message: GOOGLE_BUSY_MESSAGE });
    }
    expect((await call('GET', `/api/listing/${a}`)).status).toBe(200);
  });

  /** A launched coin for `placeId` (D1 row + VaultState), whose Google listing has `listing` (website, phone). */
  async function launchedCoin(placeId: string, listing: { websiteUri?: string; internationalPhoneNumber?: string }): Promise<void> {
    world.places.set(placeId, { id: placeId, businessStatus: 'OPERATIONAL', primaryType: 'cafe', types: ['cafe'], ...listing });
    const a = await placeAddresses(placeId, SHOP_VAULT_PROGRAM_ID);
    const k = () => someone().toBase58();
    const mint = k();
    db.raw.prepare("INSERT INTO metadata(id, json, name, symbol, description, image_id, place_id, created_at) VALUES (?, '{}', 'Cafe', 'CAFE', '', 'a', ?, ?)").run(`m-${placeId}`, placeId, NOW);
    db.raw
      .prepare(
        `INSERT INTO coins(place_id, place_hash, mint, vault, vault_state, bonding_curve, ticker, name, category, emoji, bg, metadata_id, launcher, created_at, launch_sig, launch_slot, cluster, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'CAFE', 'Cafe', 'cafe', '☕', '#000000', ?, ?, ?, ?, 1, 'mainnet', ?)`,
      )
      .run(placeId, a.placeHashHex, mint, a.vault, a.vaultState, k(), `m-${placeId}`, k(), NOW, b58encode(crypto.getRandomValues(new Uint8Array(64))), NOW);
    world.chain.set(a.vaultState, { lamports: 1n, owner: SHOP_VAULT_PROGRAM_ID, data: vaultStateData({ placeHashHex: a.placeHashHex, mint, launcher: k() }) });
  }

  it('website code: the per-network cap, the per-shop cap and the budget all come before the paid contact lookup', async () => {
    const W = 'ChIJsecuritywebsite01';
    await launchedCoin(W, { websiteUri: 'https://www.nowherecafe.co.uk/' });
    const googleCalls = () => world.requests.filter((r) => r.includes('places.googleapis.com')).length;
    const website = (ip: string, placeId = W) => call<{ status?: string; error?: string; message?: string }>('POST', '/api/claim/website', { placeId }, env, ip);
    const ipA = '198.51.100.201';
    const ipB = '198.51.100.202';
    const ipKeyOf = async (ip: string) => `website:ip:${await ipHash(env, ip)}`;

    let g = googleCalls();
    const first = await website(ipA);
    expect(first.body).toMatchObject({ status: 'code' });
    expect(googleCalls()).toBe(g + 1);
    expect(counter('google:global')).toBe(1);
    expect(counter(await ipKeyOf(ipA))).toBe(1);
    expect(counter(`website:place:${W}`)).toBe(1);

    // the network's 10 a day are used up: refused before Google, and nothing else is used up
    setCounter(await ipKeyOf(ipA), 10);
    g = googleCalls();
    const perIp = await website(ipA);
    expect(perIp.status).toBe(429);
    expect(perIp.body).toMatchObject({ error: 'too_many_attempts', message: 'Too many attempts from your network today.' });
    expect(googleCalls()).toBe(g);
    expect(counter(await ipKeyOf(ipA))).toBe(10);
    expect(counter(`website:place:${W}`)).toBe(1);
    expect(counter('google:global')).toBe(1);

    // the shop's 20 a day are used up: refused before Google; the network's attempt is given back
    setCounter(`website:place:${W}`, 20);
    const perPlace = await website(ipB);
    expect(perPlace.status).toBe(429);
    expect(perPlace.body).toMatchObject({ error: 'too_many_attempts', message: 'Too many attempts for this shop today.' });
    expect(googleCalls()).toBe(g);
    expect(counter(await ipKeyOf(ipB))).toBe(0);
    expect(counter(`website:place:${W}`)).toBe(20);

    // the global budget is used up: "Lookups are busy today", Google not called, the caps given back
    setCounter(`website:place:${W}`, 0);
    setCounter('google:global', GOOGLE_LOOKUPS_PER_DAY);
    const busy = await website(ipB);
    expect(busy.status).toBe(429);
    expect(busy.body).toMatchObject({ error: 'rate_limited', message: GOOGLE_BUSY_MESSAGE });
    expect(googleCalls()).toBe(g);
    expect(counter(await ipKeyOf(ipB))).toBe(0);
    expect(counter(`website:place:${W}`)).toBe(0);

    // a listing without a site of its own is refused after the lookup: that billed call is counted everywhere
    const F = 'ChIJsecuritywebsite02';
    await launchedCoin(F, { websiteUri: 'https://www.facebook.com/nowherecafe' });
    setCounter('google:global', 0);
    const platform = await website(ipB, F);
    expect(platform.body.error).toBe('not_own_domain');
    expect(googleCalls()).toBe(g + 1);
    expect(counter('google:global')).toBe(1);
    expect(counter(await ipKeyOf(ipB))).toBe(1);
    expect(counter(`website:place:${F}`)).toBe(1);
  });

  it('phone call (once Twilio is on): the per-network and per-shop caps and the budget come before the paid lookup', async () => {
    const tw: Env = { ...env, TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'twilio-auth-token-secret', TWILIO_VERIFY_SID: `VA${'2'.repeat(32)}` };
    const P = 'ChIJsecuritycall00001';
    await launchedCoin(P, { internationalPhoneNumber: '+44 20 7946 0811' });
    const googleCalls = () => world.requests.filter((r) => r.includes('places.googleapis.com')).length;
    const phone = (ip: string, placeId = P) => call<{ claimId?: string; error?: string; message?: string }>('POST', '/api/claim/call', { placeId }, tw, ip);
    const ipA = '198.51.100.211';
    const ipB = '198.51.100.212';
    const ipCap = async (ip: string) => `claim:ip:${await ipHash(env, ip)}`;
    const started = world.twilio.started.length;

    // the network's 5 an hour are used up: refused before Google, and nothing else is used up
    setCounter(await ipCap(ipA), 5, HOUR);
    let g = googleCalls();
    const perIp = await phone(ipA);
    expect(perIp.status).toBe(429);
    expect(perIp.body).toMatchObject({ error: 'too_many_attempts', message: 'Too many attempts from your network.' });
    expect(googleCalls()).toBe(g);
    expect([counter(await ipCap(ipA)), counter(`claim:place:${P}`), counter('google:global')]).toEqual([5, 0, 0]);

    // the shop's 6 a day are used up: refused before Google; the network's attempt is given back
    setCounter(`claim:place:${P}`, 6);
    const perPlace = await phone(ipB);
    expect(perPlace.status).toBe(429);
    expect(perPlace.body).toMatchObject({ error: 'too_many_attempts', message: 'Too many attempts for this shop today.' });
    expect(googleCalls()).toBe(g);
    expect([counter(await ipCap(ipB)), counter(`claim:place:${P}`)]).toEqual([0, 6]);

    // the global budget is used up: Google not called, both caps given back
    setCounter(`claim:place:${P}`, 0);
    setCounter('google:global', GOOGLE_LOOKUPS_PER_DAY);
    const busy = await phone(ipB);
    expect(busy.status).toBe(429);
    expect(busy.body).toMatchObject({ error: 'rate_limited', message: GOOGLE_BUSY_MESSAGE });
    expect(googleCalls()).toBe(g);
    expect([counter(await ipCap(ipB)), counter(`claim:place:${P}`)]).toEqual([0, 0]);

    // a listing without a phone is refused after the lookup: that billed call is counted everywhere
    const N = 'ChIJsecuritycall00002';
    await launchedCoin(N, {});
    setCounter('google:global', 0);
    const none = await phone(ipB, N);
    expect(none.body.error).toBe('no_phone');
    expect(googleCalls()).toBe(g + 1);
    expect([counter('google:global'), counter(await ipCap(ipB)), counter(`claim:place:${N}`)]).toEqual([1, 1, 1]);

    // and a call goes out: one lookup, one of each cap
    g = googleCalls();
    const ok = await phone('198.51.100.213');
    expect(ok.status).toBe(200);
    expect(ok.body.claimId).toBeTruthy();
    expect(world.twilio.started.length).toBe(started + 1);
    expect(googleCalls()).toBe(g + 1);
    expect([counter('google:global'), counter(`claim:place:${P}`)]).toEqual([2, 1]);
  });

  it('launch prepare: a Google eligibility lookup spends the budget; over it, prepare refuses before calling Google', async () => {
    const prepare = async (placeId: string) => {
      world.places.set(placeId, { id: placeId, businessStatus: 'OPERATIONAL', primaryType: 'cafe', types: ['cafe'] });
      const metadataId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      db.raw.prepare("INSERT INTO metadata(id, json, name, symbol, description, image_id, place_id, created_at) VALUES (?, '{}', 'Cafe', 'CAFE', '', 'a', ?, ?)").run(metadataId, placeId, NOW);
      return call<{ error?: string; message?: string }>('POST', '/api/launch/prepare', {
        placeId,
        launcher: someone().toBase58(),
        mint: someone().toBase58(),
        metadataId,
        category: 'cafe',
        emoji: '☕',
        bg: '#0e7c47',
        devBuyLamports: '0',
      });
    };
    const googleCalls = () => world.requests.filter((r) => r.includes('places.googleapis.com')).length;
    let g = googleCalls();
    const ok = await prepare('ChIJsecurityprepare01');
    expect(ok.body.error).toBeUndefined();
    expect(googleCalls()).toBe(g + 1);
    expect(counter('google:global')).toBe(1);
    setCounter('google:global', GOOGLE_LOOKUPS_PER_DAY);
    g = googleCalls();
    const busy = await prepare('ChIJsecurityprepare02');
    expect(busy.status).toBe(429);
    expect(busy.body).toMatchObject({ error: 'rate_limited', message: GOOGLE_BUSY_MESSAGE });
    expect(googleCalls()).toBe(g);
  });
});

/* ------------------------------------------------------------------------------------ /api/rpc */

const sdk = new pump.PumpSdk();
const wire = (message: unknown) => toB64(new Uint8Array(new web3.VersionedTransaction(message).serialize()));
const cb = () => [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })];
const ataIx = async (payer: any, mint: any) => {
  const s = await sv();
  return new web3.TransactionInstruction({
    programId: s.ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: s.associatedTokenAddress(payer, mint, s.TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: s.SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: s.TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: NodeBuffer.from([1]),
  });
};

/** Every kind of transaction the browser (src/chain) sends, built with the same SDKs and instruction shapes. */
async function appTransactions(): Promise<Record<string, string>> {
  const s = await sv();
  const user = someone();
  const mint = someone();
  const ph = s.placeHash('ChIJsecurityvault00001');
  const vault = s.vaultPda(ph)[0];
  const claim = await buildClaim();
  // pump `collect_creator_fee(creator)` exactly as src/chain/vault.ts collectCreatorFeeIx builds it
  const collect = new web3.TransactionInstruction({
    programId: new web3.PublicKey(PUMP_PROGRAM),
    keys: [vault, s.pumpCreatorVaultPda(vault), s.SYSTEM_PROGRAM_ID, new web3.PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'), new web3.PublicKey(PUMP_PROGRAM)].map((pubkey, i) => ({ pubkey, isSigner: false, isWritable: i < 2 })),
    data: NodeBuffer.from([0x14, 0x16, 0x56, 0x7b, 0xc6, 0x1c, 0xdb, 0x84]),
  });
  return {
    'launch with dev buy': wire((await buildLaunch()).message),
    'launch without dev buy': wire((await buildLaunch({ devBuy: 0n })).message),
    'curve buy': wire(compile(user, [...cb(), await ataIx(user, mint), await sdk.getBuyExactQuoteInV3InstructionRaw({ user, mint, spendableQuoteIn: new BN(100_000_000), minTokensOut: new BN(1), buybackFeeRecipient: BUYBACK })], [])),
    'curve sell': wire(compile(user, [...cb(), await sdk.getSellV3InstructionRaw({ user, mint, amount: new BN(1_000_000), quoteAmount: new BN(1), buybackFeeRecipient: BUYBACK })], [])),
    // graduated coins trade on PumpSwap (src/chain/amm.ts, pump-swap-sdk): the instruction is pump-amm's
    'amm trade': wire(compile(user, [...cb(), await ataIx(user, mint), new web3.TransactionInstruction({ programId: new web3.PublicKey(PUMP_AMM_PROGRAM), keys: [{ pubkey: user, isSigner: true, isWritable: true }], data: NodeBuffer.from([1, 2, 3]) })], [])),
    'claim request (attestor co-signed)': wire(web3.VersionedMessage.deserialize(claim.bytes)),
    'claim finalize': wire(compile(user, [...cb(), s.finalizeClaim({ placeHash: ph })], [])),
    'claim cancel (guardian)': wire(compile(user, [s.cancelClaim({ authority: user, placeHash: ph })], [])),
    'withdraw with sweep + collect': wire(
      compile(user, [...cb(), await sdk.sweepCreatorFeeInstruction({ payer: user, mint, creator: vault, quoteMint: s.NATIVE_MINT }), collect, s.withdraw({ owner: user, placeHash: ph })], []),
    ),
    'withdraw only': wire(compile(user, [...cb(), s.withdraw({ owner: user, placeHash: ph })], [])),
  };
}

/** Transactions that invoke only generic programs (System, Compute Budget, ATA, Token). */
async function foreignTransactions(): Promise<Record<string, string>> {
  const from = someone();
  const legacy = encodeTransaction(
    [new Uint8Array(64).fill(1)],
    encodeMessage({
      version: 'legacy',
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      staticAccountKeys: [from.toBase58(), someone().toBase58(), '11111111111111111111111111111111'].map((k) => b58decode(k)),
      recentBlockhash: new Uint8Array(32).fill(9),
      instructions: [{ programIdIndex: 2, accountKeyIndexes: [0, 1], data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }],
      addressTableLookups: [],
    }),
  );
  return {
    'system transfer (legacy)': toB64(legacy),
    'system transfer (v0)': wire(compile(from, [...cb(), web3.SystemProgram.transfer({ fromPubkey: from, toPubkey: someone(), lamports: 1 })], [])),
    'ATA create + transfer through the app ALT': wire(compile(from, [...cb(), await ataIx(from, someone()), web3.SystemProgram.transfer({ fromPubkey: from, toPubkey: someone(), lamports: 1 })], [altAccount()])),
  };
}

const rpcReq = (method: 'sendTransaction' | 'simulateTransaction', tx: string, id: number) => ({
  jsonrpc: '2.0',
  id,
  method,
  params: [tx, method === 'sendTransaction' ? { encoding: 'base64', skipPreflight: true, maxRetries: 0 } : { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'processed' }],
});

describe('/api/rpc on mainnet relays only AtlasPad transactions', () => {
  it('names the shop-vault program from config, pump and pump-amm; a raw byte scan', () => {
    const keys = appProgramKeys(env).map((k) => new web3.PublicKey(k).toBase58());
    expect(keys).toEqual([SHOP_VAULT_PROGRAM_ID, PUMP_PROGRAM, PUMP_AMM_PROGRAM]);
    const other = someone().toBase58();
    expect(new web3.PublicKey(appProgramKeys({ ...env, PROGRAM_ID: other })[0]!).toBase58()).toBe(other);
    expect(namesAppProgram('not base64!', appProgramKeys(env))).toBe(false);
    expect(namesAppProgram(42, appProgramKeys(env))).toBe(false);
    expect(namesAppProgram(toB64(b58decode(PUMP_PROGRAM).slice(0, 31)), appProgramKeys(env))).toBe(false);
    expect(namesAppProgram(toB64(Uint8Array.from([...new Uint8Array(5), ...b58decode(PUMP_AMM_PROGRAM)])), appProgramKeys(env))).toBe(true);
  });

  it('every transaction the app sends is simulated and relayed', async () => {
    const txs = await appTransactions();
    for (const [name, tx] of Object.entries(txs)) {
      expect(namesAppProgram(tx, appProgramKeys(env)), name).toBe(true);
      const sent = world.chain.sent.length;
      const sim = await call<{ result?: unknown; error?: unknown }>('POST', '/api/rpc', rpcReq('simulateTransaction', tx, 1));
      expect(sim.body.error, name).toBeUndefined();
      const r = await call<{ result?: unknown; error?: unknown }>('POST', '/api/rpc', rpcReq('sendTransaction', tx, 2));
      expect(r.body.error, name).toBeUndefined();
      expect(typeof r.body.result, name).toBe('string');
      expect(world.chain.sent.length, name).toBe(sent + 1);
    }
  });

  it('a send or simulation naming none of our programs is refused (-32602) and never reaches the RPC', async () => {
    for (const [name, tx] of Object.entries(await foreignTransactions())) {
      expect(namesAppProgram(tx, appProgramKeys(env)), name).toBe(false);
      const calls = world.chain.calls.length;
      for (const method of ['sendTransaction', 'simulateTransaction'] as const) {
        const r = await call<{ id: number; error: { code: number; message: string } }>('POST', '/api/rpc', rpcReq(method, tx, 9));
        expect(r.status).toBe(200);
        expect(r.body, `${name} ${method}`).toEqual({ jsonrpc: '2.0', id: 9, error: { code: -32602, message: 'invalid params: not an AtlasPad transaction' } });
      }
      expect(world.chain.calls.slice(calls).filter((m) => m === 'sendTransaction' || m === 'simulateTransaction'), name).toEqual([]);
    }
  });

  it('in a batch only the foreign send is refused; sanctions screening still comes first', async () => {
    const app = (await appTransactions())['curve buy']!;
    const foreign = (await foreignTransactions())['system transfer (legacy)']!;
    const sent = world.chain.sent.length;
    const r = await call<{ id: number; result?: unknown; error?: { code: number } }[]>('POST', '/api/rpc', [rpcReq('sendTransaction', app, 1), rpcReq('sendTransaction', foreign, 2), { jsonrpc: '2.0', id: 3, method: 'getSlot' }]);
    expect(typeof r.body[0]!.result).toBe('string');
    expect(r.body[1]!.error?.code).toBe(-32602);
    expect(r.body[2]!.result).toBeDefined();
    expect(world.chain.sent.length).toBe(sent + 1);
    const listed = someone().toBase58();
    __setSanctionedWallets([listed]);
    try {
      const tx = toB64(Uint8Array.from([...fromB64(foreign), ...b58decode(listed)]));
      expect((await call<{ error: { code: number } }>('POST', '/api/rpc', rpcReq('sendTransaction', tx, 4))).body.error.code).toBe(RPC_WALLET_BLOCKED);
    } finally {
      __setSanctionedWallets(null);
    }
  });

  it('devnet stays open (free SOL; the devnet e2e funds its test keys with plain transfers through the proxy)', async () => {
    setBuild('devnet', true);
    const devWorld = new FakeWorld();
    const devEnv: Env = { ...env, CLUSTER: 'devnet', PUBLIC_ORIGIN: 'https://cornershop-devnet.tiejiucai.workers.dev', DB: new FakeD1().asD1() };
    try {
      const tx = (await foreignTransactions())['system transfer (v0)']!;
      const res = (await handlePhase2(
        new Request(`${devEnv.PUBLIC_ORIGIN}/api/rpc`, { method: 'POST', headers: { 'cf-connecting-ip': '198.51.100.250', origin: devEnv.PUBLIC_ORIGIN!, 'content-type': 'application/json' }, body: JSON.stringify(rpcReq('sendTransaction', tx, 1)) }),
        devEnv,
        exec,
        { ...deps, fetch: devWorld.fetch },
      ))!;
      expect(typeof ((await res.json()) as { result?: unknown }).result).toBe('string');
      expect(devWorld.chain.sent).toEqual([tx]);
    } finally {
      setBuild('mainnet', false);
    }
  });
});

/* ------------------------------------------------------------------------------------------- HSTS */

describe('HSTS on every page', () => {
  it('the SPA, share pages and the 451 page carry Strict-Transport-Security; so does public/_headers', async () => {
    expect(PAGE_SECURITY_HEADERS['strict-transport-security']).toBe(HSTS);
    for (const path of ['/', '/c/TESCO', '/p/ChIJsecuritysharepage1']) {
      const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env, exec as never);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('strict-transport-security'), path).toBe(HSTS);
    }
    const blocked = new Request(`${ORIGIN}/`);
    Object.defineProperty(blocked, 'cf', { value: { country: 'KP' } });
    const res = await worker.fetch(blocked, env, exec as never);
    expect(res.status).toBe(451);
    expect(await res.text()).toBe(REGION_BLOCKED_HTML);
    expect(res.headers.get('strict-transport-security')).toBe(HSTS);
    const headers = readFileSync(decodeURIComponent(new URL('../public/_headers', import.meta.url).pathname), 'utf8');
    const all = headers.split(/\n(?=\S)/).find((b) => b.startsWith('/*\n'));
    expect(all).toContain(`  Strict-Transport-Security: ${HSTS}\n`);
  });
});

/* ------------------------------------------------------------------------------------- share cards */

describe('share cards on a real Worker', () => {
  it('/c/<anything> is "This coin" unless the registry has it; only the demo Worker turns a short id into a ticker', async () => {
    for (const path of ['/c/TESCO', '/c/kebab', `/c/${someone().toBase58()}`]) {
      const m = await coinShareMeta(env, path);
      expect(m?.title, path).toBe('This coin on AtlasPad — 100% of creator fees held for the shop');
      expect(m?.url, path).toBe(`${ORIGIN}${path}`);
    }
    setBuild('demo', false);
    try {
      expect((await coinShareMeta({ ASSETS: env.ASSETS }, '/c/kebab'))?.title).toBe('$KEBAB on AtlasPad — 100% of creator fees held for the shop');
    } finally {
      setBuild('mainnet', false);
    }
  });
});
