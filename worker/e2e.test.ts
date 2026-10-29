/**
 * API-level end-to-end test of the real-mode Worker (devnet build) against fake upstreams (worker/test/fakeChain.ts)
 * and a node:sqlite D1 with the real migration: config → metadata → prepare → cosign (real policy + real attestor
 * signature over an SDK-built launch tx) → confirm → registry reads → market → trade indexing → feed → claim (screen
 * code) → cosign → confirm → cron finalize → withdrawable fees. Plus the RPC proxy rules, origin checks, locks and
 * the demo Worker.
 */
import './test/globals';
import { beforeAll, describe, expect, it } from 'vitest';
import { VAULT_CU } from '../src/chain/budget';
import { lamportsPerToken } from '../src/chain/curve';
import { canonicalPoolPda, curveBaseAta, placeAddresses, pumpCreatorVaultPda } from './addresses';
import { b58encode, fromHex, toB64, u64le } from './bytes';
import { __resetHealthCache, FAUCET_PAYOUT_FLOOR_LAMPORTS } from './configRoute';
import { FAUCET_FLOOR } from './dev/airdrop';
import { ipHash } from './hmac';
import { coinShareMeta } from './share';
import { ALT_KEYS, CONFIG_PDA, PUMP_GLOBAL, PUMP_PROGRAM, SHOP_VAULT_PROGRAM_ID } from './consts';
import { HOUR, type Deps } from './ctx';
import type { Env } from './env';
import { runIndexer } from './indexer';
import worker from './index';
import { buildCtx, handlePhase2 } from './router';
import { FakeD1 } from './test/fakeD1';
import { altData, configData, curveData, FakeWorld, pumpGlobalData, tradeEventIxData, vaultStateData } from './test/fakeChain';
import { altAccount, buildLaunch, NodeBuffer, sv, web3 } from './test/launchFixture';
import { decodeMessage } from './txcodec';
import type {
  ClaimCallResponse,
  ClaimCheckResponse,
  ClaimConfirmResponse,
  ClaimCosignResponse,
  CoinDetailResponse,
  CoinsResponse,
  ConfigResponse,
  FeedResponse,
  HealthResponse,
  LaunchConfirmResponse,
  LaunchCosignResponse,
  LaunchPrepareResponse,
  MarketResponse,
  MetadataUploadResponse,
} from './wire';

const ORIGIN = 'https://cornershop-devnet.tiejiucai.workers.dev';
const CAFE = 'ChIJcafe0000000000001';
const ROAD = 'ChIJroad0000000000001';
const ALCHEMY_KEY = 'alchemy-secret-key-do-not-leak-123';
const RENT0 = 890_880n;

const world = new FakeWorld();
const db = new FakeD1();
const attestor = web3.Keypair.generate();
const crank = web3.Keypair.generate();
const faucet = web3.Keypair.generate();
const guardian = web3.Keypair.generate().publicKey.toBase58();
const governance = web3.Keypair.generate().publicKey.toBase58();
const ALT = web3.Keypair.generate().publicKey.toBase58();
const b64 = (u: Uint8Array) => NodeBuffer.from(u).toString('base64');

const env: Env = {
  ASSETS: { fetch: async () => new Response('<!doctype html><title>x</title>', { headers: { 'content-type': 'text/html' } }) } as unknown as Fetcher,
  DB: db.asD1(),
  CLUSTER: 'devnet',
  PUBLIC_ORIGIN: ORIGIN,
  PROGRAM_ID: SHOP_VAULT_PROGRAM_ID,
  ALT_ADDRESS: ALT,
  MAX_DEV_BUY_LAMPORTS: '1000000000',
  PRIORITY_FEE_DEFAULT: '10000',
  FEATURE_WEBSITE_VERIFY: '1',
  BUILD_ID: 'test',
  GOOGLE_SERVER_KEY: 'google-server-key-test-0001',
  ALCHEMY_API_KEY: ALCHEMY_KEY,
  ATTESTOR_SECRET: b64(attestor.secretKey),
  CRANK_SECRET: b64(crank.secretKey),
  HMAC_KEY: b64(crypto.getRandomValues(new Uint8Array(32))),
  DEV_FAUCET_SECRET: b64(faucet.secretKey),
};

let clock = Date.UTC(2026, 9, 8, 12, 0, 0);
const deps: Deps = { fetch: world.fetch, now: () => clock, sleep: async () => {} };
const pending: Promise<unknown>[] = [];
const exec = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
async function flush() {
  while (pending.length) await Promise.allSettled(pending.splice(0));
}

async function call<T = unknown>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers; text: string }> {
  const init: RequestInit = { method, headers: { 'cf-connecting-ip': '203.0.113.9', origin: ORIGIN, ...extra } };
  if (body !== undefined) {
    if (body instanceof FormData) init.body = body;
    else {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
  }
  if (method === 'GET') delete (init.headers as Record<string, string>).origin;
  const res = (await handlePhase2(new Request(`${ORIGIN}${path}`, init), env, exec, deps)) ?? new Response('null', { status: 599 });
  const text = await res.text();
  await flush();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers, text };
}

/** Minimal PNG header (signature + IHDR) — the Worker only sniffs the header. */
function png(w: number, h: number): Uint8Array {
  const d = new Uint8Array(64);
  d.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(d.buffer).setUint32(16, w);
  new DataView(d.buffer).setUint32(20, h);
  return d;
}

function metaForm(over: Record<string, string> = {}, image: Uint8Array = png(512, 512), type = 'image/png'): FormData {
  const f = new FormData();
  f.set('name', over.name ?? 'Corner Cafe');
  f.set('symbol', over.symbol ?? 'CAFE');
  f.set('description', over.description ?? 'Best flat white in E8');
  f.set('placeId', over.placeId ?? CAFE);
  f.set('image', new Blob([image], { type }), 'art.png');
  return f;
}

