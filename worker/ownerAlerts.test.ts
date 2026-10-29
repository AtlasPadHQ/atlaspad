/**
 * Owner alerts, hidden-coin claims, business opt-outs and report retention (devnet build, fake upstreams, node:sqlite
 * D1 with the real migrations):
 *  - every claim / report / dispute / opt-out / manual review posts one webhook message (and sends the same text as an
 *    email when ALERT_EMAIL_TO is set) with the facts needed to act, never a phone number, an email, a name or free
 *    text; de-duplicated, rate-limited, and never failing the request;
 *  - a claim nobody confirms is still announced: at its co-sign, by the vault sweep (claim_pending_onchain) and, when
 *    the program monitor falls behind, by monitor_backlog;
 *  - a coin hidden from discovery (moderation or opt-out) is still claimable by its owner, end to end;
 *  - an opted-out place gets no coin, also before one exists (eligibility + launch prepare);
 *  - reporters' and opt-outs' personal data is scrubbed after 180 days by the cron.
 */
import './test/globals';
import { beforeAll, describe, expect, it } from 'vitest';
import { placeAddresses } from './addresses';
import { b58encode, toB64, u64le } from './bytes';
import { CONFIG_PDA, PUMP_GLOBAL, PUMP_PROGRAM, SHOP_VAULT_PROGRAM_ID } from './consts';
import { DAY, HOUR, type Deps } from './ctx';
import type { EmailMessageFactory } from './email';
import type { Env } from './env';
import { CONFIRM_GRACE_MS, monitorLagAlertMs, runIndexer } from './indexer';
import { makeLogger } from './log';
import { alertLane, notifyOwner, notifyOwnerFromChain, OWNER_ALERTS_PER_HOUR, ownerAlertFor, plain, reasonKey, shortWallet, unlockText, type AlertCoin } from './ownerAlerts';
import { buildCtx, handlePhase2 } from './router';
import { placeOptedOut, REPORT_PERSONAL_DATA_DAYS } from './takedown';
import { altData, configData, FakeWorld, pumpGlobalData, vaultStateData } from './test/fakeChain';
import { FakeD1 } from './test/fakeD1';
import { NodeBuffer, sv, web3 } from './test/launchFixture';
import { postWebhook, WEBHOOK_MAX_CHARS, webhookBody } from './webhook';
import type { ClaimCallResponse, ClaimCheckResponse, ClaimConfirmResponse, ClaimCosignResponse, ClaimStatusResponse, CoinsResponse, ConfigResponse, PlaceResponse } from './wire';

const ORIGIN = 'https://cornershop-devnet.tiejiucai.workers.dev';
const HOOK = 'https://discord.com/api/webhooks/1234567890/hook-secret-token-0001';
const PHONE = '+44 20 7946 0555';
/** The alert email's recipient: a placeholder (real addresses never appear in the repository). */
const EMAIL_TO = 'owner@example.com';
/** What the ALERT_EMAIL binding sent (raw MIME), through the fake EmailMessage factory. */
const emails: { from: string; to: string; raw: string }[] = [];
const emailMessage: EmailMessageFactory = (from, to, raw) => ({ from, to, raw });
const mailBinding = { send: async (m: EmailMessage) => void emails.push(m as unknown as (typeof emails)[number]) } as unknown as SendEmail;

const world = new FakeWorld();
const db = new FakeD1();
const attestor = web3.Keypair.generate();
const guardian = web3.Keypair.generate().publicKey.toBase58();
const governance = web3.Keypair.generate().publicKey.toBase58();
const ALT = web3.Keypair.generate().publicKey.toBase58();
const b64 = (u: Uint8Array) => NodeBuffer.from(u).toString('base64');
const newKey = () => web3.Keypair.generate().publicKey.toBase58() as string;

const env: Env = {
  ASSETS: { fetch: async () => new Response('x') } as unknown as Fetcher,
  DB: db.asD1(),
  CLUSTER: 'devnet',
  PUBLIC_ORIGIN: ORIGIN,
  PROGRAM_ID: SHOP_VAULT_PROGRAM_ID,
  ALT_ADDRESS: ALT,
  MAX_DEV_BUY_LAMPORTS: '1000000000',
  PRIORITY_FEE_DEFAULT: '10000',
  FEATURE_WEBSITE_VERIFY: '1',
  BUILD_ID: 'test',
  GOOGLE_SERVER_KEY: 'google-server-key-test-0003',
  ALCHEMY_API_KEY: 'alchemy-secret-key-alerts-0003',
  ATTESTOR_SECRET: b64(attestor.secretKey),
  CRANK_SECRET: b64(web3.Keypair.generate().secretKey),
  HMAC_KEY: b64(crypto.getRandomValues(new Uint8Array(32))),
  ALERT_WEBHOOK_URL: HOOK,
  ALERT_EMAIL: mailBinding,
  ALERT_EMAIL_TO: EMAIL_TO,
};

let clock = Date.UTC(2026, 9, 20, 9, 0, 0);
/** What reached the webhook (parsed JSON bodies), and how the webhook behaves. */
const posts: { url: string; body: { content?: string; text?: string; allowed_mentions?: unknown } }[] = [];
let hook: 'ok' | 'throw' | '500' = 'ok';
const deps: Deps = {
  fetch: async (input, init) => {
    if (input.startsWith('https://discord.com/') || input.startsWith('https://hooks.slack.com/')) {
      if (hook === 'throw') throw new Error('webhook unreachable');
      posts.push({ url: input, body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: hook === '500' ? 500 : 204 });
    }
    return world.fetch(input, init);
  },
  now: () => clock,
  sleep: async () => {},
  emailMessage,
};
const pending: Promise<unknown>[] = [];
const exec = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
async function flush() {
  while (pending.length) await Promise.allSettled(pending.splice(0));
}

let ipN = 0;
async function call<T = unknown>(method: string, path: string, body?: unknown, ip = '203.0.113.20'): Promise<{ status: number; body: T; text: string }> {
  const init: RequestInit = { method, headers: { 'cf-connecting-ip': ip, ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}) } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = (await handlePhase2(new Request(`${ORIGIN}${path}`, init), env, exec, deps)) ?? new Response('{"error":"fallthrough"}', { status: 599 });
  const text = await res.text();
  await flush();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, text };
}
const freshIp = () => `198.51.100.${++ipN}`;
const lastPost = () => posts.at(-1)?.body.content ?? '';

interface TestCoin {
  placeId: string;
  mint: string;
  launcher: string;
  vault: string;
  vaultState: string;
  placeHashHex: string;
}

