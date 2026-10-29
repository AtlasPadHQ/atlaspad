#!/usr/bin/env node
/**
 * Claims admin (INTEGRATION §10.2; SPEC §5.4 cancel_claim, §8.6). Disputes are handled during the public window.
 *
 *   node scripts/claims-admin.mjs --env devnet list
 *   node scripts/claims-admin.mjs --env devnet cancel <placeId> [--execute]
 *   node scripts/claims-admin.mjs --env mainnet cancel <placeId> [--authority guardian|governance]
 *
 * list    active D1 claims (calling / verified / cosigned / pending_onchain) joined with the live on-chain VaultState
 *         (pending owner, unlock time, probation flag), plus on-chain pending claims that have NO D1 row (critical:
 *         possible attestor misuse, SPEC §8.6). Phone numbers are never stored, so none are shown.
 * cancel  must happen before unlock_ts (cancel and finalize split time; SPEC §5.4).
 *         devnet: signs cancel_claim with .keys/devnet-guardian.json (the deployer pays the fee), simulates first,
 *         sends on --execute, then marks the D1 claim cancelled.
 *         mainnet: never signs. Prints the cancel_claim instruction (for Squads: governance may cancel at most 2 claims
 *         per place, ever) and an UNSIGNED transaction with a fresh blockhash (valid ~60-90 s) for the hardware guardian.
 *         A guardian on Phantom signs with `node scripts/guardian.mjs --cluster mainnet cancel <placeId>` instead
 *         (RUNBOOK §8 "Guardian: cancel a wrong claim / pause launches").
 */
import { createHash } from 'node:crypto';
import { b58encode } from './lib/b58.mjs';
import { readDeploy } from './lib/deployJson.mjs';
import { keypair } from './lib/keys.mjs';
import { bad, fatal, head, info, ok, parseArgs, warn } from './lib/log.mjs';
import { explorerTx, PUBLIC_RPC } from './lib/paths.mjs';
import { assertGenesis, chainTime, getAccount } from './lib/rpc.mjs';
import { d1Execute } from './lib/wrangler.mjs';
import { PLACE_ID_RE } from './moderate.mjs';

export function placeHashHex(placeId) {
  return createHash('sha256').update(Buffer.from(placeId, 'utf8')).digest('hex');
}

async function list(env, url, sv, web3) {
  const rows = await d1Execute(env, `SELECT id, place_id, mint, method, status, new_owner, unlock_ts, in_probation, requested_at FROM claims WHERE status IN ('calling','verified','cosigned','pending_onchain') ORDER BY requested_at DESC LIMIT 200`);
  const now = Number(await chainTime(url));
  if (!rows.length) info('no active claims in D1');
  for (const r of rows) {
    const [vs] = sv.vaultStatePda(Buffer.from(placeHashHex(r.place_id), 'hex'));
    const acc = await getAccount(url, vs.toBase58());
    const st = acc ? sv.decodeVaultState(acc.data) : null;
    const pend = st?.pending ? `on-chain pending ${st.pending.owner.toBase58()} unlocks ${new Date(Number(st.pending.unlockTs) * 1000).toISOString()} (${Number(st.pending.unlockTs) - now} s)${st.pending.inProbation ? ' IN PROBATION' : ''}` : 'no on-chain pending claim';
    console.log(`${r.status.padEnd(16)} ${r.method.padEnd(7)} place ${r.place_id} · mint ${r.mint} · new owner ${r.new_owner ?? '—'} · ${pend}`);
  }
  // On-chain pending claims without a D1 row (the coins mirror carries pending_owner from the vault sweep).
  const mirrored = await d1Execute(env, `SELECT place_id, mint, pending_owner, unlock_ts FROM coins WHERE pending_owner IS NOT NULL`);
  const known = new Set(rows.filter((r) => r.status === 'pending_onchain').map((r) => r.place_id));
  for (const m of mirrored) {
    if (!known.has(m.place_id)) warn(`CRITICAL: on-chain pending claim with no D1 claim row — place ${m.place_id} · pending owner ${m.pending_owner} · unlock ${m.unlock_ts ? new Date(m.unlock_ts * 1000).toISOString() : '—'} (cancel before unlock if it is not ours)`);
  }
}

