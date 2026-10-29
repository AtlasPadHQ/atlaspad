/**
 * shop-vault end-to-end on DEVNET against the live pump.fun programs (SPEC.md §13.5, §8.1-§8.4).
 *
 *   cd programs/shop-vault/client && npm ci     # once: this script loads web3.js / pump-sdk 3.2.0 from client/node_modules
 *   cd .. && scripts/devnet-deploy.sh           # once per cluster: deploys target/deploy-devnet/shop_vault.so
 *   node scripts/devnet-e2e.ts                  # DRY_RUN (default): checks + simulations only, sends nothing
 *   DRY_RUN=false node scripts/devnet-e2e.ts    # the real run
 *
 * What it does (every transaction is simulated with sigVerify before it is sent; every signature is printed with an
 * explorer link and written to scripts/out/devnet-e2e-<time>.json):
 *   0. Guards: genesis hash must be devnet (mainnet is refused outright); keys only from .keys/, never printed.
 *   1. initialize_config(attestor, governance = deployer, guardian, 60 s) if Config does not exist yet.
 *   2. The CORNERSHOP address lookup table (shared keys only, SPEC §8.1): created, extended and frozen once.
 *   3. Tops up launcher / buyer / owner from the deployer (devnet SOL only).
 *   4. ONE launch tx: create_v2(creator = vault PDA) + register_launch + ATA + buy_exact_quote_in_v3 dev buy, through the
 *      ALT. The "Worker" step decodes the message bytes, runs the SPEC §8.4 policy (client checkLaunchMessage) and
 *      co-signs as the attestor; then the mint and launcher sign and it is sent.
 *   5. The buyer buys and sells (v3 and v2) -> a stranger runs the permissionless sweep_creator_fee + collect_creator_fee
 *      -> the vault's lamports rise by exactly the sum of TradeEvent.creator_fee.
 *   6. request_claim(owner) co-signed by the attestor (checkClaimMessage first) -> withdraw before finalize = NoOwner,
 *      finalize early = ClaimWindowActive (simulated) -> second launch for the same place = AlreadyRegistered (sent, fails
 *      on-chain, the second mint never exists) -> wait out the 60 s window -> finalize_claim -> a non-owner withdraw =
 *      NotOwner (sent, fails on-chain) -> the owner withdraws (relayer pays the fee): the owner receives exactly
 *      vault - rent_min(0), the vault stays at rent_min(0), system-owned, no data.
 *   7. Pause: the guardian pauses, a launch simulates to LaunchesPaused, the guardian unpauses.
 *   8. GRADUATE=1 (needs ~3.3 SOL on the buyer): buys out the curve and waits for pump's migration bot (not run by default).
 *
 * GRADUATE_WAIT_MIN (30) bounds the wait for the migration bot. Env: RPC_URL (default https://api.devnet.solana.com; only its origin is ever printed), KEYS_DIR (default ../../../.keys),
 * PLACE_ID (default a fresh fictional `cornershop-test:e2e-<time>` id), DEV_BUY_SOL (0.01), BUY_SOL (0.1), BUY_V2_SOL (0.05),
 * FUND_FROM_DEPLOYER (true), PAUSE_TEST (true), GRADUATE (unset), ALT_ADDRESS (override the stored ALT),
 * LOCALNET=1 (rehearsal against a solana-test-validator on 127.0.0.1 that cloned pump from devnet; never anything else).
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sv from "../client/src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
// Every dependency resolves from ../client/node_modules, so this script and the client sources share ONE copy of
// @solana/web3.js (its package has no "exports", so ESM imports and require() load the same CJS module instance).
const requireClient = createRequire(join(HERE, "../client/package.json"));
const web3 = requireClient("@solana/web3.js");
const splToken = requireClient("@solana/spl-token");
const pump = requireClient("@pump-fun/pump-sdk"); // CJS: the SDK's ESM build does not load under plain Node
const BN = requireClient("bn.js");
const {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedMessage,
  VersionedTransaction,
  SYSVAR_CLOCK_PUBKEY,
} = web3;
type Kp = InstanceType<typeof Keypair>;
type Pk = InstanceType<typeof PublicKey>;
type Ix = InstanceType<typeof TransactionInstruction>;
type VTx = InstanceType<typeof VersionedTransaction>;

// ------------------------------------------------------------------------------------------------------ settings

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DRY_RUN = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const LOCALNET = process.env.LOCALNET === "1";
const KEYS_DIR = process.env.KEYS_DIR ?? join(HERE, "../../../.keys");
const OUT_DIR = join(HERE, "out");
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
const PLACE_ID = process.env.PLACE_ID ?? `cornershop-test:e2e-${STAMP}`;
const CLAIM_WINDOW_SECS = 60;
const DEV_BUY = sol(process.env.DEV_BUY_SOL ?? "0.01");
const BUY_V3 = sol(process.env.BUY_SOL ?? "0.1");
const BUY_V2 = sol(process.env.BUY_V2_SOL ?? "0.05");
const MAX_DEV_BUY = sol("1"); // the Worker's dev-buy cap (§8.4 rule 6)
const FUND = process.env.FUND_FROM_DEPLOYER !== "false";
const PAUSE_TEST = process.env.PAUSE_TEST !== "false";
const GRADUATE = process.env.GRADUATE === "1";
const GRADUATE_WAIT_MIN = Number(process.env.GRADUATE_WAIT_MIN ?? "30"); // how long to wait for pump's migration bot
const PRIORITY_MICROLAMPORTS = 10_000;
const LAUNCH_CU = 400_000;

/** `Global.buybackFeeRecipients[0]` (identical on devnet and mainnet); fixed so it can live in the ALT. */
const BUYBACK = new PublicKey("5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD");
const PUMP_MINT_AUTHORITY = new PublicKey("TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM");
const PUMP: Pk = pump.PUMP_PROGRAM_ID;
const EVENT_IX_TAG = Buffer.from("e445a52e51cb9a1d", "hex");
const TRADE_EVENT_DISC = Buffer.from("bddb7fd34ee661ee", "hex");
const COLLECT_CREATOR_FEE_DISC = Buffer.from("1416567bc61cdb84", "hex");