/** A registered coin (D1 row + VaultState on the fake chain), without going through a launch. */
async function addCoin(
  placeId: string,
  o: { ticker?: string; name?: string; status?: 'live' | 'hidden'; owner?: string | null; pending?: { owner: string; unlockTs: number } | null; nonce?: bigint } = {},
): Promise<TestCoin> {
  const a = await placeAddresses(placeId, SHOP_VAULT_PROGRAM_ID);
  const mint = newKey();
  const launcher = newKey();
  db.raw
    .prepare(
      `INSERT INTO coins(place_id, place_hash, mint, vault, vault_state, bonding_curve, ticker, name, category, emoji, bg, metadata_id, launcher,
         created_at, launch_sig, launch_slot, cluster, status, owner, pending_owner, unlock_ts, claim_nonce, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cafe', '☕', '#000000', 'm', ?, ?, ?, 1, 'devnet', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      placeId,
      a.placeHashHex,
      mint,
      a.vault,
      a.vaultState,
      newKey(),
      o.ticker ?? 'CAFE',
      o.name ?? 'Corner Cafe',
      launcher,
      clock,
      b58encode(crypto.getRandomValues(new Uint8Array(64))),
      o.status ?? 'live',
      o.owner ?? null,
      o.pending?.owner ?? null,
      o.pending?.unlockTs ?? null,
      Number(o.nonce ?? 0n),
      clock,
    );
  world.chain.set(a.vaultState, {
    lamports: 2_338_000n,
    owner: SHOP_VAULT_PROGRAM_ID,
    data: vaultStateData({ placeHashHex: a.placeHashHex, mint, launcher, owner: o.owner ?? null, pending: o.pending ?? null, nonce: o.nonce ?? 0n }),
  });
  world.chain.set(a.vault, { lamports: 890_880n, owner: '11111111111111111111111111111111', data: new Uint8Array(0) });
  return { placeId, mint, launcher, vault: a.vault, vaultState: a.vaultState, placeHashHex: a.placeHashHex };
}

function googlePlace(id: string, over: Record<string, unknown> = {}): void {
  world.places.set(id, {
    id,
    businessStatus: 'OPERATIONAL',
    primaryType: 'coffee_shop',
    types: ['coffee_shop', 'cafe', 'food', 'establishment'],
    location: { latitude: 51.5469, longitude: -0.0712 },
    internationalPhoneNumber: PHONE,
    ...over,
  });
}

/** A `Program data:` ClaimRequested event (SPEC §7) in a landed shop-vault transaction. */
function landClaimRequested(c: TestCoin, newOwner: string, nonce: bigint, unlockTs: number): string {
  const sig = b58encode(crypto.getRandomValues(new Uint8Array(64)));
  const enc = (s: string) => toB64(new TextEncoder().encode(s));
  const key = (k: string) => toB64(new web3.PublicKey(k).toBytes());
  world.chain.land(sig, {
    accountKeys: [newOwner, attestor.publicKey.toBase58(), c.vaultState, SHOP_VAULT_PROGRAM_ID],
    numRequiredSignatures: 2,
    inner: [],
    logs: [
      `Program ${SHOP_VAULT_PROGRAM_ID} invoke [1]`,
      `Program data: ${enc('ClaimRequested')} ${toB64(NodeBuffer.from(c.placeHashHex, 'hex'))} ${key(newOwner)} ${toB64(u64le(nonce))} ${toB64(u64le(BigInt(unlockTs)))}`,
      `Program ${SHOP_VAULT_PROGRAM_ID} success`,
    ],
    blockTime: Math.floor(clock / 1000),
  });
  return sig;
}

async function cron() {
  db.raw.prepare("DELETE FROM kv_meta WHERE key = 'indexer_lock'").run();
  const r = await runIndexer((await buildCtx(env, exec, deps, 'cron'))!);
  await flush();
  return r;
}

beforeAll(async () => {
  const c = world.chain;
  c.set(CONFIG_PDA, { lamports: 2_000_000n, owner: SHOP_VAULT_PROGRAM_ID, data: configData({ attestor: attestor.publicKey.toBase58(), guardian, governance, window: 60 }) });
  c.set(SHOP_VAULT_PROGRAM_ID, { lamports: 1n, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', data: new Uint8Array(36), executable: true });
  c.set(ALT, { lamports: 3_000_000n, owner: 'AddressLookupTab1e1111111111111111111111111', data: altData() });
  c.set(PUMP_GLOBAL, { lamports: 1n, owner: PUMP_PROGRAM, data: pumpGlobalData() });
  // recent rows: the cron's retention job removes unused uploads older than 6 hours (UPLOAD_KEEP_MS)
  db.raw.prepare("INSERT INTO assets(id, content_type, bytes, width, height, created_at) VALUES ('a', 'image/png', x'00', 1, 1, ?)").run(clock);
  db.raw.prepare("INSERT INTO metadata(id, json, name, symbol, description, image_id, place_id, created_at) VALUES ('m', '{}', 'Corner Cafe', 'CAFE', '', 'a', 'x', ?)").run(clock);
  // the first cron run puts the program monitor's cursor at the chain head (later events are new)
  await cron();
});

/* ======================================================================================== the messages */

describe('owner alert messages', () => {
  const at = { cluster: 'devnet' as const, origin: ORIGIN, now: Date.UTC(2026, 9, 20, 9, 0, 0) };
  const coin: AlertCoin = { place_id: 'ChIJmsgcafe000000001', mint: newKey(), ticker: 'CAFE', name: 'Corner Cafe', status: 'live', owner: null, pending_owner: null, unlock_ts: null };
  const claimant = newKey();
  const unlockTs = Math.floor(at.now / 1000) + 72 * 3600;

  it('a website-code claim asks for a human check, with everything needed to act', () => {
    const a = ownerAlertFor(
      { kind: 'claim', placeId: coin.place_id, method: 'website', newOwner: claimant, previousOwner: null, nonce: 1, unlockTs, sig: 'SiG1', websiteHost: 'www.mycafe.co.uk' },
      coin,
      at,
    );
    expect(a).toMatchObject({ kind: 'owner_claim', severity: 'warn', ref: `claim:${coin.place_id}:1` });
    expect(a.text.split('\n')).toEqual([
      '[AtlasPad devnet] Website-code claim requested: needs a human check before unlock',
      'Shop: Corner Cafe ($CAFE)',
      `Place: ${coin.place_id}`,
      `Claimant: ${shortWallet(claimant)}`,
      'Website: www.mycafe.co.uk',
      'Unlocks: 2026-10-23 09:00 UTC (in 72 h)',
      `Coin: <${ORIGIN}/c/${coin.mint}>`,
      `Explorer: <https://solscan.io/token/${coin.mint}?cluster=devnet>`,
      'Claim tx: <https://solscan.io/tx/SiG1?cluster=devnet>',
      `If it is wrong, the guardian cancels it before it unlocks: node scripts/claims-admin.mjs --env devnet cancel ${coin.place_id}`,
    ]);
    expect(shortWallet(claimant)).toMatch(/^.{4}….{4}$/);
  });

  it('a phone claim is informational; a re-claim of an owned shop is flagged with the current owner', () => {
    const phone = ownerAlertFor({ kind: 'claim', placeId: coin.place_id, method: 'call', newOwner: claimant, previousOwner: null, nonce: 2, unlockTs }, coin, at);
    expect(phone.severity).toBe('info');
    expect(phone.text).toMatch(/^\[AtlasPad devnet\] Phone claim requested \(phone call\)\n/);
    expect(phone.text).not.toMatch(/guardian cancels/);
    const owner = newKey();
    const re = ownerAlertFor({ kind: 'claim', placeId: coin.place_id, method: 'call', newOwner: claimant, previousOwner: owner, nonce: 3, unlockTs, inProbation: true }, { ...coin, owner }, at);
    expect(re.severity).toBe('warn');
    expect(re.text).toContain('Re-claim of an owned shop (phone call): needs a human check before unlock');
    expect(re.text).toContain(`Current owner: ${shortWallet(owner)}`);
    expect(re.text).toContain('· probation (longer window)');
    expect(re.text).toContain('claims-admin.mjs --env devnet cancel');
  });

  it('a co-signed claim is a warning on the claims lane, once per place, nonce and wallet, before anything is on chain', () => {
    const owner = newKey();
    const a = ownerAlertFor(
      { kind: 'claim_cosigned', placeId: coin.place_id, method: 'website', newOwner: claimant, previousOwner: owner, nonce: 4, websiteHost: 'www.mycafe.co.uk' },
      { ...coin, owner },
      at,
    );
    expect(a).toMatchObject({ kind: 'owner_cosign', severity: 'warn', ref: `cosign:${coin.place_id}:4:${claimant}`, dedupeMs: DAY });
    expect(alertLane(a.kind)).toBe('claims');
    expect(a.text.split('\n')).toEqual([
      '[AtlasPad devnet] Re-claim of an owned shop co-signed (website code)',
      'Shop: Corner Cafe ($CAFE)',
      `Place: ${coin.place_id}`,
      `Claimant: ${shortWallet(claimant)}`,
      `Current owner: ${shortWallet(owner)}`,
      'Website: www.mycafe.co.uk',
      'Not on-chain yet. If no claim alert follows, check: node scripts/claims-admin.mjs --env devnet list',
      `Coin: <${ORIGIN}/c/${coin.mint}>`,
      `Explorer: <https://solscan.io/token/${coin.mint}?cluster=devnet>`,
      `If it is wrong, the guardian cancels it before it unlocks: node scripts/claims-admin.mjs --env devnet cancel ${coin.place_id}`,
    ]);
    // a phone claim's co-sign is a warning too (the claimant may never confirm it)
    const phone = ownerAlertFor({ kind: 'claim_cosigned', placeId: coin.place_id, method: 'call', newOwner: claimant, previousOwner: null, nonce: 1 }, coin, at);
    expect(phone).toMatchObject({ severity: 'warn', subject: '[AtlasPad devnet] WARN owner_cosign: Claim co-signed (phone call)' });
    // another wallet at the same nonce (an earlier co-sign that never landed) is another message
    const other = newKey();
    expect(ownerAlertFor({ kind: 'claim_cosigned', placeId: coin.place_id, method: 'call', newOwner: other, previousOwner: null, nonce: 1 }, coin, at).ref).toBe(`cosign:${coin.place_id}:1:${other}`);
  });

  it('a website on a hosting platform anyone can sign up to is flagged for the human check', () => {
    const ev = { placeId: coin.place_id, method: 'website' as const, newOwner: claimant, previousOwner: null, nonce: 2, websiteHost: 'www.rosies.netlify.app' };
    const flag = "Multi-tenant host (netlify.app): check the subdomain is the business's own";
    expect(ownerAlertFor({ kind: 'claim_cosigned', ...ev }, coin, at).text).toContain(`\nWebsite: www.rosies.netlify.app\n${flag}\n`);
    expect(ownerAlertFor({ kind: 'claim', ...ev, unlockTs: null }, coin, at).text).toContain(`\nWebsite: www.rosies.netlify.app\n${flag}\n`);
    // a business's own domain is not flagged
    expect(ownerAlertFor({ kind: 'claim_cosigned', ...ev, websiteHost: 'www.rosies.co.uk' }, coin, at).text).not.toContain('Multi-tenant');
  });

  it('reports, disputes, opt-outs and manual reviews', () => {
    const report = ownerAlertFor({ kind: 'report', placeId: coin.place_id, mint: coin.mint, reason: 'scam' }, coin, at);
    expect(report).toMatchObject({ kind: 'owner_report', severity: 'info', ref: `report:${coin.place_id}:scam` });
    expect(report.text).toContain('Report filed (reason: scam)');
    expect(report.text).toContain('moderate.mjs --env devnet --reports');
    // a report while a claim is in its public window is a dispute: the guardian has until the unlock
    const disputed = { ...coin, pending_owner: claimant, unlock_ts: unlockTs };
    const dispute = ownerAlertFor({ kind: 'report', placeId: coin.place_id, mint: null, reason: 'impersonation' }, disputed, at);
    expect(dispute).toMatchObject({ kind: 'owner_dispute', severity: 'warn' });
    expect(dispute.text).toContain('Dispute filed against a pending claim (reason: impersonation)');
    expect(dispute.text).toContain(`Claimant: ${shortWallet(claimant)}`);
    expect(dispute.text).toContain('Unlocks: 2026-10-23 09:00 UTC');
    // the window is over: an ordinary report again
    expect(ownerAlertFor({ kind: 'report', placeId: coin.place_id, mint: null, reason: 'other' }, { ...disputed, unlock_ts: Math.floor(at.now / 1000) - 1 }, at).kind).toBe('owner_report');
    // an opt-out before any coin exists: the place page, and the command that blocks launches
    const opt = ownerAlertFor({ kind: 'optout', placeId: 'ChIJnocoin0000000001', mint: null, reason: 'optout' }, null, at);
    expect(opt.text).toContain('Opt-out requested');
    expect(opt.text).toContain('Shop: no coin yet');
    expect(opt.text).toContain(`Place page: <${ORIGIN}/p/ChIJnocoin0000000001>`);
    expect(opt.text).toContain('moderate.mjs --env devnet --optout ChIJnocoin0000000001 --execute');
    const manual = ownerAlertFor({ kind: 'manual_claim', placeId: coin.place_id, mint: coin.mint, reason: 'manual_claim', wallet: claimant }, coin, at);
    expect(manual).toMatchObject({ kind: 'owner_manual', ref: `manual:${coin.place_id}` });
    expect(manual.text).toContain(`Claimant: ${shortWallet(claimant)}`);
    // a hidden coin says so
    expect(ownerAlertFor({ kind: 'report', placeId: coin.place_id, mint: null, reason: 'other' }, { ...coin, status: 'hidden' }, at).text).toContain('Shop: Corner Cafe ($CAFE) · hidden from the map');
  });

  it('user-chosen text cannot ping, link or break lines; mainnet links have no cluster parameter', () => {
    expect(plain('@everyone [free] <@&123>\nline2‮`x`')).toBe('everyone free &123 line2 x');
    expect(plain('')).toBe('—');
    expect(plain('a'.repeat(100))).toHaveLength(60);
    const main = ownerAlertFor({ kind: 'report', placeId: coin.place_id, mint: null, reason: 'scam' }, coin, { ...at, cluster: 'mainnet', origin: 'https://atlaspad.online' });
    expect(main.text).toContain(`Coin: <https://atlaspad.online/c/${coin.mint}>`);
    expect(main.text).toContain(`Explorer: <https://solscan.io/token/${coin.mint}>`);
    expect(main.text.startsWith('[AtlasPad mainnet]')).toBe(true);
    expect(unlockText(Math.floor(at.now / 1000) + 600, at.now)).toBe('2026-10-20 09:10 UTC (in 10 min)');
    expect(unlockText(null, at.now)).toBe('—');
  });

  it('webhook bodies: Discord without mentions, Slack as text; nothing posted without a URL', async () => {
    expect(JSON.parse(webhookBody(HOOK, 'hi'))).toEqual({ content: 'hi', allowed_mentions: { parse: [] } });
    expect(JSON.parse(webhookBody('https://hooks.slack.com/services/T/B/x', 'hi'))).toEqual({ text: 'hi' });
    expect(JSON.parse(webhookBody(HOOK, 'x'.repeat(5000))).content).toHaveLength(1900);
    let fetched = 0;
    const f = async () => (fetched++, new Response(null, { status: 204 }));
    expect(await postWebhook({}, f, 'x')).toBe(false);
    expect(await postWebhook({ ALERT_WEBHOOK_URL: 'http://insecure.example/hook' }, f, 'x')).toBe(false);
    expect(fetched).toBe(0);
    expect(await postWebhook({ ALERT_WEBHOOK_URL: HOOK }, async () => Promise.reject(new Error('down')), 'x')).toBe(false);
  });
});