async function cancel(env, url, sv, web3, placeId, { execute, authorityRole }) {
  if (!PLACE_ID_RE.test(placeId)) fatal('placeId must be a Google place id (or a devnet test id)');
  const ph = Buffer.from(placeHashHex(placeId), 'hex');
  const [vsPk] = sv.vaultStatePda(ph);
  const acc = await getAccount(url, vsPk.toBase58());
  if (!acc) fatal(`no VaultState for ${placeId} on ${env}`);
  const st = sv.decodeVaultState(acc.data);
  if (!st.pending) fatal('nothing pending on chain for this place');
  const now = await chainTime(url);
  info(`pending owner ${st.pending.owner.toBase58()} · unlock ${new Date(Number(st.pending.unlockTs) * 1000).toISOString()} · ${Number(st.pending.unlockTs - now)} s left${st.pending.inProbation ? ' · in probation (the current owner may cancel too)' : ''}`);
  if (now >= st.pending.unlockTs) fatal('the window has elapsed: cancel_claim would fail with ClaimWindowElapsed (123)');
  const dep = readDeploy(env) ?? {};

  if (env === 'devnet') {
    const { connection, buildTx, simulateAndSend } = await import('./lib/web3.mjs');
    const guardian = await keypair('devnet-guardian');
    const payer = await keypair('devnet-deployer');
    if (dep.guardian && dep.guardian !== guardian.publicKey.toBase58()) fatal(`deploy/devnet.json guardian ${dep.guardian} ≠ .keys/devnet-guardian.json`);
    const ix = sv.cancelClaim({ authority: guardian.publicKey, placeHash: ph });
    const conn = connection(url);
    const r = await simulateAndSend(conn, await buildTx(conn, payer.publicKey, [ix], [payer, guardian]), { execute, label: 'cancel_claim (guardian)' });
    if (r.simulatedOnly) {
      ok('cancel_claim simulated OK (dry run; add --execute)');
      return;
    }
    ok(`cancelled — ${explorerTx(r.signature, env)}`);
    await d1Execute(env, `UPDATE claims SET status = 'cancelled', updated_at = ${Date.now()} WHERE place_id = '${placeId}' AND status = 'pending_onchain'`);
    ok('D1 claim row marked cancelled');
    return;
  }

  // mainnet: print only, never sign.
  const role = authorityRole === 'governance' ? 'governance' : 'guardian';
  const authority = dep[role];
  if (!authority) fatal(`deploy/mainnet.json has no ${role}`);
  const ix = sv.cancelClaim({ authority: new web3.PublicKey(authority), placeHash: ph });
  console.log(`\ncancel_claim instruction (authority = ${role} ${authority}):`);
  console.log(`  program  ${ix.programId.toBase58()}`);
  for (const k of ix.keys) console.log(`  account  ${k.pubkey.toBase58()}${k.isSigner ? ' (signer)' : ''}${k.isWritable ? ' (writable)' : ''}`);
  console.log(`  data     ${b58encode(ix.data)} (base58)`);
  if (role === 'governance') {
    warn('governance may cancel at most 2 claims per place, ever (SPEC D6); prefer the guardian. Create this as a Squads vault transaction; its time lock must end before unlock.');
    return;
  }
  const { connection } = await import('./lib/web3.mjs');
  const conn = connection(url);
  const { blockhash } = await conn.getLatestBlockhash('finalized');
  const tx = new web3.Transaction();
  tx.feePayer = new web3.PublicKey(authority);
  tx.recentBlockhash = blockhash;
  tx.add(ix);
  const unsigned = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  console.log(`\nUNSIGNED transaction (fee payer = guardian; blockhash valid ~60-90 s; sign with the hardware guardian and send):`);
  console.log(`  base58  ${b58encode(unsigned)}`);
  console.log(`  base64  ${Buffer.from(unsigned).toString('base64')}`);
  info(`guardian on Phantom: node scripts/guardian.mjs --cluster mainnet cancel ${placeId} (a page that checks it is the guardian and asks Phantom to sign; RUNBOOK §8 "Guardian")`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['execute']);
  const env = args.env;
  const [cmd, arg] = args._;
  if (!['devnet', 'mainnet'].includes(env) || !['list', 'cancel'].includes(cmd)) {
    console.error('usage: node scripts/claims-admin.mjs --env devnet|mainnet list | cancel <placeId> [--execute] [--authority guardian|governance]');
    process.exit(64);
  }
  if (env === 'mainnet' && args.execute) fatal('mainnet cancels are never signed by this script (H1); it prints the transaction for the guardian');
  const url = PUBLIC_RPC[env];
  head(`claims-admin · ${env} · ${cmd}`);
  await assertGenesis(url, env);
  const { sv, web3 } = await import('./lib/web3.mjs');
  if (cmd === 'list') await list(env, url, sv, web3);
  else if (!arg) bad('cancel needs a placeId');
  else await cancel(env, url, sv, web3, arg, { execute: !!args.execute, authorityRole: args.authority });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fatal(e.message));
}