/** Keys shared by every launch (SPEC §8.1; the same 14 keys the TS policy test measures 1,126 B / 1,169 B with). */
const ALT_KEYS: Pk[] = [
  pump.GLOBAL_PDA,
  pump.PUMP_EVENT_AUTHORITY_PDA,
  pump.PUMP_FEE_CONFIG_PDA,
  pump.getGlobalParamsPda(),
  pump.getSolVaultPda(),
  PUMP_MINT_AUTHORITY,
  sv.TOKEN_2022_PROGRAM_ID,
  sv.SPL_TOKEN_PROGRAM_ID,
  sv.NATIVE_MINT,
  BUYBACK,
  sv.SYSTEM_PROGRAM_ID,
  sv.configPda()[0],
  pump.MAYHEM_PROGRAM_ID,
  sv.INSTRUCTIONS_SYSVAR_ID,
];

// --------------------------------------------------------------------------------------------------- utilities

function sol(s: string): bigint {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`bad SOL amount ${s}`);
  return BigInt(Math.round(n * 1e9));
}
const fmt = (lamports: bigint | number) => `${(Number(lamports) / 1e9).toFixed(9)} SOL`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpcLabel = (() => {
  try {
    return new URL(RPC_URL).origin; // never the path or query: keyed RPC URLs carry the key there
  } catch {
    return "rpc";
  }
})();

function link(sig: string): string {
  return LOCALNET
    ? `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(rpcLabel)}`
    : `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}
function addrLink(a: Pk | string): string {
  const s = typeof a === "string" ? a : a.toBase58();
  return LOCALNET
    ? `https://explorer.solana.com/address/${s}?cluster=custom&customUrl=${encodeURIComponent(rpcLabel)}`
    : `https://explorer.solana.com/address/${s}?cluster=devnet`;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

interface StepRecord {
  step: string;
  ok: boolean;
  signature?: string;
  explorer?: string;
  note?: string;
}
const report: Record<string, any> = {
  startedAt: new Date().toISOString(),
  cluster: LOCALNET ? "localnet (rehearsal, pump cloned from devnet)" : "devnet",
  rpc: rpcLabel,
  dryRun: DRY_RUN,
  programId: sv.SHOP_VAULT_PROGRAM_ID.toBase58(),
  placeId: PLACE_ID,
  steps: [] as StepRecord[],
  checks: [] as string[],
  costs: {} as Record<string, unknown>,
};

function step(name: string, ok: boolean, signature?: string, note?: string) {
  const r: StepRecord = { step: name, ok, ...(signature ? { signature, explorer: link(signature) } : {}), ...(note ? { note } : {}) };
  report.steps.push(r);
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${note ? ` — ${note}` : ""}${signature ? `\n       ${link(signature)}` : ""}`);
}
function check(cond: unknown, what: string): asserts cond {
  if (!cond) {
    report.checks.push(`FAILED: ${what}`);
    throw new Error(`check failed: ${what}`);
  }
  report.checks.push(`ok: ${what}`);
}
function die(msg: string): never {
  console.error(`\nABORT: ${msg}`);
  report.aborted = msg;
  writeReport();
  process.exit(2);
}
function writeReport() {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${LOCALNET ? "localnet" : "devnet"}-e2e-${STAMP}.json`);
  report.finishedAt = new Date().toISOString();
  writeFileSync(file, JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`\nreport: ${file}`);
}

function loadKey(name: string): Kp {
  const file = join(KEYS_DIR, `devnet-${name}.json`);
  if (!existsSync(file)) die(`missing ${file} (create it with solana-keygen new --no-bip39-passphrase --silent -o ${file})`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8"))));
}

// ------------------------------------------------------------------------------------------- chain + tx helpers

const conn = new Connection(RPC_URL, { commitment: "confirmed", ...(process.env.WS_URL ? { wsEndpoint: process.env.WS_URL } : {}) }); // WS_URL: e.g. public devnet wss when the HTTP RPC (Alchemy) has no signatureSubscribe
const sdk = new pump.PumpSdk();
const online = new pump.OnlinePumpSdk(conn);

async function balance(k: Pk): Promise<bigint> {
  return BigInt(await conn.getBalance(k, "confirmed"));
}
async function rent(len: number): Promise<bigint> {
  return BigInt(await conn.getMinimumBalanceForRentExemption(len, "confirmed"));
}
async function chainTime(): Promise<bigint> {
  const a = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  return a.data.readBigInt64LE(32);
}
async function account(k: Pk) {
  return conn.getAccountInfo(k, "confirmed");
}
const cuLimit = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });
const cuPrice = () => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS });

interface Built {
  tx: VTx;
  blockhash: string;
  lastValidBlockHeight: number;
}
async function build(payer: Pk, ixs: Ix[], signers: Kp[], alts: unknown[] = []): Promise<Built> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  if (signers.length) tx.sign(signers);
  return { tx, blockhash, lastValidBlockHeight };
}

async function waitTx(signature: string, b: Built) {
  // Poll signature status over HTTP (no websocket): works with RPCs that lack signatureSubscribe (e.g. Alchemy) and
  // never throws for a transaction that landed with an on-chain error (the caller inspects meta.err).
  for (let i = 0; ; i++) {
    const st = (await conn.getSignatureStatuses([signature])).value[0];
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) break;
    if (i % 5 === 4 && (await conn.getBlockHeight("confirmed")) > b.lastValidBlockHeight) {
      throw new Error(`transaction ${signature}: block height exceeded before it landed`);
    }
    await sleep(800);
  }
  for (let i = 0; i < 20; i++) {
    const t = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t?.meta) return t.meta;
    await sleep(400 * (i + 1));
  }
  throw new Error(`transaction ${signature} confirmed but not returned by getTransaction`);
}

interface Expect {
  ix: number;
  code: number;
  name: string;
  /** Also send it (skipPreflight) so the refusal is recorded on-chain with a signature. */
  record?: boolean;
}
interface Executed {
  signature?: string;
  logs: string[];
  unitsConsumed?: number;
  meta?: any;
  simulatedOnly: boolean;
}

const isExpiry = (e: unknown) => /block height exceeded|has expired|BlockheightExceeded/i.test(String((e as Error)?.message ?? e));

/**
 * Simulates (sigVerify) and, unless DRY_RUN, sends + confirms. With `expect`, the failure itself is the assertion.
 * `make` builds AND signs a fresh transaction (fresh blockhash; for co-signed txs a fresh attestor signature), so a
 * transaction that is dropped and expires is rebuilt and resent (at most 3 attempts). An expired blockhash can never
 * land later, so a retry cannot execute anything twice.
 */
async function execute(label: string, make: () => Promise<Built>, expect?: Expect): Promise<Executed> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await executeOnce(label, await make(), expect);
    } catch (e) {
      if (!isExpiry(e) || attempt >= 3) throw e;
      console.log(`  ..  ${label}: transaction expired before landing (attempt ${attempt}); rebuilding with a fresh blockhash`);
    }
  }
}

