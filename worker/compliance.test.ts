/**
 * Sanctions at the API (worker/geo.ts, worker/sanctions.ts), devnet build against fake upstreams: the eligibility check
 * and launch prepare refuse a business in a blocked (or, for a launch, unknown) region and prepare refuses a sanctioned
 * launcher; claim call and the website code refuse a blocked business; claim co-sign refuses a sanctioned payout
 * wallet; /api/rpc never relays a sendTransaction that names a sanctioned wallet. Plus the committed OFAC list's shape.
 */
import './test/globals';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { placeAddresses } from './addresses';
import { b58decode, b58encode, isPubkey, toB64 } from './bytes';
import { CONFIG_PDA, PUMP_GLOBAL, PUMP_PROGRAM, SHOP_VAULT_PROGRAM_ID } from './consts';
import type { Deps } from './ctx';
import list from './data/sanctioned-wallets.json';
import type { Env } from './env';
import { hmacHex } from './hmac';
import { STATUS } from './http';
import { handlePhase2 } from './router';
import { __setSanctionedWallets, isSanctionedWallet, sanctionedInTx } from './sanctions';
import { altData, configData, FakeWorld, pumpGlobalData, vaultStateData } from './test/fakeChain';
import { FakeD1 } from './test/fakeD1';
import { NodeBuffer, web3 } from './test/launchFixture';
import { encodeMessage, encodeTransaction } from './txcodec';
import { RPC_WALLET_BLOCKED, type ClaimCallResponse, type LaunchPrepareResponse } from './wire';

const ORIGIN = 'https://cornershop-devnet.tiejiucai.workers.dev';
const world = new FakeWorld();
const db = new FakeD1();
const attestor = web3.Keypair.generate();
const ALT = web3.Keypair.generate().publicKey.toBase58();
const SANCTIONED = web3.Keypair.generate().publicKey.toBase58();
const b64 = (u: Uint8Array) => NodeBuffer.from(u).toString('base64');
const NOW = Date.UTC(2026, 9, 26, 12);

const env: Env = {
  ASSETS: { fetch: async () => new Response('x') } as unknown as Fetcher,
  DB: db.asD1(),
  CLUSTER: 'devnet',
  PUBLIC_ORIGIN: ORIGIN,
  PROGRAM_ID: SHOP_VAULT_PROGRAM_ID,
  ALT_ADDRESS: ALT,
  MAX_DEV_BUY_LAMPORTS: '1000000000',
  FEATURE_WEBSITE_VERIFY: '1',
  GOOGLE_SERVER_KEY: 'google-server-key-test-0003',
  ALCHEMY_API_KEY: 'alchemy-secret-key-test-0003',
  ATTESTOR_SECRET: b64(attestor.secretKey),
  CRANK_SECRET: b64(web3.Keypair.generate().secretKey),
  HMAC_KEY: b64(crypto.getRandomValues(new Uint8Array(32))),
};
const deps: Deps = { fetch: world.fetch, now: () => NOW, sleep: async () => {} };
const pending: Promise<unknown>[] = [];
const exec = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };

let ipN = 0;
async function call<T>(method: string, path: string, body?: unknown, e: Env = env): Promise<{ status: number; body: T }> {
  // a fresh client IP per call keeps the per-IP caps out of the way
  const headers: Record<string, string> = { 'cf-connecting-ip': `198.51.100.${++ipN}` };
  if (method === 'POST') Object.assign(headers, { origin: ORIGIN, 'content-type': 'application/json' });
  const res = (await handlePhase2(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), e, exec, deps))!;
  const text = await res.text();
  await Promise.allSettled(pending.splice(0));
  return { status: res.status, body: JSON.parse(text) as T };
}

const addr = (country: string | null, level1?: string) => [
  ...(level1 ? [{ longText: level1, shortText: level1, types: ['administrative_area_level_1', 'political'] }] : []),
  ...(country ? [{ longText: country, shortText: country, types: ['country', 'political'] }] : []),
];
/** A cafe with a phone and its own website; `address` 'none' = Google gave no addressComponents, unset = London. */
const cafe = (id: string, n: number, address?: unknown[] | 'none') =>
  world.places.set(id, {
    ...(address === undefined ? {} : { addressComponents: address === 'none' ? undefined : address }),
    id,
    businessStatus: 'OPERATIONAL',
    primaryType: 'cafe',
    types: ['cafe'],
    location: { latitude: 50 + n / 100, longitude: 30 },
    internationalPhoneNumber: `+44 20 7946 01${String(n).padStart(2, '0')}`,
    websiteUri: `https://www.cafe${n}.example/`,
  });

