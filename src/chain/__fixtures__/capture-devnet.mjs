/**
 * READ-ONLY fixture capture from Solana devnet (or mainnet) for the src/chain unit tests (curve math, AMM pool price,
 * event decoding, launch rent sizes). Sends nothing: only getGenesisHash / getSignaturesForAddress / getTransaction /
 * getMultipleAccounts / getMinimumBalanceForRentExemption.
 *
 *   node src/chain/__fixtures__/capture-devnet.mjs                    → writes src/chain/__fixtures__/devnet.json
 *   node src/chain/__fixtures__/capture-devnet.mjs --cluster mainnet  → writes src/chain/__fixtures__/mainnet.json
 *     (today's mainnet pump.fun for src/chain/mainnet.test.ts: re-capture after every pump upgrade)
 *
 * RPC: RPC_URL if set, else Alchemy (ALCHEMY_API_KEY_MAINNET or ALCHEMY_API_KEY for mainnet, ALCHEMY_API_KEY for
 * devnet) read in-process from .env.server, else the public RPC. Only the RPC ORIGIN is ever printed (keyed URLs carry
 * the key in the path).
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const web3 = require('@solana/web3.js');
const pump = require('@pump-fun/pump-sdk');
const amm = require('@pump-fun/pump-swap-sdk');
const spl = require('@solana/spl-token');
const bs58 = require('bs58').default ?? require('bs58');

const CLUSTER = process.argv.includes('--cluster') ? process.argv[process.argv.indexOf('--cluster') + 1] : 'devnet';
if (CLUSTER !== 'devnet' && CLUSTER !== 'mainnet') throw new Error('--cluster devnet|mainnet');
function rpcUrl() {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  const envFile = join(HERE, '../../../.env.server');
  if (existsSync(envFile)) {
    const text = readFileSync(envFile, 'utf8');
    const m = (CLUSTER === 'mainnet' && /^ALCHEMY_API_KEY_MAINNET=(.+)$/m.exec(text)) || /^ALCHEMY_API_KEY=(.+)$/m.exec(text);
    if (m) return `https://solana-${CLUSTER}.g.alchemy.com/v2/${m[1].trim().replace(/^["']|["']$/g, '')}`;
  }
  return CLUSTER === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com';
}
const RPC = rpcUrl();
const GENESIS = { devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' }[CLUSTER];
const conn = new web3.Connection(RPC, 'confirmed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EVENT_TAG = Buffer.from('e445a52e51cb9a1d', 'hex');
const TRADE = Buffer.from('bddb7fd34ee661ee', 'hex');
const AMM_BUY = Buffer.from('67f4521f2cf57777', 'hex');
const AMM_SELL = Buffer.from('3e2f370aa503dc2a', 'hex');
const CREATE_V2 = Buffer.from('d6904cec5f8b31b4', 'hex');

async function getTx(signature) {
  const raw = await conn._rpcRequest('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  return raw.result;
}

/** Inner instructions of `tx` that are Anchor CPI events with discriminator `disc`. */
function eventsOf(tx, disc) {
  const out = [];
  for (const g of tx?.meta?.innerInstructions ?? []) {
    for (const ix of g.instructions) {
      const d = Buffer.from(bs58.decode(ix.data));
      if (d.length >= 16 && d.subarray(0, 8).equals(EVENT_TAG) && d.subarray(8, 16).equals(disc)) out.push(d.subarray(16));
    }
  }
  return out;
}

