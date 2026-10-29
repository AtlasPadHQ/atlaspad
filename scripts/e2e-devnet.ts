/**
 * API-level end-to-end test of the deployed DEVNET Worker (INTEGRATION §10.2 `e2e-devnet`, §11.3 row 3).
 *
 *   node scripts/e2e-devnet.ts                    # DRY RUN: guards, config, health, balances, plan (no writes)
 *   node scripts/e2e-devnet.ts --execute          # the real run (~3-8 min; the 60 s claim window + the 5-minute cron)
 *   GRADUATE=1 node scripts/e2e-devnet.ts --execute   # + buy out the curve, wait for PumpSwap, AMM buy + sell
 *   options: --origin <url> (default https://cornershop-devnet.tiejiucai.workers.dev) · --no-fund
 *   env: DEV_BUY_SOL (0.01) · BUY_SOL (0.1) · CRON_WAIT_SEC (360) · GRADUATE_WAIT_MIN (30) · PLACE_ID (fresh test id)
 *
 * It does what the browser does, with local devnet keys instead of a wallet (.keys/devnet-{launcher,buyer,owner}.json,
 * the deployer funds them and relays the withdraw fee). Every chain call goes through the Worker's /api/rpc proxy,
 * like the app (H3): build in "the browser" with the same SDKs (root node_modules, exact pins), the Worker validates
 * and co-signs, the key signs, send + confirm by polling (no WebSockets), then the Worker registers/indexes.
 *
 *  1. launch `cornershop-test:e2e-<id>`: metadata (PNG + JSON, served back from /meta and /img) → prepare →
 *     a tampered create_v2 name is refused by cosign (422 policy_violation) → cosign → sign → send → confirm
 *     (202 → registered); the coin is in /api/place, /api/coins and on chain (VaultState, curve.creator = vault)
 *  2. a second launch of the same place → 409 taken (existing = our mint)
 *  3. buy (v3) + sell 50% (exact raw units) → /api/index/tx → both in /api/feed within 5 s
 *  4. fees waiting (/api/coins/:mint?fresh=1) == Σ TradeEvent.creator_fee, exactly
 *  5. claim: status → call (devCode on screen) → a wrong code (attemptsLeft 2) → check → request_claim cosigned →
 *     confirm (pending_onchain) → 60 s window → the cron finalizes (or we do) → collect + withdraw pays the owner
 *     exactly Σ creator fees; the vault is left at rent_min(0); the API shows claimed + withdrawn
 *  6. GRADUATE=1: buy out the curve → pool appears → API graduated → PumpSwap buy + sell indexed
 * Report (signatures, timings, checks; no secrets): scripts/out/e2e-devnet-<time>.json. Exit 0 = pass.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { b58decode, b58encode } from './lib/b58.mjs';
import { readDeploy } from './lib/deployJson.mjs';
import { readSecretKey } from './lib/keys.mjs';
import { fmtSol, parseArgs } from './lib/log.mjs';
import { GENESIS, ORIGINS, OUT_DIR, PUBLIC_RPC, ROOT } from './lib/paths.mjs';

const req = createRequire(join(ROOT, 'package.json'));
const web3: any = req('@solana/web3.js');
const spl: any = req('@solana/spl-token');
const pump: any = req('@pump-fun/pump-sdk');
const BN: any = req('bn.js');
const sv: any = await import('@cornershop/shop-vault-client');
const { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } = web3;

// ------------------------------------------------------------------------------------------------- settings
const args = parseArgs(process.argv.slice(2), ['execute', 'no-fund']);
const EXECUTE = !!args.execute;
const ORIGIN = new URL(String(args.origin ?? ORIGINS.devnet)).origin;
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
const PLACE_ID = process.env.PLACE_ID ?? `cornershop-test:e2e-${Date.now().toString(36)}`;
const lamports = (s: string) => {
  const m = /^(\d+)(?:\.(\d{0,9}))?$/.exec(s.trim());
  if (!m) throw new Error(`bad SOL amount ${s}`);
  return BigInt(m[1]) * 1_000_000_000n + BigInt((m[2] ?? '').padEnd(9, '0') || '0');
};
const DEV_BUY = lamports(process.env.DEV_BUY_SOL ?? '0.01');
const BUY = lamports(process.env.BUY_SOL ?? '0.1');
// devnet's cron runs every 5 minutes (wrangler.jsonc, D1 budget): its finalize can come up to 300 s after unlock, + slack
const CRON_WAIT_SEC = Number(process.env.CRON_WAIT_SEC ?? '360');
const GRADUATE = process.env.GRADUATE === '1';
const GRADUATE_WAIT_MIN = Number(process.env.GRADUATE_WAIT_MIN ?? '30');
const BUYBACK = new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD');
const EVENT_IX_TAG = Buffer.from('e445a52e51cb9a1d', 'hex');
const TRADE_EVENT = Buffer.from('bddb7fd34ee661ee', 'hex');
const AMM_BUY_EVENT = Buffer.from('67f4521f2cf57777', 'hex');
const AMM_SELL_EVENT = Buffer.from('3e2f370aa503dc2a', 'hex');
const COLLECT_CREATOR_FEE = Buffer.from('1416567bc61cdb84', 'hex');

const report: Record<string, any> = { startedAt: new Date().toISOString(), origin: ORIGIN, execute: EXECUTE, placeId: PLACE_ID, steps: [], checks: [], timings: {}, signatures: {} };
const explorer = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(cond: unknown, what: string, detail?: string): asserts cond {
  report.checks.push({ ok: !!cond, what, detail });
  console.log(`${cond ? '  ✓' : '  ✗'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!cond) throw new Error(`check failed: ${what}${detail ? ` (${detail})` : ''}`);
}
function note(what: string) {
  report.checks.push({ ok: true, what, note: true });
  console.log(`  · ${what}`);
}
function section(name: string) {
  report.steps.push({ step: name, at: new Date().toISOString() });
  console.log(`\n${name}`);
}
function writeReport() {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `e2e-devnet-${STAMP}.json`);
  report.finishedAt = new Date().toISOString();
  writeFileSync(file, JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log(`\nreport: ${file}`);
}

// ------------------------------------------------------------------------------------------------- HTTP (our API)
type ApiRes = { status: number; json: any; ms: number; headers: Headers };
async function api(path: string, init: { method?: string; body?: any; form?: FormData; retry429?: boolean } = {}): Promise<ApiRes> {
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    const res = await fetch(new URL(path, ORIGIN), {
      method: init.method ?? (init.body || init.form ? 'POST' : 'GET'),
      headers: { origin: ORIGIN, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      body: init.form ?? (init.body ? JSON.stringify(init.body) : undefined),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const ms = Math.round(performance.now() - t0);
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    if (res.status === 429 && init.retry429 !== false && attempt < 4) {
      const wait = Number(res.headers.get('retry-after') ?? '5');
      console.log(`  · 429 on ${path}; waiting ${wait} s`);
      await sleep(Math.min(60, wait) * 1000 + 250);
      continue;
    }
    return { status: res.status, json, ms, headers: res.headers };
  }
}
const timed = (name: string, ms: number) => {
  (report.timings[name] ??= []).push(ms);
};

// ------------------------------------------------------------------------------------------------- chain via the proxy
const conn = new Connection(`${ORIGIN}/api/rpc`, { commitment: 'confirmed', disableRetryOnRateLimit: true, wsEndpoint: 'wss://invalid.invalid', httpHeaders: { origin: ORIGIN } });
const direct = new Connection(PUBLIC_RPC.devnet, { commitment: 'confirmed', wsEndpoint: 'wss://invalid.invalid' }); // genesis cross-check only
const sdk = new pump.PumpSdk();
const online = new pump.OnlinePumpSdk(conn);
const kp = (name: string) => Keypair.fromSecretKey(readSecretKey(name));
const cuLimit = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });
let PRIORITY = 10_000;
const cuPrice = () => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY });
const bal = async (pk: any) => BigInt(await conn.getBalance(pk, 'confirmed'));
const acct = (pk: any) => conn.getAccountInfo(pk, 'confirmed');

async function build(payer: any, ixs: any[], signers: any[] = [], alts: any[] = [], blockhash?: { blockhash: string; lastValidBlockHeight: number }) {
  const bh = blockhash ?? (await conn.getLatestBlockhash('confirmed'));
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  if (signers.length) tx.sign(signers);
  return { tx, lastValidBlockHeight: bh.lastValidBlockHeight };
}

/** INTEGRATION §4.7: simulate, send skipPreflight via the proxy, poll statuses every 800 ms, rebroadcast every 2 s. */
async function sendAndConfirm(label: string, b: { tx: any; lastValidBlockHeight: number }): Promise<{ signature: string; meta: any; ms: number; slot: number }> {
  const t0 = performance.now();
  const sim = await conn.simulateTransaction(b.tx, { sigVerify: true, commitment: 'confirmed' });
  if (sim.value.err) throw new Error(`${label}: simulation failed ${JSON.stringify(sim.value.err)}\n    ${(sim.value.logs ?? []).slice(-10).join('\n    ')}`);
  const raw = b.tx.serialize();
  const signature = b58encode(b.tx.signatures[0]); // known before sending (INTEGRATION §4.7 step 3)
  await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  let last = Date.now();
  for (;;) {
    const st = (await conn.getSignatureStatuses([signature])).value[0];
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
      if (st.err) throw new Error(`${label}: failed on-chain ${JSON.stringify(st.err)} ${explorer(signature)}`);
      break;
    }
    if ((await conn.getBlockHeight('confirmed')) > b.lastValidBlockHeight) throw new Error(`${label}: expired before landing (${signature})`);
    if (performance.now() - t0 > 60_000) throw new Error(`${label}: unconfirmed after 60 s (${signature})`);
    if (Date.now() - last > 2000) {
      await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      last = Date.now();
    }
    await sleep(800);
  }
  const ms = Math.round(performance.now() - t0);
  let meta: any = null;
  let slot = 0;
  for (let i = 0; i < 15 && !meta; i++) {
    const t = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    meta = t?.meta ?? null;
    slot = t?.slot ?? 0;
    if (!meta) await sleep(500 * (i + 1));
  }
  console.log(`  ✓ ${label} — ${ms} ms — ${explorer(signature)}`);
  report.signatures[label] = signature;
  timed(`tx:${label}`, ms);
  return { signature, meta, ms, slot };
}