beforeAll(() => {
  const c = world.chain;
  c.set(CONFIG_PDA, { lamports: 2_000_000n, owner: SHOP_VAULT_PROGRAM_ID, data: configData({ attestor: attestor.publicKey.toBase58(), guardian, governance, window: 60 }) });
  c.set(SHOP_VAULT_PROGRAM_ID, { lamports: 1n, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', data: new Uint8Array(36), executable: true });
  c.set(ALT, { lamports: 3_000_000n, owner: 'AddressLookupTab1e1111111111111111111111111', data: altData() });
  c.set(PUMP_GLOBAL, { lamports: 1n, owner: PUMP_PROGRAM, data: pumpGlobalData() });
  c.set(faucet.publicKey.toBase58(), { lamports: 5_000_000_000n, owner: '11111111111111111111111111111111', data: new Uint8Array(0) });
  world.places.set(CAFE, {
    id: CAFE,
    businessStatus: 'OPERATIONAL',
    primaryType: 'coffee_shop',
    types: ['coffee_shop', 'cafe', 'food', 'establishment'],
    location: { latitude: 51.5469, longitude: -0.0712 },
    internationalPhoneNumber: '+44 20 7946 0123',
    websiteUri: 'https://www.mycafe.co.uk/',
  });
  world.places.set(ROAD, { id: ROAD, primaryType: 'route', types: ['route'] });
});

/* ======================================================================================== the devnet loop */

interface LaunchState {
  prep: LaunchPrepareResponse;
  launcher: any;
  mint: any;
  sig: string;
  vault: string;
  vaultState: string;
  curve: string;
}
const S: { launch?: LaunchState; newOwner?: any; claimId?: string; token?: string } = {};

describe('real-mode devnet loop', () => {
  it('GET /api/config describes the devnet deployment (no secrets)', async () => {
    const r = await call<ConfigResponse>('GET', '/api/config');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('public, max-age=30');
    expect(r.body.cluster).toBe('devnet');
    expect(r.body.attestor).toBe(attestor.publicKey.toBase58());
    expect(r.body.claimWindowSecs).toBe(60);
    expect(r.body.launchesPaused).toBe(false);
    expect(r.body.alt).toBe(ALT);
    expect(r.body.features.phoneVerification).toBe('screen');
    expect(r.body.features.testWallet).toBe(true);
    expect(r.body.features.privy).toBe(false);
    expect(r.body.explorer.tx).toBe('https://solscan.io/tx/{sig}?cluster=devnet');
    expect(r.text).not.toContain(ALCHEMY_KEY);
    expect(r.text).not.toContain('alchemy.com');
    expect(r.text).not.toContain(env.GOOGLE_SERVER_KEY!);
  });

  it('eligibility: a road is not launchable, the cafe is (category from Google)', async () => {
    const road = await call<{ launchable: boolean; reason: string }>('GET', `/api/place/${ROAD}/eligibility`);
    expect(road.body).toMatchObject({ launchable: false, reason: 'not_business' });
    const cafe = await call<{ launchable: boolean; reason: string; category: string }>('GET', `/api/place/${CAFE}/eligibility`);
    expect(cafe.body).toMatchObject({ launchable: true, reason: 'ok', category: 'cafe' });
  });

  it('POST /api/metadata validates and stores art + server-built JSON', async () => {
    expect((await call('POST', '/api/metadata', metaForm({ name: 'Official Corner Cafe' }))).body).toMatchObject({ error: 'moderation' });
    expect((await call('POST', '/api/metadata', metaForm({ symbol: 'cafe' }))).body).toMatchObject({ error: 'bad_request' });
    expect((await call('POST', '/api/metadata', metaForm({ name: 'Visit cafe.com now' }))).body).toMatchObject({ error: 'bad_request' });
    expect((await call('POST', '/api/metadata', metaForm({}, png(512, 300)))).body).toMatchObject({ error: 'bad_request' });
    expect((await call('POST', '/api/metadata', metaForm({}, png(512, 512), 'image/svg+xml'))).body).toMatchObject({ error: 'unsupported_media' });
    expect((await call('POST', '/api/metadata', metaForm({}, png(512, 512), 'image/jpeg'))).body).toMatchObject({ error: 'unsupported_media' });
    const r = await call<MetadataUploadResponse>('POST', '/api/metadata', metaForm());
    expect(r.status).toBe(200);
    expect(r.body.uri).toMatch(/^https:\/\/cornershop-devnet\.tiejiucai\.workers\.dev\/meta\/[0-9a-f]{32}\.json$/);
    expect(new TextEncoder().encode(r.body.uri).length).toBeLessThanOrEqual(100);
    const metaRes = await worker.fetch(new Request(r.body.uri), env, exec as never);
    expect(metaRes.status).toBe(200);
    expect(metaRes.headers.get('access-control-allow-origin')).toBe('*');
    expect(metaRes.headers.get('cache-control')).toContain('immutable');
    const meta = (await metaRes.json()) as Record<string, unknown>;
    expect(meta).toMatchObject({ name: 'Corner Cafe', symbol: 'CAFE', image: r.body.imageUrl, showName: true, createdOn: ORIGIN, website: `${ORIGIN}/p/${CAFE}` });
    const img = await worker.fetch(new Request(r.body.imageUrl), env, exec as never);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect((await worker.fetch(new Request(r.body.imageUrl.replace('.png', '.webp')), env, exec as never)).status).toBe(404);
    (S as Record<string, unknown>).metadata = r.body;
  });

  it('prepare → cosign (policy + attestor) → confirm registers the coin', async () => {
    const md = (S as Record<string, unknown>).metadata as MetadataUploadResponse;
    const launcher = web3.Keypair.generate();
    const mint = web3.Keypair.generate();
    const prep = await call<LaunchPrepareResponse>('POST', '/api/launch/prepare', {
      placeId: CAFE,
      launcher: launcher.publicKey.toBase58(),
      mint: mint.publicKey.toBase58(),
      metadataId: md.metadataId,
      category: 'cafe',
      emoji: '☕',
      bg: '#1f8a4c',
      devBuyLamports: '100000000',
    });
    expect(prep.status).toBe(200);
    expect(prep.body).toMatchObject({ placeId: CAFE, name: 'Corner Cafe', symbol: 'CAFE', uri: md.uri, attestor: attestor.publicKey.toBase58(), alt: ALT, computeUnitLimit: 400_000 });

    const s = await sv();
    const placeHash = s.placeHash(CAFE);
    const keys = { launcher, mint, attestor, placeId: CAFE, placeHash, vault: s.vaultPda(placeHash)[0], name: prep.body.name, symbol: prep.body.symbol, uri: prep.body.uri };
    // a tampered message (other name) is refused and does NOT lock the place
    const bad = await buildLaunch({ name: 'Not Moderated', alts: [altAccount(ALT)] }, keys);
    const refused = await call<{ error: string; violations: string[] }>('POST', '/api/launch/cosign', { reservationId: prep.body.reservationId, messageBase64: toB64(bad.bytes) });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe('policy_violation');
    expect(refused.body.violations.join()).toMatch(/name differs/);
    expect(db.get<{ status: string }>('SELECT status FROM launch_reservations WHERE id = ?', prep.body.reservationId)!.status).toBe('prepared');

    const b = await buildLaunch({ alts: [altAccount(ALT)] }, keys);
    const cos = await call<LaunchCosignResponse>('POST', '/api/launch/cosign', { reservationId: prep.body.reservationId, messageBase64: toB64(b.bytes) });
    expect(cos.status).toBe(200);
    const pub = await crypto.subtle.importKey('raw', attestor.publicKey.toBytes(), { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, pub, NodeBuffer.from(cos.body.attestorSignature, 'base64'), b.bytes)).toBe(true);
    // the signature makes a valid tx together with the mint + launcher signatures
    const tx = new web3.VersionedTransaction(b.message);
    tx.addSignature(attestor.publicKey, NodeBuffer.from(cos.body.attestorSignature, 'base64'));
    tx.sign([mint, launcher]);
    expect(tx.serialize().length).toBeLessThanOrEqual(1232);
    const sig = b58encode(tx.signatures[0]);

    // not landed yet → 202 pending
    expect((await call('POST', '/api/launch/confirm', { reservationId: prep.body.reservationId, signature: sig })).status).toBe(202);

    // land it on the fake chain: VaultState, curve after a 0.1 SOL dev buy, vault topped up, TradeEvent
    const addrs = await placeAddresses(CAFE, SHOP_VAULT_PROGRAM_ID);
    const curve = b.expect.bondingCurve;
    const m = decodeMessage(b.bytes);
    const statics = m.staticAccountKeys.map((k) => b58encode(k));
    const lk = m.addressTableLookups[0]!;
    const loaded = { writable: lk.writableIndexes.map((i) => ALT_KEYS[i]!), readonly: lk.readonlyIndexes.map((i) => ALT_KEYS[i]!) };
    const vSol = 1_000_000_000n + 100_000_000n;
    const vTok = (1_073_000_000_000_000n * 1_000_000_000n) / vSol;
    const tokens = 1_073_000_000_000_000n - vTok;
    world.chain.set(addrs.vaultState, {
      lamports: 2_338_000n,
      owner: SHOP_VAULT_PROGRAM_ID,
      data: vaultStateData({ placeHashHex: addrs.placeHashHex, mint: mint.publicKey.toBase58(), launcher: launcher.publicKey.toBase58() }),
    });
    world.chain.set(addrs.vault, { lamports: RENT0, owner: '11111111111111111111111111111111', data: new Uint8Array(0) });
    world.chain.set(curve, { lamports: 200_000_000n, owner: PUMP_PROGRAM, data: curveData({ vTok, vSol, rTok: 793_100_000_000_000n - tokens, rSol: 100_000_000n, creator: addrs.vault, bucket: 300_000n }) });
    world.chain.land(
      sig,
      {
        accountKeys: statics,
        numRequiredSignatures: 3,
        loaded,
        inner: [
          {
            programId: PUMP_PROGRAM,
            data: tradeEventIxData({ mint: mint.publicKey.toBase58(), sol: 100_000_000n, tokens, isBuy: true, user: launcher.publicKey.toBase58(), ts: Math.floor(clock / 1000), vSol, vTok, rSol: 100_000_000n, rTok: 793_100_000_000_000n - tokens, creator: addrs.vault, creatorFee: 300_000n }),
          },
        ],
        blockTime: Math.floor(clock / 1000),
      },
      [...statics, curve],
    );
    const conf = await call<LaunchConfirmResponse>('POST', '/api/launch/confirm', { reservationId: prep.body.reservationId, signature: sig });
    expect(conf.status).toBe(200);
    expect(conf.body.status).toBe('registered');
    if (conf.body.status !== 'registered') return;
    const coin = conf.body.coin;
    expect(coin).toMatchObject({ placeId: CAFE, mint: mint.publicKey.toBase58(), ticker: 'CAFE', category: 'cafe', emoji: '☕', launcher: launcher.publicKey.toBase58(), launchSig: sig, graduated: false });
    expect(coin.location).toEqual({ lat: 51.5469, lng: -0.0712 });
    // exact curve math (same functions the browser uses)
    expect(coin.market.vSol).toBe(vSol.toString());
    expect(coin.market.mcapLamports).toBe(((vSol * 1_000_000_000_000_000n) / vTok).toString());
    expect(coin.market.priceLamports).toBe(lamportsPerToken(vSol, vTok));
    // fees: vault at rent minimum (0) + curve bucket 300_000 collectable
    expect(coin.fees).toMatchObject({ waitingLamports: '300000', withdrawableNowLamports: '0', collectableLamports: '300000', earnedLamports: '300000' });
    expect(coin.owner.status).toBe('unclaimed');
    const trades = db.all<{ side: string; sol_lamports: number; creator_fee_lamports: number }>('SELECT * FROM trades');
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ side: 'buy', sol_lamports: 100_000_000, creator_fee_lamports: 300_000 });
    expect(db.get<{ used_by_mint: string }>('SELECT used_by_mint FROM metadata WHERE id = ?', md.metadataId)!.used_by_mint).toBe(mint.publicKey.toBase58());
    // idempotent
    expect((await call<LaunchConfirmResponse>('POST', '/api/launch/confirm', { reservationId: prep.body.reservationId, signature: sig })).body.status).toBe('registered');
    S.launch = { prep: prep.body, launcher, mint, sig, vault: addrs.vault, vaultState: addrs.vaultState, curve };
  });

  it('a second launch of the same place → 409 taken (with the existing coin)', async () => {
    const md = await call<MetadataUploadResponse>('POST', '/api/metadata', metaForm({ name: 'Another Cafe Coin', symbol: 'CAFE2' }));
    const r = await call<{ error: string; existing: { mint: string } }>('POST', '/api/launch/prepare', {
      placeId: CAFE,
      launcher: web3.Keypair.generate().publicKey.toBase58(),
      mint: web3.Keypair.generate().publicKey.toBase58(),
      metadataId: md.body.metadataId,
      category: 'cafe',
      emoji: '☕',
      bg: '#1f8a4c',
      devBuyLamports: '0',
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('taken');
    expect(r.body.existing.mint).toBe(S.launch!.mint.publicKey.toBase58());
    const e = await call<{ reason: string }>('GET', `/api/place/${CAFE}/eligibility`);
    expect(e.body.reason).toBe('taken');
  });

  it('registry reads: place, coins (bbox / mints / launcher / new), detail, top, market', async () => {
    const mint = S.launch!.mint.publicKey.toBase58();
    const place = await call<{ coin: { mint: string } | null; launchInProgress: boolean }>('GET', `/api/place/${CAFE}`);
    expect(place.body.coin?.mint).toBe(mint);
    for (const q of ['bbox=-0.08,51.54,-0.06,51.55', `mints=${mint}`, `launcher=${S.launch!.launcher.publicKey.toBase58()}`, 'sort=new']) {
      const r = await call<CoinsResponse>('GET', `/api/coins?${q}`);
      expect(r.status, q).toBe(200);
      expect(r.body.coins.map((c) => c.mint), q).toEqual([mint]);
    }
    expect((await call<CoinsResponse>('GET', '/api/coins?bbox=10,10,11,11')).body.coins).toEqual([]);
    expect((await call('GET', '/api/coins?bbox=1,2,3')).status).toBe(400);
    expect((await call<CoinsResponse>('GET', '/api/coins?bbox=179,-90,-179,90')).body.coins).toEqual([]); // antimeridian split
    const d = await call<CoinDetailResponse>('GET', `/api/coins/${mint}`);
    expect(d.status).toBe(200);
    expect(d.body.history).toHaveLength(48);
    expect(d.body.history[47]).toBeCloseTo(d.body.market.priceLamports, 6);
    expect(d.body.trades).toHaveLength(1);
    expect(d.body.ticks).toHaveLength(1);
    expect(d.body.market.vol24hLamports).toBe('100000000');
    const fresh = await call<CoinDetailResponse>('GET', `/api/coins/${mint}?fresh=1`);
    expect(fresh.headers.get('cache-control')).toBe('no-store');
    const top = await call<{ coins: { mint: string }[] }>('GET', '/api/top?by=fees');
    expect(top.body.coins[0]!.mint).toBe(mint);
    const mk = await call<MarketResponse>('GET', `/api/market?mints=${mint}`);
    expect(mk.body.quotes[mint]!.venue).toBe('curve');
    expect(mk.body.quotes[mint]!.realSol).toBe('100000000');
    expect(mk.body.solUsd).toBeNull(); // the cron has not fetched a price yet
    expect((await call('GET', '/api/coins/notamint')).status).toBe(400);
    expect((await call('GET', `/api/coins/${web3.Keypair.generate().publicKey.toBase58()}`)).status).toBe(404);
  });

  it('/api/market serves curve reads from the isolate cache, refreshes stale ones in the background, never older than 6 s', async () => {
    const { __resetMarketCache } = await import('./reads');
    __resetMarketCache();
    const mint = S.launch!.mint.publicKey.toBase58();
    await flush();
    // each quote's `at` is when the Worker read the curve: it tells a cache hit (old `at`) from a read (`at` = now)
    const t0 = clock;
    const a = await call<MarketResponse>('GET', `/api/market?mints=${mint}`); // miss: read before answering
    expect(a.body.quotes[mint]!.at).toBe(t0);
    clock += 2_000;
    const b = await call<MarketResponse>('GET', `/api/market?mints=${mint}`); // fresh hit
    expect(b.body.quotes[mint]!.at).toBe(t0);
    await flush();
    clock += 3_300; // 5.3 s: the next poll of a 5 s poller
    const c = await call<MarketResponse>('GET', `/api/market?mints=${mint}`); // stale hit: served now, refreshed behind
    expect(c.body.quotes[mint]!.at).toBe(t0);
    await flush();
    clock += 5_200;
    const d = await call<MarketResponse>('GET', `/api/market?mints=${mint}`); // the background refresh made this a hit
    expect(d.body.quotes[mint]!.at).toBe(t0 + 5_300);
    await flush();
    clock += 7_000; // nobody polled for 7 s: too old to serve, read before answering
    const e = await call<MarketResponse>('GET', `/api/market?mints=${mint}`);
    expect(e.body.quotes[mint]!.at).toBe(clock);
    await flush();
    clock += 500; // back on a whole second (later tests compare block times in seconds)
  });

  it('indexing: a trade tx via /api/index/tx shows in the feed and moves the mirror', async () => {
    const L = S.launch!;
    const buyer = web3.Keypair.generate().publicKey.toBase58();
    const sig = b58encode(crypto.getRandomValues(new Uint8Array(64)));
    const vSol = 1_100_000_000n + 50_000_000n;
    const vTok = (1_073_000_000_000_000n * 1_000_000_000n) / vSol;
    clock += 5_000;
    world.chain.land(sig, {
      accountKeys: [buyer, L.curve, PUMP_PROGRAM],
      numRequiredSignatures: 1,
      inner: [
        {
          programId: PUMP_PROGRAM,
          data: tradeEventIxData({ mint: L.mint.publicKey.toBase58(), sol: 50_000_000n, tokens: 1_000_000n, isBuy: true, user: buyer, ts: Math.floor(clock / 1000), vSol, vTok, rSol: 150_000_000n, rTok: 700_000_000_000_000n, creator: L.vault, creatorFee: 150_000n }),
        },
      ],
      blockTime: Math.floor(clock / 1000),
    });
    const r = await call<{ indexed: number }>('POST', '/api/index/tx', { signature: sig });
    expect(r.body.indexed).toBe(1);
    expect((await call<{ indexed: number }>('POST', '/api/index/tx', { signature: sig })).body.indexed).toBe(1); // idempotent (INSERT OR IGNORE)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trades')!.n).toBe(2);
    expect(db.get<{ real_sol: number }>('SELECT real_sol FROM coins WHERE mint = ?', L.mint.publicKey.toBase58())!.real_sol).toBe(150_000_000);
    const feed = await call<FeedResponse>('GET', '/api/feed?limit=10');
    expect(feed.body.events.map((e) => e.kind)).toEqual(['trade', 'trade', 'launch']);
    expect(feed.body.events[0]!.id).toBe(`${sig}:0`);
    const since = await call<FeedResponse>('GET', `/api/feed?since=${clock - 1}`);
    expect(since.body.events.map((e) => e.id)).toEqual([`${sig}:0`]);
    expect((await call('POST', '/api/index/tx', { signature: 'x' })).status).toBe(400);
  });

  it('claim: status → call (devnet screen code) → check → cosign → confirm', async () => {
    const L = S.launch!;
    const st = await call<{ owner: { status: string }; verificationActive: boolean; claimWindowSecs: number }>('GET', `/api/claim/status?placeId=${CAFE}`);
    expect(st.body).toMatchObject({ owner: { status: 'unclaimed' }, verificationActive: false, claimWindowSecs: 60 });
    const callRes = await call<ClaimCallResponse>('POST', '/api/claim/call', { placeId: CAFE });
    expect(callRes.status).toBe(200);
    expect(callRes.body.channel).toBe('screen');
    expect(callRes.body.masked).toBe('+44 20 •••• ••23');
    expect(callRes.body.devCode).toMatch(/^\d{6}$/);
    expect(world.twilio.started).toHaveLength(0); // devnet never calls anyone
    expect(db.get<{ phone_hash: string; code_hash: string }>('SELECT phone_hash, code_hash FROM claims')!.phone_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(db.all('SELECT * FROM claims'))).not.toContain(callRes.body.devCode!);
    expect(JSON.stringify(db.all('SELECT * FROM claims'))).not.toContain('7946');
    // one active claim per place
    const second = await call<{ error: string }>('POST', '/api/claim/call', { placeId: CAFE }, { 'cf-connecting-ip': '198.51.100.1' });
    expect(second.body.error).toBe('claim_active');
    const st2 = await call<{ verificationActive: boolean }>('GET', `/api/claim/status?placeId=${CAFE}`);
    expect(st2.body.verificationActive).toBe(true);

    const wrongCode = callRes.body.devCode === '000000' ? '111111' : '000000';
    const wrong = await call<ClaimCheckResponse>('POST', '/api/claim/check', { claimId: callRes.body.claimId, code: wrongCode });
    expect(wrong.body).toEqual({ approved: false, attemptsLeft: 2 });
    const ok = await call<ClaimCheckResponse>('POST', '/api/claim/check', { claimId: callRes.body.claimId, code: callRes.body.devCode });
    expect(ok.body.approved).toBe(true);
    if (!ok.body.approved) return;

    const s = await sv();
    const newOwner = web3.Keypair.generate();
    const build = (nonce: bigint) =>
      new Uint8Array(
        new web3.TransactionMessage({
          payerKey: newOwner.publicKey,
          recentBlockhash: world.chain.blockhash,
          instructions: [
            web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }),
            web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
            s.requestClaim({ attestor: attestor.publicKey, newOwner: newOwner.publicKey, placeHash: s.placeHash(CAFE), nonce }),
          ],
        })
          .compileToV0Message([])
          .serialize(),
      );
    const badNonce = await call<{ error: string }>('POST', '/api/claim/cosign', { claimId: callRes.body.claimId, claimToken: ok.body.claimToken, newOwner: newOwner.publicKey.toBase58(), messageBase64: toB64(build(2n)) });
    expect(badNonce.body.error).toBe('policy_violation');
    const badToken = await call<{ error: string }>('POST', '/api/claim/cosign', { claimId: callRes.body.claimId, claimToken: 'x'.repeat(43), newOwner: newOwner.publicKey.toBase58(), messageBase64: toB64(build(1n)) });
    expect(badToken.body.error).toBe('claim_not_verified');
    const wrongOwner = await call<{ error: string }>('POST', '/api/claim/cosign', { claimId: callRes.body.claimId, claimToken: ok.body.claimToken, newOwner: web3.Keypair.generate().publicKey.toBase58(), messageBase64: toB64(build(1n)) });
    expect(wrongOwner.body.error).toBe('wrong_owner'); // the first cosign bound the new owner
    const msg = build(1n);
    const cos = await call<ClaimCosignResponse>('POST', '/api/claim/cosign', { claimId: callRes.body.claimId, claimToken: ok.body.claimToken, newOwner: newOwner.publicKey.toBase58(), messageBase64: toB64(msg) });
    expect(cos.status).toBe(200);
    expect(cos.body.expectedNonce).toBe('1');
    const pub = await crypto.subtle.importKey('raw', attestor.publicKey.toBytes(), { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, pub, NodeBuffer.from(cos.body.attestorSignature, 'base64'), msg)).toBe(true);

    // land request_claim
    const sig = b58encode(crypto.getRandomValues(new Uint8Array(64)));
    const unlockTs = Math.floor(clock / 1000) + 60;
    world.chain.set(L.vaultState, {
      lamports: 2_338_000n,
      owner: SHOP_VAULT_PROGRAM_ID,
      data: vaultStateData({ placeHashHex: L.prep.placeHash, mint: L.mint.publicKey.toBase58(), launcher: L.launcher.publicKey.toBase58(), pending: { owner: newOwner.publicKey.toBase58(), unlockTs }, nonce: 1n }),
    });
    world.chain.land(sig, { accountKeys: [newOwner.publicKey.toBase58(), attestor.publicKey.toBase58(), L.vaultState, SHOP_VAULT_PROGRAM_ID], numRequiredSignatures: 2, inner: [] });
    const conf = await call<ClaimConfirmResponse>('POST', '/api/claim/confirm', { claimId: callRes.body.claimId, signature: sig });
    expect(conf.body).toEqual({ status: 'pending_onchain', unlockTs, inProbation: false, claimWindowSecs: 60 });
    const again = await call<{ error: string }>('POST', '/api/claim/call', { placeId: CAFE }, { 'cf-connecting-ip': '198.51.100.2' });
    expect(again.body.error).toBe('claim_pending');
    S.newOwner = newOwner;
    S.claimId = callRes.body.claimId;
  });

  it('cron: price + config + finalize after the window (crank) → finalized; fees withdrawable', async () => {
    const L = S.launch!;
    const ctx = (await buildCtx(env, exec, deps, 'cron'))!;
    let r = await runIndexer(ctx);
    await flush();
    expect(r.skipped).toBeUndefined();
    expect(r.jobs.price).toMatch(/jupiter 150.25/);
    expect(r.jobs.claims).toBe('nothing due');
    expect(r.fetches).toBeLessThanOrEqual(40);
    const cfg = await call<ConfigResponse>('GET', '/api/config');
    expect(cfg.body.solUsd).toBe(150.25);

    // window passes; the crank's finalize "lands" and flips the VaultState
    clock += 61_000;
    world.chain.onSend = () => {
      world.chain.set(L.vaultState, {
        lamports: 2_338_000n,
        owner: SHOP_VAULT_PROGRAM_ID,
        data: vaultStateData({ placeHashHex: L.prep.placeHash, mint: L.mint.publicKey.toBase58(), launcher: L.launcher.publicKey.toBase58(), owner: S.newOwner.publicKey.toBase58(), nonce: 1n, ownerSince: Math.floor(clock / 1000) }),
      });
    };
    r = await runIndexer(ctx);
    await flush();
    expect(r.jobs.claims).toBe('0 finalized, 1 sent');
    expect(world.chain.sent).toHaveLength(1);
    // right-sized: finalize's own CU limit (src/chain/budget), not a 20k blanket
    const fin = web3.VersionedTransaction.deserialize(NodeBuffer.from(world.chain.sent[0]!, 'base64')).message.compiledInstructions;
    expect(Array.from(fin[0]!.data)).toEqual([2, ...u64le(BigInt(VAULT_CU.finalizeClaim)).slice(0, 4)]);
    // the finalize landed but the mirror has not caught up yet: a plain detail read of a coin whose claim window is
    // over is answered from chain, so the panel never offers a Finalize that can only fail
    expect(db.get<{ pending_owner: string | null }>('SELECT pending_owner FROM coins WHERE mint = ?', L.mint.publicKey.toBase58())!.pending_owner).toBe(S.newOwner.publicKey.toBase58());
    const plain = await call<CoinDetailResponse>('GET', `/api/coins/${L.mint.publicKey.toBase58()}`);
    expect(plain.body.owner).toMatchObject({ status: 'claimed', owner: S.newOwner.publicKey.toBase58() });
    expect(plain.headers.get('cache-control')).toBe('no-store');
    await flush();
    clock += 61_000;
    r = await runIndexer(ctx);
    await flush();
    expect(r.jobs.claims).toBe('1 finalized, 0 sent');
    expect(db.get<{ status: string }>('SELECT status FROM claims WHERE id = ?', S.claimId)!.status).toBe('finalized');
    // the coin's owner mirror follows in the same pass: a plain (cached) detail read already says "claimed"
    expect(db.get<{ owner: string | null; pending_owner: string | null }>('SELECT owner, pending_owner FROM coins WHERE mint = ?', L.mint.publicKey.toBase58())).toEqual({
      owner: S.newOwner.publicKey.toBase58(),
      pending_owner: null,
    });
    // fees arrive in the vault → the vault sweep reports them withdrawable (exact lamports)
    world.chain.set(L.vault, { lamports: RENT0 + 450_000n, owner: '11111111111111111111111111111111', data: new Uint8Array(0) });
    world.chain.set(await pumpCreatorVaultPda(L.vault), { lamports: 0n, owner: '11111111111111111111111111111111', data: new Uint8Array(0) });
    const d = await call<CoinDetailResponse>('GET', `/api/coins/${L.mint.publicKey.toBase58()}?fresh=1`);
    expect(d.body.owner).toMatchObject({ status: 'claimed', owner: S.newOwner.publicKey.toBase58() });
    expect(d.body.fees).toMatchObject({ withdrawableNowLamports: '450000', collectableLamports: '300000', waitingLamports: '750000' });
    const feed = await call<FeedResponse>('GET', '/api/feed?kinds=claim');
    expect(feed.body.events.map((e) => (e.kind === 'claim' ? e.stage : ''))).toEqual(['finalized', 'requested']);
    // the lock is released and a concurrent run is refused while held
    // a finished run releases its lock by expiring it (the row stays: the next run rewrites one row, not two)
    expect(db.get<{ updated_at: number }>("SELECT updated_at FROM kv_meta WHERE key = 'indexer_lock'")!.updated_at).toBe(0);
    const held = await db
      .asD1()
      .prepare("INSERT INTO kv_meta(key, value, updated_at) VALUES ('indexer_lock', '\"other\"', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .bind(clock)
      .run();
    expect(held.success).toBe(true);
    expect((await runIndexer(ctx)).skipped).toBe('locked');
  });

  it('graduation: a completed curve with a canonical pool flips to graduated', async () => {
    const L = S.launch!;
    db.raw.prepare("DELETE FROM kv_meta WHERE key = 'indexer_lock'").run();
    const cur = world.chain.accounts.get(L.curve)!;
    const done = cur.data.slice();
    done[48] = 1; // complete
    world.chain.set(L.curve, { ...cur, data: done });
    const pool = await canonicalPoolPda(L.mint.publicKey.toBase58());
    const pd = new Uint8Array(300);
    pd.set(NodeBuffer.from('f19a6d0411b16dbc', 'hex'), 0);
    pd.set(L.mint.publicKey.toBytes(), 43);
    pd.set(web3.Keypair.generate().publicKey.toBytes(), 139);
    pd.set(web3.Keypair.generate().publicKey.toBytes(), 171);
    world.chain.set(pool, { lamports: 1n, owner: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', data: pd });
    const ctx = (await buildCtx(env, exec, deps, 'cron'))!;
    clock += 61_000;
    const r = await runIndexer(ctx);
    await flush();
    expect(r.jobs.graduation).toBe('1 graduated');
    expect(db.get<{ graduated: number; pool: string }>('SELECT graduated, pool FROM coins WHERE mint = ?', L.mint.publicKey.toBase58())).toEqual({ graduated: 1, pool });
  });

  it('website verification: own domain only; the code on the site approves a re-claim', async () => {
    const issued = await call<{ status: string; claimId: string; code: string; host: string }>('POST', '/api/claim/website', { placeId: CAFE });
    expect(issued.status).toBe(200);
    expect(issued.body.status).toBe('code');
    expect(issued.body.host).toBe('www.mycafe.co.uk');
    expect(issued.body.code).toMatch(/^atlaspad-verify=[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const early = await call<{ status: string }>('POST', '/api/claim/website', { placeId: CAFE, claimId: issued.body.claimId });
    expect(early.body.status).toBe('not_found');
    // SECURITY: the code anywhere a visitor can write (a review / comment in the home page body, or a catch-all route
    // serving that page as the .txt) proves nothing, under the AtlasPad or the legacy CORNERSHOP tag name
    const value = issued.body.code.split('=')[1];
    const homeWithReview = `<!doctype html><html><head><title>My Cafe</title><script type="application/ld+json">{"review":"<meta name=\\"atlaspad-verify\\" content=\\"${value}\\">"}</script></head><body><p>Great coffee! ${issued.body.code}</p><meta name="atlaspad-verify" content="${value}"><meta name="cornershop-verify" content="${value}"></body></html>`;
    world.sites.set('www.mycafe.co.uk/', homeWithReview);
    clock += 11_000;
    expect((await call<{ status: string }>('POST', '/api/claim/website', { placeId: CAFE, claimId: issued.body.claimId })).body.status).toBe('not_found');
    world.sites.set('www.mycafe.co.uk/.well-known/atlaspad.txt.html', homeWithReview);
    world.sites.set('www.mycafe.co.uk/.well-known/atlaspad.txt', `hello ${issued.body.code}\n`); // not a line of its own
    world.sites.set('www.mycafe.co.uk/.well-known/cornershop.txt', `hello ${issued.body.code}\n`);
    clock += 11_000;
    expect((await call<{ status: string }>('POST', '/api/claim/website', { placeId: CAFE, claimId: issued.body.claimId })).body.status).toBe('not_found');
    world.sites.set('www.mycafe.co.uk/.well-known/atlaspad.txt', `${issued.body.code}\n`);
    clock += 11_000;
    const ok = await call<{ status: string; claimToken: string }>('POST', '/api/claim/website', { placeId: CAFE, claimId: issued.body.claimId });
    expect(ok.body.status).toBe('approved');
    // a website-code claim is a weaker proof: ops / the guardian get an alert
    await flush();
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'claim_website_verified'")!.n).toBe(1);
    expect(ok.body.claimToken.length).toBeGreaterThan(30);
    // a listing whose "website" is a platform page cannot use this method
    const P2 = 'ChIJtripadvisor000001';
    world.places.set(P2, { ...world.places.get(CAFE)!, id: P2, websiteUri: 'https://www.tripadvisor.co.uk/Restaurant_Review-x' });
    db.raw
      .prepare(
        `INSERT INTO coins(place_id, place_hash, mint, vault, vault_state, bonding_curve, ticker, name, category, emoji, bg, metadata_id, launcher, created_at, launch_sig, launch_slot, cluster, updated_at)
         SELECT ?, 'ff' || substr(place_hash, 3), ?, vault, vault_state, bonding_curve, 'TRIP', 'Trip', category, emoji, bg, metadata_id, launcher, created_at, ?, 1, cluster, updated_at FROM coins WHERE place_id = ?`,
      )
      .run(P2, web3.Keypair.generate().publicKey.toBase58(), b58encode(new Uint8Array(64).fill(5)), CAFE);
    const refused = await call<{ error: string }>('POST', '/api/claim/website', { placeId: P2 });
    expect(refused.body.error).toBe('not_own_domain');
  });

  it('program monitor: unknown Registered / ClaimRequested and unplanned AdminChanged raise critical alerts', async () => {
    const enc = (s: string) => toB64(new TextEncoder().encode(s));
    const k = () => toB64(web3.Keypair.generate().publicKey.toBytes());
    const P = SHOP_VAULT_PROGRAM_ID;
    const sig = b58encode(crypto.getRandomValues(new Uint8Array(64)));
    world.chain.land(sig, {
      accountKeys: [web3.Keypair.generate().publicKey.toBase58(), P],
      numRequiredSignatures: 1,
      inner: [],
      logs: [
        `Program ${P} invoke [1]`,
        `Program data: ${enc('Registered')} ${toB64(new Uint8Array(32).fill(9))} ${k()} ${k()} ${k()} ${k()}`,
        `Program data: ${enc('AdminChanged')} ${toB64(Uint8Array.of(1))} ${k()}`,
        `Program ${P} success`,
      ],
    });
    db.raw.prepare("DELETE FROM kv_meta WHERE key = 'indexer_lock'").run();
    clock += 61_000;
    const before = db.queries;
    const r = await runIndexer((await buildCtx(env, exec, deps, 'cron'))!);
    await flush();
    expect(r.jobs.monitor).toBe('2 events from 1 txs');
    expect(db.queries - before).toBeLessThanOrEqual(50); // Workers Free: ≤ 50 D1 queries per invocation
    const alerts = db.all<{ kind: string; severity: string }>("SELECT kind, severity FROM alerts WHERE kind IN ('registered_unknown','admin_changed') ORDER BY id");
    expect(alerts).toEqual([
      { kind: 'registered_unknown', severity: 'critical' },
      { kind: 'admin_changed', severity: 'critical' },
    ]);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM chain_events WHERE sig = ?', sig)!.n).toBe(2);
  });
});

/* ===================================================================================== rpc proxy / origin */

describe('/api/rpc proxy', () => {
  const rpc = (body: unknown, extra: Record<string, string> = {}) => call<any>('POST', '/api/rpc', body, extra);

  it('forwards allowlisted methods, caches, and never leaks the key', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 7, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ jsonrpc: '2.0', id: 7, result: { value: { blockhash: world.chain.blockhash } } });
    expect(r.text).not.toContain(ALCHEMY_KEY);
    const before = world.chain.calls.length;
    await rpc({ jsonrpc: '2.0', id: 8, method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] });
    expect(world.chain.calls.length).toBe(before); // 1 s shared cache
  });

  it('refuses methods outside the allowlist and bad params', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: ['x'] })).body.error.code).toBe(-32601);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'requestAirdrop', params: [] })).body.error.code).toBe(-32601);
    const pk = web3.Keypair.generate().publicKey.toBase58();
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [pk] })).body.error.code).toBe(-32602); // encoding required
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [pk, { encoding: 'base58' }] })).body.error.code).toBe(-32602);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [pk, { limit: 100 }] })).body.error.code).toBe(-32602);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[b58encode(new Uint8Array(64).fill(1))], { searchTransactionHistory: true }] })).body.error.code).toBe(-32602);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [b58encode(new Uint8Array(64).fill(1)), { encoding: 'json' }] })).body.error.code).toBe(-32602);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [pk, { programId: pk }, { encoding: 'base64' }] })).body.error.code).toBe(-32602);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [toB64(new Uint8Array(1300)), { encoding: 'base64' }] })).body.error.code).toBe(-32602);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [toB64(new Uint8Array(300)), { encoding: 'base64', maxRetries: 50 }] })).body.error.code).toBe(-32602);
    const batch = await rpc(Array.from({ length: 11 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'getSlot' })));
    expect(batch.status).toBe(400);
    const mixed = await rpc([
      { jsonrpc: '2.0', id: 'a', method: 'getSlot' },
      { jsonrpc: '2.0', id: 'b', method: 'getProgramAccounts' },
    ]);
    expect(mixed.body[0]).toMatchObject({ id: 'a', result: world.chain.slot });
    expect(mixed.body[1]).toMatchObject({ id: 'b', error: { code: -32601 } });
    expect((await rpc('not json' as unknown as object)).status).toBe(200); // a JSON string is a single invalid request
  });

  it('cross-origin POSTs are refused; same-origin and no-Origin pass', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'getSlot' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', '/api/report', { kind: 'report', reason: 'scam', mint: S.launch!.mint.publicKey.toBase58() }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', '/api/report', { kind: 'report', reason: 'scam', mint: `${ORIGIN}/c/${S.launch!.mint.publicKey.toBase58()}` })).status).toBe(204);
    expect((await call('POST', '/api/report', { kind: 'report', reason: 'scam' })).status).toBe(400); // which coin?
  });

  it('a body over 8 KB is refused', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'x'.repeat(9000) }] });
    expect(r.status).toBe(413);
  });
});

