#!/usr/bin/env node
/**
 * GO MAINNET (INTEGRATION §10.3, SPEC §11). Scripted, checked, HUMAN-STARTED. Never run --execute from automation.
 *
 *   node scripts/go-mainnet.mjs                         # = --dry-run: every preflight, read-only; lists what is missing
 *   node scripts/go-mainnet.mjs --dry-run --deployer ~/wallet.json --guardian <pubkey> --squads-a <multisig> --squads-b <multisig>
 *   node scripts/go-mainnet.mjs --execute  (same flags; interactive TTY; typed confirmations; the phrase below)
 *   node scripts/go-mainnet.mjs --propose-governance --deployer ~/wallet.json   # after go-live: hand governance to Squads A
 *
 * Options: --deployer <keypair.json> (your funded wallet; only used to sign, never printed) · --deployer-pubkey <addr>
 *   (dry run without the key file) · --guardian <pubkey> (hardware wallet) · --squads-a <multisig> (governance) ·
 *   --squads-b <multisig> (upgrade authority) · --window <secs> (259200) · --upgrade (program already deployed) ·
 *   --create-keys (create .keys/mainnet-{attestor,crank}.json + mainnet-hmac.key) · --record (save the public inputs to
 *   deploy/mainnet.json) · --verify (run the reproducible-build check in a dry run too; slow, needs Docker) ·
 *   --build (run programs/shop-vault/scripts/build.sh first) · --skip-app-build · --allow-hot-guardian ·
 *   --verified-artifact <dir> (the unzipped CI verifiable-build artifact: hash check instead of a local Docker build) ·
 *   --waive-graduation "<reason>" (pump's devnet migration bot never migrates: the GRADUATE=1 e2e is waived, the
 *   reason is recorded in scripts/out/go-mainnet-state.json)
 *   RPC_URL=<your mainnet endpoint> to deploy through a private RPC (only its origin is printed).
 *   Devnet evidence (e2e, graduation, accuracy audit) must be newer than the latest devnet deploy record in
 *   scripts/out and at most 7 days old (lib/evidence.mjs).
 *
 * Preflight (✓/✗, no secret printed): toolchain · artifact (size < 40,960 B, mainnet marker only, verified build,
 * SBPF version vs SIMD-0500) · mainnet genesis + program state · deployer balance vs the rent estimate · keys
 * (attestor/crank/hmac, guardian, Squads A/B multisigs decoded on chain: threshold ≥ 2 of ≥ 3, autonomous,
 * A's time lock < claim window − 24 h) and SPEC I10 distinctness · claim window ≥ 72 h · secret SOURCES present
 * (Alchemy, Google, Turnstile, an owner-alert channel: the webhook or the free email; Twilio optional, all three or none) ·
 * wrangler env.mainnet (H6 flags) + D1 + no DEV_FAUCET_SECRET on the Worker · build:mainnet + check-bundle (client +
 * Worker dry-run bundle) · devnet sign-off evidence · MAINNET-CHECKLIST.md all ticked. --execute adds typed
 * confirmations (Squads A time lock, Twilio code length + voice geo permissions when Twilio is set, Google referrer
 * for the mainnet PUBLIC_ORIGIN, https://atlaspad.online/*, Workers Paid) and the phrase `DEPLOY ATLASPAD TO MAINNET`.
 * The site's origin comes from wrangler.jsonc env.mainnet (lib/origin.mjs), which also has to carry the
 * atlaspad.online + www custom domains; a read-only DNS lookup checks the zone is on Cloudflare.
 *
 * Execute (SPEC §11 order; each step checks the chain first, so a re-run resumes):
 *   1 program deploy (target/deploy/shop_vault.so, --max-len = size, buffer .keys/mainnet-deploy-buffer.json)
 *   2 initialize_config(attestor_mainnet, governance = deployer, guardian, window) → flavor 0, rotation 604800, marker
 *   3 create + freeze the ALT → deploy/mainnet.json         4 crank top-up 0.1 SOL
 *   5 D1 cornershop-mainnet + migrations                    6 secrets (one `secret bulk`, stdin; never DEV_FAUCET_SECRET)
 *   7 build:mainnet + check-bundle                          8 `wrangler deploy --env mainnet` (REPLACES THE DEMO)
 *   9 smoke (read-only) and admin_expectations for the Squads A handover   10 the manual follow-ups, printed
 * Rollback of the Worker: `npx wrangler rollback --env mainnet` (the demo version id is printed before step 8).
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { parseSol } from './lib/amounts.mjs';
import { b58encode, isAddress } from './lib/b58.mjs';
import { readChecklist } from './lib/checklist.mjs';
import { readDeploy, writeDeploy } from './lib/deployJson.mjs';
import { alchemySourceName, envValue, isPlainEmailAddress } from './lib/env.mjs';
import { DEVNET_GRADUATION_POOL, graduationWaiver, latestDevnetDeploy, reportTime, staleReason } from './lib/evidence.mjs';
import { ensureKey, ensureRandomKey, keyPath, pubkey, readSecretKey } from './lib/keys.mjs';
import { Checks, fmtSol, head, info, ok, parseArgs, warn } from './lib/log.mjs';
import { originProblems, publicOrigin, zoneProblems } from './lib/origin.mjs';
import { CLAIM_WINDOW, CONFIG_PDA, GENESIS, KEYS_DIR, OUT_DIR, PROGRAM_DIR, PROGRAM_ID, PUBLIC_RPC, ROOT, SQUADS_V4_PROGRAM, WORKER_NAMES, WORKERS_DEV_ORIGINS, explorerTx } from './lib/paths.mjs';
import { hasCommand, run } from './lib/proc.mjs';
import { artifactInfo, deployedProgram, programDeployCost, simd0500Active } from './lib/program.mjs';
import { assertGenesis, getAccount, getBalance, label, rentExempt } from './lib/rpc.mjs';
import { collectSecrets, putSecretsBulk } from './lib/secretPut.mjs';
import { decodeMultisig, multisigProblems, squadsVaultPda } from './lib/squads.mjs';
import { readVerifiedArtifact, sourceDriftProblems, verifiedArtifactProblems } from './lib/verifiedBuild.mjs';
import { d1Ensure, d1Execute, d1MigrateRemote, d1Uuid, deploymentsList, envConfig, envProblems, expectedAccountId, pendingMigrations, readWranglerConfig, replaceD1Placeholder, secretNames, whoamiMatches, wrangler, WRANGLER_LOGIN_FIX } from './lib/wrangler.mjs';

export const PHRASE = 'DEPLOY ATLASPAD TO MAINNET';
/** The mainnet site (wrangler.jsonc env.mainnet.vars.PUBLIC_ORIGIN, default https://atlaspad.online). */
export const MAINNET_ORIGIN = publicOrigin('mainnet');
/** The Google browser key confirmation: the key must allow the mainnet site as an HTTP referrer. */
export const googleReferrerPrompt = (origin = MAINNET_ORIGIN) => `the Google browser key allows the referrer ${origin}/*`;
/**
 * The Cloudflare plan confirmation. Workers Free (100,000 requests a day, 10 ms CPU) is enough for a quiet soft launch
 * only with the reference co-sign check off (env.mainnet POLICY_REFERENCE "0": its cold start costs 25-55 ms CPU); the
 * strict policy gate (worker/policy.ts) stays on either way.
 */