interface TradeEv { mint: string; sol: bigint; tokens: bigint; isBuy: boolean; user: string; creator: string; creatorFee: bigint; venue: 'curve' | 'amm' }
function tradeEvents(meta: any): TradeEv[] {
  const out: TradeEv[] = [];
  for (const g of meta?.innerInstructions ?? []) {
    for (const ix of g.instructions) {
      const d = Buffer.from(b58decode(ix.data));
      if (d.length < 16 || !d.subarray(0, 8).equals(EVENT_IX_TAG)) continue;
      const disc = d.subarray(8, 16);
      const e = d.subarray(16);
      if (disc.equals(TRADE_EVENT) && e.length >= 217) {
        out.push({ mint: new PublicKey(e.subarray(0, 32)).toBase58(), sol: e.readBigUInt64LE(32), tokens: e.readBigUInt64LE(40), isBuy: e[48] !== 0, user: new PublicKey(e.subarray(49, 81)).toBase58(), creator: new PublicKey(e.subarray(169, 201)).toBase58(), creatorFee: e.readBigUInt64LE(209), venue: 'curve' });
      } else if ((disc.equals(AMM_BUY_EVENT) || disc.equals(AMM_SELL_EVENT)) && e.length >= 352) {
        out.push({ mint: '', sol: e.readBigUInt64LE(104), tokens: e.readBigUInt64LE(8), isBuy: disc.equals(AMM_BUY_EVENT), user: new PublicKey(e.subarray(144, 176)).toBase58(), creator: '', creatorFee: e.readBigUInt64LE(344), venue: 'amm' });
      }
    }
  }
  return out;
}

