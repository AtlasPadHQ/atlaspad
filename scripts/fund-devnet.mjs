#!/usr/bin/env node
/**
 * Devnet funding (INTEGRATION §10.2). DEVNET ONLY: the genesis hash is checked before anything is sent.
 *
 *   node scripts/fund-devnet.mjs                       # show balances + plan (dry run)
 *   node scripts/fund-devnet.mjs --execute             # requestAirdrop 1 SOL × n for the deployer until ≥ --target (8)
 *   node scripts/fund-devnet.mjs --roles [--execute]   # top up crank (0.2) and faucet (3) FROM the deployer
 *   options: --target <SOL> (deployer goal, default 8) · --max <n> (airdrop requests, default 8)
 *            --crank <SOL> (0.2) · --faucet <SOL> (3) · --reserve <SOL> (deployer keeps at least this, 0.5)
 *
 * When airdrops are refused (the public faucet is often dry), it prints https://faucet.solana.com and the deployer
 * PUBKEY to fund by hand (GitHub login gives more). Nothing secret is printed.
 */
import { b58encode } from './lib/b58.mjs';
import { ensureKey, keypair, pubkey } from './lib/keys.mjs';
import { bad, fmtSol, head, info, ok, parseArgs, sleep, warn } from './lib/log.mjs';
import { LAMPORTS_PER_SOL, PUBLIC_RPC, explorerTx } from './lib/paths.mjs';
import { assertGenesis, getBalance, label, pickRpc, rpc, waitSignature } from './lib/rpc.mjs';

const args = parseArgs(process.argv.slice(2), ['execute', 'roles']);
const EXECUTE = !!args.execute;
const sol = (s) => {
  const [w, f = ''] = String(s).split('.');
  if (!/^\d+$/.test(w) || !/^\d*$/.test(f) || f.length > 9) throw new Error(`bad SOL amount ${s}`);
  return BigInt(w) * LAMPORTS_PER_SOL + BigInt(f.padEnd(9, '0'));
};
const TARGET = sol(args.target ?? '8');
const MAX = Number(args.max ?? 8);
const CRANK = sol(args.crank ?? '0.2');
const FAUCET = sol(args.faucet ?? '3');
const RESERVE = sol(args.reserve ?? '0.5');

const picked = await pickRpc('devnet');
const url = picked.url;

export async function airdrop({ execute = EXECUTE, target = TARGET, max = MAX } = {}) {
  const deployer = pubkey('devnet-deployer');
  let bal = await getBalance(url, deployer);
  info(`deployer ${deployer}: ${fmtSol(bal)} (goal ${fmtSol(target)})`);
  if (bal >= target) {
    ok('deployer already at goal');
    return bal;
  }
  if (!execute) {
    info(`would request up to ${max} × 1 SOL airdrops (dry run; add --execute)`);
    return bal;
  }
  const endpoints = [url, PUBLIC_RPC.devnet].filter((u, i, a) => a.indexOf(u) === i);
  let failures = 0;
  for (let i = 0; i < max && bal < target; i++) {
    let done = false;
    for (const ep of endpoints) {
      try {
        const sig = await rpc(ep, 'requestAirdrop', [deployer, Number(LAMPORTS_PER_SOL)], { retries: 0 });
        await waitSignature(ep, sig, { timeoutMs: 60_000 });
        ok(`airdrop 1 SOL via ${label(ep)} — ${explorerTx(sig, 'devnet')}`);
        done = true;
        break;
      } catch (e) {
        warn(`airdrop via ${label(ep)} refused: ${String(e.message).slice(0, 160)}`);
      }
    }
    if (!done) {
      failures++;
      if (failures >= 2) break;
      await sleep(5000 * failures);
    }
    bal = await getBalance(url, deployer);
  }
  bal = await getBalance(url, deployer);
  info(`deployer balance now ${fmtSol(bal)}`);
  if (bal < target) {
    bad(`deployer is below the ${fmtSol(target)} goal.`);
    console.log(`\n  Fund it by hand: open https://faucet.solana.com (network: devnet; log in with GitHub for more),`);
    console.log(`  paste this address and request SOL until it holds ~${fmtSol(target)}:\n\n    ${deployer}\n`);
  }
  return bal;
}

export async function fundRoles({ execute = EXECUTE, crank = CRANK, faucet = FAUCET, reserve = RESERVE } = {}) {
  const { web3, connection, buildTx, simulateAndSend } = await import('./lib/web3.mjs');
  const conn = connection(url);
  const deployerKp = await keypair('devnet-deployer');
  const targets = [
    ['crank', ensureKey('devnet-crank'), crank],
    ['faucet', ensureKey('devnet-faucet'), faucet],
  ];
  const ixs = [];
  let need = 0n;
  for (const [role, k, want] of targets) {
    if (k.created) ok(`created .keys/devnet-${role}.json (pubkey ${k.pubkey})`);
    const have = await getBalance(url, k.pubkey);
    if (have >= want) {
      ok(`${role} ${k.pubkey}: ${fmtSol(have)} (≥ ${fmtSol(want)})`);
      continue;
    }
    info(`${role} ${k.pubkey}: ${fmtSol(have)} → top up ${fmtSol(want - have)}`);
    ixs.push(web3.SystemProgram.transfer({ fromPubkey: deployerKp.publicKey, toPubkey: new web3.PublicKey(k.pubkey), lamports: want - have }));
    need += want - have;
  }
  if (!ixs.length) return true;
  const bal = await getBalance(url, deployerKp.publicKey.toBase58());
  if (bal < need + reserve) {
    bad(`deployer has ${fmtSol(bal)}; topping up crank/faucet needs ${fmtSol(need)} and keeps a ${fmtSol(reserve)} reserve`);
    return false;
  }
  const built = await buildTx(conn, deployerKp.publicKey, ixs, [deployerKp]);
  const r = await simulateAndSend(conn, built, { execute, label: 'fund crank/faucet' });
  if (r.simulatedOnly) info(`would transfer ${fmtSol(need)} from the deployer (simulated OK; dry run)`);
  else ok(`transferred ${fmtSol(need)} — ${explorerTx(r.signature ?? b58encode(built.tx.signatures[0]), 'devnet')}`);
  return true;
}

async function main() {
  head(`fund-devnet · ${label(url)} · ${EXECUTE ? 'EXECUTE' : 'dry run'}`);
  if (picked.fallback) warn(`${picked.fallback}; using ${label(url)} from this machine`);
  await assertGenesis(url, 'devnet');
  ok('RPC genesis is devnet');
  if (args.roles) {
    const done = await fundRoles();
    process.exit(done ? 0 : 3);
  }
  const bal = await airdrop();
  process.exit(bal >= TARGET || !EXECUTE ? 0 : 3);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    bad(e.message);
    process.exit(1);
  });
}
