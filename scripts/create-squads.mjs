#!/usr/bin/env node
/**
 * Create the two Squads v4 multisigs mainnet needs (SPEC §11), with one command instead of the Squads web app.
 *
 *   node scripts/create-squads.mjs --cluster devnet|mainnet --payer <keypair.json> --members <a,b,c>            # dry run
 *   node scripts/create-squads.mjs --cluster devnet|mainnet --payer <keypair.json> --members <a,b,c> --execute
 *   node scripts/create-squads.mjs --cluster mainnet          # verify deploy/mainnet-squads.json on chain, print the flags
 *
 *   A  governance                   2-of-3, time lock 0 s
 *   B  program upgrade authority    2-of-3, time lock 604,800 s (7 days)
 *   Both autonomous (no config authority), no rent collector, all three members Initiate|Vote|Execute.
 *
 * Options: --keys-dir <dir> (where <cluster>-attestor.json / <cluster>-crank.json live; default .keys) ·
 *   --deploy-dir <dir> (where the <cluster>-squads.json record lives; default deploy) ·
 *   --guardian <pubkey> (warns when a member is the guardian; default deploy/<cluster>.json) · --window <secs> (claim
 *   window for go-mainnet's time-lock rule, default 259200) · --priority-fee <micro-lamports per CU> (default devnet 0,
 *   mainnet 10000: about 0.000002 SOL a transaction).
 *
 * Dry run (the default) checks everything and sends nothing: three distinct valid wallet addresses (on the ed25519
 * curve, not the payer, attestor, crank, deployer, faucet, a program id or, on mainnet, a key file on this machine),
 * the cluster genesis, the Squads program and its ProgramConfig (the treasury and creation fee are READ from it), the
 * payer balance against the rent for both plus a margin, and a simulation of both creations (unsigned, so no RPC
 * ever holds a transaction it could broadcast).
 * --execute creates A then B (each seeded by a fresh one-time create key that is never stored), confirms each by
 * polling getSignatureStatuses, reads each back (lib/squads.mjs) and asserts 2-of-3, the time lock and no config
 * authority, then runs go-mainnet's Squads checks and writes deploy/<cluster>-squads.json (public data only). Mainnet
 * --execute needs an interactive terminal and the typed phrase below. A re-run resumes: created multisigs are verified,
 * not created again. Prints public keys only; the RPC is rpcUrl(cluster) (RPC_URL overrides; only its origin is shown).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join, relative, resolve } from 'node:path';
import { distinctnessProblems, windowProblems } from './go-mainnet.mjs';
import { b58decode, isAddress, isSignature } from './lib/b58.mjs';
import { readDeploy } from './lib/deployJson.mjs';
import { pubkey, readSecretKey } from './lib/keys.mjs';
import { Checks, fatal, fmtSol, head, info, ok, parseArgs, sleep } from './lib/log.mjs';
import { assertCluster, CLAIM_WINDOW, DEPLOY_DIR, explorerAddress, explorerTx, KEYS_DIR, PROGRAM_ID, SQUADS_V4_PROGRAM } from './lib/paths.mjs';
import { assertGenesis, getAccount, getBalance, label, rentExempt, rpc, rpcUrl } from './lib/rpc.mjs';
import { decodeMultisig, multisigProblems, squadsVaultPda } from './lib/squads.mjs';
import { ALL_PERMISSIONS, decodeProgramConfig, isMultisigAccount, multisigAccountSize, multisigCreateV2Ix, multisigPda, programConfigPda, SYSTEM_PROGRAM } from './lib/squadsCreate.mjs';

export const THRESHOLD = 2;
export const MEMBER_COUNT = 3;
/** The two multisigs, in creation order. `flag` is go-mainnet's option for it. */
export const SQUADS_SPECS = [
  { id: 'A', role: 'governance', name: 'Squads A (governance)', timeLock: 0, flag: '--squads-a' },
  { id: 'B', role: 'upgrade', name: 'Squads B (program upgrade authority)', timeLock: 604_800, flag: '--squads-b' },
];
export const CONFIRM_PHRASE = 'CREATE SQUADS ON MAINNET';
/** Added to rent + fees in the payer balance check. */
export const FEE_MARGIN = 5_000_000n;
/** A creation fee above this is refused (mainnet and devnet charge 0 today; read from ProgramConfig every run). */
export const MAX_CREATION_FEE = 100_000_000n;
export const DEFAULT_PRIORITY_FEE = { devnet: 0, mainnet: 10_000 };
const MAX_PRIORITY_FEE = 1_000_000;
const BASE_FEE_PER_SIGNATURE = 5_000n;