/**
 * Σ creator fees paid to `vault` by every trade of `mint` on chain, up to `maxSlot`. Devnet bots trade fresh pump.fun
 * coins too, and their fees are real vault money, so the exact-fee checks compare against this rather than our trades.
 */
async function chainCreatorFees(mint: any, vault: string, maxSlot = Infinity): Promise<{ sum: bigint; foreign: TradeEv[] }> {
  let sum = 0n;
  const foreign: TradeEv[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await conn.getSignaturesForAddress(mint, { limit: 25, before }, 'confirmed');
    for (const s of page) {
      if (s.err || s.slot > maxSlot) continue;
      const t = await conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      for (const e of tradeEvents(t?.meta)) {
        if (e.creator !== vault) continue;
        sum += e.creatorFee;
        if (!ourTraders.has(e.user)) foreign.push(e);
      }
    }
    if (page.length < 25) return { sum, foreign };
    before = page[page.length - 1].signature;
  }
}
const ourTraders = new Set<string>();

/** GET /api/coins/:mint?fresh=1 with the on-chain Σ read either side, retried while a trade lands in between. */
async function feesAgainstChain(mint: any, vault: string): Promise<{ res: ApiRes; chain: { sum: bigint; foreign: TradeEv[] } }> {
  for (let i = 0; ; i++) {
    const before = await chainCreatorFees(mint, vault);
    const res = await api(`/api/coins/${mint.toBase58()}?fresh=1`);
    const chain = await chainCreatorFees(mint, vault);
    if (chain.sum === before.sum || i === 2) return { res, chain };
  }
}