const GB = 'ChIJcomplianceGB00001';
const IR = 'ChIJcomplianceIR00001';
const DONETSK = 'ChIJcomplianceUA00014';
const UNKNOWN = 'ChIJcomplianceXX00001';
const meta: Record<string, string> = {};

/** A registered coin for `placeId` (D1 row + on-chain VaultState), so claims can start. */
async function coinFor(placeId: string): Promise<void> {
  const a = await placeAddresses(placeId, SHOP_VAULT_PROGRAM_ID);
  const mint = web3.Keypair.generate().publicKey.toBase58();
  const k = () => web3.Keypair.generate().publicKey.toBase58();
  db.raw
    .prepare(
      `INSERT INTO coins(place_id, place_hash, mint, vault, vault_state, bonding_curve, ticker, name, category, emoji, bg, metadata_id, launcher, created_at, launch_sig, launch_slot, cluster, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'CAFE', 'Cafe', 'cafe', '☕', '#000000', ?, ?, ?, ?, 1, 'devnet', ?)`,
    )
    .run(placeId, a.placeHashHex, mint, a.vault, a.vaultState, k(), meta[placeId] ?? 'm', k(), NOW, b58encode(crypto.getRandomValues(new Uint8Array(64))), NOW);
  world.chain.set(a.vaultState, { lamports: 1n, owner: SHOP_VAULT_PROGRAM_ID, data: vaultStateData({ placeHashHex: a.placeHashHex, mint, launcher: k() }) });
}

beforeAll(async () => {
  const c = world.chain;
  c.set(CONFIG_PDA, { lamports: 1n, owner: SHOP_VAULT_PROGRAM_ID, data: configData({ attestor: attestor.publicKey.toBase58(), guardian: web3.Keypair.generate().publicKey.toBase58(), governance: web3.Keypair.generate().publicKey.toBase58() }) });
  c.set(ALT, { lamports: 1n, owner: 'AddressLookupTab1e1111111111111111111111111', data: altData() });
  c.set(PUMP_GLOBAL, { lamports: 1n, owner: PUMP_PROGRAM, data: pumpGlobalData() });
  cafe(GB, 1); // FakeWorld default: London
  cafe(IR, 2, addr('IR', 'Tehran Province'));
  cafe(DONETSK, 3, addr('UA', 'Donetsk Oblast'));
  cafe(UNKNOWN, 4, 'none');
  db.raw.prepare("INSERT INTO assets(id, content_type, bytes, width, height, created_at) VALUES ('a', 'image/png', x'00', 1, 1, 0)").run();
  [GB, IR, DONETSK, UNKNOWN].forEach((p, i) => {
    meta[p] = `${'0'.repeat(31)}${i + 1}`;
    db.raw.prepare("INSERT INTO metadata(id, json, name, symbol, description, image_id, place_id, created_at) VALUES (?, '{}', 'Cafe', 'CAFE', '', 'a', ?, 0)").run(meta[p], p);
  });
  await coinFor(IR);
  await coinFor(UNKNOWN);
  __setSanctionedWallets([SANCTIONED]);
});

afterEach(() => __setSanctionedWallets([SANCTIONED]));

const prepare = (placeId: string, launcher = web3.Keypair.generate().publicKey.toBase58(), e: Env = env) =>
  call<LaunchPrepareResponse & { error?: string; message?: string }>(
    'POST',
    '/api/launch/prepare',
    { placeId, launcher, mint: web3.Keypair.generate().publicKey.toBase58(), metadataId: meta[placeId], category: 'cafe', emoji: '☕', bg: '#0e7c47', devBuyLamports: '0' },
    e,
  );

const alerts = () => db.raw.prepare("SELECT kind, ref FROM alerts WHERE kind = 'sanctioned_wallet'").all() as { kind: string; ref: string }[];