/* ======================================================================================== from the API */

describe('owner alerts from the API', () => {
  let C: TestCoin;
  beforeAll(async () => {
    googlePlace('ChIJalertcafe0000001');
    C = await addCoin('ChIJalertcafe0000001', { ticker: 'ALRT', name: 'Alert Cafe' });
  });

  it('a report posts one alert (no free text); the same report within the hour is not posted again', async () => {
    const before = posts.length;
    const r = await call('POST', '/api/report', { kind: 'report', placeId: C.placeId, reason: 'scam', details: 'The owner Jane Doe told me 07700 900123' });
    expect(r.status).toBe(204);
    expect(posts.length).toBe(before + 1);
    expect(posts.at(-1)!.url).toBe(HOOK);
    expect(posts.at(-1)!.body.allowed_mentions).toEqual({ parse: [] });
    const text = lastPost();
    expect(text).toContain('Report filed (reason: scam)');
    expect(text).toContain('Shop: Alert Cafe ($ALRT)');
    expect(text).toContain(`Place: ${C.placeId}`);
    expect(text).toContain(`Coin: <${ORIGIN}/c/${C.mint}>`);
    expect(text).not.toMatch(/Jane|07700/);
    expect(await call('POST', '/api/report', { kind: 'report', placeId: C.placeId, reason: 'scam' }, freshIp())).toMatchObject({ status: 204 });
    expect(posts.length).toBe(before + 1);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'owner_report'")!.n).toBe(1);
    // the API takes any short word key as the reason: only the site's own keys reach the alert, never crafted text
    const mint = newKey();
    expect((await call('POST', '/api/report', { kind: 'report', mint, reason: 'Jane Doe call 07700 900123' }, freshIp())).status).toBe(204);
    expect(lastPost()).toContain('Report filed (reason: other)');
    expect(lastPost()).not.toMatch(/Jane|07700/);
    expect(db.get<{ message: string }>('SELECT message FROM alerts WHERE ref = ?', `report:${mint}:other`)!.message).not.toMatch(/Jane|07700/);
    expect(reasonKey('scam')).toBe('scam');
    expect(reasonKey('manual_claim')).toBe('manual_claim');
    expect(reasonKey('Scam')).toBe('other');
  });

  it('an opt-out request alerts without the requester name or email (they stay in reports for ops)', async () => {
    const r = await call('POST', '/api/report', {
      kind: 'optout',
      placeId: C.placeId,
      mint: C.mint,
      reason: 'optout',
      details: 'Name: Jane Doe\nPlease take it down',
      contact: 'jane@alertcafe.co.uk',
    });
    expect(r.status).toBe(204);
    const text = lastPost();
    expect(text).toContain('Opt-out requested');
    expect(text).toContain(`--optout ${C.placeId} --execute`);
    expect(text).not.toMatch(/Jane|jane@|alertcafe\.co\.uk|take it down/);
    const stored = db.get<{ message: string }>("SELECT message FROM alerts WHERE kind = 'owner_optout'")!;
    expect(stored.message).not.toMatch(/Jane|jane@/);
    expect(db.get<{ contact: string }>("SELECT contact FROM reports WHERE kind = 'optout'")!.contact).toBe('jane@alertcafe.co.uk');
  });

  it('a report against a coin whose claim is in its public window is a dispute', async () => {
    const claimant = newKey();
    const D = await addCoin('ChIJdisputecafe00001', { ticker: 'DSPT', name: 'Dispute Cafe', pending: { owner: claimant, unlockTs: Math.floor(clock / 1000) + 3600 }, nonce: 1n });
    expect((await call('POST', '/api/report', { kind: 'report', placeId: D.placeId, reason: 'impersonation' }, freshIp())).status).toBe(204);
    const text = lastPost();
    expect(text).toMatch(/^\[AtlasPad devnet\] Dispute filed against a pending claim \(reason: impersonation\)/);
    expect(text).toContain(`Claimant: ${shortWallet(claimant)}`);
    expect(text).toContain('(in 60 min)');
    expect(db.get<{ severity: string }>("SELECT severity FROM alerts WHERE kind = 'owner_dispute'")!.severity).toBe('warn');
  });

  it('a webhook that is down or failing never fails the request; the alert is still stored', async () => {
    for (const mode of ['throw', '500'] as const) {
      hook = mode;
      const mint = newKey();
      const r = await call('POST', '/api/report', { kind: 'report', mint, reason: 'offensive' }, freshIp());
      expect(r.status, mode).toBe(204);
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM alerts WHERE ref = ?', `report:${mint}:offensive`)!.n, mode).toBe(1);
    }
    hook = 'ok';
  });

  it('manual review (on by default on devnet): the alert shows the claimant wallet; a bad wallet is refused', async () => {
    const wallet = newKey();
    const r = await call('POST', '/api/claim/manual', { placeId: C.placeId, mint: C.mint, reason: 'manual_claim', details: 'Code CS-ABCD posted at https://instagram.com/p/x', wallet }, freshIp());
    expect(r.status).toBe(204);
    expect(lastPost()).toContain('Manual-review claim requested');
    expect(lastPost()).toContain(`Claimant: ${shortWallet(wallet)}`);
    expect(lastPost()).not.toContain('instagram');
    const bad = await call<{ error: string }>('POST', '/api/claim/manual', { placeId: C.placeId, reason: 'manual_claim', wallet: 'not-a-wallet' }, freshIp());
    expect(bad.status).toBe(400);
    const cfg = await call<ConfigResponse>('GET', '/api/config');
    expect(cfg.body.features.manualReview).toBe(true);
  });

  it(`at most ${OWNER_ALERTS_PER_HOUR} alerts an hour reach the webhook; the next one says the rest are held back`, async () => {
    clock = Math.floor(clock / HOUR) * HOUR + HOUR + 60_000; // a fresh hourly window
    const before = posts.length;
    let ip = freshIp();
    for (let i = 0; i < OWNER_ALERTS_PER_HOUR + 5; i++) {
      if (i % 10 === 0) ip = freshIp();
      expect((await call('POST', '/api/report', { kind: 'report', mint: newKey(), reason: 'scam' }, ip)).status).toBe(204);
    }
    expect(posts.length - before).toBe(OWNER_ALERTS_PER_HOUR + 1);
    expect(lastPost()).toBe(`[AtlasPad devnet] More than ${OWNER_ALERTS_PER_HOUR} report alerts this hour: the rest are held back. List them: node scripts/watchdog.mjs --cluster devnet`);
    // every one of them is in D1 for the watchdog
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'owner_report' AND created_at >= ?", clock - 60_000)!.n).toBe(OWNER_ALERTS_PER_HOUR + 5);

    // a report flood (anyone can file them) never holds back a claim that needs a human check before it unlocks
    expect(alertLane('owner_report')).toBe('reports');
    expect(alertLane('owner_optout')).toBe('reports');
    expect(alertLane('owner_manual')).toBe('reports');
    expect(alertLane('owner_dispute')).toBe('claims');
    const ctx = (await buildCtx(env, exec, deps, 'cron'))!;
    const claimant = newKey();
    await notifyOwner(ctx, { kind: 'claim', placeId: C.placeId, method: 'website', newOwner: claimant, previousOwner: null, nonce: 7, unlockTs: Math.floor(clock / 1000) + 259_200, websiteHost: 'www.alertcafe.co.uk' });
    expect(posts.length - before).toBe(OWNER_ALERTS_PER_HOUR + 2);
    expect(lastPost()).toMatch(/^\[AtlasPad devnet\] Website-code claim requested: needs a human check before unlock\n/);
    expect(lastPost()).toContain(`Claimant: ${shortWallet(claimant)}`);
    clock += HOUR;
  });

  it('a full claims lane still sends each place one claim or co-sign message an hour', async () => {
    clock = Math.floor(clock / HOUR) * HOUR + HOUR + 60_000; // a fresh hourly window
    db.raw
      .prepare('INSERT INTO rate_counters(key, window_start, count) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET window_start = ?2, count = ?3')
      .run('owner_alerts:claims:devnet', Math.floor(clock / HOUR) * HOUR, OWNER_ALERTS_PER_HOUR);
    const A = await addCoin('ChIJfulllanecafe00001', { ticker: 'LANA', name: 'Lane A Cafe' });
    const B = await addCoin('ChIJfulllanecafe00002', { ticker: 'LANB', name: 'Lane B Cafe' });
    const unlockTs = Math.floor(clock / 1000) + 259_200;
    const D = await addCoin('ChIJfulllanecafe00003', { ticker: 'LAND', name: 'Lane D Cafe', pending: { owner: newKey(), unlockTs }, nonce: 1n });
    const ctx = (await buildCtx(env, exec, deps, 'cron'))!;
    const before = posts.length;
    // A's co-sign: the first over the cap, sent as itself
    await notifyOwner(ctx, { kind: 'claim_cosigned', placeId: A.placeId, method: 'call', newOwner: newKey(), previousOwner: null, nonce: 1 });
    expect(posts.length - before).toBe(1);
    expect(lastPost()).toMatch(/^\[AtlasPad devnet\] Claim co-signed \(phone call\)\nShop: Lane A Cafe/);
    // A's second message this hour is over the cap: the "held back" notice goes out instead
    await notifyOwner(ctx, { kind: 'claim', placeId: A.placeId, method: 'call', newOwner: newKey(), previousOwner: null, nonce: 1, unlockTs });
    expect(posts.length - before).toBe(2);
    expect(lastPost()).toBe(`[AtlasPad devnet] More than ${OWNER_ALERTS_PER_HOUR} claim alerts this hour: the rest are held back. List them: node scripts/watchdog.mjs --cluster devnet`);
    // B's first claim message still goes out; its second, and a dispute, are held back silently
    await notifyOwner(ctx, { kind: 'claim', placeId: B.placeId, method: 'website', newOwner: newKey(), previousOwner: null, nonce: 1, unlockTs, websiteHost: 'www.laneb.co.uk' });
    expect(posts.length - before).toBe(3);
    expect(lastPost()).toMatch(/^\[AtlasPad devnet\] Website-code claim requested: needs a human check before unlock\nShop: Lane B Cafe/);
    await notifyOwner(ctx, { kind: 'claim_cosigned', placeId: B.placeId, method: 'website', newOwner: newKey(), previousOwner: null, nonce: 2, websiteHost: 'www.laneb.co.uk' });
    await notifyOwner(ctx, { kind: 'report', placeId: D.placeId, mint: D.mint, reason: 'scam' });
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'owner_dispute' AND ref = ?", `dispute:${D.placeId}`)!.n).toBe(1);
    expect(posts.length - before).toBe(3);
    // all of them are in D1 for the watchdog
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE kind IN ('owner_claim','owner_cosign') AND message LIKE '%Lane _ Cafe%'")!.n).toBe(4);
    clock += HOUR;
  });

  it(`past a full claims lane, at most ${OWNER_ALERTS_PER_HOUR} places an hour still get their first message through`, async () => {
    clock = Math.floor(clock / HOUR) * HOUR + HOUR + 60_000; // a fresh hourly window
    const full = db.raw.prepare('INSERT INTO rate_counters(key, window_start, count) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET window_start = ?2, count = ?3');
    full.run('owner_alerts:claims:devnet', Math.floor(clock / HOUR) * HOUR, OWNER_ALERTS_PER_HOUR);
    full.run('owner_alerts:claims_overflow:devnet', Math.floor(clock / HOUR) * HOUR, OWNER_ALERTS_PER_HOUR);
    const E = await addCoin('ChIJoverflowcafe00001', { ticker: 'OVFE', name: 'Overflow E Cafe' });
    const F = await addCoin('ChIJoverflowcafe00002', { ticker: 'OVFF', name: 'Overflow F Cafe' });
    const ctx = (await buildCtx(env, exec, deps, 'cron'))!;
    const before = posts.length;
    // E's first co-sign: the bypass is used up this hour, so only the "held back" notice goes out
    await notifyOwner(ctx, { kind: 'claim_cosigned', placeId: E.placeId, method: 'call', newOwner: newKey(), previousOwner: null, nonce: 1 });
    expect(posts.length - before).toBe(1);
    expect(lastPost()).toBe(`[AtlasPad devnet] More than ${OWNER_ALERTS_PER_HOUR} claim alerts this hour: the rest are held back. List them: node scripts/watchdog.mjs --cluster devnet`);
    // F's first co-sign is held back silently, and both are in D1 for the watchdog
    await notifyOwner(ctx, { kind: 'claim_cosigned', placeId: F.placeId, method: 'call', newOwner: newKey(), previousOwner: null, nonce: 1 });
    expect(posts.length - before).toBe(1);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'owner_cosign' AND message LIKE '%Overflow _ Cafe%'")!.n).toBe(2);
    clock += HOUR;
  });
});