// ------------------------------------------------------------------------------------------------- tiny PNG (512×512)
function png(rgb: [number, number, number]): Buffer {
  const W = 512;
  const row = Buffer.alloc(1 + W * 3);
  for (let x = 0; x < W; x++) row.set(rgb, 1 + x * 3);
  const rows: Buffer[] = [];
  for (let y = 0; y < W; y++) {
    const r = Buffer.from(row);
    if ((y >> 5) % 2) for (let x = 0; x < W; x += 2) r[1 + x * 3] = 255 - rgb[0];
    rows.push(r);
  }
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(W, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

async function uploadMetadata(description: string) {
  const fd = new FormData();
  fd.set('name', 'Corner Cafe E2E');
  fd.set('symbol', 'CAFE');
  fd.set('description', description);
  fd.set('placeId', PLACE_ID);
  fd.set('image', new Blob([png([46, 125, 50])], { type: 'image/png' }), 'coin.png');
  const r = await api('/api/metadata', { form: fd });
  timed('api:metadata', r.ms);
  return r;
}

// ------------------------------------------------------------------------------------------------- main
async function main() {
  console.log(`e2e-devnet · ${ORIGIN} · ${EXECUTE ? 'EXECUTE (sends devnet transactions)' : 'DRY RUN (reads only)'} · place ${PLACE_ID}`);

  section('0 · guards');
  const genesis = await direct.getGenesisHash();
  check(genesis === GENESIS.devnet, 'public RPC genesis is devnet', genesis);
  const cfgRes = await api('/api/config');
  timed('api:config', cfgRes.ms);
  check(cfgRes.status === 200, '/api/config', `HTTP ${cfgRes.status}`);
  const cfg = cfgRes.json;
  check(cfg.cluster === 'devnet', 'Worker cluster is devnet (never anything else)', cfg.cluster);
  check((await conn.getGenesisHash()) === GENESIS.devnet, 'proxy genesis is devnet');
  const dep = readDeploy('devnet') ?? {};
  if (dep.alt) check(cfg.alt === dep.alt, 'config.alt = deploy/devnet.json', cfg.alt);
  check(cfg.features?.phoneVerification === 'screen', 'phone verification = screen (devnet)');
  PRIORITY = cfg.priorityFeeMicroLamports || PRIORITY;
  const health = await api('/api/health');
  if (!health.json?.ok) note(`health not ok: ${JSON.stringify(health.json?.checks ?? health.json)}`);
  else check(true, '/api/health ok');

  const launcher = kp('devnet-launcher');
  const buyer = kp('devnet-buyer');
  ourTraders.add(launcher.publicKey.toBase58()).add(buyer.publicKey.toBase58());
  const owner = kp('devnet-owner');
  const deployer = kp('devnet-deployer');
  report.keys = { launcher: launcher.publicKey.toBase58(), buyer: buyer.publicKey.toBase58(), owner: owner.publicKey.toBase58(), relayer: deployer.publicKey.toBase58() };

  section('1 · funding');
  const targets: [string, any, bigint][] = [
    ['launcher', launcher, DEV_BUY + lamports('0.06')],
    ['buyer', buyer, BUY + lamports('0.05') + (GRADUATE ? lamports('3.4') : 0n)],
    ['owner', owner, lamports('0.01')],
  ];
  const tops: any[] = [];
  let need = 0n;
  for (const [name, k, want] of targets) {
    const have = await bal(k.publicKey);
    console.log(`  · ${name} ${k.publicKey.toBase58()} ${fmtSol(have)} (needs ${fmtSol(want)})`);
    if (have < want) {
      tops.push(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: k.publicKey, lamports: want - have }));
      need += want - have;
    }
  }
  const depBal = await bal(deployer.publicKey);
  console.log(`  · deployer ${fmtSol(depBal)}${need ? `, tops up ${fmtSol(need)}` : ''}`);
  if (!EXECUTE) {
    console.log('\nDRY RUN: guards and balances OK. Run with --execute for the full flow (sends devnet transactions).');
    report.passed = true;
    return;
  }
  if (tops.length) {
    if (args['no-fund']) throw new Error(`test keys need ${fmtSol(need)} and --no-fund was given`);
    check(depBal >= need + lamports('0.02'), 'deployer can fund the run', fmtSol(depBal));
    await sendAndConfirm('fund test keys', await build(deployer.publicKey, tops, [deployer]));
  }

  // ----------------------------------------------------------------------------------------------- 1 launch
  section('2 · launch');
  const tLaunch = performance.now();
  const meta = await uploadMetadata('Automated devnet end-to-end test coin.');
  check(meta.status === 200 && /^[0-9a-f]{32}$/.test(meta.json?.metadataId ?? ''), 'POST /api/metadata', `HTTP ${meta.status} ${meta.json?.error ?? ''}`);
  check(new TextEncoder().encode(meta.json.uri).length <= 100, 'metadata URI ≤ 100 bytes', meta.json.uri);
  const metaJson = await fetch(meta.json.uri).then((r) => r.json());
  check(metaJson.name === meta.json.name && metaJson.image === meta.json.imageUrl, 'metadata JSON served at the URI', meta.json.uri);
  const img = await fetch(meta.json.imageUrl);
  check(img.status === 200 && /^image\/(png|webp|jpeg)$/.test(img.headers.get('content-type') ?? ''), 'image served', `${img.headers.get('content-type')} · ${img.headers.get('cache-control')}`);
  const elig = await api(`/api/place/${encodeURIComponent(PLACE_ID)}/eligibility`);
  check(elig.status === 200 && elig.json?.launchable === true, 'devnet test place is launchable', JSON.stringify(elig.json));

  const mint = Keypair.generate();
  const prepBody = { placeId: PLACE_ID, launcher: launcher.publicKey.toBase58(), mint: mint.publicKey.toBase58(), metadataId: meta.json.metadataId, category: 'cafe', emoji: '☕', bg: '#e8f5e9', devBuyLamports: DEV_BUY.toString() };
  const prep = await api('/api/launch/prepare', { body: prepBody });
  timed('api:prepare', prep.ms);
  check(prep.status === 200 && prep.json?.reservationId, 'POST /api/launch/prepare', `HTTP ${prep.status} ${prep.json?.error ?? ''} ${prep.json?.message ?? ''}`);
  const p = prep.json;
  check(p.alt === cfg.alt && p.attestor === cfg.attestor, 'prepare: ALT and attestor match /api/config');
  const placeHash = sv.fromHex(p.placeHash);
  check(sv.toHex(sv.placeHash(PLACE_ID)) === p.placeHash, 'prepare: placeHash = sha256(placeId)');
  check(sv.vaultPda(placeHash)[0].toBase58() === p.vault, 'prepare: vault = PDA(["vault", place_hash])');
  const altAcc = (await conn.getAddressLookupTable(new PublicKey(p.alt))).value;
  check(altAcc && altAcc.state.addresses.length === 14 && altAcc.state.authority === undefined, 'ALT loaded through the proxy (14 keys, frozen)');

  const launchIxs = async (name: string) => {
    const ixs = [
      cuLimit(p.computeUnitLimit),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p.priorityFeeMicroLamports }),
      await sdk.createV2Instruction({ mint: mint.publicKey, name, symbol: p.symbol, uri: p.uri, creator: new PublicKey(p.vault), user: launcher.publicKey, mayhemMode: false }),
      sv.registerLaunch({ launcher: launcher.publicKey, attestor: new PublicKey(p.attestor), placeHash, mint: mint.publicKey }),
    ];
    if (DEV_BUY > 0n) {
      ixs.push(
        spl.createAssociatedTokenAccountIdempotentInstruction(launcher.publicKey, sv.associatedTokenAddress(launcher.publicKey, mint.publicKey, sv.TOKEN_2022_PROGRAM_ID), launcher.publicKey, mint.publicKey, sv.TOKEN_2022_PROGRAM_ID),
        await sdk.getBuyExactQuoteInV3InstructionRaw({ user: launcher.publicKey, mint: mint.publicKey, spendableQuoteIn: new BN(DEV_BUY.toString()), minTokensOut: new BN(1), buybackFeeRecipient: BUYBACK }),
      );
    }
    return ixs;
  };
  const bh = { blockhash: p.blockhash, lastValidBlockHeight: p.lastValidBlockHeight };

  // The Worker must refuse a message whose create_v2 name differs from the moderated metadata (SPEC §8.4 rule 4).
  const tampered = await build(launcher.publicKey, await launchIxs('Not Moderated'), [], [altAcc], bh);
  const bad = await api('/api/launch/cosign', { body: { reservationId: p.reservationId, messageBase64: Buffer.from(tampered.tx.message.serialize()).toString('base64') } });
  check(bad.status === 422 && bad.json?.error === 'policy_violation', 'cosign refuses a tampered name (422 policy_violation)', `HTTP ${bad.status} ${bad.json?.error ?? ''} ${(bad.json?.violations ?? []).join('; ')}`);

  const built = await build(launcher.publicKey, await launchIxs(p.name), [], [altAcc], bh);
  const size = built.tx.serialize().length;
  check(size <= 1232, 'launch tx ≤ 1,232 B', `${size} B`);
  const cos = await api('/api/launch/cosign', { body: { reservationId: p.reservationId, messageBase64: Buffer.from(built.tx.message.serialize()).toString('base64') } });
  timed('api:cosign', cos.ms);
  check(cos.status === 200 && cos.json?.attestorSignature, 'POST /api/launch/cosign', `HTTP ${cos.status} ${cos.json?.error ?? ''} ${(cos.json?.violations ?? []).join('; ')}`);
  built.tx.addSignature(new PublicKey(cos.json.attestor), Buffer.from(cos.json.attestorSignature, 'base64'));
  built.tx.sign([mint, launcher]);
  const launch = await sendAndConfirm('launch (create_v2 + register_launch + dev buy)', built);
  let confirmed: ApiRes | null = null;
  const tConfirm = performance.now();
  for (let i = 0; i < 20; i++) {
    confirmed = await api('/api/launch/confirm', { body: { reservationId: p.reservationId, signature: launch.signature } });
    timed('api:confirm', confirmed.ms);
    if (confirmed.status !== 202) break;
    await sleep(1500);
  }
  check(confirmed?.status === 200 && confirmed.json?.status === 'registered', 'POST /api/launch/confirm → registered', `HTTP ${confirmed?.status} after ${Math.round(performance.now() - tConfirm)} ms`);
  const launchMs = Math.round(performance.now() - tLaunch);
  report.timings.launchTotalMs = launchMs;
  check(launchMs <= 12_000, 'launch click → registered ≤ 12 s (p95 budget; no wallet approval here)', `${launchMs} ms`);
  const coin = confirmed!.json.coin;
  check(coin.mint === mint.publicKey.toBase58() && coin.placeId === PLACE_ID && coin.vault === p.vault && coin.ticker === 'CAFE', 'registered coin fields', `${coin.ticker} ${coin.mint}`);
  report.mint = coin.mint;
  const placeRes = await api(`/api/place/${encodeURIComponent(PLACE_ID)}`);
  check(placeRes.json?.coin?.mint === coin.mint, '/api/place/:placeId returns the coin');
  const byMint = await api(`/api/coins?mints=${coin.mint}`);
  check(byMint.json?.coins?.[0]?.mint === coin.mint, '/api/coins?mints= returns the coin');
  const vs = sv.decodeVaultState((await acct(new PublicKey(p.vaultState))).data);
  check(vs.mint.toBase58() === coin.mint && vs.launcher.equals(launcher.publicKey) && sv.toHex(vs.placeHash) === p.placeHash, 'on chain: VaultState(mint, launcher, place_hash)');
  const curve0 = sv.decodeBondingCurvePrefix((await acct(sv.bondingCurvePda(mint.publicKey))).data);
  check(curve0.creator.toBase58() === p.vault, 'on chain: bonding_curve.creator = vault');
  const events = tradeEvents(launch.meta);
  check(events.length === (DEV_BUY > 0n ? 1 : 0), 'dev buy TradeEvent present', `${events.length}`);

  // ----------------------------------------------------------------------------------------------- 2 duplicate
  section('3 · duplicate launch → 409 taken');
  const meta2 = await uploadMetadata('Second launch attempt for the same place.');
  check(meta2.status === 200, 'second metadata upload');
  const dup = await api('/api/launch/prepare', { body: { ...prepBody, mint: Keypair.generate().publicKey.toBase58(), metadataId: meta2.json.metadataId } });
  check(dup.status === 409 && dup.json?.error === 'taken' && dup.json?.existing?.mint === coin.mint, 'prepare for a launched place → 409 taken (existing = our coin)', `HTTP ${dup.status} ${dup.json?.error ?? ''}`);

  // ----------------------------------------------------------------------------------------------- 3 trades
  section('4 · trades (curve v3) + indexing');
  const { global, feeConfig } = { global: await online.fetchGlobal(), feeConfig: await online.fetchFeeConfig() };
  const t0Feed = Date.now() - 2000;
  const tradeSigs: string[] = [];
  {
    const st = await online.fetchBuyState(mint.publicKey, buyer.publicKey, sv.TOKEN_2022_PROGRAM_ID);
    const q = new BN(BUY.toString());
    const amount = pump.getBuyV3TokenAmountFromQuoteAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: q, curveBaseTokenBalance: st.curveBaseTokenBalance });
    const ixs = await sdk.buyExactQuoteInV3Instructions({ bondingCurve: st.bondingCurve, associatedUserAccountInfo: st.associatedUserAccountInfo, mint: mint.publicKey, user: buyer.publicKey, amount, quoteAmount: q, slippage: 2, tokenProgram: sv.TOKEN_2022_PROGRAM_ID, buybackFeeRecipient: BUYBACK });
    const r = await sendAndConfirm(`buy ${fmtSol(BUY)}`, await build(buyer.publicKey, [cuLimit(200_000), cuPrice(), ...ixs], [buyer]));
    events.push(...tradeEvents(r.meta));
    tradeSigs.push(r.signature);
  }
  {
    const ata = sv.associatedTokenAddress(buyer.publicKey, mint.publicKey, sv.TOKEN_2022_PROGRAM_ID);
    const raw = BigInt((await conn.getTokenAccountBalance(ata, 'confirmed')).value.amount);
    const half = raw / 2n;
    const st = await online.fetchSellState(mint.publicKey, buyer.publicKey, sv.TOKEN_2022_PROGRAM_ID);
    const amount = new BN(half.toString());
    const out = pump.getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount });
    const ixs = await sdk.sellV3Instructions({ bondingCurve: st.bondingCurve, mint: mint.publicKey, user: buyer.publicKey, amount, quoteAmount: out, slippage: 2, tokenProgram: sv.TOKEN_2022_PROGRAM_ID, buybackFeeRecipient: BUYBACK });
    const r = await sendAndConfirm('sell 50% (exact raw units)', await build(buyer.publicKey, [cuLimit(200_000), cuPrice(), ...ixs], [buyer]));
    events.push(...tradeEvents(r.meta));
    tradeSigs.push(r.signature);
  }
  for (const sig of tradeSigs) {
    const ix = await api('/api/index/tx', { body: { signature: sig } });
    timed('api:index', ix.ms);
    check(ix.status === 200 && ix.json?.indexed >= 1, 'POST /api/index/tx', `indexed ${ix.json?.indexed ?? ix.status}`);
  }
  {
    const t = performance.now();
    let seen = 0;
    while (performance.now() - t < 5000) {
      const f = await api(`/api/feed?since=${t0Feed}&limit=50`);
      seen = tradeSigs.filter((s) => (f.json?.events ?? []).some((e: any) => e.kind === 'trade' && e.id.startsWith(`${s}:`))).length;
      if (seen === tradeSigs.length) break;
      await sleep(700);
    }
    check(seen === tradeSigs.length, 'both trades in /api/feed within 5 s', `${seen}/${tradeSigs.length} after ${Math.round(performance.now() - t)} ms`);
  }
  check(events.every((e) => e.creator === p.vault && e.creatorFee > 0n), 'every TradeEvent pays the vault a creator fee');
  const sumFees = events.reduce((s, e) => s + e.creatorFee, 0n);
  report.creatorFeesLamports = sumFees;

  section('5 · fees waiting (exact)');
  const { res: fresh, chain: chain5 } = await feesAgainstChain(mint.publicKey, p.vault);
  timed('api:coin-fresh', fresh.ms);
  check(fresh.status === 200, 'GET /api/coins/:mint?fresh=1', `${fresh.ms} ms`);
  check(chain5.sum - chain5.foreign.reduce((s, e) => s + e.creatorFee, 0n) === sumFees, 'on chain: our TradeEvents found', `${sumFees}`);
  if (chain5.foreign.length) note(`${chain5.foreign.length} trade(s) by other wallets (devnet bots) paid the vault too`);
  check(fresh.json.fees.waitingLamports === chain5.sum.toString(), 'fees.waiting == Σ TradeEvent.creator_fee (every trader)', `${fresh.json.fees.waitingLamports} vs ${chain5.sum}`);
  const curveRaw = (await acct(sv.bondingCurvePda(mint.publicKey))).data;
  const realSol = curveRaw.readBigUInt64LE(32);
  check(fresh.json.market.realSol === realSol.toString(), 'market.realSol == on-chain real_quote_reserves', `${fresh.json.market.realSol}`);
  check(fresh.json.trades.some((t: any) => t.sig === tradeSigs[0]), 'detail.trades includes our buy');

  // ----------------------------------------------------------------------------------------------- 4 claim
  section('6 · claim → finalize → withdraw');
  const st0 = await api(`/api/claim/status?placeId=${encodeURIComponent(PLACE_ID)}`);
  check(st0.json?.owner?.status === 'unclaimed', 'claim status: unclaimed');
  const call = await api('/api/claim/call', { body: { placeId: PLACE_ID } });
  check(call.status === 200 && call.json?.channel === 'screen' && /^\d{6}$/.test(call.json?.devCode ?? ''), 'POST /api/claim/call → devnet screen code', `HTTP ${call.status} ${call.json?.error ?? ''}`);
  const wrong = call.json.devCode.slice(0, 5) + String((Number(call.json.devCode[5]) + 1) % 10);
  const w = await api('/api/claim/check', { body: { claimId: call.json.claimId, code: wrong } });
  check(w.json?.approved === false && w.json?.attemptsLeft === 2, 'a wrong code → attemptsLeft 2', JSON.stringify(w.json));
  const okc = await api('/api/claim/check', { body: { claimId: call.json.claimId, code: call.json.devCode } });
  check(okc.json?.approved === true && okc.json?.claimToken, 'the right code → claimToken');
  const vsNow = sv.decodeVaultState((await acct(new PublicKey(p.vaultState))).data);
  const nonce = vsNow.claimNonce + 1n;
  const claimTx = await build(owner.publicKey, [cuLimit(30_000), cuPrice(), sv.requestClaim({ attestor: new PublicKey(cfg.attestor), newOwner: owner.publicKey, placeHash, nonce })]);
  const ccos = await api('/api/claim/cosign', { body: { claimId: call.json.claimId, claimToken: okc.json.claimToken, newOwner: owner.publicKey.toBase58(), messageBase64: Buffer.from(claimTx.tx.message.serialize()).toString('base64') } });
  check(ccos.status === 200 && ccos.json?.expectedNonce === nonce.toString(), 'POST /api/claim/cosign', `HTTP ${ccos.status} ${ccos.json?.error ?? ''} ${(ccos.json?.violations ?? []).join('; ')}`);
  claimTx.tx.addSignature(new PublicKey(ccos.json.attestor), Buffer.from(ccos.json.attestorSignature, 'base64'));
  claimTx.tx.sign([owner]);
  const reqc = await sendAndConfirm('request_claim', claimTx);
  let cc: ApiRes | null = null;
  for (let i = 0; i < 20; i++) {
    cc = await api('/api/claim/confirm', { body: { claimId: call.json.claimId, signature: reqc.signature } });
    if (cc.status !== 202) break;
    await sleep(1500);
  }
  check(cc?.json?.status === 'pending_onchain' && cc.json.claimWindowSecs === cfg.claimWindowSecs, 'POST /api/claim/confirm → pending_onchain', JSON.stringify(cc?.json));
  const unlockTs = BigInt(cc!.json.unlockTs);
  const st1 = await api(`/api/claim/status?placeId=${encodeURIComponent(PLACE_ID)}`);
  check(st1.json?.owner?.status === 'pending' && st1.json?.owner?.pendingOwner === owner.publicKey.toBase58(), 'claim status: pending for our owner');

  process.stdout.write(`  · waiting for chain time ≥ unlock_ts ${unlockTs} `);
  for (;;) {
    const clock = await acct(web3.SYSVAR_CLOCK_PUBKEY);
    const now = clock.data.readBigInt64LE(32);
    if (now > unlockTs) break;
    process.stdout.write('.');
    await sleep(Math.min(5000, Number(unlockTs + 1n - now) * 1000));
  }
  console.log('');
  let finalizedBy = 'cron';
  {
    const t = performance.now();
    let ownerSet = false;
    while (performance.now() - t < CRON_WAIT_SEC * 1000) {
      const v = sv.decodeVaultState((await acct(new PublicKey(p.vaultState))).data);
      if (v.owner?.equals(owner.publicKey)) {
        ownerSet = true;
        break;
      }
      await sleep(5000);
    }
    if (!ownerSet) {
      finalizedBy = 'e2e (cron did not finalize in time)';
      await sendAndConfirm('finalize_claim (fallback)', await build(owner.publicKey, [sv.finalizeClaim({ placeHash })], [owner]));
    }
    report.finalizedBy = finalizedBy;
    const after = `${Math.round((performance.now() - t) / 1000)} s after unlock`;
    if (finalizedBy === 'cron') check(true, 'claim finalized by the Worker cron', after);
    else note(`claim finalized by the e2e: the cron did not finalize within ${CRON_WAIT_SEC} s (check the indexer)`);
  }

  const vault = new PublicKey(p.vault);
  const rent0 = BigInt(await conn.getMinimumBalanceForRentExemption(0));
  const { res: pre, chain: chain6 } = await feesAgainstChain(mint.publicKey, p.vault);
  check(pre.json.owner.status === 'claimed' && pre.json.owner.owner === owner.publicKey.toBase58(), 'API: owner claimed');
  const expected = BigInt(pre.json.fees.waitingLamports);
  if (chain6.foreign.length) note(`${chain6.foreign.length} trade(s) by other wallets (devnet bots) paid the vault so far`);
  check(expected === chain6.sum, 'fees waiting before withdraw == Σ creator fees (every trader)', `${expected}`);
  const bucket = sv.decodeBondingCurvePrefix((await acct(sv.bondingCurvePda(mint.publicKey))).data).creatorFeeBucket ?? 0n;
  const collect = new TransactionInstruction({
    programId: pump.PUMP_PROGRAM_ID,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: sv.pumpCreatorVaultPda(vault), isSigner: false, isWritable: true },
      { pubkey: sv.SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: pump.PUMP_EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false },
      { pubkey: pump.PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: COLLECT_CREATOR_FEE,
  });
  const wixs = [cuLimit(200_000), cuPrice()];
  if (bucket > 0n) wixs.push(await sdk.sweepCreatorFeeInstruction({ payer: deployer.publicKey, mint: mint.publicKey, creator: vault, quoteMint: sv.NATIVE_MINT }));
  wixs.push(collect, sv.withdraw({ owner: owner.publicKey, placeHash }));
  const ownerBefore = await bal(owner.publicKey);
  const wd = await sendAndConfirm('collect + withdraw (owner signs, relayer pays the fee)', await build(deployer.publicKey, wixs, [deployer, owner]));
  const paid = (await bal(owner.publicKey)) - ownerBefore;
  const upToWithdraw = (await chainCreatorFees(mint.publicKey, p.vault, wd.slot)).sum;
  check(paid === upToWithdraw, 'owner received exactly Σ creator fees', `${paid} lamports`);
  check(BigInt((await acct(vault)).lamports) === rent0, 'vault left at rent_min(0)');
  const post = await api(`/api/coins/${coin.mint}?fresh=1`);
  const f = post.json.fees;
  check(f.withdrawnLamports === paid.toString(), 'API: withdrawn = payout', `${f.withdrawnLamports}`);
  check(BigInt(f.waitingLamports) === (await chainCreatorFees(mint.publicKey, p.vault)).sum - paid, 'API: waiting = fees since the withdraw (0 unless a bot traded)', `${f.waitingLamports}`);
  check(BigInt(f.earnedLamports) === BigInt(f.withdrawnLamports) + BigInt(f.waitingLamports), 'API: earned = withdrawn + waiting');

  // ----------------------------------------------------------------------------------------------- 5 graduation
  if (GRADUATE) {
    section('7 · graduation (GRADUATE=1)');
    const st = await online.fetchBuyState(mint.publicKey, buyer.publicKey, sv.TOKEN_2022_PROGRAM_ID);
    const remaining = st.bondingCurve.realTokenReserves;
    const cost = pump.getBuyV3QuoteAmountFromTokenAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: remaining, curveBaseTokenBalance: st.curveBaseTokenBalance });
    note(`buying the remaining ${remaining.toString()} base units for ~${fmtSol(BigInt(cost.toString()))}`);
    const ixs = await sdk.buyV3Instructions({ bondingCurve: st.bondingCurve, associatedUserAccountInfo: st.associatedUserAccountInfo, mint: mint.publicKey, user: buyer.publicKey, amount: remaining, quoteAmount: cost, slippage: 2, tokenProgram: sv.TOKEN_2022_PROGRAM_ID, buybackFeeRecipient: BUYBACK });
    const g = await sendAndConfirm('buy out the curve', await build(buyer.publicKey, [cuLimit(400_000), cuPrice(), ...ixs], [buyer]));
    await api('/api/index/tx', { body: { signature: g.signature } });
    const pool = pump.canonicalPumpPoolPda(mint.publicKey);
    process.stdout.write(`  · waiting ≤ ${GRADUATE_WAIT_MIN} min for the migration bot (pool ${pool.toBase58()}) and the indexer `);
    let graduated = false;
    const t = performance.now();
    while (performance.now() - t < GRADUATE_WAIT_MIN * 60_000) {
      const d = await api(`/api/coins/${coin.mint}?fresh=1`);
      if (d.json?.graduated && d.json?.pool === pool.toBase58()) {
        graduated = true;
        break;
      }
      process.stdout.write('.');
      await sleep(20_000);
    }
    console.log('');
    check(graduated, 'API: graduated with the canonical pool', `${Math.round((performance.now() - t) / 1000)} s`);
    const amm: any = req('@pump-fun/pump-swap-sdk');
    const ammOnline = new amm.OnlinePumpAmmSdk(conn);
    const ammSdk = new amm.PumpAmmSdk();
    const s1 = await ammOnline.swapSolanaState(pool, buyer.publicKey);
    const bix = await ammSdk.buyQuoteInput(s1, new BN(lamports('0.02').toString()), 2);
    const ab = await sendAndConfirm('PumpSwap buy 0.02 SOL', await build(buyer.publicKey, [cuLimit(300_000), cuPrice(), ...bix], [buyer]));
    const ata = sv.associatedTokenAddress(buyer.publicKey, mint.publicKey, sv.TOKEN_2022_PROGRAM_ID);
    const raw = BigInt((await conn.getTokenAccountBalance(ata, 'confirmed')).value.amount);
    const s2 = await ammOnline.swapSolanaState(pool, buyer.publicKey);
    const six = await ammSdk.sellBaseInput(s2, new BN((raw / 10n).toString()), 2);
    const as = await sendAndConfirm('PumpSwap sell 10%', await build(buyer.publicKey, [cuLimit(300_000), cuPrice(), ...six], [buyer]));
    for (const sig of [ab.signature, as.signature]) {
      const ix = await api('/api/index/tx', { body: { signature: sig } });
      check(ix.json?.indexed >= 1, 'AMM trade indexed', sig);
    }
    const m = await api(`/api/market?mints=${coin.mint}`);
    check(m.json?.quotes?.[coin.mint]?.venue === 'amm', '/api/market venue = amm');
    report.graduation = { pool: pool.toBase58(), ammEvents: [...tradeEvents(ab.meta), ...tradeEvents(as.meta)] };
  }

  report.passed = true;
}

main()
  .then(() => {
    writeReport();
    const failed = report.checks.filter((c: any) => !c.ok).length;
    console.log(`\nE2E ${EXECUTE ? '' : 'DRY RUN '}${failed ? 'FAILED' : 'PASSED'} (${report.checks.length} checks)`);
    process.exit(failed ? 1 : 0);
  })
  .catch((e) => {
    report.passed = false;
    report.error = String(e?.message ?? e);
    writeReport();
    console.error(`\nE2E FAILED: ${e?.message ?? e}`);
    process.exit(1);
  });