/* ================================================================================== devnet faucet / locks */

describe('devnet-only endpoints and launch locks', () => {
  it('/api/dev/airdrop sends test SOL within caps', async () => {
    const to = web3.Keypair.generate().publicKey.toBase58();
    world.chain.onSend = (tx) => {
      const sig = b58encode(Uint8Array.from(atob(tx), (c) => c.charCodeAt(0)).subarray(1, 65));
      world.chain.statuses.set(sig, { slot: world.chain.slot, err: null, confirmationStatus: 'confirmed' });
      return sig;
    };
    const r = await call<{ signature: string; lamports: string }>('POST', '/api/dev/airdrop', { address: to });
    expect(r.status).toBe(200);
    expect(r.body.lamports).toBe('1000000000');
    world.chain.set(to, { lamports: 2_000_000_000n, owner: '11111111111111111111111111111111', data: new Uint8Array(0) });
    expect((await call<{ error: string }>('POST', '/api/dev/airdrop', { address: to })).body.error).toBe('bad_request'); // already funded
  }, 30_000);

  it('only one co-signed launch per place: the second launcher gets 409 reserved', async () => {
    const PLACE = 'ChIJlock00000000000001';
    world.places.set(PLACE, { id: PLACE, businessStatus: 'OPERATIONAL', primaryType: 'barber_shop', types: ['barber_shop'], location: { latitude: 51.5, longitude: -0.1 } });
    const s = await sv();
    const ph = s.placeHash(PLACE);
    const prepFor = async () => {
      const md = await call<MetadataUploadResponse>('POST', '/api/metadata', metaForm({ placeId: PLACE, name: 'Fade Bros', symbol: 'FADE' }));
      const launcher = web3.Keypair.generate();
      const mint = web3.Keypair.generate();
      const prep = await call<LaunchPrepareResponse>('POST', '/api/launch/prepare', {
        placeId: PLACE,
        launcher: launcher.publicKey.toBase58(),
        mint: mint.publicKey.toBase58(),
        metadataId: md.body.metadataId,
        category: 'barber',
        emoji: '💈',
        bg: '#222222',
        devBuyLamports: '0',
      });
      expect(prep.status).toBe(200);
      const keys = { launcher, mint, attestor, placeId: PLACE, placeHash: ph, vault: s.vaultPda(ph)[0], name: prep.body.name, symbol: prep.body.symbol, uri: prep.body.uri };
      const b = await buildLaunch({ devBuy: 0n, alts: [altAccount(ALT)] }, keys);
      return { prep: prep.body, b };
    };
    const a = await prepFor();
    const b = await prepFor();
    expect((await call('POST', '/api/launch/cosign', { reservationId: a.prep.reservationId, messageBase64: toB64(a.b.bytes) })).status).toBe(200);
    const second = await call<{ error: string; retryAfterSec: number }>('POST', '/api/launch/cosign', { reservationId: b.prep.reservationId, messageBase64: toB64(b.b.bytes) });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('reserved');
    expect(second.body.retryAfterSec).toBeGreaterThan(0);
    const place = await call<{ launchInProgress: boolean }>('GET', `/api/place/${PLACE}`);
    expect(place.body.launchInProgress).toBe(true);
    // the first lock expires → the second launcher may co-sign (a retry with the same reservation is allowed too)
    clock += 121_000;
    const third = await call<{ error: string }>('POST', '/api/launch/cosign', { reservationId: b.prep.reservationId, messageBase64: toB64(b.b.bytes) });
    expect(third.body.error).toBe('reservation_expired'); // prepare TTL (120 s) also passed
  });

  it('a launch that landed after its reservation lapsed is adopted into the registry (no orphan coins)', async () => {
    const PLACE = 'ChIJadopt000000000001';
    world.places.set(PLACE, { id: PLACE, businessStatus: 'OPERATIONAL', primaryType: 'bakery', types: ['bakery'], location: { latitude: 51.51, longitude: -0.12 } });
    const s = await sv();
    const ph = s.placeHash(PLACE);
    const md = await call<MetadataUploadResponse>('POST', '/api/metadata', metaForm({ placeId: PLACE, name: 'Late Loaf', symbol: 'LOAF' }));
    const launcher = web3.Keypair.generate();
    const mint = web3.Keypair.generate();
    const prep = await call<LaunchPrepareResponse>('POST', '/api/launch/prepare', {
      placeId: PLACE,
      launcher: launcher.publicKey.toBase58(),
      mint: mint.publicKey.toBase58(),
      metadataId: md.body.metadataId,
      category: 'bakery',
      emoji: '🥐',
      bg: '#aa7744',
      devBuyLamports: '0',
    });
    const keys = { launcher, mint, attestor, placeId: PLACE, placeHash: ph, vault: s.vaultPda(ph)[0], name: prep.body.name, symbol: prep.body.symbol, uri: prep.body.uri };
    const b = await buildLaunch({ devBuy: 0n, alts: [altAccount(ALT)] }, keys);
    expect((await call('POST', '/api/launch/cosign', { reservationId: prep.body.reservationId, messageBase64: toB64(b.bytes) })).status).toBe(200);
    // the browser vanished; the cron expired the reservation; then the tx shows up on chain
    db.raw.prepare("UPDATE launch_reservations SET status = 'expired' WHERE id = ?").run(prep.body.reservationId);
    const addrs = await placeAddresses(PLACE, SHOP_VAULT_PROGRAM_ID);
    world.chain.set(addrs.vaultState, { lamports: 2_338_000n, owner: SHOP_VAULT_PROGRAM_ID, data: vaultStateData({ placeHashHex: addrs.placeHashHex, mint: mint.publicKey.toBase58(), launcher: launcher.publicKey.toBase58() }) });
    world.chain.set(b.expect.bondingCurve, { lamports: 1n, owner: PUMP_PROGRAM, data: curveData({ vTok: 1_073_000_000_000_000n, vSol: 1_000_000_000n, rTok: 793_100_000_000_000n, rSol: 0n, creator: addrs.vault }) });
    const m = decodeMessage(b.bytes);
    const sig = b58encode(crypto.getRandomValues(new Uint8Array(64)));
    world.chain.land(sig, { accountKeys: m.staticAccountKeys.map((k) => b58encode(k)), numRequiredSignatures: 3, inner: [] }, [addrs.vaultState]);
    const e = await call<{ reason: string }>('GET', `/api/place/${PLACE}/eligibility`);
    expect(e.body.reason).toBe('taken');
    const place = await call<{ coin: { mint: string } | null }>('GET', `/api/place/${PLACE}`);
    expect(place.body.coin?.mint).toBe(mint.publicKey.toBase58());
  });

  it('launches paused on-chain → 423', async () => {
    world.chain.set(CONFIG_PDA, { lamports: 2_000_000n, owner: SHOP_VAULT_PROGRAM_ID, data: configData({ attestor: attestor.publicKey.toBase58(), guardian, governance, window: 60, paused: true }) });
    const { __resetChainCaches } = await import('./chainState');
    __resetChainCaches();
    const md = await call<MetadataUploadResponse>('POST', '/api/metadata', metaForm({ placeId: 'ChIJpaused00000000001', name: 'Paused Pub', symbol: 'PUB' }));
    world.places.set('ChIJpaused00000000001', { id: 'ChIJpaused00000000001', businessStatus: 'OPERATIONAL', primaryType: 'pub', types: ['pub'] });
    const r = await call<{ error: string }>('POST', '/api/launch/prepare', {
      placeId: 'ChIJpaused00000000001',
      launcher: web3.Keypair.generate().publicKey.toBase58(),
      mint: web3.Keypair.generate().publicKey.toBase58(),
      metadataId: md.body.metadataId,
      category: 'pub',
      emoji: '🍺',
      bg: '#333333',
      devBuyLamports: '0',
    });
    expect(r.status).toBe(423);
    expect(r.body.error).toBe('launches_paused');
    world.chain.set(CONFIG_PDA, { lamports: 2_000_000n, owner: SHOP_VAULT_PROGRAM_ID, data: configData({ attestor: attestor.publicKey.toBase58(), guardian, governance, window: 60 }) });
    __resetChainCaches();
  });
});