export const workersPlanPrompt = (policyReference) =>
  policyReference === '0'
    ? 'Workers Free is enough for now: the reference co-sign check is off (POLICY_REFERENCE "0"); you move to Workers Paid ($5/month) and set it back to "1" before traffic grows past ~100,000 requests a day'
    : 'the Cloudflare account is on Workers Paid ($5/month)';
// The owner sends 0.6 SOL, then create-squads.mjs pays ≈0.004 SOL of Squads rent from it; the computed need is ≈0.49
// (35,928 B program at mainnet rent on 2026-10-27, the 0.1 SOL crank included), so the floor keeps ≈0.1 SOL spare.
export const MIN_DEPLOYER = parseSol('0.59');
// The crank pays every finalize_claim / fee-collect fee and pump's creator-vault rent per coin; the watchdog warns below
// 0.02 SOL and fails below 0.005 SOL (scripts/watchdog.mjs crankFinding).
export const CRANK_TARGET = parseSol('0.1');
/**
 * Program upload: write transactions retry up to DEPLOY_SIGN_ATTEMPTS times (the CLI default of 5 gave up on a free
 * Alchemy plan's per-second limit, 2026-10-27) with a small priority fee (µlamports per CU; env DEPLOY_CU_PRICE).
 */
export const DEPLOY_SIGN_ATTEMPTS = 100;
export const DEPLOY_CU_PRICE = Number(process.env.DEPLOY_CU_PRICE ?? 10_000);
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

/**
 * Lamports already parked in a resumable upload buffer (.keys/mainnet-deploy-buffer.json) whose authority is the
 * deployer: a failed deploy leaves them there and the re-run reuses that buffer, so they count towards the deployer's
 * funds. 0 when there is no such buffer.
 */
export function parkedBufferLamports(acc, deployerPk) {
  if (!acc || acc.owner !== UPGRADEABLE_LOADER || acc.data.length < 37) return 0n;
  // UpgradeableLoaderState::Buffer = tag u32 1, then Option<Pubkey> authority (1 + 32 bytes)
  if (acc.data.readUInt32LE(0) !== 1 || acc.data[4] !== 1) return 0n;
  return b58encode(acc.data.subarray(5, 37)) === deployerPk ? acc.lamports : 0n;
}
export const REQUIRED_MAINNET_SECRETS = ['ALCHEMY_API_KEY', 'GOOGLE_SERVER_KEY', 'ATTESTOR_SECRET', 'CRANK_SECRET', 'HMAC_KEY'];
export const TWILIO_SECRETS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SID'];

/**
 * Phone verification on mainnet is optional (it starts without Twilio): 'call' with all three TWILIO_* sources,
 * 'none' with none of them (owners verify with a website code; the Worker reports phoneVerification 'none'), 'partial'
 * otherwise (a mistake: the Worker would treat it as 'none').
 */
export function phoneSetup(missingOptional) {
  const missing = TWILIO_SECRETS.filter((n) => missingOptional.includes(n)).length;
  return missing === 0 ? 'call' : missing === TWILIO_SECRETS.length ? 'none' : 'partial';
}

/**
 * The owner-alert channels the secret sources set up (worker/notify.ts; either one is enough): 'webhook'
 * (ALERT_WEBHOOK_URL, a Discord or Slack webhook) and 'email' (ALERT_EMAIL_TO, free: Cloudflare Email Routing sends it
 * through the Worker's ALERT_EMAIL binding to that verified address).
 */
export function alertChannels(missingOptional) {
  const out = [];
  if (!missingOptional.includes('ALERT_WEBHOOK_URL')) out.push('webhook');
  if (!missingOptional.includes('ALERT_EMAIL_TO')) out.push('email');
  return out;
}

/** The pass line for the alert channels. */
export function alertChannelsText(channels) {
  const parts = [];
  if (channels.includes('email')) parts.push('email to ALERT_EMAIL_TO from alerts@atlaspad.online (Cloudflare Email Routing, free)');
  if (channels.includes('webhook')) parts.push('Discord/Slack webhook (ALERT_WEBHOOK_URL)');
  return `${parts.join(' + ')}: every claim, dispute, report and opt-out`;
}

export const ALERT_CHANNEL_FIX =
  'add ALERT_EMAIL_TO=<an address verified in Cloudflare Email Routing> to .env.server (free: the Worker emails your alerts from alerts@atlaspad.online), or a Discord channel webhook as ALERT_WEBHOOK_URL';

/**
 * The optional-secret mistakes that stop a mainnet deploy: a partial Twilio setup, and no owner-alert channel. Every
 * claim, dispute, report and opt-out alerts the site owner (ALERT_EMAIL_TO and/or ALERT_WEBHOOK_URL), and website-code
 * claims (a weaker proof than a call, on with or without Twilio) need a human check before they unlock, so one channel
 * is always required. Returns [{ name, detail, fix }].
 */
export function optionalSecretProblems(missingOptional) {
  const out = [];
  if (phoneSetup(missingOptional) === 'partial') {
    const missing = TWILIO_SECRETS.filter((n) => missingOptional.includes(n)).join(', ');
    out.push({ name: 'phone verification', detail: `only some TWILIO_* sources are present (${missing} missing)`, fix: 'add all three TWILIO_* values to .env.server, or none of them' });
  }
  if (!alertChannels(missingOptional).length) {
    out.push({
      name: 'owner alerts',
      detail: 'neither ALERT_EMAIL_TO nor ALERT_WEBHOOK_URL is set: nobody would hear about website-code claims before they unlock',
      fix: ALERT_CHANNEL_FIX,
    });
  }
  return out;
}

/**
 * With ALERT_EMAIL_TO set: it is one plain address, and wrangler.jsonc env.mainnet (`envCfg`) has the unrestricted
 * send_email binding ALERT_EMAIL (no destination address: the recipient is the secret, never a committed file) and,
 * when set, an ALERT_EMAIL_FROM on atlaspad.online or the site's own host. `emailTo` is only tested, never printed.
 * Returns [{ name, detail, fix }].
 */
export function alertEmailProblems({ emailTo, envCfg, origin = MAINNET_ORIGIN }) {
  const out = [];
  if (!isPlainEmailAddress(emailTo)) {
    out.push({ name: 'ALERT_EMAIL_TO', detail: 'is not one plain email address (name@example.com)', fix: 'set ALERT_EMAIL_TO in .env.server to the address verified in Cloudflare Email Routing (dashboard → atlaspad.online → Email → Email Routing → Destination addresses)' });
  }
  const bindings = (Array.isArray(envCfg?.send_email) ? envCfg.send_email : []).filter((b) => b?.name === 'ALERT_EMAIL');
  if (!bindings.length) {
    out.push({ name: 'ALERT_EMAIL binding', detail: 'ALERT_EMAIL_TO is set but wrangler.jsonc env.mainnet has no send_email binding ALERT_EMAIL', fix: 'add "send_email": [{ "name": "ALERT_EMAIL" }] to env.mainnet in wrangler.jsonc' });
  }
  if (bindings.some((b) => b.destination_address || b.allowed_destination_addresses)) {
    out.push({ name: 'ALERT_EMAIL binding', detail: 'names a destination address in wrangler.jsonc (a committed file)', fix: 'remove destination_address / allowed_destination_addresses from env.mainnet.send_email: the recipient is the ALERT_EMAIL_TO secret' });
  }
  const from = envCfg?.vars?.ALERT_EMAIL_FROM;
  if (from) {
    let host = '';
    try {
      host = new URL(origin).hostname.toLowerCase();
    } catch {
      /* no origin: atlaspad.online only */
    }
    const domain = String(from).slice(String(from).lastIndexOf('@') + 1).toLowerCase();
    if (!isPlainEmailAddress(from) || !['atlaspad.online', host].includes(domain)) {
      out.push({ name: 'ALERT_EMAIL_FROM', detail: 'env.mainnet.vars.ALERT_EMAIL_FROM is not an address on atlaspad.online (the Worker would send from alerts@atlaspad.online instead)', fix: 'set env.mainnet.vars.ALERT_EMAIL_FROM to "alerts@atlaspad.online"' });
    }
  }
  return out;
}