const USAGE = `usage: node scripts/create-squads.mjs --cluster devnet|mainnet --payer <keypair.json> --members <a,b,c> [--execute]
       [--keys-dir <dir>] [--deploy-dir <dir>] [--guardian <pubkey>] [--window <secs>] [--priority-fee <micro-lamports per CU>]`;

/**
 * `--members a,b,c` → { members, problems }. Never echoes a rejected value (it could be a pasted secret key).
 * @param {unknown} input
 */
export function parseMembers(input) {
  if (typeof input !== 'string' || !input.trim()) return { members: [], problems: ['--members <a,b,c> is required: three wallet addresses, comma separated'] };
  const members = input.split(',').map((s) => s.trim());
  const problems = [];
  if (members.length !== MEMBER_COUNT) problems.push(`exactly ${MEMBER_COUNT} members are needed, got ${members.length}`);
  members.forEach((m, i) => {
    if (isAddress(m)) return;
    let secretLike = false;
    try {
      secretLike = /^[1-9A-HJ-NP-Za-km-z]+$/.test(m) && b58decode(m).length === 64;
    } catch {
      /* not base58 */
    }
    problems.push(
      secretLike
        ? `member ${i + 1} is 64 bytes: that looks like a SECRET key. Never paste secret keys; use the wallet's public address`
        : `member ${i + 1} is not a valid address (${m.length} characters)`,
    );
  });
  const seen = new Set();
  for (const m of members) {
    if (m && seen.has(m)) problems.push(`member ${m} is listed twice; the three members must be different wallets`);
    seen.add(m);
  }
  return { members, problems };
}

/**
 * The message for a --payer value that is not a readable keypair file. Echoes the value only when it is plainly a
 * `.json` path: anything else (a pasted base58 secret, a JSON byte array) could be a secret key and is never printed.
 * @param {unknown} value
 * @param {string} message the keys.mjs error (which embeds the path built from `value`)
 */
export function payerErrorMessage(value, message) {
  if (typeof value === 'string' && /\.json$/i.test(value.trim()) && !/[[\],]/.test(value)) return `--payer: ${message}`;
  return '--payer must be the path of a keypair FILE (e.g. ~/wallet.json); the value given is not one and is not echoed (never paste a secret key)';
}

/**
 * Role and safety rules for the members. Returns { fail: string[], warn: string[] }.
 * @param {{ cluster: 'devnet'|'mainnet', members: string[], payer?: string|null,
 *           roles?: { attestor?: string|null, crank?: string|null, deployer?: string|null, faucet?: string|null, programId?: string|null },
 *           guardian?: string|null, hotKeys?: Map<string,string>, isOnCurve?: (a: string) => boolean }} o
 */
export function memberProblems({ cluster, members, payer = null, roles = {}, guardian = null, hotKeys = new Map(), isOnCurve }) {
  const fail = [];
  const warn = [];
  const forbidden = new Map();
  for (const [what, k] of [
    ['the payer', payer],
    ['the attestor', roles.attestor],
    ['the crank', roles.crank],
    ['the deployer', roles.deployer],
    ['the faucet', roles.faucet],
    ['the shop-vault program id', PROGRAM_ID],
    ['the recorded program id', roles.programId],
    ['the Squads program', SQUADS_V4_PROGRAM],
    ['the System program', SYSTEM_PROGRAM],
  ]) {
    if (k && !forbidden.has(k)) forbidden.set(k, what);
  }
  members.forEach((m, i) => {
    if (!isAddress(m)) return;
    const n = `member ${i + 1} ${m}`;
    if (forbidden.has(m)) fail.push(`${n} is ${forbidden.get(m)}; members must be their own (hardware) wallets`);
    if (isOnCurve && !isOnCurve(m)) fail.push(`${n} is off the ed25519 curve (a program-derived address): no wallet can sign for it`);
    const hot = hotKeys.get(m);
    if (hot) (cluster === 'mainnet' ? fail : warn).push(`${n} is the key file ${hot} on this machine; mainnet members must be hardware wallets`);
    if (guardian && m === guardian) warn.push(`${n} is also the guardian; a separate key per role is safer (SPEC I10)`);
  });
  return { fail, warn };
}

