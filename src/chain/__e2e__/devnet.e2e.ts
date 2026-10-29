/**
 * DEVNET end-to-end for the chain layer (src/chain) — launch → buy → sell → exact fees in the vault → claim →
 * finalize → collect + withdraw, using the SAME code the browser runs (launchCoin, quoteBuy/buy, quoteSell/sell,
 * getVault, requestClaim, finalizeClaim, collectAndWithdraw). Only the Worker is replaced by `LocalBackend`, which
 * decodes each message itself, runs the SPEC §8.4 policy and co-signs with .keys/devnet-attestor.json in-process.
 *
 *   CHAIN_E2E=devnet npx vitest run --config src/chain/__e2e__/vitest.config.ts
 *
 * Safety:
 *  - Refuses to run unless the RPC's genesis hash is DEVNET (mainnet is refused outright). Sends only devnet txs.
 *  - RPC = Alchemy devnet with ALCHEMY_API_KEY read in-process from .env.server (or RPC_URL); only the origin is ever
 *    printed, and every printed/recorded string passes `redact()`.
 *  - Traders are EPHEMERAL in-memory keypairs funded from .keys/devnet-deployer.json (≈0.2 SOL in flight) and swept
 *    back at the end, so runs never collide with the shop-vault e2e (which uses launcher/buyer/owner). No secret is
 *    printed or written.
 *  - Report (public data only: addresses, signatures, amounts, timings): src/chain/__e2e__/out/devnet-<time>.json.
 *
 * Env: CHAIN_E2E=devnet (required) · ALT_ADDRESS (else deploy/devnet.json, else programs/shop-vault/scripts/out/
 * devnet-state.json) · DEV_BUY_SOL (0.01) · BUY_SOL (0.05) · CLAIM=0 to stop after the vault check.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import * as sv from '@cornershop/shop-vault-client';
import type { ConfigResponse } from '../../../worker/wire';
import {
  buy,
  collectAndWithdraw,
  estimateLaunchCost,
  finalizeClaim,
  getVault,
  initChain,
  launchCoin,
  quoteBuy,
  quoteSell,
  requestClaim,
  sell,
} from '../index';
import { ALT_KEYS, GENESIS, MAX_PRICE_IMPACT_PCT } from '../constants';
import { decodeBondingCurve, curvePrice } from '../curve';
import { pumpTradeEvents } from '../events';
import { b64ToBytes, getBalance, getMultipleAccountsRaw, getToken2022Holdings, rpc, setRpcEndpoint } from '../rpc';
import { executeWithRetry, fetchTx, latestBlockhash } from '../send';
import type { OnProgress, TxOutcome } from '../types';
import { keypairSigner, LocalBackend } from './helpers';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RUN = process.env.CHAIN_E2E === 'devnet';
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
const OUT_DIR = join(ROOT, 'src/chain/__e2e__/out');
const PUBLIC_ORIGIN = 'https://cornershop-devnet.tiejiucai.workers.dev';
const SOL = 1_000_000_000n;
const sol = (s: string) => BigInt(Math.round(Number(s) * 1e9));
const DEV_BUY = sol(process.env.DEV_BUY_SOL ?? '0.01');
const BUY = sol(process.env.BUY_SOL ?? '0.05');
const DO_CLAIM = process.env.CLAIM !== '0';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------------------------------ secrets hygiene */