/** SPEC I10 + operational separation: every role key distinct. Returns problem strings. */
export function distinctnessProblems(roles) {
  const p = [];
  const entries = Object.entries(roles).filter(([, v]) => v);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i][1] === entries[j][1]) p.push(`${entries[i][0]} and ${entries[j][0]} are the same key (${entries[i][1]})`);
    }
  }
  return p;
}

/** Claim-window rules (SPEC D10, T11b). */
export function windowProblems(windowSecs, governanceTimeLock) {
  const p = [];
  if (!Number.isSafeInteger(windowSecs) || windowSecs < 259_200) p.push(`claim window ${windowSecs} s < 72 h (259,200 s)`);
  if (windowSecs > 2_592_000) p.push(`claim window ${windowSecs} s > 30 d (the mainnet build refuses it)`);
  if (governanceTimeLock !== undefined && !(windowSecs > governanceTimeLock + 86_400)) p.push(`claim window ${windowSecs} s must exceed the governance time lock ${governanceTimeLock} s + 24 h`);
  return p;
}

/** Deployer funds needed (lamports): program peak + Config + ALT + crank + fees margin, never below 0.59 SOL. */
export function deployerNeed({ programPeak, configRent, altRent, crankTopUp, margin = 20_000_000n, floor = MIN_DEPLOYER }) {
  const need = programPeak + configRent + altRent + crankTopUp + margin;
  return need > floor ? need : floor;
}

/** Newest report in scripts/out whose name starts with `prefix` and that satisfies `accept` (default: any). */
function latestReport(prefix, accept = () => true) {
  if (!existsSync(OUT_DIR)) return null;
  const files = readdirSync(OUT_DIR).filter((x) => x.startsWith(prefix) && x.endsWith('.json')).sort().reverse();
  for (const f of files) {
    try {
      const json = JSON.parse(readFileSync(join(OUT_DIR, f), 'utf8'));
      if (accept(json)) return { file: f, json };
    } catch {
      /* unreadable report */
    }
  }
  return null;
}