/** Network fee estimate of one creation (2 signatures + the priority fee on the default 200,000 CU limit). */
export function txFeeEstimate(priorityMicroLamports = 0) {
  return 2n * BASE_FEE_PER_SIGNATURE + (BigInt(priorityMicroLamports) * 200_000n + 999_999n) / 1_000_000n;
}

/** Lamports the payer needs to create `count` multisigs: rent + creation fee + network fees each, plus FEE_MARGIN. */
export function payerNeed({ rentEach, creationFee = 0n, count = SQUADS_SPECS.length, priorityMicroLamports = 0 }) {
  const n = BigInt(count);
  if (n === 0n) return 0n;
  return n * (BigInt(rentEach) + BigInt(creationFee) + txFeeEstimate(priorityMicroLamports)) + FEE_MARGIN;
}

/** 604800 → "7 days", 3600 → "1 hour", 90 → "90 s". */
export function humanDuration(s) {
  if (s > 0 && s % 86_400 === 0) return `${s / 86_400} day${s === 86_400 ? '' : 's'}`;
  if (s > 0 && s % 3_600 === 0) return `${s / 3_600} hour${s === 3_600 ? '' : 's'}`;
  return `${s} s`;
}

/** go-mainnet takes the MULTISIG addresses (it reads each account and derives vault 0 itself). */
export function goMainnetFlags({ multisigA, multisigB }) {
  return `--squads-a ${multisigA} --squads-b ${multisigB}`;
}

/**
 * The dry-run plan as printable lines (pure).
 * @param {{ cluster: string, rpc: string, payer: string|null, balance: bigint, need: bigint, members: string[],
 *           programConfig: string, treasury: string, creationFee: bigint, accountSize: number, rentEach: bigint,
 *           priorityMicroLamports: number,
 *           items: { spec: typeof SQUADS_SPECS[number], status: 'new'|'adopt'|'created', multisig: string, vault: string, simUnits?: number }[] }} p
 */
export function planLines(p) {
  const L = [];
  const toCreate = p.items.filter((i) => i.status === 'new').length;
  L.push(`cluster ${p.cluster} · RPC ${p.rpc}`);
  L.push(`Squads v4 program ${SQUADS_V4_PROGRAM}`);
  L.push(`ProgramConfig ${p.programConfig}: treasury ${p.treasury}, creation fee ${fmtSol(p.creationFee)} per multisig (read on chain)`);
  for (const it of p.items) {
    const tl = `time lock ${it.spec.timeLock} s${it.spec.timeLock ? ` (${humanDuration(it.spec.timeLock)})` : ''}`;
    L.push(`${it.spec.name}: ${THRESHOLD}-of-${p.members.length} · ${tl} · autonomous (no config authority) · no rent collector`);
    const what =
      it.status === 'new'
        ? `to create: multisig ${it.multisig} (fresh one-time create key), vault ${it.vault}${it.simUnits !== undefined ? ` · simulated OK, ${it.simUnits} CU` : ''}`
        : it.status === 'adopt'
          ? `landed in an earlier run: multisig ${it.multisig}, vault ${it.vault} (adopted, not created again)`
          : `already created: multisig ${it.multisig}, vault ${it.vault}`;
    L.push(`    ${what}`);
  }
  L.push(`members of both (permissions Initiate|Vote|Execute = ${ALL_PERMISSIONS}):`);
  p.members.forEach((m, i) => L.push(`    ${i + 1}. ${m}`));
  if (toCreate) {
    const rent = p.rentEach * BigInt(toCreate);
    const fees = (txFeeEstimate(p.priorityMicroLamports) + p.creationFee) * BigInt(toCreate);
    L.push(`estimated cost: ${toCreate} × ${p.accountSize}-byte account rent ${fmtSol(p.rentEach)} = ${fmtSol(rent)} (stays in the multisig accounts) + ${fmtSol(fees)} fees`);
    L.push(`payer ${p.payer} (creator and fee payer): balance ${fmtSol(p.balance)}, needs ≥ ${fmtSol(p.need)} (incl. a ${fmtSol(FEE_MARGIN)} margin)`);
  } else {
    L.push('nothing to create: both multisigs exist');
  }
  return L;
}

/**
 * What the created account must be (beyond go-mainnet's multisigProblems). Returns problem strings.
 * @param {ReturnType<typeof decodeMultisig>} ms
 * @param {{ threshold?: number, timeLock: number, members: string[] }} want
 */
