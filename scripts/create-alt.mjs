#!/usr/bin/env node
/**
 * The frozen CORNERSHOP address lookup table (SPEC §8.1, INTEGRATION §1.1, §10.2).
 *
 *   node scripts/create-alt.mjs --cluster devnet            # dry run: verify the recorded ALT, or show the plan
 *   node scripts/create-alt.mjs --cluster devnet --execute  # create + extend (exactly the 14 ALT_KEYS) + freeze
 *   node scripts/create-alt.mjs --cluster devnet --adopt <address>   # verify an existing ALT and record it
 *   node scripts/create-alt.mjs --cluster mainnet           # read-only verification of deploy/mainnet.json.alt
 *
 * Idempotent and resumable:
 * - deploy/<cluster>.json `alt` present → verified on chain (owner, exactly ALT_KEYS in order, frozen) → printed.
 * - `altPending` present (an earlier run stopped half-way) → resumes: extends an empty table, freezes an extended one.
 * - Before creating anything, ALT_KEYS (scripts/lib/paths.mjs) is cross-checked against the pump SDK and shop-vault
 *   client derivations, so a stale key list can never be frozen into a table.
 * Mainnet creation runs only from go-mainnet.mjs (createAlt({ allowMainnet: true })). Prints the ALT address only.
 */
import { b58encode } from './lib/b58.mjs';
import { readDeploy, writeDeploy } from './lib/deployJson.mjs';
import { keypair } from './lib/keys.mjs';
import { bad, fatal, head, info, ok, parseArgs, sleep } from './lib/log.mjs';
import { ALT_KEY_LIST, ALT_KEYS, ALT_PROGRAM, explorerAddress, explorerTx } from './lib/paths.mjs';
import { assertGenesis, getAccount, label, pickRpc, rpc } from './lib/rpc.mjs';

/** Decode an address lookup table account (AddressLookupTab1e…): { deactivationSlot, lastExtendedSlot, authority, addresses }. */
export function decodeAlt(data) {
  const d = Buffer.from(data);
  if (d.length < 56 || d.readUInt32LE(0) !== 1) throw new Error('not an address lookup table');
  const deactivationSlot = d.readBigUInt64LE(4);
  const lastExtendedSlot = d.readBigUInt64LE(12);
  const hasAuthority = d[21] === 1;
  const authority = hasAuthority ? b58encode(d.subarray(22, 54)) : null;
  const addresses = [];
  for (let o = 56; o + 32 <= d.length; o += 32) addresses.push(b58encode(d.subarray(o, o + 32)));
  return { deactivationSlot, lastExtendedSlot, authority, addresses };
}

/** Problems with an ALT's content (empty = it is exactly the frozen CORNERSHOP table). */
export function altProblems(alt, { requireFrozen = true } = {}) {
  const p = [];
  if (alt.deactivationSlot !== 0xffffffffffffffffn) p.push('table is deactivated');
  if (alt.addresses.length !== ALT_KEY_LIST.length) p.push(`holds ${alt.addresses.length} keys, expected ${ALT_KEY_LIST.length}`);
  ALT_KEY_LIST.forEach((k, i) => {
    if (alt.addresses[i] !== undefined && alt.addresses[i] !== k) p.push(`key #${i} is ${alt.addresses[i]}, expected ${k} (${ALT_KEYS[i][1]})`);
  });
  if (requireFrozen && alt.authority) p.push(`not frozen (authority ${alt.authority})`);
  return p;
}

/** Cross-check ALT_KEYS against the SDK/client derivations. Returns problem strings. */
export async function altKeyDerivationProblems() {
  const { sv, pumpSdk } = await import('./lib/web3.mjs');
  const pump = pumpSdk();
  const derived = [
    pump.GLOBAL_PDA,
    pump.PUMP_EVENT_AUTHORITY_PDA,
    pump.PUMP_FEE_CONFIG_PDA,
    pump.getGlobalParamsPda(),
    pump.getSolVaultPda(),
    'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM', // pump mint_authority (fixed PDA of pump)
    sv.TOKEN_2022_PROGRAM_ID,
    sv.SPL_TOKEN_PROGRAM_ID,
    sv.NATIVE_MINT,
    '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD', // Global.buybackFeeRecipients[0] (checked on chain below)
    sv.SYSTEM_PROGRAM_ID,
    sv.configPda()[0],
    pump.MAYHEM_PROGRAM_ID,
    sv.INSTRUCTIONS_SYSVAR_ID,
  ].map((k) => (typeof k === 'string' ? k : k.toBase58()));
  const p = [];
  derived.forEach((k, i) => {
    if (k !== ALT_KEY_LIST[i]) p.push(`ALT_KEYS[${i}] (${ALT_KEYS[i][1]}) is ${ALT_KEY_LIST[i]} but the SDK derives ${k}`);
  });
  const [mintAuth] = (await import('./lib/web3.mjs')).web3.PublicKey.findProgramAddressSync([Buffer.from('mint-authority')], pump.PUMP_PROGRAM_ID);
  if (mintAuth.toBase58() !== ALT_KEY_LIST[5]) p.push(`pump mint_authority PDA is ${mintAuth.toBase58()}, ALT_KEYS has ${ALT_KEY_LIST[5]}`);
  return p;
}