function allKeys(tx) {
  const m = tx.transaction.message;
  return [...m.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
}

/** The create_v2 of `tx` with the accounts it created (owner, size), or null. */
async function createOf(signature, tx) {
  const keys = allKeys(tx);
  const top = tx.transaction.message.instructions.find(
    (ix) => keys[ix.programIdIndex] === pump.PUMP_PROGRAM_ID.toBase58() && Buffer.from(bs58.decode(ix.data)).subarray(0, 8).equals(CREATE_V2),
  );
  if (!top) return null;
  const created = [];
  keys.forEach((k, i) => {
    if (tx.meta.preBalances[i] === 0 && tx.meta.postBalances[i] > 0) created.push({ address: k, lamports: tx.meta.postBalances[i] });
  });
  const infos = await conn.getMultipleAccountsInfo(created.map((c) => new web3.PublicKey(c.address)));
  created.forEach((c, i) => {
    c.owner = infos[i]?.owner.toBase58() ?? null;
    c.size = infos[i]?.data.length ?? null;
  });
  const args = Buffer.from(bs58.decode(top.data));
  return { signature, created, mint: keys[top.accounts[0]], argsHex: args.toString('hex') };
}

async function main() {
  console.log(`capture ${CLUSTER} from ${new URL(RPC).origin}`);
  const genesis = await conn.getGenesisHash();
  if (genesis !== GENESIS) throw new Error(`not ${CLUSTER}`);
  const slot = await conn.getSlot();
  const [globalAi, feeAi] = await conn.getMultipleAccountsInfo([pump.GLOBAL_PDA, pump.PUMP_FEE_CONFIG_PDA]);
  const out = {
    capturedAt: new Date().toISOString(),
    slot,
    global: globalAi.data.toString('base64'),
    feeConfig: feeAi.data.toString('base64'),
    rent0: await conn.getMinimumBalanceForRentExemption(0),
    rent165: await conn.getMinimumBalanceForRentExemption(165),
    curves: [],
    txs: [],
    create: null,
    amm: null,
  };

  // ---- pump: trade txs (TradeEvent) + a create_v2 tx
  const sigs = await conn.getSignaturesForAddress(pump.PUMP_PROGRAM_ID, { limit: 150 });
  const mints = new Set();
  for (const s of sigs) {
    if (s.err) continue;
    if (out.txs.length >= 6 && out.create) break;
    await sleep(150);
    const tx = await getTx(s.signature);
    if (!tx?.meta) continue;
    const trades = eventsOf(tx, TRADE);
    if (trades.length && out.txs.length < 6) {
      for (const e of trades) mints.add(new web3.PublicKey(e.subarray(0, 32)).toBase58());
      out.txs.push({ signature: s.signature, tx });
    }
    if (!out.create) out.create = await createOf(s.signature, tx);
  }
  // Mainnet: create_v2 is rare among the latest pump signatures; pump's mint authority PDA signs only creates.
  if (!out.create && CLUSTER === 'mainnet') {
    for (const s of await conn.getSignaturesForAddress(new web3.PublicKey('TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM'), { limit: 40 })) {
      if (s.err) continue;
      await sleep(150);
      const tx = await getTx(s.signature);
      if (tx?.meta && (out.create = await createOf(s.signature, tx))) break;
    }
  }
  const mintList = [...mints].slice(0, 12);
  const curveKeys = mintList.map((m) => pump.bondingCurvePda(new web3.PublicKey(m)));
  const infos = await conn.getMultipleAccountsInfo(curveKeys);
  infos.forEach((ai, i) => {
    if (ai) out.curves.push({ mint: mintList[i], address: curveKeys[i].toBase58(), data: ai.data.toString('base64') });
  });
  // The curve ATA balance (curveBaseTokenBalance) for v3 quotes: both token programs, as the SDK sums them.
  for (const c of out.curves) {
    const atas = [spl.TOKEN_2022_PROGRAM_ID, spl.TOKEN_PROGRAM_ID].map((p) =>
      spl.getAssociatedTokenAddressSync(new web3.PublicKey(c.mint), new web3.PublicKey(c.address), true, p),
    );
    const ai = await conn.getMultipleAccountsInfo(atas);
    c.curveAta = ai.reduce((s, a) => s + (a && a.data.length >= 72 ? a.data.readBigUInt64LE(64) : 0n), 0n).toString();
  }

  // ---- pump-amm: one canonical pump pool with a Buy/Sell event, its vaults, GlobalConfig + FeeConfig
  let ammSigs = await conn.getSignaturesForAddress(amm.PUMP_AMM_PROGRAM_ID, { limit: CLUSTER === 'mainnet' ? 300 : 100 });
  // Alchemy lists no signatures for pump-amm's busy program address on mainnet; the public RPC does (public data).
  if (!ammSigs.length && CLUSTER === 'mainnet') ammSigs = await new web3.Connection('https://api.mainnet-beta.solana.com', 'confirmed').getSignaturesForAddress(amm.PUMP_AMM_PROGRAM_ID, { limit: 300 });
  for (const s of ammSigs) {
    if (s.err) continue;
    await sleep(150);
    const tx = await getTx(s.signature);
    if (!tx?.meta) continue;
    const buys = eventsOf(tx, AMM_BUY);
    const sells = eventsOf(tx, AMM_SELL);
    const ev = buys[0] ?? sells[0];
    if (!ev) continue;
    const pool = new web3.PublicKey(ev.subarray(112, 144));
    const poolAi = await conn.getAccountInfo(pool);
    if (!poolAi) continue;
    const decoded = amm.PUMP_AMM_SDK.decodePool(poolAi);
    const canonical = pump.canonicalPumpPoolPda(decoded.baseMint).equals(pool);
    if (!canonical || !decoded.quoteMint.equals(spl.NATIVE_MINT)) continue;
    const [gc, fc, baseVault, quoteVault, baseMint] = await conn.getMultipleAccountsInfo([
      amm.GLOBAL_CONFIG_PDA,
      amm.PUMP_AMM_FEE_CONFIG_PDA,
      decoded.poolBaseTokenAccount,
      decoded.poolQuoteTokenAccount,
      decoded.baseMint,
    ]);
    out.amm = {
      signature: s.signature,
      tx,
      side: buys[0] ? 'buy' : 'sell',
      pool: pool.toBase58(),
      poolData: poolAi.data.toString('base64'),
      globalConfig: gc.data.toString('base64'),
      feeConfig: fc ? fc.data.toString('base64') : null,
      baseVault: { address: decoded.poolBaseTokenAccount.toBase58(), data: baseVault.data.toString('base64'), owner: baseVault.owner.toBase58() },
      quoteVault: { address: decoded.poolQuoteTokenAccount.toBase58(), data: quoteVault.data.toString('base64'), owner: quoteVault.owner.toBase58() },
      baseMint: { address: decoded.baseMint.toBase58(), data: baseMint.data.toString('base64'), owner: baseMint.owner.toBase58() },
    };
    break;
  }

  writeFileSync(join(HERE, `${CLUSTER}.json`), JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
  console.log(
    `wrote ${out.curves.length} curves, ${out.txs.length} trade txs, create ${out.create ? 'yes' : 'no'}, amm pool ${out.amm ? out.amm.pool : 'none'}, slot ${slot}`,
  );
}
main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