/* ======================================================================================== hidden coins */

describe('a hidden or opted-out coin stays claimable by its owner', () => {
  let H: TestCoin;
  const newOwner = web3.Keypair.generate();
  let claimId = '';

  beforeAll(async () => {
    googlePlace('ChIJhiddencafe000001', { websiteUri: 'https://www.hiddencafe.co.uk/' });
    H = await addCoin('ChIJhiddencafe000001', { ticker: 'HIDE', name: 'Hidden Cafe', status: 'hidden' });
  });

  it('hidden from discovery: no place coin, not in lists, no detail page', async () => {
    const place = await call<PlaceResponse>('GET', `/api/place/${H.placeId}`);
    expect(place.body).toMatchObject({ coin: null, hidden: true });
    expect(place.body.optedOut).toBeUndefined();
    expect((await call<CoinsResponse>('GET', `/api/coins?mints=${H.mint}`)).body.coins).toEqual([]);
    expect((await call('GET', `/api/coins/${H.mint}`)).status).toBe(404);
  });

  it('but the claim status returns it to its owner, and a phone claim goes all the way on-chain', async () => {
    const st = await call<ClaimStatusResponse>('GET', `/api/claim/status?placeId=${H.placeId}`);
    expect(st.status).toBe(200);
    expect(st.body.coin).toEqual({ placeId: H.placeId, mint: H.mint, ticker: 'HIDE', name: 'Hidden Cafe', hidden: true });
    expect(st.body.owner.status).toBe('unclaimed');

    const started = await call<ClaimCallResponse>('POST', '/api/claim/call', { placeId: H.placeId });
    expect(started.status).toBe(200);
    expect(started.body.channel).toBe('screen');
    const ok = await call<ClaimCheckResponse>('POST', '/api/claim/check', { claimId: started.body.claimId, code: started.body.devCode });
    expect(ok.body.approved).toBe(true);
    if (!ok.body.approved) return;
    const s = await sv();
    const msg = new Uint8Array(
      new web3.TransactionMessage({
        payerKey: newOwner.publicKey,
        recentBlockhash: world.chain.blockhash,
        instructions: [
          web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }),
          web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
          s.requestClaim({ attestor: attestor.publicKey, newOwner: newOwner.publicKey, placeHash: s.placeHash(H.placeId), nonce: 1n }),
        ],
      })
        .compileToV0Message([])
        .serialize(),
    );
    const postsBeforeCosign = posts.length;
    const emailsBeforeCosign = emails.length;
    const claimToken = ok.body.claimToken;
    const cosign = () => call<ClaimCosignResponse>('POST', '/api/claim/cosign', { claimId: started.body.claimId, claimToken, newOwner: newOwner.publicKey.toBase58(), messageBase64: toB64(msg) });
    const cos = await cosign();
    expect(cos.status).toBe(200);
    // the co-sign itself is announced (the claimant could send it through any RPC and never confirm), by email too
    expect(posts.length).toBe(postsBeforeCosign + 1);
    expect(lastPost()).toMatch(/^\[AtlasPad devnet\] Claim co-signed \(devnet on-screen code\)\n/);
    expect(lastPost()).toContain('Shop: Hidden Cafe ($HIDE) · hidden from the map');
    expect(lastPost()).toContain(`Claimant: ${shortWallet(newOwner.publicKey.toBase58())}`);
    expect(emails.length).toBe(emailsBeforeCosign + 1);
    expect(emails.at(-1)!.raw).toContain('\r\nSubject: [AtlasPad devnet] WARN owner_cosign: Claim co-signed (devnet on-screen code)\r\n');
    // a retried co-sign of the same claim (same place, nonce and wallet) is not announced again
    expect((await cosign()).status).toBe(200);
    expect(posts.length).toBe(postsBeforeCosign + 1);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'owner_cosign' AND ref = ?", `cosign:${H.placeId}:1:${newOwner.publicKey.toBase58()}`)!.n).toBe(1);
    // another wallet co-signed at the same nonce within the day (this one may be the claim that lands) is announced
    const other = newKey();
    await notifyOwner((await buildCtx(env, exec, deps, 'cron'))!, { kind: 'claim_cosigned', placeId: H.placeId, method: 'call', newOwner: other, previousOwner: null, nonce: 1 });
    expect(posts.length).toBe(postsBeforeCosign + 2);
    expect(lastPost()).toContain(`Claimant: ${shortWallet(other)}`);

    const before = posts.length;
    const emailsBefore = emails.length;
    const unlockTs = Math.floor(clock / 1000) + 60;
    world.chain.set(H.vaultState, {
      lamports: 2_338_000n,
      owner: SHOP_VAULT_PROGRAM_ID,
      data: vaultStateData({ placeHashHex: H.placeHashHex, mint: H.mint, launcher: H.launcher, pending: { owner: newOwner.publicKey.toBase58(), unlockTs }, nonce: 1n }),
    });
    const sig = b58encode(crypto.getRandomValues(new Uint8Array(64)));
    world.chain.land(sig, { accountKeys: [newOwner.publicKey.toBase58(), attestor.publicKey.toBase58(), H.vaultState, SHOP_VAULT_PROGRAM_ID], numRequiredSignatures: 2, inner: [] });
    const conf = await call<ClaimConfirmResponse>('POST', '/api/claim/confirm', { claimId: started.body.claimId, signature: sig });
    expect(conf.body).toEqual({ status: 'pending_onchain', unlockTs, inProbation: false, claimWindowSecs: 60 });
    claimId = started.body.claimId;

    // the site owner hears about it at once: one message, with the facts and no phone number
    expect(posts.length).toBe(before + 1);
    const text = lastPost();
    expect(text).toMatch(/^\[AtlasPad devnet\] Phone claim requested \(devnet on-screen code\)\n/);
    expect(text).toContain('Shop: Hidden Cafe ($HIDE) · hidden from the map');
    expect(text).toContain(`Claimant: ${shortWallet(newOwner.publicKey.toBase58())}`);
    expect(text).toContain(`Claim tx: <https://solscan.io/tx/${sig}?cluster=devnet>`);
    expect(text).not.toMatch(/7946|\+44/);
    // and the same message by email (ALERT_EMAIL_TO through the ALERT_EMAIL binding), from alerts@atlaspad.online
    expect(emails.length).toBe(emailsBefore + 1);
    const mail = emails.at(-1)!;
    expect(mail).toMatchObject({ from: 'alerts@atlaspad.online', to: EMAIL_TO });
    const [head, body] = mail.raw.split('\r\n\r\n');
    expect(head).toContain('\r\nSubject: [AtlasPad devnet] INFO owner_claim: Phone claim requested (devnet on-screen code)\r\n');
    expect(new TextDecoder().decode(NodeBuffer.from(body!.replace(/\r\n/g, ''), 'base64'))).toBe(text.replace(/\n/g, '\r\n'));
  });

  it('the program monitor sees the same claim on-chain: no second message; the cron finalizes it', async () => {
    const before = posts.length;
    landClaimRequested(H, newOwner.publicKey.toBase58(), 1n, Math.floor(clock / 1000) + 60);
    clock += 61_000;
    world.chain.onSend = () => {
      world.chain.set(H.vaultState, {
        lamports: 2_338_000n,
        owner: SHOP_VAULT_PROGRAM_ID,
        data: vaultStateData({ placeHashHex: H.placeHashHex, mint: H.mint, launcher: H.launcher, owner: newOwner.publicKey.toBase58(), nonce: 1n, ownerSince: Math.floor(clock / 1000) }),
      });
    };
    const r = await cron();
    expect(r.jobs.monitor).toMatch(/^1 events from \d+ txs$/);
    expect(posts.length).toBe(before);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'owner_claim' AND ref = ?", `claim:${H.placeId}:1`)!.n).toBe(1);
    clock += 61_000;
    await cron();
    world.chain.onSend = null;
    expect(db.get<{ status: string }>('SELECT status FROM claims WHERE id = ?', claimId)!.status).toBe('finalized');
    expect(db.get<{ owner: string; status: string }>('SELECT owner, status FROM coins WHERE place_id = ?', H.placeId)).toEqual({ owner: newOwner.publicKey.toBase58(), status: 'hidden' });
    const st = await call<ClaimStatusResponse>('GET', `/api/claim/status?placeId=${H.placeId}`);
    expect(st.body.owner).toMatchObject({ status: 'claimed', owner: newOwner.publicKey.toBase58() });
  });

  it('withdrawals read the vault through /api/rpc like any other coin', async () => {
    const r = await call<{ result: { value: ({ owner: string } | null)[] } }>('POST', '/api/rpc', {
      jsonrpc: '2.0',
      id: 1,
      method: 'getMultipleAccounts',
      params: [[H.vaultState, H.vault], { encoding: 'base64', commitment: 'confirmed' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.result.value[0]?.owner).toBe(SHOP_VAULT_PROGRAM_ID);
  });

  it('a website-code claim works on a hidden coin too, and its verification is sent to the owner (warn)', async () => {
    const ip = freshIp();
    const r = await call<{ status: string; host: string; claimId: string; code: string }>('POST', '/api/claim/website', { placeId: H.placeId }, ip);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'code', host: 'www.hiddencafe.co.uk' });
    world.sites.set('www.hiddencafe.co.uk/.well-known/atlaspad.txt', `${r.body.code}\n`);
    const before = posts.length;
    const ok = await call<{ status: string }>('POST', '/api/claim/website', { placeId: H.placeId, claimId: r.body.claimId }, ip);
    expect(ok.body.status).toBe('approved');
    expect(posts.length).toBe(before + 1);
    expect(lastPost()).toBe(`[AtlasPad devnet] WARN claim_website_verified: Website-code claim ${r.body.claimId} verified for place ${H.placeId} (www.hiddencafe.co.uk, well-known)`);
    expect(db.get<{ severity: string }>("SELECT severity FROM alerts WHERE kind = 'claim_website_verified' AND ref = ?", r.body.claimId)!.severity).toBe('warn');
    world.sites.delete('www.hiddencafe.co.uk/.well-known/atlaspad.txt');
  });

  it("a website code found on a hosting platform's subdomain is flagged for the human check", async () => {
    googlePlace('ChIJtenantcafe000001', { websiteUri: 'https://rosies.netlify.app/' });
    const R = await addCoin('ChIJtenantcafe000001', { ticker: 'ROSY', name: 'Rosies Cafe' });
    const ip = freshIp();
    const r = await call<{ status: string; host: string; claimId: string; code: string }>('POST', '/api/claim/website', { placeId: R.placeId }, ip);
    expect(r.body).toMatchObject({ status: 'code', host: 'rosies.netlify.app' });
    world.sites.set('rosies.netlify.app/.well-known/atlaspad.txt', `${r.body.code}\n`);
    const ok = await call<{ status: string }>('POST', '/api/claim/website', { placeId: R.placeId, claimId: r.body.claimId }, ip);
    expect(ok.body.status).toBe('approved');
    expect(lastPost()).toBe(
      `[AtlasPad devnet] WARN claim_website_verified: Website-code claim ${r.body.claimId} verified for place ${R.placeId} (rosies.netlify.app, well-known); multi-tenant host (netlify.app): check the subdomain is the business's own`,
    );
    world.sites.delete('rosies.netlify.app/.well-known/atlaspad.txt');
  });

  it('a claim whose browser never confirmed it is still announced, from the program monitor', async () => {
    googlePlace('ChIJnoconfirmcafe001', { websiteUri: 'https://www.noconfirm.co.uk/' });
    const N = await addCoin('ChIJnoconfirmcafe001', { ticker: 'NOCF', name: 'No Confirm Cafe' });
    const claimant = newKey();
    db.raw
      .prepare(
        `INSERT INTO claims(id, place_id, mint, method, website_host, status, calls, new_owner, nonce, requested_at, expires_at, updated_at)
         VALUES ('noconfirm-claim-0001', ?, ?, 'website', 'www.noconfirm.co.uk', 'cosigned', 1, ?, 1, ?, ?, ?)`,
      )
      .run(N.placeId, N.mint, claimant, clock, clock + HOUR, clock);
    const before = posts.length;
    landClaimRequested(N, claimant, 1n, Math.floor(clock / 1000) + 259_200);
    clock += 61_000;
    await cron();
    expect(posts.length).toBe(before + 1);
    const text = lastPost();
    expect(text).toMatch(/^\[AtlasPad devnet\] Website-code claim requested: needs a human check before unlock\n/);
    expect(text).toContain('Shop: No Confirm Cafe ($NOCF)');
    expect(text).toContain('Website: www.noconfirm.co.uk');
    expect(text).toContain(`Claimant: ${shortWallet(claimant)}`);
    expect(text).toContain('(in 72 h)');
    // a ClaimRequested without any claims row is the critical claim_unknown alert, not an owner alert
    const ctx = (await buildCtx(env, exec, deps, 'cron'))!;
    await notifyOwnerFromChain(ctx, N.placeHashHex, { newOwner: newKey(), nonce: '2', unlockTs: '1' }, 'sig-x');
    expect(posts.length).toBe(before + 1);
  });
});