/* ======================================================================================== the demo Worker */

describe('demo Worker (vars.CLUSTER unset)', () => {
  const demoEnv: Env = { ASSETS: env.ASSETS, GOOGLE_SERVER_KEY: env.GOOGLE_SERVER_KEY };
  it('every Phase-2 route answers 404 not_enabled; Phase-1 routes keep working', async () => {
    for (const p of ['/api/config', '/api/coins?sort=new', '/api/market?mints=x']) {
      const res = await worker.fetch(new Request(`https://cornershop.tiejiucai.workers.dev${p}`), demoEnv, exec as never);
      expect(res.status, p).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe('not_enabled');
    }
    const rpcRes = await worker.fetch(new Request('https://cornershop.tiejiucai.workers.dev/api/rpc', { method: 'POST', body: '{}' }), demoEnv, exec as never);
    expect(rpcRes.status).toBe(404);
    const health = await worker.fetch(new Request('https://cornershop.tiejiucai.workers.dev/api/health'), demoEnv, exec as never);
    expect(await health.json()).toMatchObject({ ok: true, service: 'cornershop-api', google: true });
    const resolve = await worker.fetch(new Request('https://cornershop.tiejiucai.workers.dev/api/resolve'), demoEnv, exec as never);
    expect(resolve.status).toBe(400);
  });
});