async function ask(rl, q) {
  return (await rl.question(q)).trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['execute', 'dry-run', 'upgrade', 'create-keys', 'record', 'verify', 'build', 'skip-app-build', 'allow-hot-guardian', 'propose-governance']);
  if (args.execute && args['dry-run']) throw new Error('choose --dry-run or --execute');
  if (args['propose-governance']) return proposeGovernance(args);
  const EXECUTE = !!args.execute;
  const url = process.env.RPC_URL || PUBLIC_RPC.mainnet;
  const checks = new Checks();
  const todo = [];
  const fail = (what, detail, fix) => {
    checks.fail(what, detail);
    if (fix) todo.push(fix);
  };
  const recIn = readDeploy('mainnet') ?? {};

  head(`GO MAINNET · ${EXECUTE ? 'EXECUTE' : 'DRY RUN (read-only: nothing is sent, deployed or changed)'} · ${label(url)}`);

  // ------------------------------------------------------------------------------------------------ toolchain
  head('1 · toolchain');
  const [maj, min] = process.versions.node.split('.').map(Number);
  checks.check(maj > 22 || (maj === 22 && min >= 18), 'Node ≥ 22.18', process.versions.node);
  checks.check(await hasCommand('solana'), 'solana CLI');
  const who = await whoamiMatches();
  if (who) checks.pass('wrangler logged in to the AtlasPad Cloudflare account', `account id ${expectedAccountId()}`);
  else fail('wrangler login', `not logged in to the AtlasPad Cloudflare account (account id ${expectedAccountId()})`, WRANGLER_LOGIN_FIX);

  // ------------------------------------------------------------------------------------------------ artifact
  head('2 · program artifact (SPEC §11 step 0)');
  if (args.build) {
    const b = await run('bash', [join(PROGRAM_DIR, 'scripts', 'build.sh')], { cwd: PROGRAM_DIR });
    checks.check(b.code === 0, 'programs/shop-vault/scripts/build.sh', `exit ${b.code}`);
  }
  const art = artifactInfo('mainnet');
  if (!art) fail('mainnet artifact', 'target/deploy/shop_vault.so missing', 'programs/shop-vault/scripts/build.sh');
  else {
    checks.check(art.bytes < 40_960, 'size < 40,960 B', `${art.bytes} B`);
    checks.check(art.hasMarker && !art.hasOtherMarker, 'mainnet flavour marker only (not a devnet build)', `sha256 ${art.sha256.slice(0, 16)}…`);
    const ca = await run('bash', [join(PROGRAM_DIR, 'scripts', 'check-artifact.sh'), art.path, 'mainnet'], { cwd: PROGRAM_DIR, echo: false });
    checks.check(ca.code === 0, 'check-artifact.sh mainnet', ca.out.trim().split('\n').pop());
    const tools = (await hasCommand('solana-verify')) && (await hasCommand('docker'));
    if (typeof args['verified-artifact'] === 'string') {
      // The CI solana-verify build (lib/verifiedBuild.mjs): no Docker needed here.
      const ci = readVerifiedArtifact(resolve(String(args['verified-artifact'])));
      const vp = [...verifiedArtifactProblems(ci, art.sha256), ...(await sourceDriftProblems(ci.info?.commit, (a) => run('git', a, { echo: false })))];
      for (const p of vp) fail('verified build (CI artifact)', p, 'download the verifiable-build workflow artifact, unzip it, copy its shop_vault.so to programs/shop-vault/target/deploy/ and pass --verified-artifact <dir>');
      if (!vp.length) checks.pass('candidate equals the CI solana-verify build', `commit ${ci.info.commit.slice(0, 12)} · sha256 ${art.sha256.slice(0, 16)}…`);
    } else if (!tools) fail('verified build', 'solana-verify and Docker are required for the reproducible-build check', 'run the "Verifiable build" GitHub workflow and pass --verified-artifact <unzipped artifact dir> (or install Docker Desktop and `cargo install solana-verify`, then re-run with --verify)');
    else if (EXECUTE || args.verify) {
      const v = await run('bash', [join(PROGRAM_DIR, 'scripts', 'check-artifact.sh'), art.path, 'mainnet', '--verified'], { cwd: PROGRAM_DIR, timeoutMs: 3_600_000 });
      if (v.code === 0) checks.pass('candidate equals the solana-verify build');
      else fail('verified build', 'hash mismatch or build failed', 'deploy the solana-verify output: copy programs/shop-vault/target/deploy/shop_vault.so from the verified build');
    } else checks.warn('verified build', 'tools present; run with --verify for the (slow) reproducible-build check — it is mandatory at --execute');
    try {
      const active = await simd0500Active(url);
      if (active && art.eFlags === 0) fail('SBPF version', 'SIMD-0500 is ACTIVE on mainnet and this is an SBPF v0 build', 'rebuild with `cargo build-sbf --arch v3` (DEVNET.md "SBPF version"), re-run tests and the size gate');
      else checks.pass('SBPF deployable', active ? `SIMD-0500 active, e_flags ${art.eFlags}` : `SIMD-0500 inactive (v0 build deployable), e_flags ${art.eFlags}`);
    } catch (e) {
      checks.warn('SIMD-0500 status', e.message);
    }
  }

  // ------------------------------------------------------------------------------------------------ chain state
  head('3 · mainnet (read-only)');
  let prog = { exists: false };
  let configAcc = null;
  try {
    await assertGenesis(url, 'mainnet');
    checks.pass('RPC genesis is mainnet', label(url));
    prog = await deployedProgram(url);
    configAcc = await getAccount(url, CONFIG_PDA);
    if (!prog.exists) checks.pass('program id not deployed yet', PROGRAM_ID);
    else if (art && prog.deployedSha256(art.bytes) === art.sha256) checks.pass('program already deployed with this artifact (resume)', `authority ${prog.upgradeAuthority ?? 'immutable'}`);
    else if (args.upgrade) checks.warn('program deployed; --upgrade given', `authority ${prog.upgradeAuthority ?? 'immutable'}`);
    else fail('program already deployed with different bytes', PROGRAM_ID, 'investigate before continuing; pass --upgrade only for a deliberate upgrade');
    if (configAcc) {
      const { sv } = await import('./lib/web3.mjs');
      const c = sv.decodeConfig(configAcc.data);
      if (c.flavor !== 'mainnet') fail('existing Config', `flavor ${c.flavor} (a devnet binary initialised it!)`, 'STOP: see SPEC T18');
      else checks.pass('Config already initialised (resume)', `attestor ${c.attestor.toBase58()}`);
    }
  } catch (e) {
    fail('mainnet RPC', e.message, 'check connectivity / RPC_URL');
  }

  // ------------------------------------------------------------------------------------------------ deployer
  head('4 · deployer (your wallet)');
  let deployerPk = null;
  let deployerKp = null;
  const deployerPath = typeof args.deployer === 'string' ? resolve(String(args.deployer)) : null;
  if (deployerPath) {
    try {
      const bytes = readSecretKey(resolve(String(args.deployer)));
      const { web3 } = await import('./lib/web3.mjs');
      deployerKp = web3.Keypair.fromSecretKey(bytes);
      deployerPk = deployerKp.publicKey.toBase58();
      if (resolve(String(args.deployer)).startsWith(KEYS_DIR) && /devnet-/.test(String(args.deployer))) fail('deployer', 'that is a devnet key', 'use your own funded mainnet wallet keypair');
      else checks.pass('deployer keypair readable', deployerPk);
    } catch (e) {
      fail('deployer keypair', e.message, 'pass --deployer <path to your wallet keypair JSON>');
    }
  } else if (typeof args['deployer-pubkey'] === 'string' && isAddress(args['deployer-pubkey'])) {
    deployerPk = args['deployer-pubkey'];
    checks.warn('deployer', `pubkey only (${deployerPk}); --execute needs --deployer <keypair.json>`);
  } else fail('deployer', 'not given', 'pass --deployer <path to your mainnet wallet keypair JSON> (≈0.6 SOL)');
  let need = MIN_DEPLOYER;
  if (art) {
    try {
      const cost = await programDeployCost(url, art.bytes, rentExempt);
      const configRent = configAcc ? 0n : await rentExempt(url, 256);
      const altRent = recIn.alt ? 0n : await rentExempt(url, 56 + 14 * 32);
      // once the program is deployed (a resumed launch) the 0.59 SOL floor has been spent on it: only what is left counts
      need = deployerNeed({ programPeak: prog.exists ? (args.upgrade ? cost.buffer + cost.fees : 0n) : cost.peak, configRent, altRent, crankTopUp: CRANK_TARGET, floor: prog.exists ? 0n : MIN_DEPLOYER });
      info(`rent estimate: program ${fmtSol(cost.locked)} locked (ProgramData + account), ${fmtSol(cost.buffer)} buffer during deploy (refunded) · Config ${fmtSol(configRent)} · ALT ${fmtSol(altRent)} · crank ${fmtSol(CRANK_TARGET)}`);
    } catch (e) {
      checks.warn('rent estimate', e.message);
    }
  }
  if (deployerPk) {
    try {
      const own = await getBalance(url, deployerPk);
      let parked = 0n;
      if (!prog.exists && existsSync(keyPath('mainnet-deploy-buffer'))) parked = parkedBufferLamports(await getAccount(url, pubkey('mainnet-deploy-buffer')), deployerPk);
      const b = own + parked;
      const note = parked > 0n ? ` (${fmtSol(own)} + ${fmtSol(parked)} already in the upload buffer, reused)` : '';
      if (b >= need) checks.pass('deployer balance', `${fmtSol(b)} ≥ ${fmtSol(need)}${note}`);
      else fail('deployer balance', `${fmtSol(b)} < ${fmtSol(need)}${note}`, `send at least ${fmtSol(need - b)} to ${deployerPk}`);
      if (prog.exists && prog.upgradeAuthority && prog.upgradeAuthority !== deployerPk) fail('upgrade authority', `${prog.upgradeAuthority} is not the deployer`, 'deploy/upgrade with the current upgrade authority');
    } catch (e) {
      checks.warn('deployer balance', e.message);
    }
  }

  // ------------------------------------------------------------------------------------------------ keys + governance
  head('5 · keys and governance (SPEC §11, I10, T11b)');
  for (const [k, kind] of [['mainnet-attestor', 'key'], ['mainnet-crank', 'key'], ['mainnet-hmac.key', 'rand']]) {
    if (!existsSync(keyPath(k))) {
      if (args['create-keys']) {
        const r = kind === 'key' ? ensureKey(k) : ensureRandomKey(k);
        checks.pass(`created .keys/${k}${kind === 'key' ? '.json' : ''}`, r.pubkey ?? '32 random bytes');
      } else fail(`.keys/${k}${kind === 'key' ? '.json' : ''}`, 'missing', 'node scripts/go-mainnet.mjs --create-keys (creates the mainnet attestor, crank and HMAC keys; prints pubkeys only)');
    } else checks.pass(`.keys/${k}${kind === 'key' ? '.json' : ''}`, kind === 'key' ? pubkey(k) : 'present');
  }
  const attestor = existsSync(keyPath('mainnet-attestor')) ? pubkey('mainnet-attestor') : null;
  const crank = existsSync(keyPath('mainnet-crank')) ? pubkey('mainnet-crank') : null;
  if (attestor) {
    try {
      const b = await getBalance(url, attestor);
      if (b > 0n) checks.warn('attestor holds SOL', `${fmtSol(b)}: the attestor is never funded and never a fee payer (SPEC §8.4)`);
    } catch {
      /* balance optional */
    }
  }
  const guardian = typeof args.guardian === 'string' ? args.guardian : recIn.guardian;
  if (!guardian || !isAddress(guardian)) fail('guardian', 'not given', 'pass --guardian <hardware wallet pubkey> (offline ops key; SPEC D9)');
  else {
    const local = existsSync(KEYS_DIR) ? readdirSync(KEYS_DIR).filter((f) => f.endsWith('.json')).map((f) => { try { return pubkey(f); } catch { return null; } }) : [];
    if (local.includes(guardian) && !args['allow-hot-guardian']) fail('guardian', 'is a key file on this machine; mainnet needs a hardware wallet', 'use a Ledger/Keystone address (or pass --allow-hot-guardian deliberately)');
    else checks.pass('guardian', guardian);
  }
  const windowSecs = Number(args.window ?? CLAIM_WINDOW.mainnet);
  const squads = {};
  for (const [flag, role] of [['squads-a', 'governance'], ['squads-b', 'upgrade']]) {
    const ms = typeof args[flag] === 'string' ? args[flag] : recIn[flag === 'squads-a' ? 'squadsA' : 'squadsB'];
    if (!ms || !isAddress(ms)) {
      fail(`Squads ${flag === 'squads-a' ? 'A (governance)' : 'B (upgrade authority)'}`, 'not given', `create a Squads v4 multisig (2-of-3 hardware keys${role === 'governance' ? ', time lock ≤ 48 h' : ''}) and pass --${flag} <multisig address>`);
      continue;
    }
    try {
      const acc = await getAccount(url, ms);
      if (!acc || acc.owner !== SQUADS_V4_PROGRAM) throw new Error(`${ms} is not a Squads v4 multisig on mainnet (pass the MULTISIG address, not the vault)`);
      const d = decodeMultisig(acc.data);
      const vault = await squadsVaultPda(ms, 0);
      squads[flag] = { multisig: ms, vault, timeLock: d.timeLock, threshold: d.threshold, members: d.members.length };
      const probs = multisigProblems(d, { role, claimWindowSecs: windowSecs });
      if (probs.length) for (const p of probs) fail(`Squads ${flag}`, p, `fix the ${flag} multisig settings in Squads`);
      else checks.pass(`Squads ${flag} (${role})`, `${d.threshold}-of-${d.members.length}, time lock ${d.timeLock} s, vault ${vault}`);
    } catch (e) {
      fail(`Squads ${flag}`, e.message, `check the --${flag} address`);
    }
  }
  if (squads['squads-a'] && squads['squads-b'] && squads['squads-a'].multisig === squads['squads-b'].multisig) fail('Squads A/B', 'governance and upgrade authority must be DIFFERENT multisigs (SPEC §11)', 'create a second multisig for the upgrade authority');
  for (const p of windowProblems(windowSecs, squads['squads-a']?.timeLock)) fail('claim window', p, 'use --window ≥ 259200 and > Squads A time lock + 24 h');
  if (!windowProblems(windowSecs, squads['squads-a']?.timeLock).length) checks.pass('claim window', `${windowSecs} s (${windowSecs / 3600} h)`);
  const dist = distinctnessProblems({ attestor, guardian, governance: squads['squads-a']?.vault, upgradeAuthority: squads['squads-b']?.vault, deployer: deployerPk, crank });
  for (const p of dist) fail('distinct keys (SPEC I10)', p, 'every role needs its own key');
  if (!dist.length && attestor && guardian && deployerPk) checks.pass('attestor, guardian, governance, upgrade authority, deployer and crank are all distinct');

  // ------------------------------------------------------------------------------------------------ secrets + worker
  head('6 · Worker config, D1 and secret sources (names only)');
  const { values: secretValues, missingRequired, missingOptional, sources } = collectSecrets('mainnet');
  for (const s of sources) info(`${s.name.padEnd(22)} ← ${s.source}${s.present ? '' : s.required ? '  MISSING' : '  (optional)'}`);
  const TURNSTILE_FIX = 'create a Turnstile widget for the mainnet origin; add TURNSTILE_SECRET_KEY to .env.server and the public TURNSTILE_SITE_KEY to wrangler.jsonc env.mainnet.vars';
  const KEYS_FIX = 'node scripts/go-mainnet.mjs --create-keys (creates the mainnet attestor, crank and HMAC keys; prints pubkeys only)';
  for (const n of missingRequired) {
    const fix = n.startsWith('TWILIO')
      ? 'create the Twilio account + Verify service (code length 6, voice) and add TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_VERIFY_SID to .env.server'
      : n === 'TURNSTILE_SECRET_KEY'
        ? TURNSTILE_FIX
        : ['ATTESTOR_SECRET', 'CRANK_SECRET', 'HMAC_KEY'].includes(n)
          ? KEYS_FIX
          : `add ${n}'s source (see .env.example)`;
    fail(`secret source ${n}`, 'missing', fix);
  }
  if (alchemySourceName('mainnet') === 'ALCHEMY_API_KEY') checks.warn('Alchemy', 'mainnet uses the shared ALCHEMY_API_KEY; a separate AtlasPad app (ALCHEMY_API_KEY_MAINNET) on the Developer plan is recommended');
  const phone = phoneSetup(missingOptional);
  if (phone === 'call') checks.pass('phone verification', 'Twilio voice calls (all three TWILIO_* sources present)');
  else if (phone === 'none') checks.warn('phone verification', 'off (no TWILIO_* sources): owners verify with a code on their website; add Twilio later to switch calls on');
  // a partial Twilio setup, and no owner-alert channel (where website-code claims get their human check before unlock)
  for (const p of optionalSecretProblems(missingOptional)) fail(p.name, p.detail, p.fix);
  if (!envValue('GOOGLE_SERVER_KEY')) fail('GOOGLE_SERVER_KEY', 'missing', 'add it to .env.server');
  let cfg = null;
  try {
    cfg = readWranglerConfig();
  } catch (e) {
    fail('wrangler.jsonc', e.message);
  }
  const ep = cfg ? envProblems('mainnet', cfg) : [];
  for (const p of ep) fail('wrangler.jsonc env.mainnet', p, 'BACKEND/integrator: fix env.mainnet (INTEGRATION §1.4)');
  if (cfg && !ep.length) checks.pass('wrangler.jsonc env.mainnet', `name ${WORKER_NAMES.mainnet}, CLUSTER mainnet, __CS_DEV_ENDPOINTS__ false`);
  const op = cfg ? originProblems('mainnet', cfg) : [];
  if (cfg && !op.length) op.push(...(await zoneProblems(MAINNET_ORIGIN))); // read-only DNS: the zone is live on Cloudflare
  for (const p of op) fail('mainnet domain', p, 'fix env.mainnet in wrangler.jsonc (PUBLIC_ORIGIN, custom-domain routes, run_worker_first) and the zone on Cloudflare (RUNBOOK §12)');
  if (cfg && !op.length) checks.pass('mainnet domain', `${MAINNET_ORIGIN} (custom domains + canonical-host redirect configured, zone on Cloudflare)`);
  const em = cfg ? envConfig('mainnet', cfg) : null;
  const channels = alertChannels(missingOptional);
  const ap = channels.includes('email') ? alertEmailProblems({ emailTo: secretValues.ALERT_EMAIL_TO, envCfg: em }) : [];
  for (const p of ap) fail(p.name, p.detail, p.fix);
  if (channels.length && !ap.length) checks.pass('owner alerts', alertChannelsText(channels));
  if (phone === 'call') {
    // Turnstile guards the phone 'call me' step: required with Twilio, unused without it
    if (missingOptional.includes('TURNSTILE_SECRET_KEY')) fail('secret source TURNSTILE_SECRET_KEY', 'missing (needed with phone calls)', TURNSTILE_FIX);
    if (em && !em.vars?.TURNSTILE_SITE_KEY) fail('TURNSTILE_SITE_KEY', 'env.mainnet.vars.TURNSTILE_SITE_KEY is empty (needed with phone calls)', TURNSTILE_FIX);
  }
  if (who) {
    try {
      const uuid = await d1Uuid('mainnet');
      if (!uuid) checks.warn('D1 cornershop-mainnet', 'does not exist yet (created at --execute)');
      else {
        checks.pass('D1 cornershop-mainnet exists', uuid);
        const pm = await pendingMigrations('mainnet');
        if (pm.ok) info(pm.pending.length ? `migrations pending: ${pm.pending.join(', ')} (applied at --execute)` : 'migrations up to date');
      }
      const names = await secretNames('mainnet');
      if (names?.includes('DEV_FAUCET_SECRET')) fail('Worker secrets', `DEV_FAUCET_SECRET is set on ${WORKER_NAMES.mainnet} (H6)`, `npx wrangler secret delete DEV_FAUCET_SECRET --env mainnet`);
      else checks.pass(`secrets currently on ${WORKER_NAMES.mainnet} (names)`, names?.length ? names.join(', ') : 'none');
    } catch (e) {
      checks.warn('Cloudflare reads', e.message);
    }
  }

  // ------------------------------------------------------------------------------------------------ build + bundle
  head('7 · build:mainnet + check-bundle (H6 proofs)');
  if (args['skip-app-build']) checks.warn('app build', 'skipped (--skip-app-build)');
  else {
    const b = await buildMainnet(false);
    if (b.code !== 0) fail('build:mainnet', b.out.trim().split('\n').slice(-3).join(' | '), 'fix the build (npm run build:mainnet)');
    else {
      checks.pass('build:mainnet', 'dist-mainnet');
      const cb = await run('node', ['scripts/check-bundle.mjs', 'dist-mainnet', '--cluster', 'mainnet', '--build-worker'], { echo: false });
      if (cb.code === 0) checks.pass('check-bundle mainnet (client + Worker dry-run bundle)', 'budgets, leak scan, no devnet-only code');
      else fail('check-bundle mainnet', cb.out.split('\n').filter((l) => l.startsWith('✗')).slice(0, 4).join(' | '), 'node scripts/check-bundle.mjs dist-mainnet --cluster mainnet --build-worker');
    }
  }

  // ------------------------------------------------------------------------------------------------ sign-off evidence
  head('8 · devnet sign-off + checklist');
  // Evidence counts only when it ran after the latest devnet deploy record and is ≤ 7 days old (lib/evidence.mjs).
  const lastDeploy = latestDevnetDeploy(OUT_DIR);
  const stale = (r) => staleReason({ at: reportTime(r.json, r.file), deploy: lastDeploy, now: Date.now() });
  if (lastDeploy) info(`latest devnet deploy record: ${lastDeploy.file}`);
  const E2E_FIX = 'node scripts/e2e-devnet.ts --execute (npm run e2e:devnet -- --execute)';
  const e2e = latestReport('e2e-devnet-', (j) => j.execute === true);
  const grad = latestReport('e2e-devnet-', (j) => j.execute === true && j.passed === true && !!j.graduation);
  if (!e2e?.json?.passed) fail('e2e-devnet', e2e ? `latest executed run ${e2e.file} did not pass` : 'no executed run in scripts/out', E2E_FIX);
  else if (stale(e2e)) fail('e2e-devnet stale', `${e2e.file} ${stale(e2e)}`, E2E_FIX);
  else checks.pass('latest executed e2e-devnet passed', e2e.file);
  let poolExists = null;
  if (args['waive-graduation'] !== undefined) {
    try {
      poolExists = !!(await getAccount(PUBLIC_RPC.devnet, DEVNET_GRADUATION_POOL));
    } catch (e) {
      checks.warn('devnet graduation pool', `could not check ${DEVNET_GRADUATION_POOL} (${e.message})`);
    }
  }
  const gw = graduationWaiver(args['waive-graduation'], poolExists);
  for (const p of gw.problems) fail('--waive-graduation', p, 'GRADUATE=1 node scripts/e2e-devnet.ts --execute, or --waive-graduation "<why>"');
  if (gw.waiver) stateExtra.waivers = { graduation: { ...gw.waiver, at: new Date().toISOString() } };
  if (grad && !stale(grad)) checks.pass('e2e-devnet with GRADUATE=1 passed', grad.file);
  else if (gw.waiver) checks.warn('e2e-devnet GRADUATE=1 WAIVED', `${gw.waiver.reason} (pool ${DEVNET_GRADUATION_POOL.slice(0, 8)}… ${poolExists === false ? 'still does not exist' : 'not checked'}; recorded in scripts/out/go-mainnet-state.json)`);
  else if (grad) fail('e2e-devnet GRADUATE=1 stale', `${grad.file} ${stale(grad)}`, 'GRADUATE=1 node scripts/e2e-devnet.ts --execute (needs ~3.4 SOL extra on devnet), or --waive-graduation "<why>"');
  else if (!gw.problems.length) fail('e2e-devnet GRADUATE=1', 'no passing graduation run', 'GRADUATE=1 node scripts/e2e-devnet.ts --execute (needs ~3.4 SOL extra on devnet), or --waive-graduation "<why>" while pump\'s devnet migration bot does not migrate');
  const aud = latestReport('accuracy-audit-devnet-');
  const AUDIT_FIX = 'node scripts/accuracy-audit.mjs https://cornershop-devnet.tiejiucai.workers.dev --json';
  if (!aud || !(aud.json.checks ?? []).every((c) => c.status !== 'fail')) fail('accuracy audit', aud ? `${aud.file} has failures` : 'no report', AUDIT_FIX);
  else if (stale(aud)) fail('accuracy audit stale', `${aud.file} ${stale(aud)}`, AUDIT_FIX);
  else checks.pass('latest accuracy audit green', aud.file);
  const cl = readChecklist();
  if (!cl) fail('MAINNET-CHECKLIST.md', 'missing');
  else if (cl.unchecked.length) {
    fail('MAINNET-CHECKLIST.md', `${cl.unchecked.length} of ${cl.items.length} boxes unticked`, `tick every box in MAINNET-CHECKLIST.md (first open: "${cl.unchecked[0].text.slice(0, 80)}")`);
    for (const u of cl.unchecked.slice(0, 5)) info(`  [ ] ${u.text.replace(/[`*]/g, '').slice(0, 100)}`);
    if (cl.unchecked.length > 5) info(`  … and ${cl.unchecked.length - 5} more`);
  } else checks.pass('MAINNET-CHECKLIST.md', `all ${cl.items.length} boxes ticked`);

  if (args.record) {
    writeDeploy('mainnet', {
      genesisHash: GENESIS.mainnet,
      programId: PROGRAM_ID,
      configPda: CONFIG_PDA,
      ...(guardian && isAddress(guardian) ? { guardian } : {}),
      ...(deployerPk ? { deployer: deployerPk } : {}),
      ...(attestor ? { attestor } : {}),
      ...(crank ? { crank } : {}),
      ...(squads['squads-a'] ? { squadsA: squads['squads-a'].multisig, squadsAVault: squads['squads-a'].vault, squadsATimeLockSecs: squads['squads-a'].timeLock } : {}),
      ...(squads['squads-b'] ? { squadsB: squads['squads-b'].multisig, squadsBVault: squads['squads-b'].vault, squadsBTimeLockSecs: squads['squads-b'].timeLock } : {}),
      claimWindowSecs: windowSecs,
    });
    ok('public inputs recorded in deploy/mainnet.json');
  }

  const green = checks.summary(`go-mainnet preflight (${EXECUTE ? 'execute' : 'dry run'})`);
  const confirmations = [
    `Squads A (governance) time lock is ${squads['squads-a']?.timeLock ?? '?'} s, below the ${windowSecs} s claim window minus 24 h`,
    ...(phone === 'call' ? ['the Twilio Verify service has code length 6 and voice geo permissions for the UK (and every country you serve)'] : []),
    googleReferrerPrompt(),
    workersPlanPrompt(cfg?.env?.mainnet?.vars?.POLICY_REFERENCE),
  ];
  if (!EXECUTE) {
    if (todo.length) {
      head('what you still need to provide or do');
      [...new Set(todo)].forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
    }
    head('at --execute you will also be asked to confirm, by typing yes');
    confirmations.forEach((c) => console.log(`  · ${c}`));
    console.log(`\n  and finally to type the phrase: ${PHRASE}`);
    console.log('\nDry run complete. Nothing was sent, deployed or changed.');
    writeState({ dryRun: true, green, todo: [...new Set(todo)], checks: checks.toJSON() });
    process.exit(green ? 0 : 1);
  }

  // ================================================================================================ EXECUTE
  if (!green) throw new Error('refusing to execute: preflight has failures (run the dry run and fix every ✗)');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('refusing to execute without an interactive terminal');
  if (!deployerKp) throw new Error('--execute needs --deployer <keypair.json>');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    head('confirmations');
    for (const c of confirmations) {
      if ((await ask(rl, `  Confirm: ${c}? (type yes) `)) !== 'yes') throw new Error('not confirmed; nothing was done');
    }
    console.log(`\n  This deploys the program to MAINNET with ${deployerPk} paying, serves AtlasPad at ${MAINNET_ORIGIN}, and REPLACES the demo at ${WORKERS_DEV_ORIGINS.mainnet} (which then redirects there).`);
    if ((await ask(rl, `  Type the phrase to continue: `)) !== PHRASE) throw new Error('phrase mismatch; nothing was done');
  } finally {
    rl.close();
  }
  await executeAll({ url, art, prog, deployerKp, deployerPk, deployerPath, attestor, crank, guardian, squads, windowSecs, phone, upgrade: !!args.upgrade });
}

/** `npm run build:mainnet`, or the same command when the npm script is not there yet (typecheck + vite build). */
async function buildMainnet(echo) {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {};
  if (scripts['build:mainnet']) return run('npm', ['run', 'build:mainnet'], { echo });
  const tc = await run('npm', ['run', 'typecheck'], { echo });
  if (tc.code !== 0) return tc;
  return run('npx', ['--no-install', 'vite', 'build', '--outDir', 'dist-mainnet', '--emptyOutDir'], { env: { VITE_CLUSTER: 'mainnet', VITE_TEST_WALLET: '' }, echo });
}

/** Recorded in every state file write of this run (the --waive-graduation decision). */
const stateExtra = {};

function writeState(o) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'go-mainnet-state.json'), JSON.stringify({ at: new Date().toISOString(), ...stateExtra, ...o }, null, 2));
}

async function executeAll(c) {
  const { url, art, deployerKp, deployerPk, deployerPath, attestor, crank, guardian, squads, windowSecs } = c;
  const done = [];
  const step = (s) => {
    done.push({ step: s, at: new Date().toISOString() });
    writeState({ execute: true, done });
  };

  head('E1 · program deploy');
  let prog = await deployedProgram(url);
  if (!(prog.exists && prog.deployedSha256(art.bytes) === art.sha256)) {
    if (prog.exists && !c.upgrade) throw new Error('program exists with different bytes and --upgrade was not given');
    if (await simd0500Active(url) && art.eFlags === 0) throw new Error('SIMD-0500 is active: an SBPF v0 build cannot be deployed');
    ensureKey('mainnet-deploy-buffer'); // a failed deploy never prints a recovery seed phrase; re-run resumes the buffer
    const argv = ['-u', url, 'program', 'deploy', art.path, '--program-id', keyPath('shop-vault-program'), '--keypair', deployerPath, '--upgrade-authority', deployerPath, '--buffer', keyPath('mainnet-deploy-buffer'), '--use-rpc', '--commitment', 'confirmed', '--max-sign-attempts', String(DEPLOY_SIGN_ATTEMPTS), '--with-compute-unit-price', String(DEPLOY_CU_PRICE)];
    if (!prog.exists) argv.push('--max-len', String(art.bytes)); // SPEC §9: --max-len = binary size on first deploy
    const r = await run('solana', argv, { cwd: PROGRAM_DIR, timeoutMs: 1_800_000 });
    prog = await deployedProgram(url);
    if (r.code !== 0 || !prog.exists || prog.deployedSha256(art.bytes) !== art.sha256) throw new Error('program deploy did not complete; re-run go-mainnet --execute to resume the buffer');
  }
  if (prog.upgradeAuthority !== deployerPk) throw new Error(`upgrade authority is ${prog.upgradeAuthority}, expected the deployer`);
  ok(`program ${PROGRAM_ID} deployed (sha256 ${art.sha256.slice(0, 16)}…)`);
  writeDeploy('mainnet', { genesisHash: GENESIS.mainnet, programId: PROGRAM_ID, programDataSha256: art.sha256, programSoBytes: art.bytes, upgradeAuthority: deployerPk, deployer: deployerPk, programDeployedAt: new Date().toISOString() });
  step('program');

  head('E2 · initialize_config');
  const { initConfig } = await import('./init-config.mjs');
  const ic = await initConfig({ cluster: 'mainnet', url, payer: deployerKp, attestor, guardian, governance: deployerPk, windowSecs, execute: true, allowMainnet: true });
  if (ic.problems.length) throw new Error(`Config: ${ic.problems.join('; ')}`);
  ok(`Config ${ic.status}${ic.signature ? ` — ${explorerTx(ic.signature, 'mainnet')}` : ''}`);
  step('config');

  head('E3 · ALT');
  const { createAlt } = await import('./create-alt.mjs');
  const alt = await createAlt({ cluster: 'mainnet', url, authority: deployerKp, execute: true, allowMainnet: true });
  if (alt.problems.length || !alt.alt) throw new Error(`ALT: ${alt.problems.join('; ') || alt.status}`);
  ok(`ALT ${alt.alt}`);
  step('alt');

  head('E4 · crank top-up');
  const { web3, connection, buildTx, simulateAndSend } = await import('./lib/web3.mjs');
  const have = await getBalance(url, crank);
  if (have < CRANK_TARGET) {
    const conn = connection(url);
    const ix = web3.SystemProgram.transfer({ fromPubkey: deployerKp.publicKey, toPubkey: new web3.PublicKey(crank), lamports: CRANK_TARGET - have });
    const r = await simulateAndSend(conn, await buildTx(conn, deployerKp.publicKey, [ix], [deployerKp]), { execute: true, label: 'fund crank' });
    ok(`crank +${fmtSol(CRANK_TARGET - have)} — ${explorerTx(r.signature, 'mainnet')}`);
  } else ok(`crank holds ${fmtSol(have)}`);
  writeDeploy('mainnet', {
    attestor,
    guardian,
    governance: deployerPk,
    crank,
    squadsA: squads['squads-a'].multisig,
    squadsAVault: squads['squads-a'].vault,
    squadsATimeLockSecs: squads['squads-a'].timeLock,
    squadsB: squads['squads-b'].multisig,
    squadsBVault: squads['squads-b'].vault,
    squadsBTimeLockSecs: squads['squads-b'].timeLock,
    claimWindowSecs: windowSecs,
  });
  step('crank');

  head('E5 · D1 cornershop-mainnet');
  const { uuid } = await d1Ensure('mainnet');
  replaceD1Placeholder('mainnet', uuid);
  info(await d1MigrateRemote('mainnet'));
  step('d1');

  head('E6 · secrets (one bulk call, stdin; names only)');
  const { values, missingRequired } = collectSecrets('mainnet');
  if (missingRequired.length) throw new Error(`missing secret sources: ${missingRequired.join(', ')}`);
  ok(`set: ${(await putSecretsBulk(values, 'mainnet')).join(', ')}`);
  const names = await secretNames('mainnet');
  for (const n of REQUIRED_MAINNET_SECRETS) if (!names?.includes(n)) throw new Error(`secret ${n} not visible on ${WORKER_NAMES.mainnet}`);
  if (names?.includes('DEV_FAUCET_SECRET')) throw new Error('DEV_FAUCET_SECRET present on mainnet (H6)');
  step('secrets');

  head('E7 · build:mainnet + check-bundle');
  const b = await buildMainnet(true);
  if (b.code !== 0) throw new Error('build:mainnet failed');
  const cb = await run('node', ['scripts/check-bundle.mjs', 'dist-mainnet', '--cluster', 'mainnet', '--build-worker']);
  if (cb.code !== 0) throw new Error('check-bundle failed');
  step('build');

  head('E8 · wrangler deploy --env mainnet (replaces the demo)');
  // `deployments list --json` is oldest first: the live version is the newest deployment's (deploy-mainnet-hotfix.mjs).
  const { currentVersionId } = await import('./deploy-mainnet-hotfix.mjs');
  const prev = currentVersionId(await deploymentsList('mainnet'));
  info(`rollback target (current version): ${prev ?? 'unknown'} — npx wrangler rollback ${prev ?? '<version id>'} --env mainnet`);
  const { buildId } = await import('./deploy-devnet.mjs');
  const id = buildId(join(ROOT, 'dist-mainnet'));
  const d = await wrangler(['deploy', '--env', 'mainnet', '--var', `ALT_ADDRESS:${alt.alt}`, '--var', `BUILD_ID:${id}`], { echo: true, timeoutMs: 600_000 });
  // wrangler uploads the Worker first and attaches the Custom Domains / cron after, so a late failure leaves it live
  if (d.code !== 0) throw new Error(`wrangler deploy --env mainnet failed. If its output shows "Uploaded ${WORKER_NAMES.mainnet}", the mainnet Worker is already live (workers.dev redirects to ${MAINNET_ORIGIN}) and only the Custom Domains or cron failed: fix them (RUNBOOK §12) and re-run, or \`npx wrangler rollback --env mainnet\` to bring the demo back. Otherwise the demo is still live.`);
  step('deploy');

  head('E9 · smoke + monitoring setup');
  let sm = { code: 1 };
  for (let i = 0; i < 6 && sm.code !== 0; i++) {
    if (i) await new Promise((r) => setTimeout(r, 10_000));
    sm = await run('node', ['scripts/smoke.mjs', MAINNET_ORIGIN, '--cluster', 'mainnet', '--json']);
  }
  if (sm.code !== 0) warn('smoke is not green: investigate now; rollback with `npx wrangler rollback --env mainnet` if users are affected');
  else ok('smoke green');
  const { expectationSql } = await import('./admin-expect.mjs');
  for (const kind of [4, 5]) await d1Execute('mainnet', expectationSql({ kind, key: squads['squads-a'].vault, note: 'go-mainnet: governance handover to Squads A' }));
  ok('registered the planned governance handover (admin_expectations kinds 4 proposed + 5 applied → Squads A vault)');
  step('smoke');

  head('E10 · manual follow-ups (SPEC §11 steps 3-7, §8.6)');
  followUps({ squadsAVault: squads['squads-a'].vault, squadsBVault: squads['squads-b'].vault, guardian, phone: c.phone, windowSecs }).forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  writeState({ execute: true, done, finished: true });
}

