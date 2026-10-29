/**
 * Solana libraries for scripts that build or sign transactions.
 *
 * Everything resolves from programs/shop-vault/client/node_modules (exact pins: web3.js 1.99.0, spl-token 0.4.14,
 * pump-sdk 3.2.0, bn.js 5.2.2), the same way programs/shop-vault/scripts/devnet-e2e.ts does it, so the shop-vault client
 * sources (imported as .ts through Node type stripping) and these scripts share ONE copy of @solana/web3.js
 * (`instanceof PublicKey` holds). The pump SDK is CJS-only under plain Node, hence createRequire.
 * Run `(cd programs/shop-vault/client && npm ci)` once if this import fails.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLIENT_DIR } from './paths.mjs';

if (!existsSync(join(CLIENT_DIR, 'node_modules', '@solana', 'web3.js'))) {
  throw new Error('programs/shop-vault/client/node_modules is missing: run (cd programs/shop-vault/client && npm ci)');
}

export const requireClient = createRequire(join(CLIENT_DIR, 'package.json'));
export const web3 = requireClient('@solana/web3.js');
export const BN = requireClient('bn.js');
/** @type {typeof import('../../programs/shop-vault/client/src/index.ts')} */
export const sv = await import(pathToFileURL(join(CLIENT_DIR, 'src', 'index.ts')).href);

let splCache;
export function splToken() {
  splCache ??= requireClient('@solana/spl-token');
  return splCache;
}
let pumpCache;
export function pumpSdk() {
  pumpCache ??= requireClient('@pump-fun/pump-sdk');
  return pumpCache;
}
let swapCache;
/** pump-swap-sdk for AMM trades after graduation (the version the client tree carries; see e2e-devnet.ts). */
export function pumpSwapSdk() {
  if (swapCache) return swapCache;
  const tryRoots = [requireClient];
  for (const r of tryRoots) {
    try {
      swapCache = r('@pump-fun/pump-swap-sdk');
      return swapCache;
    } catch {
      /* try next */
    }
  }
  throw new Error('@pump-fun/pump-swap-sdk not found under programs/shop-vault/client/node_modules');
}

export function connection(url, commitment = 'confirmed') {
  // a 429 (e.g. a free Alchemy plan's per-second limit) is retried with web3.js's backoff: the request was refused,
  // not executed, so retrying a send is safe (go-mainnet E2 stopped on one, 2026-10-27)
  return new web3.Connection(url, { commitment, disableRetryOnRateLimit: false, wsEndpoint: 'wss://invalid.invalid' });
}

/**
 * Build a v0 transaction. Signs with `signers` when given.
 * @returns {{ tx: any, blockhash: string, lastValidBlockHeight: number }}
 */
export async function buildTx(conn, payer, ixs, signers = [], alts = []) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const msg = new web3.TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts);
  const tx = new web3.VersionedTransaction(msg);
  if (signers.length) tx.sign(signers);
  return { tx, blockhash, lastValidBlockHeight };
}

/** shop-vault events from logs (`Program data:` segments; segment 0 = ASCII name, SPEC §7). */
export function programEvents(logs = []) {
  const out = [];
  for (const l of logs) {
    if (!l.startsWith('Program data: ')) continue;
    const segs = l.slice('Program data: '.length).split(' ').map((s) => Buffer.from(s, 'base64'));
    const name = segs[0].toString('latin1');
    if (/^[A-Za-z]+$/.test(name)) out.push({ name, fields: segs.slice(1) });
  }
  return out;
}

/**
 * Simulate with sigVerify, then (when `execute`) send with skipPreflight and poll to confirmation, rebroadcasting
 * every 2 s until the blockhash expires. Returns { signature?, logs, unitsConsumed, meta?, simulatedOnly }.
 */
export async function simulateAndSend(conn, built, { execute, label = 'tx', sigVerify = true } = {}) {
  // a load-balanced RPC can simulate on a node that has not yet seen the blockhash another node just handed out:
  // BlockhashNotFound then clears within a few seconds (go-mainnet E3 stopped on one, 2026-10-27)
  let sim;
  for (let attempt = 1; ; attempt++) {
    sim = await conn.simulateTransaction(built.tx, { sigVerify, commitment: 'confirmed' });
    if (sim.value.err !== 'BlockhashNotFound' || attempt >= 5) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).slice(-12).join('\n    ');
    throw Object.assign(new Error(`${label}: simulation failed ${JSON.stringify(sim.value.err)}\n    ${logs}`), { simErr: sim.value.err });
  }
  if (!execute) return { logs: sim.value.logs ?? [], unitsConsumed: sim.value.unitsConsumed, simulatedOnly: true };
  const raw = built.tx.serialize();
  const signature = (await import('./b58.mjs')).b58encode(built.tx.signatures[0]);
  await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  let lastSend = Date.now();
  const t0 = Date.now();
  for (;;) {
    const st = (await conn.getSignatureStatuses([signature])).value[0];
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
      const meta = await fetchMeta(conn, signature);
      if (st.err || meta?.err) {
        throw Object.assign(new Error(`${label}: failed on-chain ${JSON.stringify(st.err ?? meta?.err)} (${signature})`), { signature, meta });
      }
      return { signature, logs: meta?.logMessages ?? [], unitsConsumed: meta?.computeUnitsConsumed, meta, simulatedOnly: false };
    }
    const height = await conn.getBlockHeight('confirmed');
    if (height > built.lastValidBlockHeight) throw Object.assign(new Error(`${label}: expired before landing (${signature})`), { expired: true, signature });
    if (Date.now() - t0 > 90_000) throw Object.assign(new Error(`${label}: not confirmed after 90 s (${signature})`), { signature });
    if (Date.now() - lastSend > 2000) {
      await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      lastSend = Date.now();
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

async function fetchMeta(conn, signature) {
  for (let i = 0; i < 15; i++) {
    const t = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (t?.meta) return t.meta;
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return null;
}