export function createdProblems(ms, { threshold = THRESHOLD, timeLock, members }) {
  const p = [];
  if (ms.threshold !== threshold) p.push(`threshold is ${ms.threshold}, expected ${threshold}`);
  if (ms.members.length !== members.length) p.push(`${ms.members.length} members, expected ${members.length}`);
  const got = ms.members.map((m) => m.key).sort();
  const want = [...members].sort();
  if (got.join(',') !== want.join(',')) p.push(`members on chain (${got.join(', ')}) are not the requested ones`);
  for (const m of ms.members) if (m.permissions !== ALL_PERMISSIONS) p.push(`member ${m.key} has permission mask ${m.permissions}, expected ${ALL_PERMISSIONS}`);
  if (ms.timeLock !== timeLock) p.push(`time lock is ${ms.timeLock} s, expected ${timeLock} s`);
  if (ms.configAuthority) p.push(`config authority is ${ms.configAuthority}, expected none (autonomous)`);
  if (ms.rentCollector) p.push(`rent collector is ${ms.rentCollector}, expected none`);
  return p;
}

/** go-mainnet's cross checks for the pair (SPEC §11, T11b, I10). Returns problem strings. */
export function pairProblems({ A, B, windowSecs, roles = {} }) {
  const p = [];
  if (A.multisig === B.multisig) p.push('governance and upgrade authority must be DIFFERENT multisigs (SPEC §11)');
  p.push(...windowProblems(windowSecs, A.timeLock));
  p.push(...distinctnessProblems({ attestor: roles.attestor, guardian: roles.guardian, governance: A.vault, upgradeAuthority: B.vault, payer: roles.payer, crank: roles.crank }));
  return p;
}

// ------------------------------------------------------------------------------------------- deploy/<cluster>-squads.json
const RECORD_ADDRESSES = ['squadsProgram', 'multisigA', 'vaultA', 'pendingA', 'multisigB', 'vaultB', 'pendingB'];
const RECORD_NUMBERS = ['threshold', 'timeLockA', 'timeLockB'];
const RECORD_STRINGS = ['cluster', 'createdAt', 'updatedAt'];
const RECORD_ORDER = ['cluster', 'squadsProgram', 'threshold', 'multisigA', 'vaultA', 'timeLockA', 'pendingA', 'multisigB', 'vaultB', 'timeLockB', 'pendingB', 'members', 'createdAt', 'updatedAt', 'signatures'];

export function squadsRecordPath(cluster, dir = DEPLOY_DIR) {
  return join(dir, `${assertCluster(cluster)}-squads.json`);
}

/** Problems with a record (public schema only, so a secret can never land in this committed file). */
export function recordProblems(rec) {
  const p = [];
  for (const [k, v] of Object.entries(rec)) {
    if (RECORD_ADDRESSES.includes(k)) {
      if (!isAddress(v)) p.push(`${k} is not an address`);
    } else if (RECORD_NUMBERS.includes(k)) {
      if (!Number.isSafeInteger(v)) p.push(`${k} is not an integer`);
    } else if (RECORD_STRINGS.includes(k)) {
      if (typeof v !== 'string' || v.length > 64) p.push(`${k} is not a short string`);
    } else if (k === 'members') {
      if (!Array.isArray(v) || v.length !== MEMBER_COUNT || !v.every(isAddress)) p.push('members must be 3 addresses');
    } else if (k === 'signatures') {
      if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.entries(v).every(([id, s]) => (id === 'A' || id === 'B') && isSignature(s))) {
        p.push('signatures must be { A?, B? } transaction signatures');
      }
    } else p.push(`unknown field ${k}`);
  }
  return p;
}

export function readSquadsRecord(cluster, dir = DEPLOY_DIR) {
  const f = squadsRecordPath(cluster, dir);
  if (!existsSync(f)) return null;
  const rec = JSON.parse(readFileSync(f, 'utf8'));
  const p = recordProblems(rec);
  if (p.length) throw new Error(`${f}: ${p.join('; ')}`);
  return rec;
}

/** Merge `patch` (null deletes a field) into deploy/<cluster>-squads.json, validate, write atomically. */
export function writeSquadsRecord(cluster, patch, dir = DEPLOY_DIR) {
  const next = { ...(readSquadsRecord(cluster, dir) ?? {}), cluster };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  next.updatedAt = new Date().toISOString();
  const p = recordProblems(next);
  if (p.length) throw new Error(`refusing to write ${squadsRecordPath(cluster, dir)}: ${p.join('; ')}`);
  const sorted = {};
  for (const k of RECORD_ORDER) if (k in next) sorted[k] = next[k];
  mkdirSync(dir, { recursive: true });
  const f = squadsRecordPath(cluster, dir);
  writeFileSync(`${f}.tmp`, `${JSON.stringify(sorted, null, 2)}\n`);
  renameSync(`${f}.tmp`, f);
  return sorted;
}