/**
 * The manual follow-ups E10 prints. The GitHub watchdog does nothing until deploy/mainnet.json (with the ALT) is pushed,
 * so that comes first. `phone` is phoneSetup(): without Twilio the test claim uses the website code.
 */
export function followUps({ squadsAVault, squadsBVault, guardian, phone, windowSecs = CLAIM_WINDOW.mainnet }) {
  const claim = phone === 'call' ? 'claim it with the real phone call' : 'claim it with the code on your own website (phone checks are off)';
  return [
    `Commit and push the mainnet record: git add deploy/mainnet.json wrangler.jsonc && git commit -m "mainnet live" && git push
     then run the Watchdog (mainnet) workflow once (GitHub → Actions → Watchdog (mainnet) → Run workflow) and check it no longer says "nothing to watch".`,
    `Hand governance to Squads A: node scripts/go-mainnet.mjs --propose-governance --deployer <same wallet>
     then, in Squads A, execute shop-vault accept_governance (disc 12) from vault ${squadsAVault} within 30 days.`,
    `Move the upgrade authority to Squads B (vault ${squadsBVault}):
     solana program set-upgrade-authority ${PROGRAM_ID} --new-upgrade-authority ${squadsBVault} --skip-new-upgrade-authority-signer-check -k <wallet> -u m`,
    `Start the watchdog on a separate machine: node scripts/watchdog.mjs --cluster mainnet --loop 900 (exit 2 = critical)
     and keep the guardian (${guardian}) reachable: unregistered proposals must be vetoed within 7 days, and wrong
     claims cancelled before they unlock (Phantom: node scripts/guardian.mjs cancel|pause|unpause, RUNBOOK §8
     "Guardian"; vetoes are not in it yet). Keep ≈0.01 SOL in the guardian for network fees.`,
    `Launch one coin for a business YOU own with first buy 0; ${claim}; withdraw after the ${windowSecs / 3600} h claim window ends.`,
    'Every planned admin change: node scripts/admin-expect.mjs --env mainnet add … BEFORE proposing it.',
    'After ≥ 30 days without incident and an external review: --final through Squads B.',
    'Take the attestor key offline: the Worker secret is the only live copy needed (.keys/mainnet-attestor.json → offline backup).',
  ];
}