let secretKey = '';
function rpcUrl(): string {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  const env = readFileSync(join(ROOT, '.env.server'), 'utf8');
  const m = /^ALCHEMY_API_KEY=(.+)$/m.exec(env);
  if (!m) throw new Error('ALCHEMY_API_KEY missing from .env.server (or set RPC_URL)');
  secretKey = m[1].trim().replace(/^["']|["']$/g, '');
  return `https://solana-devnet.g.alchemy.com/v2/${secretKey}`;
}
function redact(s: unknown): string {
  let out = typeof s === 'string' ? s : JSON.stringify(s, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (secretKey) out = out.split(secretKey).join('[redacted]');
  return out.replace(/\/v2\/[A-Za-z0-9_-]{8,}/g, '/v2/[redacted]');
}
const log = (...a: unknown[]) => console.log(a.map(redact).join(' '));

function loadKey(name: string): Keypair {
  const file = join(ROOT, '.keys', `devnet-${name}.json`);
  if (!existsSync(file)) throw new Error(`missing .keys/devnet-${name}.json`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8')) as number[]));
}

function altAddress(): string {
  if (process.env.ALT_ADDRESS) return process.env.ALT_ADDRESS;
  for (const f of ['deploy/devnet.json', 'programs/shop-vault/scripts/out/devnet-state.json']) {
    const p = join(ROOT, f);
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, 'utf8')) as { alt?: string };
      if (j.alt) return j.alt;
    }
  }
  throw new Error('no devnet ALT address (deploy/devnet.json or ALT_ADDRESS)');
}

/* ------------------------------------------------------------------------------------------ report */

const report: Record<string, unknown> & { steps: unknown[]; checks: string[]; timings: Record<string, number>; rpcCalls: Record<string, number> } = {
  startedAt: new Date().toISOString(),
  cluster: 'devnet',
  steps: [],
  checks: [],
  timings: {},
  rpcCalls: {},
};
function check(cond: unknown, what: string): void {
  report.checks.push(`${cond ? 'ok' : 'FAILED'}: ${what}`);
  log(`${cond ? '  ok ' : 'FAIL '} ${what}`);
  expect(cond, what).toBeTruthy();
}
function writeReport(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `devnet-${STAMP}.json`);
  report.finishedAt = new Date().toISOString();
  writeFileSync(file, redact(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)));
  log(`report: ${file}`);
}

/* ------------------------------------------------------------------------------------------ rpc counting */

let rpcHttpCalls = 0;
const countingFetch: typeof fetch = (input, init) => {
  rpcHttpCalls++;
  return fetch(input, init);
};
async function measured<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const c0 = rpcHttpCalls;
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    report.timings[name] = Math.round(performance.now() - t0);
    report.rpcCalls[name] = rpcHttpCalls - c0;
  }
}

function progressLog(label: string): OnProgress {
  let last = '';
  return (p) => {
    const line = `${p.phase}${p.step ? `:${p.step}` : ''}`;
    if (line !== last) {
      last = line;
      log(`    ${label} → ${line}${p.signature ? ` ${p.signature.slice(0, 12)}…` : ''}`);
    }
  };
}

function okOrThrow<T>(label: string, r: TxOutcome<T>): Extract<TxOutcome<T>, { ok: true }> {
  if (!r.ok) {
    report.steps.push({ step: label, ok: false, error: r.error });
    throw new Error(`${label} failed: ${redact(r.error)}`);
  }
  report.steps.push({ step: label, ok: true, signature: r.signature, explorer: r.explorerUrl });
  log(`  ${label}: ${r.explorerUrl}`);
  return r;
}

async function chainTime(): Promise<bigint> {
  const r = await rpc<{ value: { data: [string, string] } }>('getAccountInfo', ['SysvarC1ock11111111111111111111111111111111', { encoding: 'base64' }]);
  const d = b64ToBytes(r.value.data[0]);
  return new DataView(d.buffer, d.byteOffset).getBigInt64(32, true);
}

/** 1×1 PNG (the e2e's coin image; the LocalBackend content-addresses it). */
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

/* ------------------------------------------------------------------------------------------ the run */