async function executeOnce(label: string, b: Built, expect?: Expect): Promise<Executed> {
  const sim = await conn.simulateTransaction(b.tx, { sigVerify: true, commitment: "confirmed" });
  const err = sim.value.err;
  const logs: string[] = sim.value.logs ?? [];
  if (expect) {
    const got = sv.parseShopVaultError(err);
    check(
      got?.index === expect.ix && got?.code === expect.code,
      `${label}: simulation fails with ${expect.name} (${expect.code}) at instruction ${expect.ix} [got ${JSON.stringify(err)}]`,
    );
    if (DRY_RUN || !expect.record) {
      step(label, true, undefined, `refused in simulation with ${expect.name} (${expect.code}), as expected`);
      return { logs, unitsConsumed: sim.value.unitsConsumed, simulatedOnly: true };
    }
    const signature = await conn.sendRawTransaction(b.tx.serialize(), { skipPreflight: true, maxRetries: 5 });
    const meta = await waitTx(signature, b);
    const onchain = sv.parseShopVaultError(meta.err);
    check(
      onchain?.index === expect.ix && onchain?.code === expect.code,
      `${label}: failed on-chain with ${expect.name} (${expect.code}) [got ${JSON.stringify(meta.err)}]`,
    );
    step(label, true, signature, `failed on-chain with ${expect.name} (${expect.code}), as expected`);
    return { signature, logs: meta.logMessages ?? [], unitsConsumed: meta.computeUnitsConsumed, meta, simulatedOnly: false };
  }
  if (err) throw new Error(`${label}: simulation failed ${JSON.stringify(err)}\n    ${logs.slice(-14).join("\n    ")}`);
  if (DRY_RUN) {
    step(label, true, undefined, `simulated OK, ${sim.value.unitsConsumed} CU (DRY_RUN: not sent)`);
    return { logs, unitsConsumed: sim.value.unitsConsumed, simulatedOnly: true };
  }
  const signature = await conn.sendRawTransaction(b.tx.serialize(), { skipPreflight: true, maxRetries: 5 });
  const meta = await waitTx(signature, b);
  if (meta.err) {
    step(label, false, signature, `failed on-chain: ${JSON.stringify(meta.err)}`);
    throw new Error(`${label}: failed on-chain ${JSON.stringify(meta.err)}\n    ${(meta.logMessages ?? []).slice(-14).join("\n    ")}`);
  }
  step(label, true, signature, `${meta.computeUnitsConsumed} CU, fee ${meta.fee} lamports`);
  return { signature, logs: meta.logMessages ?? [], unitsConsumed: meta.computeUnitsConsumed, meta, simulatedOnly: false };
}

/** shop-vault events (`sol_log_data`, segment 0 = ASCII name, SPEC §7). */
function programEvents(logs: string[]): { name: string; fields: Buffer[] }[] {
  const out: { name: string; fields: Buffer[] }[] = [];
  for (const l of logs) {
    if (!l.startsWith("Program data: ")) continue;
    const segs = l.slice("Program data: ".length).split(" ").map((s) => Buffer.from(s, "base64"));
    const name = segs[0].toString("latin1");
    if (/^[A-Za-z]+$/.test(name)) out.push({ name, fields: segs.slice(1) });
  }
  return out;
}

interface TradeEv {
  mint: string;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: string;
  creator: string;
  creatorFee: bigint;
}
/** pump `TradeEvent`s from anchor `emit_cpi!` inner instructions (offsets as tests/common/pump.rs). */
function tradeEvents(meta: any): TradeEv[] {
  const out: TradeEv[] = [];
  for (const g of meta?.innerInstructions ?? []) {
    for (const ix of g.instructions) {
      const d = b58decode(ix.data);
      if (d.length < 16 + 217 || !d.subarray(0, 8).equals(EVENT_IX_TAG) || !d.subarray(8, 16).equals(TRADE_EVENT_DISC)) continue;
      const e = d.subarray(16);
      out.push({
        mint: new PublicKey(e.subarray(0, 32)).toBase58(),
        solAmount: e.readBigUInt64LE(32),
        tokenAmount: e.readBigUInt64LE(40),
        isBuy: e[48] !== 0,
        user: new PublicKey(e.subarray(49, 81)).toBase58(),
        creator: new PublicKey(e.subarray(169, 201)).toBase58(),
        creatorFee: e.readBigUInt64LE(209),
      });
    }
  }
  return out;
}

let globalsCache: { global: any; feeConfig: any } | undefined;
async function globals() {
  globalsCache ??= { global: await online.fetchGlobal(), feeConfig: await online.fetchFeeConfig() };
  return globalsCache;
}

// ------------------------------------------------------------------------------------------------- the "Worker"

/**
 * What the Worker's `POST /api/launch/attest` does (SPEC §8.4): decode the message bytes ITSELF, run the policy, and
 * sign exactly `message.serialize()` of that decoded object. Returns the attestor's signature (base64).
 */
function workerAttestLaunch(attestor: Kp, messageB64: string, p: Omit<sv.LaunchPolicy, "attestor">): string {
  const msg = VersionedMessage.deserialize(Buffer.from(messageB64, "base64"));
  const violations = sv.checkLaunchMessage(msg, { ...p, attestor: attestor.publicKey });
  if (violations.length) throw new Error(`attestor refuses to sign: ${violations.join("; ")}`);
  return signAs(attestor, msg);
}
/** `POST /api/claim/attest` (SPEC §8.4): only after the Twilio-verified session; here the policy part. */
function workerAttestClaim(attestor: Kp, messageB64: string, p: Omit<sv.ClaimPolicy, "attestor">): string {
  const msg = VersionedMessage.deserialize(Buffer.from(messageB64, "base64"));
  const violations = sv.checkClaimMessage(msg, { ...p, attestor: attestor.publicKey });
  if (violations.length) throw new Error(`attestor refuses to sign: ${violations.join("; ")}`);
  return signAs(attestor, msg);
}
function signAs(kp: Kp, msg: any): string {
  const t = new VersionedTransaction(msg);
  t.sign([kp]);
  const i = msg.staticAccountKeys.findIndex((k: Pk) => k.equals(kp.publicKey));
  return Buffer.from(t.signatures[i]).toString("base64");
}

// --------------------------------------------------------------------------------------------------------- main