// ------------------------------------------------------------------------------------------- chain helpers
/** Read a multisig back and apply createdProblems + go-mainnet's multisigProblems. */
export async function verifyMultisig(url, address, spec, members, windowSecs) {
  const acc = await getAccount(url, address);
  if (!acc) return { problems: [`${address} does not exist`] };
  if (acc.owner !== SQUADS_V4_PROGRAM) return { problems: [`${address} is not owned by the Squads v4 program`] };
  if (!isMultisigAccount(acc.data)) return { problems: [`${address} is not a Squads v4 Multisig account`] };
  const decoded = decodeMultisig(acc.data);
  const vault = await squadsVaultPda(address, 0);
  const problems = [...createdProblems(decoded, { timeLock: spec.timeLock, members }), ...multisigProblems(decoded, { role: spec.role, claimWindowSecs: windowSecs })];
  return { decoded, vault, problems: [...new Set(problems)] };
}

/** The signature that created an account (its oldest), or null. */
async function creationSignature(url, address) {
  try {
    const r = await rpc(url, 'getSignaturesForAddress', [address, { limit: 20, commitment: 'confirmed' }]);
    return r.length ? r[r.length - 1].signature : null;
  } catch {
    return null;
  }
}

/** Public key → file name for every keypair file in `dir` (hot keys on this machine). */
function keyFiles(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      out.set(pubkey(join(dir, f)), f);
    } catch {
      /* not a keypair file */
    }
  }
  return out;
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