test.skipIf(!RUN)(
  'devnet: launch → buy → sell → vault fees → claim → finalize → withdraw (src/chain builders)',
  async () => {
    const url = rpcUrl();
    log(`chain e2e · devnet · ${new URL(url).origin}`);
    setRpcEndpoint(url, countingFetch);

    // 0. Guards.
    const genesis = await rpc<string>('getGenesisHash');
    if (genesis === GENESIS.mainnet) throw new Error('this RPC is MAINNET: refusing');
    if (genesis !== GENESIS.devnet) throw new Error(`genesis ${genesis} is not devnet`);
    check(true, 'genesis hash is devnet');
    const [prog, cfgAcc] = await getMultipleAccountsRaw([sv.SHOP_VAULT_PROGRAM_ID.toBase58(), sv.configPda()[0].toBase58()]);
    if (!prog?.executable) throw new Error('shop-vault is not deployed on devnet: run the OPS deploy first');
    if (!cfgAcc) throw new Error('shop-vault Config is not initialised on devnet');
    const chainCfg = sv.decodeConfig(cfgAcc.data);
    const attestor = loadKey('attestor');
    const deployer = loadKey('deployer');
    check(chainCfg.attestor.equals(attestor.publicKey), 'Config.attestor == .keys/devnet-attestor');
    check(chainCfg.flavor === 'devnet' && !chainCfg.paused, 'Config: devnet flavour, launches not paused');

    const altAddr = altAddress();
    const altRes = await rpc<{ value: { data: [string, string] } | null }>('getAccountInfo', [altAddr, { encoding: 'base64' }]);
    if (!altRes.value) throw new Error(`ALT ${altAddr} not found`);
    const alt = new AddressLookupTableAccount({ key: new PublicKey(altAddr), state: AddressLookupTableAccount.deserialize(b64ToBytes(altRes.value.data[0])) });
    check(alt.state.addresses.map((k) => k.toBase58()).join() === ALT_KEYS.join() && alt.state.authority === undefined, 'ALT holds exactly the 14 ALT_KEYS and is frozen');

    // pump Global → curve constants for the config.
    const req = createRequire(import.meta.url);
    const pump = req('@pump-fun/pump-sdk');
    const BN = req('bn.js');
    const [globalAcc] = await getMultipleAccountsRaw([pump.GLOBAL_PDA.toBase58()]);
    const global = pump.PUMP_SDK.decodeGlobal({ data: Buffer.from(globalAcc!.data), owner: pump.PUMP_PROGRAM_ID, lamports: 0, executable: false });

    const config: ConfigResponse = {
      cluster: 'devnet',
      genesisHash: GENESIS.devnet,
      publicOrigin: PUBLIC_ORIGIN,
      programId: sv.SHOP_VAULT_PROGRAM_ID.toBase58(),
      configPda: sv.configPda()[0].toBase58(),
      alt: altAddr,
      attestor: attestor.publicKey.toBase58(),
      claimWindowSecs: Number(chainCfg.claimWindowSecs),
      launchesPaused: chainCfg.paused,
      probationUntil: Number(chainCfg.probationUntil),
      maxDevBuyLamports: (1n * SOL).toString(),
      priorityFeeMicroLamports: 10_000,
      curve: {
        initialVirtualTokenReserves: global.initialVirtualTokenReserves.toString(),
        initialVirtualQuoteReserves: global.initialVirtualSolReserves.toString(), // SOL curves seed from initialVirtualSolReserves
        initialRealTokenReserves: global.initialRealTokenReserves.toString(),
        tokenTotalSupply: global.tokenTotalSupply.toString(),
      },
      solUsd: null,
      solUsdAt: null,
      features: { testWallet: false, faucet: false, privy: false, phoneVerification: 'screen', turnstileSiteKey: null, jupiter: false, websiteVerification: false },
      explorer: { tx: 'https://solscan.io/tx/{sig}?cluster=devnet', address: 'https://solscan.io/account/{address}?cluster=devnet', token: 'https://solscan.io/token/{mint}?cluster=devnet' },
      buildId: `chain-e2e-${STAMP}`,
    };
    let launchMsgSize = 0;
    const backend = new LocalBackend({
      attestor,
      publicOrigin: PUBLIC_ORIGIN,
      alt,
      maxDevBuyLamports: 1n * SOL,
      priorityFeeMicroLamports: 10_000,
      onLaunchMessage: (size, v) => {
        launchMsgSize = size;
        if (v.length) log('    policy violations:', v);
      },
    });
    initChain(config, { rpcUrl: url, backend, pumpSdk: pump });
    setRpcEndpoint(url, countingFetch); // keep counting HTTP calls

    // 1. Ephemeral traders funded from the deployer.
    const launcher = Keypair.generate();
    const buyer = Keypair.generate();
    const owner = Keypair.generate();
    report.keys = { deployer: deployer.publicKey.toBase58(), attestor: attestor.publicKey.toBase58(), launcher: launcher.publicKey.toBase58(), buyer: buyer.publicKey.toBase58(), owner: owner.publicKey.toBase58() };
    const fund: [Keypair, bigint][] = [
      [launcher, DEV_BUY + sol('0.03')],
      [buyer, BUY + sol('0.02')],
      [owner, sol('0.005')],
    ];
    const deployerBal = await getBalance(deployer.publicKey.toBase58());
    const need = fund.reduce((s, [, l]) => s + l, 0n) + sol('0.01');
    if (deployerBal < need) throw new Error(`deployer ${deployer.publicKey.toBase58()} has ${deployerBal} lamports, needs ${need}`);
    const deployerSigner = keypairSigner(deployer, 'Deployer');
    const funded = await executeWithRetry(async () => {
      const bh = await latestBlockhash();
      const msg = new TransactionMessage({
        payerKey: deployer.publicKey,
        recentBlockhash: bh.blockhash,
        instructions: fund.map(([kp, l]) => SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: l })),
      }).compileToV0Message();
      return { tx: new VersionedTransaction(msg), lastValidBlockHeight: bh.lastValidBlockHeight };
    }, deployerSigner, () => {});
    report.steps.push({ step: 'fund ephemeral launcher/buyer/owner from the deployer', ok: true, signature: funded.signature });
    log(`  funded ${fund.map(([k, l]) => `${k.publicKey.toBase58().slice(0, 6)}…=${l}`).join(' ')}`);

    const placeId = `cornershop-test:chain-e2e-${STAMP.toLowerCase()}`;
    report.placeId = placeId;
    try {
      // 2. Launch.
      const name = 'Chain E2E Cafe';
      const ticker = 'CHAIN';
      const est = await measured('estimateLaunchCost', () =>
        estimateLaunchCost(DEV_BUY, { name, symbol: ticker, uri: `${PUBLIC_ORIGIN}/meta/${'0'.repeat(32)}.json`, launcher: launcher.publicKey.toBase58() }),
      );
      const launcherBefore = await getBalance(launcher.publicKey.toBase58());
      const launch = okOrThrow(
        'launchCoin (create_v2 + register_launch + dev buy, co-signed, via ALT)',
        await measured('launch', () =>
          launchCoin(
            { placeId, name, ticker, description: 'src/chain devnet e2e', category: 'cafe', emoji: '☕', bg: '#7b4fd5', image: new Blob([PNG], { type: 'image/png' }), devBuyLamports: DEV_BUY },
            keypairSigner(launcher, 'Launcher'),
            progressLog('launch'),
          ),
        ),
      );
      const mint = launch.value.mint;
      report.mint = mint;
      const launcherSpent = launcherBefore - (await getBalance(launcher.publicKey.toBase58()));
      report.launch = { signature: launch.signature, txBytes: launchMsgSize, estimate: est, launcherSpent, devBuy: launch.value.devBuy };
      check(launchMsgSize > 0 && launchMsgSize <= 1232, `launch tx is ${launchMsgSize} B (≤ 1,232 B, 3 signatures)`);
      check(est.totalLamports >= launcherSpent && est.totalLamports - launcherSpent <= 500_000n, `launch cost estimate ${est.totalLamports} ≥ actual ${launcherSpent} and within 0.0005 SOL (Δ ${est.totalLamports - launcherSpent})`);
      const worstCase = await estimateLaunchCost(DEV_BUY);
      check(worstCase.totalLamports >= launcherSpent, `worst-case estimate (unknown launcher, max name) ${worstCase.totalLamports} ≥ actual`);

      const ph = sv.placeHash(placeId);
      const [vault] = sv.vaultPda(ph);
      const [vaultStatePk] = sv.vaultStatePda(ph);
      const [stAcc, curveAcc, vaultAcc] = await getMultipleAccountsRaw([vaultStatePk.toBase58(), sv.bondingCurvePda(new PublicKey(mint)).toBase58(), vault.toBase58()]);
      const st = sv.decodeVaultState(stAcc!.data);
      check(st.mint.toBase58() === mint && st.launcher.equals(launcher.publicKey) && sv.toHex(st.placeHash) === sv.toHex(ph), 'VaultState: mint, launcher, place_hash');
      const curve = decodeBondingCurve(curveAcc!.data);
      check(curve.creator === vault.toBase58(), 'bonding_curve.creator == shop vault PDA');
      check(vaultAcc!.owner === '11111111111111111111111111111111' && vaultAcc!.data.length === 0, 'vault: system-owned, no data');

      const launchTx = await fetchTx(launch.signature);
      const devEv = pumpTradeEvents(launchTx!).filter((e) => e.mint === mint);
      check(devEv.length === 1 && launch.value.devBuy?.tokens === devEv[0].tokenAmount && !launch.value.devBuy?.estimated, 'dev-buy fill parsed exactly from the TradeEvent');
      check(launch.value.devBuy?.lamports === DEV_BUY, `dev buy spent exactly ${DEV_BUY} lamports (curve + fees)`);
      const events = [...devEv];

      // Duplicate launch for the same place → taken (Worker/registry check before anything is signed).
      const dup = await launchCoin(
        { placeId, name, ticker, description: '', category: 'cafe', emoji: '☕', bg: '#7b4fd5', image: new Blob([PNG], { type: 'image/png' }), devBuyLamports: 0n },
        keypairSigner(launcher, 'Launcher'),
        () => {},
      );
      check(!dup.ok && dup.error.code === 'taken' && !dup.error.sent, 'second launch for the same place → taken, nothing sent');

      // 3. Price + mcap formulas vs the SDK on the live curve.
      const price = curvePrice(curve);
      const sdkMcap = pump.bondingCurveMarketCap({
        mintSupply: new BN(curve.tokenTotalSupply.toString()),
        virtualQuoteReserves: new BN(curve.virtualQuoteReserves.toString()),
        virtualTokenReserves: new BN(curve.virtualTokenReserves.toString()),
      });
      check(price.mcapLamports.toString() === sdkMcap.toString(), `mcap ${price.mcapLamports} == pump SDK bondingCurveMarketCap`);

      // 4. Buy (quote exactly matches the fill: nobody else trades this fresh curve).
      const q = await measured('quoteBuy', () => quoteBuy(mint, BUY));
      check(q.venue === 'curve' && q.tokensOut > 0n && q.minTokensOut < q.tokensOut, `quoteBuy ${BUY} → ${q.tokensOut} tokens (min ${q.minTokensOut}, impact ${q.priceImpactPct.toFixed(3)}%)`);
      const bought = okOrThrow('buy (buy_exact_quote_in_v3)', await measured('buy', () => buy(q, keypairSigner(buyer, 'Buyer'), progressLog('buy'))));
      check(bought.value.tokens === q.tokensOut && bought.value.lamports === BUY && !bought.value.estimated, `buy fill == quote exactly (${bought.value.tokens} tokens for ${bought.value.lamports} lamports)`);
      events.push(...pumpTradeEvents((await fetchTx(bought.signature))!).filter((e) => e.mint === mint));

      // Price impact guard (no send).
      const big = await quoteBuy(mint, 5n * SOL);
      const refused = await buy(big, keypairSigner(buyer, 'Buyer'), () => {});
      check(big.priceImpactPct > MAX_PRICE_IMPACT_PCT && !refused.ok && refused.error.code === 'price-impact' && !refused.error.sent, `5 SOL buy refused before signing: impact ${big.priceImpactPct.toFixed(1)}% > ${MAX_PRICE_IMPACT_PCT}%`);

      // 5. Sell half the exact holding.
      const holding = (await getToken2022Holdings(buyer.publicKey.toBase58())).find((h) => h.mint === mint);
      check(holding?.amount === bought.value.tokens, `holding read back exactly (${holding?.amount})`);
      const half = holding!.amount / 2n;
      const sq = await measured('quoteSell', () => quoteSell(mint, half));
      const sold = okOrThrow('sell (sell_v3, half)', await measured('sell', () => sell(sq, keypairSigner(buyer, 'Buyer'), progressLog('sell'))));
      check(sold.value.lamports === sq.lamportsOut && sold.value.tokens === half, `sell fill == quote exactly (${sold.value.lamports} lamports)`);
      events.push(...pumpTradeEvents((await fetchTx(sold.signature))!).filter((e) => e.mint === mint));

      // 6. Fees waiting == Σ TradeEvent.creator_fee (exact lamports).
      const sumCreator = events.reduce((s, e) => s + e.creatorFee, 0n);
      const v = await measured('getVault', () => getVault(placeId, mint));
      report.fees = { sumCreatorFee: sumCreator, vault: v.fees, events: events.length };
      check(v.exists && v.mint === mint && v.owner === null && v.pendingOwner === null, 'getVault: registered, unclaimed');
      check(v.fees.total === sumCreator && v.fees.withdrawableNow === 0n, `fees waiting ${v.fees.total} == Σ creator fees ${sumCreator} (all still collectable)`);

      if (DO_CLAIM) {
        // 7. Claim (local backend = verified phone session) → finalize after the window → collect + withdraw.
        const session = backend.startVerifiedClaim(placeId);
        const t0 = await chainTime();
        const claim = okOrThrow('requestClaim (co-signed request_claim)', await measured('requestClaim', () => requestClaim({ placeId, ...session }, keypairSigner(owner, 'Owner'), progressLog('claim'))));
        check(claim.value.unlockTs >= Number(t0) + config.claimWindowSecs && claim.value.unlockTs <= Number(t0) + config.claimWindowSecs + 60, `unlockTs ≈ request + ${config.claimWindowSecs}s`);
        const early = await finalizeClaim(placeId, keypairSigner(owner, 'Owner'), () => {});
        check(!early.ok && early.error.code === 'claim' && !early.error.sent, `finalize inside the window refused in simulation: "${early.ok ? '' : early.error.message}"`);
        const notOwner = await collectAndWithdraw(placeId, keypairSigner(buyer, 'Buyer'), () => {}, mint);
        check(!notOwner.ok && notOwner.error.code === 'claim', 'withdraw by a non-owner refused before signing');
        log(`  waiting for chain time ≥ unlock ${claim.value.unlockTs}…`);
        while ((await chainTime()) < BigInt(claim.value.unlockTs)) await sleep(4000);
        okOrThrow('finalizeClaim', await measured('finalizeClaim', () => finalizeClaim(placeId, keypairSigner(owner, 'Owner'), progressLog('finalize'))));
        const v2 = await getVault(placeId, mint);
        check(v2.owner === owner.publicKey.toBase58() && v2.pendingOwner === null, 'VaultState.owner == owner after finalize');

        const ownerBefore = await getBalance(owner.publicKey.toBase58());
        const preW = await getVault(placeId, mint);
        // test-sized fees can be below the first withdraw's cost (pump creator_vault rent): the UI refuses that
        // (`uneconomic`), the e2e withdraws anyway to check the payout to the lamport
        const w = okOrThrow(
          'collectAndWithdraw (sweep + collect + withdraw, one tx)',
          await measured('withdraw', () => collectAndWithdraw(placeId, keypairSigner(owner, 'Owner'), progressLog('withdraw'), mint, { acceptLoss: true })),
        );
        check(w.value.feeLamports === preW.withdrawCostLamports, `reported cost ${w.value.feeLamports} == predicted ${preW.withdrawCostLamports}`);
        const wtx = await fetchTx(w.signature);
        const ownerAfter = await getBalance(owner.publicKey.toBase58());
        check(w.value.withdrawnLamports === sumCreator, `withdrawn ${w.value.withdrawnLamports} == Σ creator fees ${sumCreator} (exact)`);
        check(w.value.lamports === ownerAfter - ownerBefore, `reported received ${w.value.lamports} == owner balance delta ${ownerAfter - ownerBefore}`);
        const ownerCost = (w.value.withdrawnLamports ?? 0n) - (ownerAfter - ownerBefore);
        check(ownerCost === preW.withdrawCostLamports, `owner paid exactly the predicted withdraw cost ${preW.withdrawCostLamports} (tx fee ${wtx!.meta!.fee} + one-time pump creator_vault rent)`);
        const v3 = await getVault(placeId, mint);
        check(v3.fees.total === 0n && v3.totalWithdrawn === sumCreator, 'vault drained to rent, total_withdrawn updated');
        report.withdraw = { signature: w.signature, lamports: w.value.withdrawnLamports, received: w.value.lamports };
      }
      report.passed = true;
    } finally {
      // 8. Sweep leftovers back to the deployer (ephemeral keys only).
      for (const kp of [launcher, buyer, owner]) {
        try {
          const bal = await getBalance(kp.publicKey.toBase58());
          if (bal <= 10_000n) continue;
          await executeWithRetry(async () => {
            const bh = await latestBlockhash();
            const msg = new TransactionMessage({
              payerKey: kp.publicKey,
              recentBlockhash: bh.blockhash,
              instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: deployer.publicKey, lamports: bal - 5000n })],
            }).compileToV0Message();
            return { tx: new VersionedTransaction(msg), lastValidBlockHeight: bh.lastValidBlockHeight };
          }, keypairSigner(kp), () => {});
        } catch (e) {
          log(`  (sweep of ${kp.publicKey.toBase58().slice(0, 6)}… skipped: ${redact((e as Error).message)})`);
        }
      }
      writeReport();
    }
  },
  20 * 60_000,
);