/* ======================================================================================== unconfirmed claims */

describe('a claim sent on chain without /api/claim/confirm is still announced', () => {
  /** A coin whose VaultState has `claimant` pending at nonce 1 (sent on chain, never confirmed to the site). */
  async function pendingOnChain(placeId: string, ticker: string, claimant: string): Promise<TestCoin & { unlockTs: number }> {
    googlePlace(placeId);
    const P = await addCoin(placeId, { ticker, name: `${ticker} Cafe` });
    const unlockTs = Math.floor(clock / 1000) + 259_200;
    world.chain.set(P.vaultState, {
      lamports: 2_338_000n,
      owner: SHOP_VAULT_PROGRAM_ID,
      data: vaultStateData({ placeHashHex: P.placeHashHex, mint: P.mint, launcher: P.launcher, pending: { owner: claimant, unlockTs }, nonce: 1n }),
    });
    return { ...P, unlockTs };
  }
  /** A website-code claims row for `claimant` at nonce 1, co-signed at `at`. */
  function cosignedRow(id: string, P: TestCoin, claimant: string, at: number): void {
    db.raw
      .prepare(
        `INSERT INTO claims(id, place_id, mint, method, website_host, status, calls, new_owner, nonce, requested_at, expires_at, updated_at)
         VALUES (?, ?, ?, 'website', 'www.example.co.uk', 'cosigned', 1, ?, 1, ?, ?, ?)`,
      )
      .run(id, P.placeId, P.mint, claimant, at, at + HOUR, at);
  }
  const pendingAlerts = (P: TestCoin, claimant: string) =>
    db.all<{ severity: string; message: string }>("SELECT severity, message FROM alerts WHERE kind = 'claim_pending_onchain' AND ref = ?", `${P.vaultState}:1:${claimant}`);

  it('the vault sweep alerts once (critical, emailed) for a pending claim the site never co-signed, then mirrors it', async () => {
    const claimant = newKey();
    const P = await pendingOnChain('ChIJsweepcafe0000001', 'SWEP', claimant);
    const before = posts.length;
    const emailsBefore = emails.length;
    clock += 61_000;
    await cron();
    expect(pendingAlerts(P, claimant).map((a) => a.severity)).toEqual(['critical']);
    expect(posts.length).toBe(before + 1);
    expect(lastPost()).toContain(
      `[AtlasPad devnet] CRITICAL claim_pending_onchain: Claim pending on chain for place ${P.placeId} (mint ${P.mint}) that the site never co-signed (possible attestor misuse): pending owner ${claimant}, nonce 1`,
    );
    expect(lastPost()).toContain('node scripts/claims-admin.mjs --env devnet list');
    expect(emails.length).toBe(emailsBefore + 1);
    expect(db.get<{ pending_owner: string }>('SELECT pending_owner FROM coins WHERE place_id = ?', P.placeId)!.pending_owner).toBe(claimant);
    // later sweeps (every 10 min) do not repeat it, also after the hourly de-duplication of other alerts
    for (const step of [2 * HOUR, DAY, 2 * DAY]) {
      clock += step;
      await cron();
    }
    expect(pendingAlerts(P, claimant)).toHaveLength(1);
    expect(posts.length).toBe(before + 1);
  });

  it('a public ?fresh=1 read that mirrors the pending owner first does not hide it (co-signed, never confirmed: warn)', async () => {
    const claimant = newKey();
    const P = await pendingOnChain('ChIJfreshfirstcafe01', 'FRSH', claimant);
    cosignedRow('freshfirst-claim-0001', P, claimant, clock - CONFIRM_GRACE_MS - 60_000);
    const before = posts.length;
    const emailsBefore = emails.length;
    // the coin page with ?fresh=1 (public, no alert) writes the chain's pending owner into D1 before any sweep
    const d = await call<{ owner: { status: string; pendingOwner: string | null } }>('GET', `/api/coins/${P.mint}?fresh=1`);
    expect(d.body.owner).toMatchObject({ status: 'pending', pendingOwner: claimant });
    expect(db.get<{ pending_owner: string }>('SELECT pending_owner FROM coins WHERE place_id = ?', P.placeId)!.pending_owner).toBe(claimant);
    expect(posts.length).toBe(before);
    // the coin is not new and does not trade: the next sweep of every coin (within 10 min) reads it
    clock += 11 * 60_000;
    await cron();
    const rows = pendingAlerts(P, claimant);
    expect(rows.map((a) => a.severity)).toEqual(['warn']);
    expect(rows[0]!.message).toContain('that the site co-signed but nobody confirmed (no /api/claim/confirm)');
    expect(posts.length).toBe(before + 1);
    expect(lastPost()).toMatch(/^\[AtlasPad devnet\] WARN claim_pending_onchain: /);
    expect(emails.length).toBe(emailsBefore + 1);
    clock += 2 * HOUR;
    await cron();
    expect(pendingAlerts(P, claimant)).toHaveLength(1);
  });

  it('a claim between its landing and its confirm is no false alarm; one never confirmed is reported after the grace', async () => {
    const claimant = newKey();
    const P = await pendingOnChain('ChIJconfirmlatecafe1', 'LATE', claimant);
    cosignedRow('confirmlate-claim-001', P, claimant, clock);
    clock += 61_000;
    await cron();
    expect(pendingAlerts(P, claimant)).toEqual([]);
    // its confirm arrives: the claim is recorded, so no sweep ever reports it
    db.raw.prepare("UPDATE claims SET status = 'pending_onchain', unlock_ts = ?, updated_at = ? WHERE id = 'confirmlate-claim-001'").run(P.unlockTs, clock);
    clock += CONFIRM_GRACE_MS + 61_000;
    await cron();
    expect(pendingAlerts(P, claimant)).toEqual([]);

    // the same, but nobody confirms: quiet while the browser may still be polling, then one warning
    const other = newKey();
    const Q = await pendingOnChain('ChIJneverconfirmcaf1', 'NVER', other);
    cosignedRow('neverconfirm-claim-01', Q, other, clock);
    clock += 61_000;
    await cron();
    expect(pendingAlerts(Q, other)).toEqual([]);
    clock += CONFIRM_GRACE_MS;
    await cron();
    expect(pendingAlerts(Q, other).map((a) => a.severity)).toEqual(['warn']);
  });

  it('the program monitor says when it is reading transactions late (a backlog), at most hourly', async () => {
    const stale = () => {
      world.chain.land(b58encode(crypto.getRandomValues(new Uint8Array(64))), {
        accountKeys: [newKey(), SHOP_VAULT_PROGRAM_ID],
        numRequiredSignatures: 1,
        inner: [],
        logs: [],
        blockTime: Math.floor((clock - monitorLagAlertMs('devnet') - 5 * 60_000) / 1000),
      });
    };
    expect(monitorLagAlertMs('mainnet')).toBe(10 * 60_000);
    expect(monitorLagAlertMs('devnet')).toBe(15 * 60_000);
    // on time: nothing
    landClaimRequested(await addCoin('ChIJmonitorontime0001'), newKey(), 1n, Math.floor(clock / 1000) + 60);
    clock += 61_000;
    await cron();
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'monitor_backlog'")!.n).toBe(0);
    stale();
    clock += 61_000;
    const before = posts.length;
    await cron();
    expect(db.get<{ severity: string; ref: string }>("SELECT severity, ref FROM alerts WHERE kind = 'monitor_backlog'")).toEqual({ severity: 'warn', ref: SHOP_VAULT_PROGRAM_ID });
    expect(posts.length).toBe(before + 1);
    expect(lastPost()).toMatch(/^\[AtlasPad devnet\] WARN monitor_backlog: The program monitor is reading transactions 2[01] min late/);
    stale();
    clock += 61_000;
    await cron();
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'monitor_backlog'")!.n).toBe(1);
  });

  it('a backlog of failed transactions only (never fetched) is still seen as one', async () => {
    clock += 2 * HOUR; // past the hourly de-duplication of the last backlog alert
    const backlog = () => db.all<{ message: string }>("SELECT message FROM alerts WHERE kind = 'monitor_backlog' ORDER BY id");
    const before = backlog().length;
    const failed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const sig = b58encode(crypto.getRandomValues(new Uint8Array(64)));
      failed.push(sig);
      world.chain.land(sig, {
        accountKeys: [newKey(), SHOP_VAULT_PROGRAM_ID],
        numRequiredSignatures: 1,
        inner: [],
        logs: [],
        err: { InstructionError: [0, { Custom: 1 }] },
        blockTime: Math.floor((clock - monitorLagAlertMs('devnet') - 5 * 60_000) / 1000),
      });
    }
    await cron();
    expect(world.chain.callLog.filter((c) => c.method === 'getTransaction' && failed.includes(c.params[0] as string))).toEqual([]);
    expect(backlog()).toHaveLength(before + 1);
    expect(backlog().at(-1)!.message).toMatch(/^The program monitor is reading transactions 2[01] min late/);
  });

  it('a cron run that reads many pending claims stays within the 50 D1 queries of one invocation', async () => {
    // 20 claims pending on chain that /confirm recorded (no alert), and one nobody recorded or co-signed (critical)
    const recorded: { P: TestCoin; claimant: string }[] = [];
    for (let i = 0; i < 20; i++) {
      const claimant = newKey();
      const P = await pendingOnChain(`ChIJmanypending${String(i).padStart(6, '0')}`, `MANY${i}`, claimant);
      db.raw
        .prepare(
          `INSERT INTO claims(id, place_id, mint, method, status, calls, new_owner, nonce, unlock_ts, requested_at, expires_at, updated_at)
           VALUES (?, ?, ?, 'call', 'pending_onchain', 1, ?, 1, ?, ?, ?, ?)`,
        )
        .run(`many-pending-claim-${i}`, P.placeId, P.mint, claimant, P.unlockTs, clock, clock + HOUR, clock);
      recorded.push({ P, claimant });
    }
    const stray = newKey();
    const U = await pendingOnChain('ChIJmanypendingstray1', 'STRY', stray);
    clock += 61_000;
    const before = db.calls;
    const r = await cron();
    expect(r.jobs.vaults).toMatch(/^(2[1-9]|3[0-2]) vaults/); // all 21 read in this one run
    expect(db.calls - before).toBeLessThanOrEqual(50); // Workers Free: ≤ 50 D1 queries per invocation, a batch = 1
    expect(pendingAlerts(U, stray).map((a) => a.severity)).toEqual(['critical']);
    for (const { P, claimant } of recorded) expect(pendingAlerts(P, claimant)).toEqual([]);
  });

  it('many unrecorded claims in one run (hourly jobs due too) cost a fixed number of D1 queries and send one message', async () => {
    // six co-signed long ago and never confirmed (warn), then one never co-signed (critical), in coin order
    const found: { P: TestCoin & { unlockTs: number }; claimant: string }[] = [];
    for (let i = 0; i < 7; i++) {
      const claimant = newKey();
      const P = await pendingOnChain(`ChIJmanystray${String(i).padStart(7, '0')}`, `STR${i}`, claimant);
      if (i < 6) cosignedRow(`manystray-claim-000${i}`, P, claimant, clock - CONFIRM_GRACE_MS - 60_000);
      found.push({ P, claimant });
    }
    clock += 2 * HOUR; // the hourly jobs (coords, holders, retention) are due in the same run
    const before = db.calls;
    const postsBefore = posts.length;
    const emailsBefore = emails.length;
    await cron();
    expect(db.calls - before).toBeLessThanOrEqual(50); // Workers Free: ≤ 50 D1 queries per invocation, a batch = 1
    for (const [i, { P, claimant }] of found.entries()) expect(pendingAlerts(P, claimant).map((a) => a.severity)).toEqual([i < 6 ? 'warn' : 'critical']);
    expect(posts.length).toBe(postsBefore + 1);
    expect(emails.length).toBe(emailsBefore + 1);
    const text = lastPost();
    expect(text.length).toBeLessThanOrEqual(WEBHOOK_MAX_CHARS);
    expect(text).toMatch(
      /^\[AtlasPad devnet\] CRITICAL claim_pending_onchain: 7 claims pending on chain that no confirm recorded \(1 never co-signed\)\. Check them before they unlock: node scripts\/claims-admin\.mjs --env devnet list\n/,
    );
    // the never co-signed claim leads, though its coin came last; the rest are counted, not cut off unannounced
    const lines = text.split('\n').slice(1);
    expect(lines[0]).toBe(`• place ${found[6]!.P.placeId} (mint ${found[6]!.P.mint}) that the site never co-signed (possible attestor misuse): pending owner ${found[6]!.claimant}, nonce 1, unlocks ${new Date(found[6]!.P.unlockTs * 1000).toISOString()}`);
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe('… and 3 more: node scripts/watchdog.mjs --cluster devnet');
    // the next runs find them stored: nothing is sent again
    for (const step of [61_000, 2 * HOUR]) {
      clock += step;
      await cron();
    }
    expect(posts.length).toBe(postsBefore + 1);
    for (const { P, claimant } of found) expect(pendingAlerts(P, claimant)).toHaveLength(1);
  });
});