// ------------------------------------------------------------------------------------------- main
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), ['execute', 'help']);
  } catch (e) {
    fatal(e.message, 64); // e.g. --execute=false: on/off flags take no value
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const cluster = args.cluster;
  if (cluster !== 'devnet' && cluster !== 'mainnet') fatal(`--cluster devnet|mainnet is required\n${USAGE}`, 64);
  // only a bare --execute sends: `--execute=false` / `--execute=0` must never mean "send"
  if (args.execute !== undefined && args.execute !== true) fatal(`--execute takes no value (dry run is the default; omit it to send nothing)\n${USAGE}`, 64);
  const execute = args.execute === true;
  const windowSecs = args.window === undefined ? CLAIM_WINDOW.mainnet : Number(args.window);
  if (!Number.isSafeInteger(windowSecs) || windowSecs <= 0) fatal('--window <secs> must be a positive integer', 64);
  const priority = args['priority-fee'] === undefined ? DEFAULT_PRIORITY_FEE[cluster] : Number(args['priority-fee']);
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > MAX_PRIORITY_FEE) fatal(`--priority-fee must be 0..${MAX_PRIORITY_FEE} micro-lamports per CU`, 64);
  const keysDir = typeof args['keys-dir'] === 'string' ? resolve(args['keys-dir']) : KEYS_DIR;
  const deployDir = typeof args['deploy-dir'] === 'string' ? resolve(args['deploy-dir']) : DEPLOY_DIR;

  let rec;
  try {
    rec = readSquadsRecord(cluster, deployDir);
  } catch (e) {
    fatal(e.message, 1);
  }
  const complete = !!(rec?.multisigA && rec?.multisigB);

  // ---- inputs (no network yet)
  let payerPath = null;
  let payerPk = null;
  if (typeof args.payer === 'string') {
    try {
      payerPk = pubkey(args.payer);
      payerPath = args.payer;
    } catch (e) {
      fatal(payerErrorMessage(args.payer, e.message), 64);
    }
  } else if (!complete) fatal(`--payer <keypair.json> is required (it pays the rent and signs as creator)\n${USAGE}`, 64);

  let members = rec?.members ?? null;
  if (args.members !== undefined) {
    const parsed = parseMembers(args.members);
    if (parsed.problems.length) fatal(`--members: ${parsed.problems.join('; ')}`, 64);
    if (rec?.members && !sameSet(parsed.members, rec.members)) {
      fatal(`deploy/${cluster}-squads.json already records multisigs for other members (${rec.members.join(', ')}); finish or verify those, or move that file away to start a new pair`, 64);
    }
    members = parsed.members;
  } else if (!members) fatal(`--members <a,b,c> is required\n${USAGE}`, 64);

  const dep = readDeploy(cluster) ?? {};
  const roleKey = (name) => {
    const f = join(keysDir, `${cluster}-${name}.json`);
    if (existsSync(f)) {
      try {
        return pubkey(f);
      } catch (e) {
        fatal(`${cluster}-${name}.json: ${e.message}`, 1);
      }
    }
    return dep[name] ?? null;
  };
  const roles = { attestor: roleKey('attestor'), crank: roleKey('crank'), deployer: dep.deployer ?? null, faucet: dep.faucet ?? null, programId: dep.programId ?? null };
  const guardian = typeof args.guardian === 'string' ? args.guardian : (dep.guardian ?? null);
  if (guardian && !isAddress(guardian)) fatal('--guardian must be an address', 64);
  if (cluster === 'mainnet' && execute && !(process.stdin.isTTY && process.stdout.isTTY)) fatal('mainnet --execute needs an interactive terminal (you type a confirmation phrase)', 64);

  const { web3, connection, buildTx, simulateAndSend } = await import('./lib/web3.mjs');
  const isOnCurve = (a) => web3.PublicKey.isOnCurve(new web3.PublicKey(a).toBytes());
  // hot keys = every keypair file in the repo's .keys AND in --keys-dir (a different --keys-dir must not hide .keys)
  const hotKeys = new Map([...keyFiles(KEYS_DIR), ...keyFiles(keysDir)]);
  const mp = memberProblems({ cluster, members, payer: payerPk, roles, guardian, hotKeys, isOnCurve });

  // ---- chain
  const url = rpcUrl(cluster);
  head(`create-squads · ${cluster} · ${label(url)}${process.env.RPC_URL ? ' (RPC_URL)' : ''} · ${execute ? 'EXECUTE' : 'DRY RUN (nothing is sent)'}`);
  const checks = new Checks();
  await assertGenesis(url, cluster);
  checks.pass('genesis', `${cluster}`);
  for (const w of mp.warn) checks.warn('member', w);
  for (const f of mp.fail) checks.fail('member', f);
  if (!mp.fail.length) checks.pass('members', `${members.length} distinct wallet addresses; none is the payer, attestor, crank, deployer or a program id`);

  const prog = await getAccount(url, SQUADS_V4_PROGRAM);
  if (!checks.check(!!prog?.executable, 'Squads v4 program', prog?.executable ? `${SQUADS_V4_PROGRAM} is deployed` : `${SQUADS_V4_PROGRAM} is not deployed on ${cluster}`)) {
    checks.summary('create-squads');
    process.exit(1);
  }
  const pcAddr = await programConfigPda();
  const pcAcc = await getAccount(url, pcAddr);
  if (!pcAcc || pcAcc.owner !== SQUADS_V4_PROGRAM) fatal(`Squads ProgramConfig ${pcAddr} is missing on ${cluster}`, 1);
  const pc = decodeProgramConfig(pcAcc.data);
  checks.pass('ProgramConfig', `${pcAddr}: treasury ${pc.treasury}, creation fee ${fmtSol(pc.multisigCreationFee)}`);
  if (pc.multisigCreationFee > MAX_CREATION_FEE) checks.fail('creation fee', `${fmtSol(pc.multisigCreationFee)} per multisig is above ${fmtSol(MAX_CREATION_FEE)}; check Squads' current pricing before paying it`);
  else if (pc.multisigCreationFee > 0n) checks.warn('creation fee', `Squads charges ${fmtSol(pc.multisigCreationFee)} per multisig (to its treasury)`);

  // ---- what exists already (resume), what is new
  const items = [];
  for (const spec of SQUADS_SPECS) {
    const recorded = rec?.[`multisig${spec.id}`];
    if (recorded) {
      items.push({ spec, status: 'created', multisig: recorded, signature: rec.signatures?.[spec.id] ?? null });
      continue;
    }
    const pending = rec?.[`pending${spec.id}`];
    if (pending && (await getAccount(url, pending))) {
      items.push({ spec, status: 'adopt', multisig: pending });
      continue;
    }
    let createKey;
    let multisig;
    do {
      createKey = web3.Keypair.generate();
      multisig = await multisigPda(createKey.publicKey.toBase58());
    } while (await getAccount(url, multisig));
    items.push({ spec, status: 'new', multisig, createKey });
  }
  for (const it of items) {
    it.vault = await squadsVaultPda(it.multisig, 0);
    if (it.status === 'new') continue;
    const v = await verifyMultisig(url, it.multisig, it.spec, members, windowSecs);
    if (v.problems.length) for (const p of v.problems) checks.fail(it.spec.name, p);
    else checks.pass(it.spec.name, `${it.status === 'adopt' ? 'landed earlier, adopted' : 'recorded'}: ${it.multisig} is ${THRESHOLD}-of-${members.length}, time lock ${it.spec.timeLock} s, autonomous`);
  }

  const toCreate = items.filter((i) => i.status === 'new');
  const accountSize = multisigAccountSize(members.length);
  const rentEach = await rentExempt(url, accountSize);
  const need = payerNeed({ rentEach, creationFee: pc.multisigCreationFee, count: toCreate.length, priorityMicroLamports: priority });
  const balance = payerPk ? await getBalance(url, payerPk) : 0n;
  if (toCreate.length) checks.check(balance >= need, 'payer balance', `${payerPk}: ${fmtSol(balance)} ${balance >= need ? '≥' : '<'} ${fmtSol(need)} (rent for ${toCreate.length} + fees + margin)`);

  const conn = connection(url);
  // Signed only to send. The dry run simulates an UNSIGNED transaction (sigVerify off), so it never hands an RPC a
  // valid signed transaction that someone could broadcast.
  const buildCreate = async (it, signers = []) => {
    const ix = await multisigCreateV2Ix(
      { programConfig: pcAddr, treasury: pc.treasury, multisig: it.multisig, createKey: it.createKey.publicKey.toBase58(), creator: payerPk },
      { threshold: THRESHOLD, members: members.map((key) => ({ key, permissions: ALL_PERMISSIONS })), timeLock: it.spec.timeLock, configAuthority: null, rentCollector: null, memo: null },
    );
    const ixs = priority > 0 ? [web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }), ix] : [ix];
    return buildTx(conn, new web3.PublicKey(payerPk), ixs, signers);
  };
  if (toCreate.length && !checks.failed.length) {
    for (const it of toCreate) {
      try {
        const r = await simulateAndSend(conn, await buildCreate(it), { execute: false, sigVerify: false, label: `create ${it.spec.name}` });
        it.simUnits = r.unitsConsumed;
        checks.pass(`simulate ${it.spec.name}`, `OK (${r.unitsConsumed} CU)`);
      } catch (e) {
        checks.fail(`simulate ${it.spec.name}`, e.message);
      }
    }
  }

  head('plan');
  for (const l of planLines({ cluster, rpc: label(url), payer: payerPk, balance, need, members, programConfig: pcAddr, treasury: pc.treasury, creationFee: pc.multisigCreationFee, accountSize, rentEach, priorityMicroLamports: priority, items })) {
    console.log(`  ${l}`);
  }
  const green = checks.summary('create-squads checks');
  if (!green) process.exit(1);

  if (!execute) {
    if (toCreate.length) {
      console.log('\nDry run complete. Nothing was sent. Add --execute to create them.');
      return;
    }
  } else if (toCreate.length) {
    if (cluster === 'mainnet') {
      console.log(`\n  This creates ${toCreate.length} Squads multisig${toCreate.length > 1 ? 's' : ''} on MAINNET, paid by ${payerPk} (about ${fmtSol(need - FEE_MARGIN)}).`);
      console.log('  Their members, threshold and time lock can only change later by a 2-of-3 vote of these members.');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const a = (await rl.question(`  Type the phrase to continue (${CONFIRM_PHRASE}): `)).trim();
        if (a !== CONFIRM_PHRASE) fatal('phrase mismatch; nothing was sent', 1);
      } finally {
        rl.close();
      }
    }
    head('create');
    const payerKp = web3.Keypair.fromSecretKey(readSecretKey(payerPath));
    const base ={ squadsProgram: SQUADS_V4_PROGRAM, threshold: THRESHOLD, timeLockA: SQUADS_SPECS[0].timeLock, timeLockB: SQUADS_SPECS[1].timeLock, members };
    for (const it of toCreate) {
      // recorded before sending, so a re-run after a crash or timeout adopts it instead of creating a second one
      rec = writeSquadsRecord(cluster, { ...base, [`pending${it.spec.id}`]: it.multisig }, deployDir);
      const r = await simulateAndSend(conn, await buildCreate(it, [payerKp, it.createKey]), { execute: true, label: `create ${it.spec.name}` });
      it.signature = r.signature;
      ok(`${it.spec.name} created: multisig ${it.multisig} — ${explorerTx(r.signature, cluster)}`);
      // a load-balanced RPC can answer getAccountInfo from a node a slot behind the one that confirmed the signature
      let v = await verifyMultisig(url, it.multisig, it.spec, members, windowSecs);
      for (let i = 0; i < 8 && !v.decoded; i++) {
        await sleep(1_000);
        v = await verifyMultisig(url, it.multisig, it.spec, members, windowSecs);
      }
      rec = writeSquadsRecord(cluster, {
        [`multisig${it.spec.id}`]: it.multisig,
        [`vault${it.spec.id}`]: v.vault ?? it.vault,
        [`pending${it.spec.id}`]: null,
        signatures: { ...(rec.signatures ?? {}), [it.spec.id]: r.signature },
        createdAt: rec.createdAt ?? new Date().toISOString(),
      }, deployDir);
      if (v.problems.length) fatal(`${it.spec.name} read back wrong: ${v.problems.join('; ')}`, 1);
      ok(`${it.spec.name} read back: ${v.decoded.threshold}-of-${v.decoded.members.length}, time lock ${v.decoded.timeLock} s, config authority none (autonomous), vault ${v.vault}`);
    }
  }

  // adopted (landed in an earlier run): record them now
  const adopted = items.filter((i) => i.status === 'adopt');
  if (execute && adopted.length) {
    for (const it of adopted) {
      const sig = await creationSignature(url, it.multisig);
      rec = writeSquadsRecord(cluster, {
        members,
        [`multisig${it.spec.id}`]: it.multisig,
        [`vault${it.spec.id}`]: it.vault,
        [`pending${it.spec.id}`]: null,
        ...(sig ? { signatures: { ...(rec?.signatures ?? {}), [it.spec.id]: sig } } : {}),
        createdAt: rec?.createdAt ?? new Date().toISOString(),
      }, deployDir);
      ok(`${it.spec.name} recorded (it landed in an earlier run): ${it.multisig}`);
    }
  }
  if (!execute && items.some((i) => i.status !== 'created')) {
    console.log('\nDry run complete. Nothing was sent. Add --execute to record them.');
    return;
  }

  // ---- go-mainnet's cross checks on the finished pair
  const A = items[0];
  const B = items[1];
  head(`go-mainnet Squads checks (claim window ${windowSecs} s)`);
  const pp = pairProblems({ A: { multisig: A.multisig, vault: A.vault, timeLock: A.spec.timeLock }, B: { multisig: B.multisig, vault: B.vault }, windowSecs, roles: { ...roles, guardian, payer: payerPk } });
  for (const p of pp) checks.fail('Squads A/B', p);
  if (!pp.length) checks.pass('Squads A/B', `different multisigs; A's time lock ${A.spec.timeLock} s + 24 h < claim window ${windowSecs} s; vaults distinct from the attestor, guardian, crank and payer`);
  for (const it of items) {
    const v = await verifyMultisig(url, it.multisig, it.spec, members, windowSecs);
    if (v.problems.length) for (const p of v.problems) checks.fail(it.spec.name, p);
    else checks.pass(`${it.spec.name}`, `${v.decoded.threshold}-of-${v.decoded.members.length}, time lock ${v.decoded.timeLock} s, vault ${v.vault} — ${explorerAddress(it.multisig, cluster)}`);
  }
  const done = checks.summary('create-squads');
  if (rec) info(`record: ${relative(process.cwd(), squadsRecordPath(cluster, deployDir))}`);

  head('go-mainnet flags (the MULTISIG addresses, not the vaults: go-mainnet reads each multisig and derives vault 0)');
  console.log(`  ${goMainnetFlags({ multisigA: A.multisig, multisigB: B.multisig })}`);
  console.log(`  e.g. node scripts/go-mainnet.mjs --dry-run --deployer <wallet.json> --guardian <hardware wallet> ${goMainnetFlags({ multisigA: A.multisig, multisigB: B.multisig })}`);
  info(`governance is handed to vault A ${A.vault}; the upgrade authority to vault B ${B.vault} (go-mainnet prints both steps after go-live)`);
  if (cluster === 'devnet') info('go-mainnet reads mainnet only: this devnet pair proves the flow; create the real pair with --cluster mainnet');
  process.exit(done ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fatal(e.message));
}