/**
 * Graduated coins (P1, read-only): quote + simulate on a real canonical PumpSwap pool. Nothing is sent: the signer
 * declines at the wallet prompt, which the flow only reaches after the simulation passed. The payer is the funded
 * deployer address (simulation runs without signature checks).
 */
test.skipIf(!RUN)(
  'devnet: PumpSwap quote + simulated buy/sell on a graduated coin (no sends)',
  async () => {
    const url = rpcUrl();
    setRpcEndpoint(url, countingFetch);
    if ((await rpc<string>('getGenesisHash')) !== GENESIS.devnet) throw new Error('not devnet');
    const fx = JSON.parse(readFileSync(join(ROOT, 'src/chain/__fixtures__/devnet.json'), 'utf8')) as { amm: { baseMint: { address: string }; pool: string } | null };
    const mint = process.env.AMM_MINT ?? fx.amm?.baseMint.address;
    if (!mint) throw new Error('no graduated devnet coin known (set AMM_MINT)');
    const req = createRequire(import.meta.url);
    initChain(
      {
        cluster: 'devnet',
        genesisHash: GENESIS.devnet,
        publicOrigin: PUBLIC_ORIGIN,
        priorityFeeMicroLamports: 10_000,
        attestor: loadKey('attestor').publicKey.toBase58(),
        alt: altAddress(),
        maxDevBuyLamports: SOL.toString(),
        explorer: { tx: 'https://solscan.io/tx/{sig}?cluster=devnet', address: 'https://solscan.io/account/{address}?cluster=devnet', token: 'https://solscan.io/token/{mint}?cluster=devnet' },
      } as unknown as ConfigResponse,
      { rpcUrl: url, pumpSdk: req('@pump-fun/pump-sdk'), backend: { indexTx: async () => null } as never },
    );
    setRpcEndpoint(url, countingFetch);
    const payer = loadKey('deployer').publicKey.toBase58();
    const declining = { address: payer, walletName: 'Declining', chain: 'solana:devnet' as const, signTransaction: async () => Promise.reject({ code: 4001, message: 'User rejected the request.' }) };

    const q = await measured('ammQuoteBuy', () => quoteBuy(mint, 10_000_000n));
    report.amm = { mint, quote: { venue: q.venue, tokensOut: q.tokensOut, minTokensOut: q.minTokensOut, priceBefore: q.priceBefore, priceAfter: q.priceAfter, impact: q.priceImpactPct } };
    check(q.venue === 'amm' && q.tokensOut > 0n && q.minTokensOut > 0n && q.minTokensOut < q.tokensOut, `PumpSwap quote: 0.01 SOL → ${q.tokensOut} tokens (min ${q.minTokensOut}), spot ${q.priceBefore.toFixed(4)} lamports/token`);
    const phases: string[] = [];
    const b = await measured('ammSimulatedBuy', () => buy(q, declining, (p) => phases.push(p.phase)));
    check(!b.ok && b.error.code === 'rejected' && !b.error.sent && phases.includes('awaiting-signature'), 'PumpSwap buy built and simulated OK on devnet (declined at the wallet, nothing sent)');
    const sq = await quoteSell(mint, 1_000_000n);
    check(sq.venue === 'amm' && sq.lamportsOut > 0n, `PumpSwap sell quote: 1 token → ${sq.lamportsOut} lamports`);
    const s = await sell(sq, declining, () => {});
    report.amm = { ...(report.amm as object), sellWithoutTokens: s.ok ? 'ok' : { code: s.error.code, programError: s.error.programError, logs: s.error.logs?.slice(-6) } };
    check(!s.ok && !s.error.sent && s.error.code === 'insufficient-tokens', `selling tokens the wallet doesn't hold → insufficient-tokens in simulation (${s.ok ? '' : s.error.code})`);
    writeReport();
  },
  5 * 60_000,
);