/** The buyback recipient in the ALT must still be Global.buybackFeeRecipients[0] on this cluster. */
async function buybackProblems(url) {
  const { pumpSdk, connection } = await import('./lib/web3.mjs');
  const pump = pumpSdk();
  const online = new pump.OnlinePumpSdk(connection(url));
  const g = await online.fetchGlobal();
  const first = g.buybackFeeRecipients?.[0]?.toBase58?.();
  if (!first) return ['could not read pump Global.buybackFeeRecipients'];
  return first === ALT_KEY_LIST[9] ? [] : [`pump Global.buybackFeeRecipients[0] is ${first}, the ALT has ${ALT_KEY_LIST[9]}`];
}

async function readAlt(url, address) {
  const a = await getAccount(url, address);
  if (!a) return null;
  if (a.owner !== ALT_PROGRAM) throw new Error(`${address} is not owned by the address lookup table program`);
  return decodeAlt(a.data);
}

async function waitSlotAbove(url, slot, extra = 0n) {
  for (let i = 0; i < 120; i++) {
    const s = BigInt(await rpc(url, 'getSlot', [{ commitment: 'confirmed' }]));
    if (s > slot + extra) return;
    await sleep(400);
  }
  throw new Error('slot did not advance');
}

/**
 * @param {{ cluster: 'devnet'|'mainnet', url: string, authority: any (Keypair; pays and is the temporary authority),
 *           execute: boolean, allowMainnet?: boolean, adopt?: string, log?: (s:string)=>void }} o
 * @returns {Promise<{ alt: string|null, status: 'verified'|'created'|'planned', problems: string[] }>}
 */