describe('launch prepare', () => {
  it('the eligibility check (before the art step) already refuses a blocked business', async () => {
    const blocked = await call<{ error: string }>('GET', `/api/place/${DONETSK}/eligibility`);
    expect(blocked.status).toBe(451);
    expect(blocked.body.error).toBe('place_region_blocked');
    expect((await call<{ error: string }>('GET', `/api/place/${UNKNOWN}/eligibility`)).body.error).toBe('place_region_blocked');
    expect((await call<{ launchable: boolean }>('GET', `/api/place/${GB}/eligibility`)).body.launchable).toBe(true);
  });

  it('a business in the UK launches as before', async () => {
    const r = await prepare(GB);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.placeId).toBe(GB);
  });

  it('refuses a sanctioned launcher wallet (451 wallet_blocked) and records an alert', async () => {
    const r = await prepare(GB, SANCTIONED);
    expect(r.status).toBe(451);
    expect(r.body).toEqual({ error: 'wallet_blocked', message: "This wallet can't be used on AtlasPad." });
    expect(alerts()).toContainEqual({ kind: 'sanctioned_wallet', ref: SANCTIONED });
  });

  it('refuses a business in a blocked country or region, and one whose country is unknown', async () => {
    for (const p of [IR, DONETSK, UNKNOWN]) {
      const r = await prepare(p);
      expect(r.status, p).toBe(451);
      expect(r.body.error, p).toBe('place_region_blocked');
    }
    expect((await prepare(UNKNOWN)).body.message).toMatch(/couldn't confirm which country/);
    expect((await prepare(IR)).body.message).toBe("AtlasPad isn't available for businesses in this region.");
  });

  it('the lists are configurable, and GEO_BLOCK=off turns the place rule off', async () => {
    expect((await prepare(DONETSK, undefined, { ...env, BLOCKED_REGIONS: 'UA-43' })).status).toBe(200);
    expect((await prepare(DONETSK, undefined, { ...env, GEO_BLOCK: 'off' })).status).toBe(200);
    expect((await prepare(IR, undefined, { ...env, GEO_BLOCK: 'off' })).body.error).toBe('taken'); // past the region rule
    expect((await prepare(GB, undefined, { ...env, BLOCKED_COUNTRIES: 'GB' })).body.error).toBe('place_region_blocked');
  });
});

describe('claims', () => {
  it('claim call refuses a business in a blocked country; an unknown location may still be claimed', async () => {
    const r = await call<{ error: string }>('POST', '/api/claim/call', { placeId: IR });
    expect(r.status).toBe(451);
    expect(r.body.error).toBe('place_region_blocked');
    const ok = await call<ClaimCallResponse>('POST', '/api/claim/call', { placeId: UNKNOWN });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.channel).toBe('screen');
  });

  it('the website code is refused for a business in a blocked country', async () => {
    const r = await call<{ error: string }>('POST', '/api/claim/website', { placeId: IR });
    expect(r.status).toBe(451);
    expect(r.body.error).toBe('place_region_blocked');
  });

  it('claim co-sign refuses a sanctioned payout wallet', async () => {
    const id = 'complianceclaim000001';
    const token = 'token-compliance-0001';
    db.raw
      .prepare(
        `INSERT INTO claims(id, place_id, mint, method, status, calls, token_hash, token_expires_at, requested_at, expires_at, updated_at)
         VALUES (?, ?, 'M', 'screen', 'verified', 1, ?, ?, ?, ?, ?)`,
      )
      .run(id, GB, await hmacHex(env, 'tok', token), NOW + 600_000, NOW, NOW + 600_000, NOW);
    const r = await call<{ error: string }>('POST', '/api/claim/cosign', { claimId: id, claimToken: token, newOwner: SANCTIONED, messageBase64: 'AA==' });
    expect(r.status).toBe(451);
    expect(r.body.error).toBe('wallet_blocked');
    // a clean wallet passes the screen and reaches the transaction policy
    const clean = await call<{ error: string }>('POST', '/api/claim/cosign', { claimId: id, claimToken: token, newOwner: web3.Keypair.generate().publicKey.toBase58(), messageBase64: 'AA==' });
    expect(clean.body.error).not.toBe('wallet_blocked');
  });
});

/* ------------------------------------------------------------------------------------------------ /api/rpc */

/** A signed-shape transaction: `keys[0]` pays the fee, the rest are named accounts; `data` is the instruction data. */
function txBytes(keys: string[], opts: { version?: 'legacy' | 0; data?: Uint8Array } = {}): Uint8Array {
  const message = encodeMessage({
    version: opts.version ?? 'legacy',
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
    staticAccountKeys: [...keys, '11111111111111111111111111111111'].map((k) => b58decode(k)),
    recentBlockhash: new Uint8Array(32).fill(9),
    instructions: [{ programIdIndex: keys.length, accountKeyIndexes: [0, 1], data: opts.data ?? new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) }],
    addressTableLookups: [],
  });
  return encodeTransaction([new Uint8Array(64).fill(1)], message);
}
const tx = (keys: string[], opts?: Parameters<typeof txBytes>[1]) => toB64(txBytes(keys, opts));
const send = (t: string, id: number) => ({ jsonrpc: '2.0', id, method: 'sendTransaction', params: [t, { encoding: 'base64' }] });