async function main() {
  console.log(`shop-vault e2e · ${report.cluster} · ${rpcLabel} · ${DRY_RUN ? "DRY_RUN (simulate only)" : "LIVE (sending)"}`);

  // 0. Guards.
  const genesis = await conn.getGenesisHash();
  if (genesis === MAINNET_GENESIS) die("this RPC is MAINNET. This script only runs on devnet.");
  if (LOCALNET) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC_URL)) die("LOCALNET=1 only with RPC_URL=http://127.0.0.1:<port>");
  } else if (genesis !== DEVNET_GENESIS) {
    die(`genesis ${genesis} is not devnet (${DEVNET_GENESIS})`);
  }
  report.genesis = genesis;

  const deployer = loadKey("deployer"); // fee payer, upgrade authority, governance (devnet)
  const attestor = loadKey("attestor"); // the Worker's co-signing key: never funded, never a fee payer
  const guardian = loadKey("guardian"); // ops key (pause / cancels)
  const launcher = loadKey("launcher");
  const buyer = loadKey("buyer");
  const owner = loadKey("owner");
  const roles: Record<string, Kp> = { deployer, attestor, guardian, launcher, buyer, owner };
  report.keys = Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v.publicKey.toBase58()]));
  for (const [k, v] of Object.entries(report.keys)) console.log(`  ${k.padEnd(9)} ${v}`);

  const rent0 = await rent(0);
  const rentState = await rent(sv.VAULT_STATE_LEN);

  // Program + Config.
  const prog = await account(sv.SHOP_VAULT_PROGRAM_ID);
  if (!prog?.executable) die(`program ${sv.SHOP_VAULT_PROGRAM_ID.toBase58()} is not deployed here: run scripts/devnet-deploy.sh first`);
  const pd = await account(sv.programDataPda());
  check(pd && pd.data[12] === 1 && new PublicKey(pd.data.subarray(13, 45)).equals(deployer.publicKey), "upgrade authority is the devnet deployer");
  report.programDataLen = pd.data.length;

  const [configPk] = sv.configPda();
  report.config = configPk.toBase58();
  let cfgAcc = await account(configPk);
  if (!cfgAcc) {
    const ix = sv.initializeConfig({
      payer: deployer.publicKey,
      attestor: attestor.publicKey,
      governance: deployer.publicKey,
      guardian: guardian.publicKey,
      claimWindowSecs: CLAIM_WINDOW_SECS,
    });
    const before = await balance(deployer.publicKey);
    const r = await execute("initialize_config (attestor, governance = deployer, guardian, 60 s window)", () => build(deployer.publicKey, [ix], [deployer]));
    if (r.simulatedOnly) die("Config does not exist yet; DRY_RUN stops here (run with DRY_RUN=false)");
    const ev = programEvents(r.logs).find((e) => e.name === "ConfigInitialized");
    check(ev && ev.fields.some((f) => f.toString("latin1") === "shop-vault-build:devnet"), "ConfigInitialized carries the shop-vault-build:devnet marker");
    report.costs.initializeConfig = { lamports: before - (await balance(deployer.publicKey)), configRent: await rent(sv.CONFIG_LEN) };
    report.initSignature = r.signature;
    cfgAcc = await account(configPk);
  }
  const cfg = sv.decodeConfig(cfgAcc.data);
  check(cfg.flavor === "devnet", "Config.flavor == devnet (initialised by the devnet build)");
  check(cfg.attestor.equals(attestor.publicKey), "Config.attestor == devnet-attestor");
  check(cfg.guardian.equals(guardian.publicKey), "Config.guardian == devnet-guardian");
  check(cfg.governance.equals(deployer.publicKey), "Config.governance == devnet-deployer");
  check(cfg.claimWindowSecs === BigInt(CLAIM_WINDOW_SECS), "Config.claim_window_secs == 60");
  check(!cfg.paused, "launches are not paused");
  report.configState = { flavor: cfg.flavor, claimWindowSecs: cfg.claimWindowSecs, rotationDelaySecs: cfg.rotationDelaySecs, probationUntil: cfg.probationUntil };

  // ALT (one per cluster, shared keys only, frozen).
  const stateFile = join(OUT_DIR, `${LOCALNET ? "localnet" : "devnet"}-state.json`);
  const saved = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
  let altAddress: string | undefined = process.env.ALT_ADDRESS ?? saved.alt;
  if (!altAddress) {
    if (DRY_RUN) die("no CORNERSHOP lookup table recorded yet; DRY_RUN stops here (run with DRY_RUN=false to create it)");
    const before = await balance(deployer.publicKey);
    const recentSlot = await conn.getSlot("finalized");
    const [createIx, alt] = AddressLookupTableProgram.createLookupTable({ authority: deployer.publicKey, payer: deployer.publicKey, recentSlot });
    const extendIx = AddressLookupTableProgram.extendLookupTable({ payer: deployer.publicKey, authority: deployer.publicKey, lookupTable: alt, addresses: ALT_KEYS });
    await execute("create + extend the CORNERSHOP lookup table (14 shared keys)", () => build(deployer.publicKey, [createIx, extendIx], [deployer]));
    const extendedAt = (await conn.getAddressLookupTable(alt)).value.state.lastExtendedSlot;
    while ((await conn.getSlot("confirmed")) <= extendedAt) await sleep(400);
    await execute(
      "freeze the lookup table",
      () => build(deployer.publicKey, [AddressLookupTableProgram.freezeLookupTable({ lookupTable: alt, authority: deployer.publicKey })], [deployer]),
    );
    const frozenAt = await conn.getSlot("confirmed");
    while ((await conn.getSlot("confirmed")) < frozenAt + 3) await sleep(400);
    altAddress = alt.toBase58();
    report.costs.lookupTable = { lamports: before - (await balance(deployer.publicKey)) };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ ...saved, alt: altAddress, config: configPk.toBase58() }, null, 2));
  }
  const altAcc = (await conn.getAddressLookupTable(new PublicKey(altAddress))).value;
  if (!altAcc) die(`lookup table ${altAddress} not found`);
  check(altAcc.state.addresses.length === ALT_KEYS.length && ALT_KEYS.every((k, i) => altAcc.state.addresses[i].equals(k)), "lookup table holds exactly the 14 shared keys");
  check(altAcc.state.authority === undefined, "lookup table is frozen (no authority)");
  report.lookupTable = altAddress;
  console.log(`  config    ${configPk.toBase58()}\n  ALT       ${altAddress}`);

  // Funding (devnet SOL only).
  const targets: [Kp, bigint][] = [
    [launcher, DEV_BUY + sol("0.04")],
    [buyer, BUY_V3 + BUY_V2 + sol("0.03") + (GRADUATE ? sol("3.3") : 0n)],
    [owner, sol("0.003")],
  ];
  const topUps: Ix[] = [];
  let need = 0n;
  for (const [kp, want] of targets) {
    const have = await balance(kp.publicKey);
    if (have < want) {
      topUps.push(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: want - have }));
      need += want - have;
    }
  }
  const deployerBal = await balance(deployer.publicKey);
  report.balancesBefore = Object.fromEntries(await Promise.all(Object.entries(roles).map(async ([k, v]) => [k, await balance(v.publicKey)])));
  if (topUps.length) {
    if (!FUND) die(`launcher/buyer/owner need ${fmt(need)} more and FUND_FROM_DEPLOYER=false`);
    if (deployerBal < need + sol("0.02")) die(`deployer ${deployer.publicKey.toBase58()} has ${fmt(deployerBal)}, needs ${fmt(need + sol("0.02"))} to fund the run`);
    const funded = await execute(`fund launcher/buyer/owner from the deployer (${fmt(need)})`, () => build(deployer.publicKey, topUps, [deployer]));
    if (funded.simulatedOnly) die("DRY_RUN: launcher/buyer/owner are not funded yet, so the launch cannot be simulated; run with DRY_RUN=false");
  }

  // ------------------------------------------------------------------------------------------- 4. the launch
  const placeHash = sv.placeHash(PLACE_ID);
  const [vault] = sv.vaultPda(placeHash);
  const [vaultState] = sv.vaultStatePda(placeHash);
  report.place = { placeId: PLACE_ID, placeHash: sv.toHex(placeHash), vault: vault.toBase58(), vaultState: vaultState.toBase58() };
  if (await account(vaultState)) die(`place ${PLACE_ID} is already registered; pick a new PLACE_ID`);
  const meta = {
    name: "Corner Cafe E2E",
    symbol: "CAFE",
    // Placeholder metadata JSON location (never fetched on-chain); the Worker hosts real ones (BRIEF: KV/R2).
    uri: `https://cornershop-devnet.tiejiucai.workers.dev/m/${sv.toHex(placeHash).slice(0, 32)}.json`,
  };
  console.log(`\nplace ${PLACE_ID}\n  place_hash ${sv.toHex(placeHash)}\n  vault      ${vault.toBase58()}\n  vaultState ${vaultState.toBase58()}`);

  async function launchIxs(mint: Pk, devBuy: bigint): Promise<Ix[]> {
    const ixs: Ix[] = [
      cuLimit(LAUNCH_CU),
      cuPrice(),
      await sdk.createV2Instruction({ mint, name: meta.name, symbol: meta.symbol, uri: meta.uri, creator: vault, user: launcher.publicKey, mayhemMode: false }),
      sv.registerLaunch({ launcher: launcher.publicKey, attestor: attestor.publicKey, placeHash, mint }),
    ];
    if (devBuy > 0n) {
      ixs.push(
        splToken.createAssociatedTokenAccountIdempotentInstruction(
          launcher.publicKey,
          sv.associatedTokenAddress(launcher.publicKey, mint, sv.TOKEN_2022_PROGRAM_ID),
          launcher.publicKey,
          mint,
          sv.TOKEN_2022_PROGRAM_ID,
        ),
        // min_tokens_out = 1 is safe here: the curve is created in this same tx and register_launch proves it untraded.
        await sdk.getBuyExactQuoteInV3InstructionRaw({
          user: launcher.publicKey,
          mint,
          spendableQuoteIn: new BN(devBuy.toString()),
          minTokensOut: new BN(1),
          buybackFeeRecipient: BUYBACK,
        }),
      );
    }
    return ixs;
  }

  /** Browser builds -> Worker validates + co-signs -> mint + launcher sign. */
  async function coSignedLaunch(mintKp: Kp, devBuy: bigint): Promise<{ b: Built; size: number }> {
    const ixs = await launchIxs(mintKp.publicKey, devBuy);
    const b = await build(launcher.publicKey, ixs, [], [altAcc]);
    const messageB64 = Buffer.from(b.tx.message.serialize()).toString("base64");
    const attSig = workerAttestLaunch(attestor, messageB64, {
      launcher: launcher.publicKey,
      mint: mintKp.publicKey,
      placeId: PLACE_ID,
      name: meta.name,
      symbol: meta.symbol,
      uri: meta.uri,
      maxDevBuyLamports: MAX_DEV_BUY,
      lookupTable: altAcc,
    });
    b.tx.addSignature(attestor.publicKey, Buffer.from(attSig, "base64"));
    b.tx.sign([mintKp, launcher]);
    return { b, size: b.tx.serialize().length };
  }

  const mintKp = Keypair.generate(); // the coin's mint; after create_v2 its authority is pump's PDA, the key is discarded
  const { b: launchTx, size: launchSize } = await coSignedLaunch(mintKp, DEV_BUY);
  let firstLaunchBuild: Built | undefined = launchTx; // the validated + measured one is sent first; a retry rebuilds
  check(launchSize <= 1232, `launch tx is ${launchSize} B (limit 1,232 B)`);
  check(launchTx.tx.message.header.numRequiredSignatures === 3, "launch tx has exactly 3 signers (launcher, mint, attestor)");
  // The policy refuses a tampered message (moderation bypass attempt).
  const tampered = await build(launcher.publicKey, await (async () => {
    const ixs = await launchIxs(mintKp.publicKey, DEV_BUY);
    ixs[2] = await sdk.createV2Instruction({ mint: mintKp.publicKey, name: "Not Moderated", symbol: meta.symbol, uri: meta.uri, creator: vault, user: launcher.publicKey, mayhemMode: false });
    return ixs;
  })(), [], [altAcc]);
  let refused = "";
  try {
    workerAttestLaunch(attestor, Buffer.from(tampered.tx.message.serialize()).toString("base64"), {
      launcher: launcher.publicKey, mint: mintKp.publicKey, placeId: PLACE_ID, name: meta.name, symbol: meta.symbol, uri: meta.uri, maxDevBuyLamports: MAX_DEV_BUY, lookupTable: altAcc,
    });
  } catch (e) {
    refused = (e as Error).message;
  }
  check(/name differs/.test(refused), "the attestor policy refuses a launch whose create_v2 name differs from the moderated one");
  step("§8.4 policy: attestor co-signed the launch; refused a tampered copy", true, undefined, `launch tx ${launchSize} B, mint ${mintKp.publicKey.toBase58()}`);

  const launcherBefore = await balance(launcher.publicKey);
  const launch = await execute("launch: create_v2(creator = vault) + register_launch + dev buy, one co-signed v0 tx", async () => {
    const b = firstLaunchBuild ?? (await coSignedLaunch(mintKp, DEV_BUY)).b;
    firstLaunchBuild = undefined;
    return b;
  });
  report.mint = mintKp.publicKey.toBase58();
  report.launch = { signature: launch.signature, sizeBytes: launchSize, computeUnits: launch.unitsConsumed, mint: report.mint };
  if (launch.simulatedOnly) {
    console.log("\nDRY_RUN: launch simulated OK; stopping before anything depends on it. Run with DRY_RUN=false.");
    return;
  }
  const launchEvents = tradeEvents(launch.meta);
  const events = [...launchEvents];

  // State after the launch.
  const st0 = sv.decodeVaultState((await account(vaultState)).data);
  check(st0.mint.equals(mintKp.publicKey) && st0.launcher.equals(launcher.publicKey) && sv.toHex(st0.placeHash) === sv.toHex(placeHash), "VaultState: mint, launcher and place_hash recorded");
  check(st0.owner === null && st0.pending === null && st0.claimNonce === 0n, "VaultState: no owner, nothing pending, nonce 0");
  const curve0 = sv.decodeBondingCurvePrefix((await account(sv.bondingCurvePda(mintKp.publicKey))).data);
  check(curve0.creator.equals(vault), "bonding_curve.creator == vault PDA");
  check(!curve0.complete && !curve0.isMayhemMode && !curve0.isHolderReward, "curve: not complete, no mayhem, no holder rewards");
  const v0 = await account(vault);
  check(v0 && v0.owner.equals(sv.SYSTEM_PROGRAM_ID) && v0.data.length === 0 && BigInt(v0.lamports) >= rent0, "vault: system-owned, 0 data, rent-exempt");
  check(launchEvents.length === (DEV_BUY > 0n ? 1 : 0) && launchEvents.every((e) => e.creator === vault.toBase58()), "dev buy TradeEvent names the vault as creator");
  check(programEvents(launch.logs).some((e) => e.name === "Registered"), "Registered event emitted");
  const lMeta = launch.meta;
  const launcherDelta = launcherBefore - (await balance(launcher.publicKey));
  const devBuySpent = launchEvents.reduce((s, e) => s + e.solAmount, 0n);
  report.costs.launch = {
    launcherTotal: launcherDelta,
    txFee: lMeta.fee,
    shopVaultRent: rentState + rent0, // VaultState + vault top-up, paid by the launcher
    devBuySolIntoCurve: devBuySpent,
    note: "launcherTotal = tx fee + shop-vault rent + pump rent (mint, curve, curve ATA, mayhem state) + launcher ATA rent + dev buy incl. pump fees",
  };

  // ------------------------------------------------------------------------------------ 5. trades + fee collection
  const mint = mintKp.publicKey;
  const { global, feeConfig } = await globals();
  const tokenAta = sv.associatedTokenAddress(buyer.publicKey, mint, sv.TOKEN_2022_PROGRAM_ID);
  const tokenBalance = async () => BigInt((await conn.getTokenAccountBalance(tokenAta, "confirmed")).value.amount);

  {
    const st = await online.fetchBuyState(mint, buyer.publicKey, sv.TOKEN_2022_PROGRAM_ID);
    const quote = new BN(BUY_V3.toString());
    const amount = pump.getBuyV3TokenAmountFromQuoteAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: quote, curveBaseTokenBalance: st.curveBaseTokenBalance });
    const ixs = await sdk.buyExactQuoteInV3Instructions({ bondingCurve: st.bondingCurve, associatedUserAccountInfo: st.associatedUserAccountInfo, mint, user: buyer.publicKey, amount, quoteAmount: quote, slippage: 3, tokenProgram: sv.TOKEN_2022_PROGRAM_ID, buybackFeeRecipient: BUYBACK });
    const r = await execute(`buyer: buy_exact_quote_in_v3 ${fmt(BUY_V3)}`, () => build(buyer.publicKey, [cuLimit(250_000), cuPrice(), ...ixs], [buyer]));
    events.push(...tradeEvents(r.meta));
  }
  {
    const amount = new BN(((await tokenBalance()) / 2n).toString());
    const st = await online.fetchSellState(mint, buyer.publicKey, sv.TOKEN_2022_PROGRAM_ID);
    const quote = pump.getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount });
    const ixs = await sdk.sellV3Instructions({ bondingCurve: st.bondingCurve, mint, user: buyer.publicKey, amount, quoteAmount: quote, slippage: 3, tokenProgram: sv.TOKEN_2022_PROGRAM_ID, buybackFeeRecipient: BUYBACK });
    const r = await execute("buyer: sell_v3 half of the tokens", () => build(buyer.publicKey, [cuLimit(250_000), cuPrice(), ...ixs], [buyer]));
    events.push(...tradeEvents(r.meta));
  }
  if (BUY_V2 > 0n) {
    const st = await online.fetchBuyState(mint, buyer.publicKey, sv.TOKEN_2022_PROGRAM_ID);
    const quote = new BN(BUY_V2.toString());
    const amount = pump.getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: quote });
    const ixs = await sdk.buyV2Instructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: st.bondingCurve, associatedUserAccountInfo: st.associatedUserAccountInfo, mint, user: buyer.publicKey, amount, quoteAmount: quote, slippage: 3, tokenProgram: sv.TOKEN_2022_PROGRAM_ID, quoteTokenProgram: st.quoteTokenProgram });
    const r = await execute(`buyer: buy_v2 ${fmt(BUY_V2)} (pays pump's creator_vault directly)`, () => build(buyer.publicKey, [cuLimit(300_000), cuPrice(), ...ixs], [buyer]));
    events.push(...tradeEvents(r.meta));

    const sellAmount = new BN(((await tokenBalance()) / 3n).toString());
    const ss = await online.fetchSellState(mint, buyer.publicKey, sv.TOKEN_2022_PROGRAM_ID);
    const out = pump.getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: ss.bondingCurve.tokenTotalSupply, bondingCurve: ss.bondingCurve, amount: sellAmount });
    const sixs = await sdk.sellV2Instructions({ global, bondingCurveAccountInfo: ss.bondingCurveAccountInfo, bondingCurve: ss.bondingCurve, mint, user: buyer.publicKey, amount: sellAmount, quoteAmount: out, slippage: 3, tokenProgram: sv.TOKEN_2022_PROGRAM_ID, quoteTokenProgram: ss.quoteTokenProgram });
    const r2 = await execute("buyer: sell_v2 a third of the tokens", () => build(buyer.publicKey, [cuLimit(300_000), cuPrice(), ...sixs], [buyer]));
    events.push(...tradeEvents(r2.meta));
  }
  check(events.every((e) => e.mint === mint.toBase58() && e.creator === vault.toBase58() && e.creatorFee > 0n), "every TradeEvent names the vault as creator with a creator fee > 0");
  const expectedFees = events.reduce((s, e) => s + e.creatorFee, 0n);
  report.tradeEvents = events;
  const bucket = sv.decodeBondingCurvePrefix((await account(sv.bondingCurvePda(mint))).data).creatorFeeBucket;
  console.log(`  Σ TradeEvent.creator_fee = ${expectedFees} lamports (curve bucket ${bucket}, pump creator_vault ${await balance(sv.pumpCreatorVaultPda(vault))})`);

  // A stranger (the buyer) runs the permissionless sweep + collect; nobody from the shop signs anything.
  const vaultBeforeCollect = await balance(vault);
  const sweep = await sdk.sweepCreatorFeeInstruction({ payer: buyer.publicKey, mint, creator: vault, quoteMint: sv.NATIVE_MINT });
  const collect = new TransactionInstruction({
    programId: PUMP,
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: sv.pumpCreatorVaultPda(vault), isSigner: false, isWritable: true },
      { pubkey: sv.SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: pump.PUMP_EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false },
      { pubkey: PUMP, isSigner: false, isWritable: false },
    ],
    data: COLLECT_CREATOR_FEE_DISC,
  });
  await execute("stranger: pump sweep_creator_fee + collect_creator_fee(creator = vault)", () => build(buyer.publicKey, [cuLimit(200_000), cuPrice(), sweep, collect], [buyer]));
  const vaultAfterCollect = await balance(vault);
  const vAcc = await account(vault);
  check(vaultAfterCollect > vaultBeforeCollect, `vault lamports increased (${vaultBeforeCollect} -> ${vaultAfterCollect})`);
  check(vaultAfterCollect - vaultBeforeCollect === expectedFees, `vault delta ${vaultAfterCollect - vaultBeforeCollect} == Σ creator fees ${expectedFees}`);
  check(vAcc.owner.equals(sv.SYSTEM_PROGRAM_ID) && vAcc.data.length === 0, "vault still system-owned with no data");
  report.fees = { expectedFromTradeEvents: expectedFees, vaultBefore: vaultBeforeCollect, vaultAfter: vaultAfterCollect };

  // --------------------------------------------------------------------------------------------------- 6. claims
  const st1 = sv.decodeVaultState((await account(vaultState)).data);
  const nonce = st1.claimNonce + 1n;
  {
    const ix = sv.requestClaim({ attestor: attestor.publicKey, newOwner: owner.publicKey, placeHash, nonce });
    const t0 = await chainTime();
    const r = await execute(`request_claim(owner, nonce ${nonce}) co-signed by the attestor`, async () => {
      // The owner's wallet builds it, the Worker validates (SPEC §8.4 claim rules) and co-signs, the owner signs.
      const b = await build(owner.publicKey, [cuLimit(20_000), cuPrice(), ix], []);
      const sig = workerAttestClaim(attestor, Buffer.from(b.tx.message.serialize()).toString("base64"), { newOwner: owner.publicKey, placeId: PLACE_ID, expectedNonce: nonce });
      b.tx.addSignature(attestor.publicKey, Buffer.from(sig, "base64"));
      b.tx.sign([owner]);
      return b;
    });
    check(programEvents(r.logs).some((e) => e.name === "ClaimRequested"), "ClaimRequested event emitted");
    const st = sv.decodeVaultState((await account(vaultState)).data);
    check(st.pending && st.pending.owner.equals(owner.publicKey) && !st.pending.inProbation, "pending claim for the owner, not in probation");
    check(st.pending!.unlockTs >= t0 + 60n && st.pending!.unlockTs <= t0 + 60n + 30n, `unlock_ts ${st.pending!.unlockTs} ≈ request time + 60 s`);
    report.claim = { nonce, unlockTs: st.pending!.unlockTs, requestSignature: r.signature };
  }

  // Inside the window: withdraw and finalize are refused (simulated).
  await execute(
    "owner withdraw before finalize -> NoOwner",
    () => build(deployer.publicKey, [sv.withdraw({ owner: owner.publicKey, placeHash })], [deployer, owner]),
    { ix: 0, code: sv.ShopVaultError.NoOwner, name: "NoOwner" },
  );
  await execute(
    "finalize_claim inside the window -> ClaimWindowActive",
    () => build(deployer.publicKey, [sv.finalizeClaim({ placeHash })], [deployer]),
    { ix: 0, code: sv.ShopVaultError.ClaimWindowActive, name: "ClaimWindowActive" },
  );

  // Second launch for the same place (new mint). The real Worker refuses this before signing (registry check); the
  // attestor signs here anyway to prove the program itself enforces one coin per place.
  const mint2 = Keypair.generate();
  await execute("second launch for the same place (new mint, co-signed) -> AlreadyRegistered", async () => (await coSignedLaunch(mint2, DEV_BUY)).b, {
    ix: 3,
    code: sv.ShopVaultError.AlreadyRegistered,
    name: "AlreadyRegistered",
    record: true,
  });
  check((await account(mint2.publicKey)) === null, `second mint ${mint2.publicKey.toBase58()} does not exist (whole tx reverted)`);
  check((await account(sv.bondingCurvePda(mint2.publicKey))) === null, "second bonding curve does not exist");
  report.secondMint = mint2.publicKey.toBase58();

  // Wait out the window on the chain clock.
  const unlock = report.claim.unlockTs as bigint;
  process.stdout.write(`  waiting for chain time >= unlock_ts ${unlock} `);
  for (;;) {
    const now = await chainTime();
    if (now >= unlock + 1n) break;
    process.stdout.write(".");
    await sleep(Math.min(5000, Number(unlock + 1n - now) * 1000));
  }
  console.log("");
  {
    const r = await execute("finalize_claim (permissionless; the deployer cranks it)", () => build(deployer.publicKey, [sv.finalizeClaim({ placeHash })], [deployer]));
    check(programEvents(r.logs).some((e) => e.name === "ClaimFinalized"), "ClaimFinalized event emitted");
    const st = sv.decodeVaultState((await account(vaultState)).data);
    check(st.owner?.equals(owner.publicKey) && st.pending === null, "VaultState.owner == owner, nothing pending");
    report.claim.finalizeSignature = r.signature;
  }

  // A non-owner tries to withdraw (signs as "owner"): refused on-chain.
  await execute(
    "non-owner (buyer) withdraw -> NotOwner",
    () => build(buyer.publicKey, [sv.withdraw({ owner: buyer.publicKey, placeHash })], [buyer]),
    { ix: 0, code: sv.ShopVaultError.NotOwner, name: "NotOwner", record: true },
  );

  // The owner withdraws; a relayer (the deployer) pays the fee so the owner's delta is exactly the payout.
  {
    const vaultLamports = await balance(vault);
    const stateLamports = await balance(vaultState);
    const expected = (vaultLamports - rent0 > 0n ? vaultLamports - rent0 : 0n) + (stateLamports - rentState > 0n ? stateLamports - rentState : 0n);
    const ownerBefore = await balance(owner.publicKey);
    const r = await execute("owner withdraw (relayer pays the fee)", () => build(deployer.publicKey, [sv.withdraw({ owner: owner.publicKey, placeHash })], [deployer, owner]));
    const ownerAfter = await balance(owner.publicKey);
    const vAfter = await account(vault);
    const st = sv.decodeVaultState((await account(vaultState)).data);
    check(ownerAfter - ownerBefore === expected, `owner received exactly ${expected} lamports (vault - rent_min(0))`);
    check(expected === expectedFees, `the payout equals the collected creator fees (${expectedFees})`);
    check(BigInt(vAfter.lamports) === rent0, `vault left at exactly rent_min(0) = ${rent0} (rent-exempt)`);
    check(vAfter.owner.equals(sv.SYSTEM_PROGRAM_ID) && vAfter.data.length === 0, "vault still system-owned with no data");
    check(st.totalWithdrawn === expected, "VaultState.total_withdrawn updated");
    check(programEvents(r.logs).some((e) => e.name === "Withdrawn"), "Withdrawn event emitted");
    report.withdraw = { signature: r.signature, amount: expected, ownerBefore, ownerAfter, vaultAfter: vAfter.lamports };
  }

  // ----------------------------------------------------------------------------------------------- 7. pause
  if (PAUSE_TEST) {
    await execute("guardian set_paused(1)", () => build(deployer.publicKey, [sv.setPaused({ authority: guardian.publicKey, paused: true })], [deployer, guardian]));
    const probeId = `${PLACE_ID}:paused-probe`;
    const ph2 = sv.placeHash(probeId);
    const m3 = Keypair.generate();
    const ixs: Ix[] = [
      cuLimit(LAUNCH_CU),
      cuPrice(),
      await sdk.createV2Instruction({ mint: m3.publicKey, name: meta.name, symbol: meta.symbol, uri: meta.uri, creator: sv.vaultPda(ph2)[0], user: launcher.publicKey, mayhemMode: false }),
      sv.registerLaunch({ launcher: launcher.publicKey, attestor: attestor.publicKey, placeHash: ph2, mint: m3.publicKey }),
    ];
    await execute("launch while paused -> LaunchesPaused", () => build(launcher.publicKey, ixs, [launcher, m3, attestor], [altAcc]), {
      ix: 3,
      code: sv.ShopVaultError.LaunchesPaused,
      name: "LaunchesPaused",
    });
    await execute("guardian set_paused(0)", () => build(deployer.publicKey, [sv.setPaused({ authority: guardian.publicKey, paused: false })], [deployer, guardian]));
    check(!sv.decodeConfig((await account(configPk)).data).paused, "launches unpaused again");
  }

  // ------------------------------------------------------------------------------------------ 8. graduation
  if (GRADUATE) {
    const st = await online.fetchBuyState(mint, buyer.publicKey, sv.TOKEN_2022_PROGRAM_ID);
    const remaining = st.bondingCurve.realTokenReserves;
    const cost = pump.getBuyV3QuoteAmountFromTokenAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: remaining, curveBaseTokenBalance: st.curveBaseTokenBalance });
    console.log(`  graduation: buying the remaining ${remaining.toString()} tokens for ~${fmt(BigInt(cost.toString()))}`);
    const ixs = await sdk.buyV3Instructions({ bondingCurve: st.bondingCurve, associatedUserAccountInfo: st.associatedUserAccountInfo, mint, user: buyer.publicKey, amount: remaining, quoteAmount: cost, slippage: 2, tokenProgram: sv.TOKEN_2022_PROGRAM_ID, buybackFeeRecipient: BUYBACK });
    const r = await execute("buyer: buy out the curve (graduation)", () => build(buyer.publicKey, [cuLimit(400_000), cuPrice(), ...ixs], [buyer]));
    const gradEvents = tradeEvents(r.meta);
    const c = sv.decodeBondingCurvePrefix((await account(sv.bondingCurvePda(mint))).data);
    check(c.complete, "curve complete");
    const v1 = await balance(vault);
    await execute("stranger: sweep + collect after graduation", async () => build(buyer.publicKey, [cuLimit(200_000), cuPrice(), await sdk.sweepCreatorFeeInstruction({ payer: buyer.publicKey, mint, creator: vault, quoteMint: sv.NATIVE_MINT }), collect], [buyer]));
    check((await balance(vault)) - v1 === gradEvents.reduce((s, e) => s + e.creatorFee, 0n), "graduation buy's creator fee collected into the vault");
    const pool = pump.canonicalPumpPoolPda(mint);
    process.stdout.write(`  waiting up to ${GRADUATE_WAIT_MIN} min for pump's migration bot to create pool ${pool.toBase58()} `);
    let migrated = (await account(pool)) !== null;
    for (let i = 0; i < GRADUATE_WAIT_MIN * 6 && !migrated; i++) {
      migrated = (await account(pool)) !== null;
      if (!migrated) {
        process.stdout.write(".");
        await sleep(10_000);
      }
    }
    console.log("");
    step("graduation: pump migration bot created the PumpSwap pool", migrated, undefined, migrated ? addrLink(pool) : `pool not created within ${GRADUATE_WAIT_MIN} min`);
    report.graduation = { pool: pool.toBase58(), migrated };
  }
}

main()
  .then(() => {
    report.passed = true;
    writeReport();
    console.log(`\nE2E ${DRY_RUN ? "DRY RUN" : ""} PASSED (${report.checks.length} checks)`);
  })
  .catch((e) => {
    report.passed = false;
    report.error = String(e?.stack ?? e);
    writeReport();
    console.error(`\nE2E FAILED: ${e?.message ?? (typeof e === "object" ? JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : e)}`); if (e && typeof e === "object" && !e.message) console.error(e);
    process.exit(1);
  });