export async function createAlt(o) {
  const { cluster, url, execute } = o;
  const log = o.log ?? info;
  if (cluster === 'mainnet' && execute && !o.allowMainnet) throw new Error('mainnet ALT creation runs only from go-mainnet.mjs');
  await assertGenesis(url, cluster);

  const deriv = await altKeyDerivationProblems();
  const buyback = await buybackProblems(url);
  if (deriv.length || buyback.length) return { alt: null, status: 'invalid-keys', problems: [...deriv, ...buyback] };

  const rec = readDeploy(cluster) ?? {};
  const candidate = o.adopt ?? rec.alt;
  if (candidate) {
    const alt = await readAlt(url, candidate);
    if (!alt) return { alt: candidate, status: 'missing', problems: [`recorded ALT ${candidate} does not exist on ${cluster}`] };
    const problems = altProblems(alt);
    if (!problems.length) writeDeploy(cluster, { alt: candidate, altKeys: ALT_KEY_LIST, altPending: null });
    return { alt: candidate, status: 'verified', problems };
  }

  if (!o.authority) return { alt: null, status: 'planned', problems: ['no ALT recorded and no authority keypair given'] };
  const { web3, connection, buildTx, simulateAndSend } = await import('./lib/web3.mjs');
  const conn = connection(url);
  const auth = o.authority;
  const { AddressLookupTableProgram, PublicKey } = web3;
  const keys = ALT_KEY_LIST.map((k) => new PublicKey(k));

  let address = rec.altPending ?? null;
  let state = address ? await readAlt(url, address) : null;
  if (address && !state) {
    log(`pending ALT ${address} was never created; starting over`);
    address = null;
  }

  if (!address) {
    // The table address derives from a recent slot that must be in the executing bank's SlotHashes. Load-balanced
    // public RPCs can answer getSlot from a node ahead of the one that simulates, so use a slot a little behind
    // `finalized` and retry with a fresh one on "is not a recent slot".
    let built;
    let alt;
    for (let attempt = 1; ; attempt++) {
      const recentSlot = (await rpc(url, 'getSlot', [{ commitment: 'finalized' }])) - 8;
      const [createIx, a] = AddressLookupTableProgram.createLookupTable({ authority: auth.publicKey, payer: auth.publicKey, recentSlot });
      const extendIx = AddressLookupTableProgram.extendLookupTable({ payer: auth.publicKey, authority: auth.publicKey, lookupTable: a, addresses: keys });
      built = await buildTx(conn, auth.publicKey, [createIx, extendIx], [auth]);
      alt = a;
      try {
        await simulateAndSend(conn, built, { execute: false, label: 'create + extend ALT' });
        break;
      } catch (e) {
        if (attempt >= 4 || !/not a recent slot|BlockhashNotFound/.test(String(e.message))) throw e;
        await sleep(1500);
      }
    }
    if (!execute) {
      return { alt: null, status: 'planned', problems: [], plan: `create + extend a table with the ${keys.length} ALT_KEYS, then freeze it (simulated OK)` };
    }
    address = alt.toBase58();
    writeDeploy(cluster, { altPending: address }); // recorded before sending so a crash can resume
    const r = await simulateAndSend(conn, built, { execute: true, label: 'create + extend ALT' });
    log(`created + extended ${address} — ${explorerTx(r.signature, cluster)}`);
    state = await readAlt(url, address);
  }

  if (state.addresses.length === 0) {
    if (!execute) return { alt: address, status: 'planned', problems: [], plan: 'extend the pending table, then freeze it' };
    const ix = AddressLookupTableProgram.extendLookupTable({ payer: auth.publicKey, authority: auth.publicKey, lookupTable: new PublicKey(address), addresses: keys });
    const r = await simulateAndSend(conn, await buildTx(conn, auth.publicKey, [ix], [auth]), { execute: true, label: 'extend ALT' });
    log(`extended — ${explorerTx(r.signature, cluster)}`);
    state = await readAlt(url, address);
  }

  const contentProblems = altProblems(state, { requireFrozen: false });
  if (contentProblems.length) {
    return { alt: address, status: 'bad-content', problems: [...contentProblems, 'this table cannot be fixed (it would need other keys removed); remove altPending from deploy json and create a new one'] };
  }

  if (state.authority) {
    if (state.authority !== auth.publicKey.toBase58()) return { alt: address, status: 'foreign', problems: [`table authority is ${state.authority}, not ${auth.publicKey.toBase58()}`] };
    if (!execute) return { alt: address, status: 'planned', problems: [], plan: 'freeze the pending table' };
    await waitSlotAbove(url, state.lastExtendedSlot); // the extension must be active before freezing
    const ix = AddressLookupTableProgram.freezeLookupTable({ lookupTable: new PublicKey(address), authority: auth.publicKey });
    const r = await simulateAndSend(conn, await buildTx(conn, auth.publicKey, [ix], [auth]), { execute: true, label: 'freeze ALT' });
    log(`frozen — ${explorerTx(r.signature, cluster)}`);
    const frozenAt = BigInt(await rpc(url, 'getSlot', [{ commitment: 'confirmed' }]));
    await waitSlotAbove(url, frozenAt, 3n); // DEVNET.md: give the frozen table a few slots before the first launch
    state = await readAlt(url, address);
  }

  const problems = altProblems(state);
  if (!problems.length) writeDeploy(cluster, { alt: address, altKeys: ALT_KEY_LIST, altPending: null, altCreatedAt: new Date().toISOString() });
  return { alt: address, status: 'created', problems };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['execute']);
  const cluster = args.cluster ?? 'devnet';
  if (cluster !== 'devnet' && cluster !== 'mainnet') fatal('--cluster devnet|mainnet', 64);
  if (cluster === 'mainnet' && args.execute) fatal('mainnet ALT creation runs only from scripts/go-mainnet.mjs --execute (H1)', 64);
  const { url, fallback } = await pickRpc(cluster);
  head(`create-alt · ${cluster} · ${label(url)} · ${args.execute ? 'EXECUTE' : 'dry run'}`);
  if (fallback) info(fallback);
  const authority = cluster === 'devnet' ? await keypair('devnet-deployer') : null;
  const r = await createAlt({ cluster, url, authority, execute: !!args.execute, adopt: typeof args.adopt === 'string' ? args.adopt : undefined });
  for (const p of r.problems) bad(p);
  if (r.plan) info(`plan: ${r.plan}${args.execute ? '' : ' (dry run; add --execute)'}`);
  if (r.alt && !r.problems.length) {
    ok(`ALT ${r.status}: exactly the ${ALT_KEY_LIST.length} ALT_KEYS, frozen — ${explorerAddress(r.alt, cluster)}`);
    console.log(r.alt);
  }
  process.exit(r.problems.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fatal(e.message));
}