/* ===================================================================================== round-1 QA fixes */

describe('round-1 QA fixes', () => {
  const setKv = (key: string, value: unknown) => {
    db.raw
      .prepare('INSERT INTO kv_meta(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), clock);
    clock += 6_000; // past the 5 s per-isolate kv snapshot
  };
  const counter = (key: string) => db.get<{ count: number }>('SELECT count FROM rate_counters WHERE key = ?', key)?.count ?? 0;

  it('the devnet test wallet never depends on the faucet; features.faucet and health follow the 0.3 SOL payout floor', async () => {
    // keep the request-driven fallback indexer (whose faucet job would rewrite the balance) out of this test
    const keepIndexerFresh = () => db.raw.prepare("INSERT INTO kv_meta(key, value, updated_at) VALUES ('indexer_last_run', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(clock + 60_000), clock);
    expect(FAUCET_PAYOUT_FLOOR_LAMPORTS).toBe(Number(FAUCET_FLOOR));
    for (const [lamports, faucetOk] of [
      [39_980_000, false],
      [299_999_999, false],
      [300_000_000, true],
      [1_200_000_000, true],
    ] as const) {
      keepIndexerFresh();
      setKv('faucet_balance', lamports);
      const c = await call<ConfigResponse>('GET', '/api/config');
      expect(c.body.features.testWallet, `${lamports}`).toBe(true);
      expect(c.body.features.faucet, `${lamports}`).toBe(faucetOk);
      const h = await call<HealthResponse>('GET', '/api/health');
      expect(h.body.checks.faucet, `${lamports}`).toBe(faucetOk ? 'ok' : 'stale');
      expect(h.body.checks.alchemy).toBe('ok');
      expect(h.body.checks).not.toHaveProperty('helius');
    }
  });

  it('/api/health shares its chain reads for 15 s per isolate (public traffic cannot burn the RPC quota)', async () => {
    __resetHealthCache();
    const genesisCalls = () => world.chain.calls.filter((m) => m === 'getGenesisHash').length;
    const n0 = genesisCalls();
    await call('GET', '/api/health');
    await call('GET', '/api/health');
    await call('GET', '/api/health');
    expect(genesisCalls() - n0).toBe(1);
    clock += 16_000;
    await call('GET', '/api/health');
    expect(genesisCalls() - n0).toBe(2);
  });

  it('faucet caps are reserved atomically: parallel airdrops from one IP never pass 3 SOL a day', async () => {
    const ip = '198.51.100.77';
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => call<{ error?: string; lamports?: string }>('POST', '/api/dev/airdrop', { address: web3.Keypair.generate().publicKey.toBase58() }, { 'cf-connecting-ip': ip })),
    );
    expect(rs.filter((r) => r.status === 200)).toHaveLength(3);
    expect(rs.filter((r) => r.status !== 200).map((r) => r.body.error)).toEqual(['faucet_cap', 'faucet_cap']);
    expect(counter(`faucet:ip:${await ipHash(env, ip)}`)).toBe(3_000_000_000); // refused requests reserved nothing
    // the payout updated the faucet balance the config / health read
    expect(db.get<{ value: string }>("SELECT value FROM kv_meta WHERE key = 'faucet_balance'")!.value).toBe(String(5_000_000_000 - 1_000_000_000 - 5_000));
  }, 30_000);

  it('a low faucet still pays: half of what it can spend, at least 0.25 SOL; below 0.3 SOL it refuses', async () => {
    const fk = faucet.publicKey.toBase58();
    const setFaucet = (lamports: bigint) => world.chain.set(fk, { lamports, owner: '11111111111111111111111111111111', data: new Uint8Array(0) });
    const drop = (ip: string) =>
      call<{ error?: string; lamports?: string }>('POST', '/api/dev/airdrop', { address: web3.Keypair.generate().publicKey.toBase58() }, { 'cf-connecting-ip': ip });
    setFaucet(580_000_000n); // 0.58 SOL: (0.58 − 0.05) / 2
    const a = await drop('198.51.100.91');
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.lamports).toBe('265000000');
    setFaucet(310_000_000n); // half of 0.26 is below the 0.25 minimum: pays the minimum
    const b = await drop('198.51.100.92');
    expect(b.body.lamports).toBe('250000000');
    setFaucet(299_999_999n); // cannot pay the minimum and keep its fee reserve
    const c = await drop('198.51.100.93');
    expect(c.status).toBe(503);
    expect(c.body.error).toBe('faucet_empty');
    setFaucet(5_000_000_000n); // well funded: 1 SOL as before
    const d = await drop('198.51.100.94');
    expect(d.body.lamports).toBe('1000000000');
  }, 30_000);

  it('devnet test places each get their own fictitious number; refused calls use up no other cap; the real wait is returned', async () => {
    const ip = '198.51.100.20';
    const clone = (placeId: string, prefix: string) =>
      db.raw
        .prepare(
          `INSERT INTO coins(place_id, place_hash, mint, vault, vault_state, bonding_curve, ticker, name, category, emoji, bg, metadata_id, launcher, created_at, launch_sig, launch_slot, cluster, updated_at)
           SELECT ?, ? || substr(place_hash, 3), ?, vault, vault_state, bonding_curve, 'TST', 'Test', category, emoji, bg, metadata_id, launcher, created_at, ?, 1, cluster, updated_at FROM coins WHERE place_id = ?`,
        )
        .run(placeId, prefix, web3.Keypair.generate().publicKey.toBase58(), b58encode(crypto.getRandomValues(new Uint8Array(64))), CAFE);
    const A = 'cornershop-test:qa-a';
    const B = 'cornershop-test:qa-b';
    clone(A, 'a1');
    clone(B, 'b2');
    const a = await call<ClaimCallResponse>('POST', '/api/claim/call', { placeId: A }, { 'cf-connecting-ip': ip });
    expect(a.status).toBe(200);
    const b = await call<ClaimCallResponse>('POST', '/api/claim/call', { placeId: B }, { 'cf-connecting-ip': ip });
    expect(b.status).toBe(200);
    expect(a.body.masked).toMatch(/^\+1 \d{3} ••• ••\d\d$/);
    expect(a.body.masked).not.toBe(b.body.masked);
    const rowA = db.get<{ phone_hash: string }>('SELECT phone_hash FROM claims WHERE id = ?', a.body.claimId)!;
    const rowB = db.get<{ phone_hash: string }>('SELECT phone_hash FROM claims WHERE id = ?', b.body.claimId)!;
    expect(rowA.phone_hash).not.toBe(rowB.phone_hash);
    // A's number has had 3 calls in 24 h: A is refused with the REAL wait, nothing else is charged
    db.raw.prepare("UPDATE claims SET status = 'expired' WHERE id = ?").run(a.body.claimId);
    const ins = db.raw.prepare("INSERT INTO phone_verifications(phone_hash, ts, place_id, claim_id, outcome) VALUES (?, ?, ?, 'x', 'started')");
    ins.run(rowA.phone_hash, clock - 3_600_000, A);
    ins.run(rowA.phone_hash, clock - 7_200_000, A);
    const h = await ipHash(env, ip);
    const before = [counter(`claim:ip:${h}`), counter(`claim:place:${A}`)];
    const refused = await call<{ error: string; message: string; retryAfterSec: number }>('POST', '/api/claim/call', { placeId: A }, { 'cf-connecting-ip': ip });
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: 'too_many_attempts', message: 'Too many calls to this number today.' });
    expect(refused.body.retryAfterSec).toBe(22 * 3600); // the 3rd most recent call (2 h ago) leaves the window in 22 h
    expect([counter(`claim:ip:${h}`), counter(`claim:place:${A}`)]).toEqual(before);
    S.claimId = b.body.claimId;
    (S as Record<string, unknown>).devCodeB = b.body.devCode;
  });

  it('parallel wrong codes: at most 3 are ever evaluated per claim', async () => {
    const devCode = (S as Record<string, unknown>).devCodeB as string;
    const wrong = devCode === '000000' ? '111111' : '000000';
    const rs = await Promise.all(Array.from({ length: 5 }, () => call<{ approved?: boolean; attemptsLeft?: number; error?: string }>('POST', '/api/claim/check', { claimId: S.claimId, code: wrong })));
    expect(rs.filter((r) => r.status === 200 && r.body.approved === false)).toHaveLength(3);
    expect(rs.filter((r) => r.status === 429).map((r) => r.body.error)).toEqual(['too_many_attempts', 'too_many_attempts']);
    expect(db.get<{ wrong_codes: number; status: string }>('SELECT wrong_codes, status FROM claims WHERE id = ?', S.claimId)).toEqual({ wrong_codes: 3, status: 'failed' });
    // and the right code no longer works on a failed claim
    expect((await call<{ error: string }>('POST', '/api/claim/check', { claimId: S.claimId, code: devCode })).body.error).toBe('claim_expired');
  });

  it('feed: ownership events carry no amount; a withdrawal is its own event with the exact payout', async () => {
    const claims = await call<FeedResponse>('GET', '/api/feed?kinds=claim&limit=20');
    const own = claims.body.events.filter((e) => e.kind === 'claim' && e.placeId === CAFE);
    expect(own.map((e) => (e as { stage: string }).stage).sort()).toEqual(['finalized', 'requested']);
    for (const e of own) expect((e as { feesLamports: string | null }).feesLamports).toBeNull();
    const L = S.launch!;
    const owner = S.newOwner.publicKey.toBase58();
    const enc = (u: Uint8Array) => toB64(u);
    const sig = b58encode(crypto.getRandomValues(new Uint8Array(64)));
    world.chain.land(sig, {
      accountKeys: [owner, L.vaultState, L.vault, SHOP_VAULT_PROGRAM_ID],
      numRequiredSignatures: 1,
      inner: [],
      logs: [
        `Program ${SHOP_VAULT_PROGRAM_ID} invoke [1]`,
        `Program data: ${enc(new TextEncoder().encode('Withdrawn'))} ${enc(fromHex(L.prep.placeHash))} ${enc(S.newOwner.publicKey.toBytes())} ${enc(u64le(1_777_779n))} ${enc(u64le(1_777_779n))}`,
        `Program ${SHOP_VAULT_PROGRAM_ID} success`,
      ],
      blockTime: Math.floor(clock / 1000),
    });
    expect((await call('POST', '/api/index/tx', { signature: sig })).status).toBe(200);
    const feed = await call<FeedResponse>('GET', '/api/feed?kinds=claim&limit=20');
    const w = feed.body.events.find((e) => e.id === `withdraw:${sig}:0`);
    expect(w).toMatchObject({ kind: 'claim', stage: 'withdrawn', feesLamports: '1777779', wallet: owner, sig, placeId: CAFE });
    // the monitor later sees the same tx: no duplicate row
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM chain_events WHERE kind = 'Withdrawn'")!.n).toBe(1);
    // a row recorded before amounts were stored is backfilled from its tx by the indexer
    db.raw.prepare(`UPDATE chain_events SET data_json = '{"name":"Withdrawn"}' WHERE sig = ?`).run(sig);
    expect((await call<FeedResponse>('GET', '/api/feed?kinds=claim&limit=20')).body.events.some((e) => e.id === `withdraw:${sig}:0`)).toBe(false);
    clock += 61_000;
    // the backfill found nothing missing on its last look, so it looks again only hourly (D1 reads)
    expect((await runIndexer((await buildCtx(env, exec, deps, 'cron'))!)).jobs.withdraw_amounts).toBe('not due');
    clock += HOUR;
    const r = await runIndexer((await buildCtx(env, exec, deps, 'cron'))!);
    await flush();
    expect(r.jobs.withdraw_amounts).toBe('1 rows');
    expect((await call<FeedResponse>('GET', '/api/feed?kinds=claim&limit=20')).body.events.find((e) => e.id === `withdraw:${sig}:0`)).toMatchObject({ feesLamports: '1777779' });
  });

  it('trades store what the trader paid / received (fees included); old rows are backfilled by the indexer', async () => {
    const row = db.get<{ sig: string; ix: number; sol_lamports: number; user_lamports: number }>(
      "SELECT sig, ix, sol_lamports, user_lamports FROM trades WHERE sol_lamports = 50000000 AND side = 'buy'",
    )!;
    expect(row.user_lamports).toBe(50_000_000 + 150_000); // curve amount + protocol fee (0 here) + creator fee
    db.raw.prepare('UPDATE trades SET user_lamports = NULL WHERE sig = ?').run(row.sig);
    clock += 61_000;
    const ctx = (await buildCtx(env, exec, deps, 'cron'))!;
    // nothing was missing on the last look: the next one is an hour later (D1 reads)
    expect((await runIndexer(ctx)).jobs.trade_amounts).toBe('not due');
    clock += HOUR;
    const r = await runIndexer(ctx);
    await flush();
    expect(r.jobs.trade_amounts).toMatch(/^\d+ rows$/);
    expect(db.get<{ user_lamports: number }>('SELECT user_lamports FROM trades WHERE sig = ?', row.sig)!.user_lamports).toBe(50_150_000);
    const detail = await call<CoinDetailResponse>('GET', `/api/coins/${S.launch!.mint.publicKey.toBase58()}`);
    expect(detail.body.trades.find((t) => t.sig === row.sig)!.userLamports).toBe('50150000');
  });

  it('holders: exact from getTokenLargestAccounts (curve account excluded, zero balances ignored)', async () => {
    const L = S.launch!;
    const mint = L.mint.publicKey.toBase58();
    world.chain.largest.set(mint, [
      { address: await curveBaseAta(L.curve, mint), amount: '700000000000000' },
      { address: web3.Keypair.generate().publicKey.toBase58(), amount: '5000000' },
      { address: web3.Keypair.generate().publicKey.toBase58(), amount: '0' },
      { address: web3.Keypair.generate().publicKey.toBase58(), amount: '7000000' },
    ]);
    db.raw.prepare('UPDATE coins SET holders = NULL WHERE mint = ?').run(mint);
    clock += 61_000;
    const ctx = (await buildCtx(env, exec, deps, 'cron'))!;
    await runIndexer(ctx);
    await flush();
    expect(db.get<{ holders: number }>('SELECT holders FROM coins WHERE mint = ?', mint)!.holders).toBe(2);
  });

  it('launch locks: a re-co-sign never extends the lock; a launcher starting over replaces its own lock; 3 locks per place a day', async () => {
    const PLACE = 'ChIJgrief0000000000001';
    world.places.set(PLACE, { id: PLACE, businessStatus: 'OPERATIONAL', primaryType: 'bar', types: ['bar'], location: { latitude: 51.52, longitude: -0.08 } });
    const s = await sv();
    const ph = s.placeHash(PLACE);
    const launcher = web3.Keypair.generate();
    const ip = { 'cf-connecting-ip': '198.51.100.88' };
    const prepAndBuild = async () => {
      const md = await call<MetadataUploadResponse>('POST', '/api/metadata', metaForm({ placeId: PLACE, name: 'Grief Bar', symbol: 'GRIEF' }), ip);
      const mint = web3.Keypair.generate();
      const prep = await call<LaunchPrepareResponse>(
        'POST',
        '/api/launch/prepare',
        { placeId: PLACE, launcher: launcher.publicKey.toBase58(), mint: mint.publicKey.toBase58(), metadataId: md.body.metadataId, category: 'pub', emoji: '🍸', bg: '#333333', devBuyLamports: '0' },
        ip,
      );
      expect(prep.status, JSON.stringify(prep.body)).toBe(200);
      const keys = { launcher, mint, attestor, placeId: PLACE, placeHash: ph, vault: s.vaultPda(ph)[0], name: prep.body.name, symbol: prep.body.symbol, uri: prep.body.uri };
      return { prep: prep.body, b: await buildLaunch({ devBuy: 0n, alts: [altAccount(ALT)] }, keys) };
    };
    const cosign = (x: { prep: LaunchPrepareResponse; b: { bytes: Uint8Array } }) =>
      call<LaunchCosignResponse & { error?: string }>('POST', '/api/launch/cosign', { reservationId: x.prep.reservationId, messageBase64: toB64(x.b.bytes) }, ip);
    const a1 = await prepAndBuild();
    const c1 = await cosign(a1);
    expect(c1.status).toBe(200);
    clock += 30_000;
    const c1again = await cosign(a1);
    expect(c1again.status).toBe(200);
    expect(c1again.body.lockedUntil).toBe(c1.body.lockedUntil); // fixed at the first co-sign
    // the same launcher starts over: its new reservation takes the place of its own lock (no stacking)
    const a2 = await prepAndBuild();
    expect((await cosign(a2)).status).toBe(200);
    expect(db.get<{ status: string }>('SELECT status FROM launch_reservations WHERE id = ?', a1.prep.reservationId)!.status).toBe('expired');
    const a3 = await prepAndBuild();
    expect((await cosign(a3)).status).toBe(200);
    const a4 = await prepAndBuild();
    const c4 = await cosign(a4);
    expect(c4.status).toBe(429);
    expect(c4.body.error).toBe('too_many_attempts');
  });

  it('coin descriptions refuse links (phishing in wallet / pump.fun metadata)', async () => {
    for (const d of ['Order online: https://evil-wallet-drainer.example/connect', 'visit evil.xyz', 'evil[.]com', 't.me/scamgroup']) {
      const r = await call<{ error: string }>('POST', '/api/metadata', metaForm({ description: d }));
      expect(r.status, d).toBe(422);
      expect(r.body.error).toBe('moderation');
    }
    expect((await call('POST', '/api/metadata', metaForm({ description: 'Best kebab in Dalston. Est. 1998. Mr. Patel says hi' }))).status).toBe(200);
  });

  it('share pages: a launched place previews its coin with the art`s real size; every page refuses framing', async () => {
    const m = await coinShareMeta(env, `/p/${CAFE}`);
    expect(m?.title).toMatch(/^\$CAFE on AtlasPad/);
    expect(m).toMatchObject({ imageWidth: 512, imageHeight: 512, card: 'summary' });
    expect(m?.image).toMatch(/\/img\/[0-9a-f]{32}\.png$/);
    const none = await coinShareMeta(env, '/p/ChIJnothing000000000001');
    expect(none).toMatchObject({ title: 'This shop has no coin yet. First launch wins. — AtlasPad', imageWidth: 1200, imageHeight: 630, card: 'summary_large_image' });
    for (const path of [`/p/${CAFE}`, `/c/${S.launch!.mint.publicKey.toBase58()}`, '/']) {
      const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env, exec as never);
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
      expect(res.headers.get('content-security-policy'), path).toBe("frame-ancestors 'none'");
    }
  });

  it('Phase-1 routes on a real Worker: no simulated claims; listing lookups behind a durable per-IP cap', async () => {
    for (const p of ['/api/claim/start', '/api/claim/verify']) {
      const res = await worker.fetch(new Request(`${ORIGIN}${p}`, { method: 'POST', body: JSON.stringify({ placeId: CAFE, code: '482913' }), headers: { 'content-type': 'application/json', origin: ORIGIN } }), env, exec as never);
      expect(res.status, p).toBe(404);
    }
    const ip = '198.51.100.99';
    const h = await ipHash(env, ip);
    db.raw.prepare('INSERT INTO rate_counters(key, window_start, count) VALUES (?, ?, 60)').run(`listing:ip:${h}`, Math.floor(clock / 86_400_000) * 86_400_000);
    const res = (await handlePhase2(new Request(`${ORIGIN}/api/claim/phone?placeId=${CAFE}`, { headers: { 'cf-connecting-ip': ip } }), env, exec, deps))!;
    expect(res.status, await res.clone().text()).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe('rate_limited');
    const other = (await handlePhase2(new Request(`${ORIGIN}/api/claim/phone?placeId=${CAFE}`, { headers: { 'cf-connecting-ip': '198.51.100.98' } }), env, exec, deps))!;
    expect(other.status).not.toBe(429); // another IP still gets its lookup
    expect(counter(`listing:ip:${await ipHash(env, '198.51.100.98')}`)).toBe(1);
  });
});