/** propose_governance(Squads A vault) signed by the current governance (= the deployer right after go-live). */
async function proposeGovernance(args) {
  const url = process.env.RPC_URL || PUBLIC_RPC.mainnet;
  const dep = readDeploy('mainnet') ?? {};
  if (!dep.squadsAVault) throw new Error('deploy/mainnet.json has no squadsAVault');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('interactive terminal required');
  await assertGenesis(url, 'mainnet');
  const { web3, sv, connection, buildTx, simulateAndSend } = await import('./lib/web3.mjs');
  const kp = web3.Keypair.fromSecretKey(readSecretKey(resolve(String(args.deployer))));
  const cfg = sv.decodeConfig((await getAccount(url, CONFIG_PDA)).data);
  if (!cfg.governance.equals(kp.publicKey)) throw new Error(`current governance is ${cfg.governance.toBase58()}, not this wallet`);
  const conn = connection(url);
  const ix = sv.proposeGovernance({ governance: kp.publicKey, newGovernance: new web3.PublicKey(dep.squadsAVault) });
  const built = await buildTx(conn, kp.publicKey, [ix], [kp]);
  await simulateAndSend(conn, built, { execute: false, label: 'propose_governance' });
  ok(`propose_governance(${dep.squadsAVault}) simulated OK`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await ask(rl, 'Type PROPOSE GOVERNANCE to send it: ');
  rl.close();
  if (a !== 'PROPOSE GOVERNANCE') throw new Error('not confirmed');
  const r = await simulateAndSend(conn, await buildTx(conn, kp.publicKey, [ix], [kp]), { execute: true, label: 'propose_governance' });
  ok(`proposed — ${explorerTx(r.signature, 'mainnet')}; now execute accept_governance from Squads A within 30 days`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}