/* ======================================================================================== opt-outs */

describe('opted-out places get no coin, also before one exists', () => {
  const OPT = 'ChIJoptedoutcafe0001';
  const ALIAS = 'ChIJoldaliasofcafe01';
  const CANON = 'ChIJcanonicalcafe001';
  const prepare = (placeId: string, metadataId: string) =>
    call<{ error: string; message: string }>(
      'POST',
      '/api/launch/prepare',
      { placeId, launcher: newKey(), mint: newKey(), metadataId, category: 'cafe', emoji: '☕', bg: '#1f8a4c', devBuyLamports: '0' },
      freshIp(),
    );

  beforeAll(() => {
    googlePlace(OPT);
    googlePlace(ALIAS, { id: CANON }); // Google answers an old id with the place's canonical id
    googlePlace(CANON);
    for (const [id, place] of [
      ['0'.repeat(31) + '1', OPT],
      ['0'.repeat(31) + '2', ALIAS],
    ]) {
      db.raw.prepare("INSERT INTO metadata(id, json, name, symbol, description, image_id, place_id, created_at) VALUES (?, '{}', 'Opt Cafe', 'OPT', '', 'a', ?, ?)").run(id, place, clock);
    }
    db.raw.prepare('INSERT INTO place_optouts(place_id, created_at) VALUES (?, ?), (?, ?)').run(OPT, clock, CANON, clock);
  });

  it('eligibility says opted_out without the paid Google lookup; the place says optedOut', async () => {
    const googleBefore = world.requests.filter((r) => r.includes('places.googleapis.com')).length;
    const e = await call<{ launchable: boolean; reason: string }>('GET', `/api/place/${OPT}/eligibility`, undefined, freshIp());
    expect(e.body).toEqual({ placeId: OPT, launchable: false, reason: 'opted_out', category: null });
    expect(world.requests.filter((r) => r.includes('places.googleapis.com')).length).toBe(googleBefore);
    const p = await call<PlaceResponse>('GET', `/api/place/${OPT}`);
    expect(p.body).toMatchObject({ coin: null, optedOut: true });
    expect(p.body.hidden).toBeUndefined();
  });

  it('launch prepare refuses it with place_opted_out (by the requested id, and by Google`s canonical id)', async () => {
    const r = await prepare(OPT, '0'.repeat(31) + '1');
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: 'place_opted_out', message: 'This business asked us not to list coins for it.' });
    const alias = await prepare(ALIAS, '0'.repeat(31) + '2');
    expect(alias.status).toBe(422);
    expect(alias.body.error).toBe('place_opted_out');
    expect((await call<{ reason: string }>('GET', `/api/place/${ALIAS}/eligibility`, undefined, freshIp())).body.reason).toBe('opted_out');
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM launch_reservations WHERE place_id IN (?, ?)', OPT, CANON)!.n).toBe(0);
  });

  it('a Worker running before migration 0003 is applied treats places as not opted out (never a broken place page)', async () => {
    const before0003 = new FakeD1();
    before0003.raw.exec('DROP TABLE place_optouts');
    expect(await placeOptedOut(before0003.asD1(), OPT)).toBe(false);
    // any other database error is not swallowed
    const down = {
      prepare: () => {
        throw new Error('D1_ERROR: network connection lost');
      },
    } as unknown as D1Database;
    await expect(placeOptedOut(down, OPT)).rejects.toThrow(/network connection lost/);
    expect(await placeOptedOut(db.asD1())).toBe(false);
  });

  it('lifting the opt-out (moderate.mjs --optin) makes the place launchable again', async () => {
    db.raw.prepare('DELETE FROM place_optouts WHERE place_id = ?').run(OPT);
    const e = await call<{ launchable: boolean; reason: string }>('GET', `/api/place/${OPT}/eligibility`, undefined, freshIp());
    expect(e.body).toMatchObject({ launchable: true, reason: 'ok' });
  });
});