describe('/api/rpc sendTransaction screening', () => {
  const someone = () => web3.Keypair.generate().publicKey.toBase58();

  it('sanctionedInTx finds the fee payer or any other named account; non-base64 is left to the param rules', () => {
    expect(sanctionedInTx(tx([SANCTIONED, someone()]))).toBe(SANCTIONED);
    expect(sanctionedInTx(tx([someone(), SANCTIONED]))).toBe(SANCTIONED);
    expect(sanctionedInTx(tx([SANCTIONED, someone()], { version: 0 }))).toBe(SANCTIONED);
    expect(sanctionedInTx(tx([someone(), someone()]))).toBeNull();
    expect(sanctionedInTx(tx([someone(), someone()], { version: 0 }))).toBeNull();
    expect(sanctionedInTx('not base64!')).toBeNull();
    expect(sanctionedInTx(toB64(new Uint8Array([1, 2, 3])))).toBeNull();
    expect(sanctionedInTx(42)).toBeNull();
  });

  it('a transaction our codec refuses but the node accepts (trailing bytes) is still screened', () => {
    const t = txBytes([SANCTIONED, someone()]);
    const padded = new Uint8Array(t.length + 3);
    padded.set(t);
    expect(sanctionedInTx(toB64(padded))).toBe(SANCTIONED);
    // a listed address in instruction data (e.g. pump's `creator` argument) or as the very last 32 bytes counts too
    expect(sanctionedInTx(tx([someone(), someone()], { data: b58decode(SANCTIONED) }))).toBe(SANCTIONED);
    expect(sanctionedInTx(toB64(Uint8Array.from([...new Uint8Array(7), ...b58decode(SANCTIONED)])))).toBe(SANCTIONED);
    expect(sanctionedInTx(toB64(b58decode(SANCTIONED).slice(0, 31)))).toBeNull();
  });

  it('a send from a sanctioned fee payer is answered with RPC_WALLET_BLOCKED and never relayed', async () => {
    const before = world.chain.sent.length;
    const r = await call<{ id: number; error: { code: number; message: string } }>('POST', '/api/rpc', send(tx([SANCTIONED, someone()]), 7));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ jsonrpc: '2.0', id: 7, error: { code: RPC_WALLET_BLOCKED, message: 'wallet blocked' } });
    expect(world.chain.sent.length).toBe(before);
    const padded = new Uint8Array(txBytes([SANCTIONED, someone()]).length + 1);
    padded.set(txBytes([SANCTIONED, someone()]));
    const r2 = await call<{ error: { code: number } }>('POST', '/api/rpc', send(toB64(padded), 8));
    expect(r2.body.error.code).toBe(RPC_WALLET_BLOCKED);
    expect(world.chain.sent.length).toBe(before);
    // the alert says what happened without claiming the wallet's owner sent it
    const msg = db.raw.prepare("SELECT message FROM alerts WHERE kind = 'sanctioned_wallet' AND ref = ?").get(SANCTIONED) as { message: string };
    expect(msg.message).toMatch(/naming .* nothing was co-signed or relayed.*may not come from that wallet's owner/);
  });

  it('in a batch only the sanctioned send is refused; clean sends and reads go through', async () => {
    const before = world.chain.sent.length;
    const r = await call<{ id: number; result?: unknown; error?: { code: number } }[]>('POST', '/api/rpc', [
      send(tx([someone(), SANCTIONED]), 1),
      send(tx([someone(), someone()]), 2),
      { jsonrpc: '2.0', id: 3, method: 'getSlot' },
    ]);
    expect(r.body[0]!.error?.code).toBe(RPC_WALLET_BLOCKED);
    expect(typeof r.body[1]!.result).toBe('string');
    expect(r.body[2]!.result).toBeDefined();
    expect(world.chain.sent.length).toBe(before + 1);
  });
});

describe('the committed OFAC list (worker/data/sanctioned-wallets.json)', () => {
  it('is a sorted, de-duplicated list of Solana addresses with its source and date', () => {
    __setSanctionedWallets(null);
    expect(list.url).toMatch(/^https:\/\/sanctionslistservice\.ofac\.treas\.gov\//);
    expect(list.listDate === null || /^\d{4}-\d{2}-\d{2}$/.test(list.listDate)).toBe(true);
    expect(list.addresses.every((a) => isPubkey(a))).toBe(true);
    expect([...new Set(list.addresses)].sort()).toEqual(list.addresses);
    for (const a of list.addresses) expect(isSanctionedWallet(a)).toBe(true);
    expect(isSanctionedWallet(SANCTIONED)).toBe(false);
    expect(isSanctionedWallet(null)).toBe(false);
  });

  it('every compliance refusal is HTTP 451', () => {
    expect([STATUS.region_blocked, STATUS.place_region_blocked, STATUS.wallet_blocked]).toEqual([451, 451, 451]);
  });
});