/* ======================================================================================== retention */

describe('report retention', () => {
  it(`the cron scrubs names, emails, free text and IP hashes after ${REPORT_PERSONAL_DATA_DAYS} days, keeping the rest`, async () => {
    const old = clock - (REPORT_PERSONAL_DATA_DAYS + 1) * DAY;
    const recent = clock - 10 * DAY;
    const ins = db.raw.prepare('INSERT INTO reports(kind, place_id, mint, reason, details, contact, created_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const a = Number(ins.run('optout', 'ChIJretentionold0001', null, 'optout', 'Name: Old Owner', 'old@shop.co.uk', old, 'iphash-old').lastInsertRowid);
    const b = Number(ins.run('report', null, newKey(), 'scam', 'old free text', null, old, 'iphash-old2').lastInsertRowid);
    const c = Number(ins.run('optout', 'ChIJretentionnew0001', null, 'optout', 'Name: New Owner', 'new@shop.co.uk', recent, 'iphash-new').lastInsertRowid);
    clock += 2 * HOUR; // the retention job runs hourly
    const r = await cron();
    expect(r.jobs.retention).toBe('ok');
    const row = (id: number) => db.get<Record<string, unknown>>('SELECT kind, place_id, reason, details, contact, ip_hash, created_at FROM reports WHERE id = ?', id)!;
    expect(row(a)).toEqual({ kind: 'optout', place_id: 'ChIJretentionold0001', reason: 'optout', details: null, contact: null, ip_hash: null, created_at: old });
    expect(row(b)).toMatchObject({ kind: 'report', reason: 'scam', details: null, ip_hash: null });
    expect(row(c)).toMatchObject({ details: 'Name: New Owner', contact: 'new@shop.co.uk', ip_hash: 'iphash-new' });
  });

  it('no secret, webhook URL or alert email address is ever logged', () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => void lines.push(s);
    try {
      makeLogger(env).info('x', { hook: HOOK, to: EMAIL_TO });
    } finally {
      console.log = orig;
    }
    expect(lines.join()).not.toContain('hook-secret-token');
    expect(lines.join()).not.toContain(EMAIL_TO);
  });
});
