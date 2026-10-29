/**
 * SPEC §8.4 attestor signing policy: the ONLY gate in front of the attestor key (INTEGRATION H7).
 *
 * PURE: no I/O, no globals, no web3.js. Input = the exact message bytes the browser submitted + the values the
 * Worker derived itself (reservation, stored metadata, on-chain nonce, the frozen ALT). Output = a list of
 * violations; the attestor signs only when it is empty, and only the bytes that were checked.
 *
 * Stricter than the shop-vault client's `checkLaunchMessage` (which runs as a second, independent gate in
 * worker/policyRef.ts):
 *  - strict decoding: minimal compact-u16 lengths, no trailing bytes, version 0 only, byte-identical re-encoding;
 *  - runtime sanitize rules: header bounds, no duplicate keys (static or loaded), program ids static and not the fee
 *    payer, every index in range, ≤ 1 lookup table and only the official frozen ALT, no empty lookup;
 *  - exact signer layout: [launcher (fee payer, writable), mint (writable), attestor (read-only)];
 *  - EVERY account of create_v2, register_launch, the ATA ix and the dev buy equals the derived address;
 *  - create_v2 name/symbol/uri compared as UTF-8 BYTES with the moderated values; creator_fee_bps, mayhem, cashback,
 *    holder-reward all zero; the dev buy spends exactly the reserved amount (≤ the cap) and partial_fill is off;
 *  - the serialized transaction (3 signatures) fits 1,232 B;
 *  - EXACT writability: every account is writable iff the allowed shape writes it (Config, pump Global, programs and
 *    sysvars stay read-only), so a co-signed message never takes a write lock the launch does not need.
 *
 * `approveLaunch` / `approveClaim` wrap a passing result in an `Approved` token whose bytes live in a module-private
 * WeakMap (unreachable, so not mutable after the check); worker/attestor.ts refuses to sign anything that is not such
 * a token, and each token signs once.
 */
import { b58decodeLen, bytesEq, readU32, readU64, u64le, utf8 } from './bytes';
import {
  ATA_PROGRAM,
  BUYBACK_FEE_RECIPIENT,
  COMPUTE_BUDGET_PROGRAM,
  DISC,
  INSTRUCTIONS_SYSVAR,
  MAYHEM_GLOBAL_PARAMS,
  MAYHEM_PROGRAM,
  MAYHEM_SOL_VAULT,
  NATIVE_MINT,
  PUMP_EVENT_AUTHORITY,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  PUMP_MINT_AUTHORITY,
  PUMP_PROGRAM,
  SHOP_VAULT_IX,
  SPL_TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TX_MAX_BYTES,
} from './consts';
import { DecodeError, decodeMessage, isCanonical, resolveAccounts, type DecodedMessage, type ResolvedAccount } from './txcodec';

/* =============================================================================================== expectations */

export interface LookupTable {
  address: string;
  /** The table's addresses in order (verified frozen + equal to ALT_KEYS before use). */
  keys: readonly string[];
}

export interface LaunchExpect {
  programId: string;
  attestor: string;
  launcher: string;
  mint: string;
  placeHash: Uint8Array;
  vault: string;
  vaultState: string;
  config: string;
  bondingCurve: string;
  curveBaseAta: string;
  curveQuoteAta: string;
  mayhemState: string;
  mayhemTokenVault: string;
  launcherAta: string;
  launcherWsolAta: string;
  userVolumeAccumulator: string;
  /** Moderated metadata (stored by /api/metadata). */
  name: string;
  symbol: string;
  uri: string;
  /** Exactly the reserved dev buy (0 = the tx must not contain one). */
  devBuyLamports: bigint;
  maxDevBuyLamports: bigint;
  /** The official ALT of this cluster, or null (then the message must not use a lookup table). */
  alt: LookupTable | null;
  maxComputeUnitLimit: number;
  maxComputeUnitPriceMicroLamports: bigint;
}

export interface ClaimExpect {
  programId: string;
  attestor: string;
  newOwner: string;
  config: string;
  vaultState: string;
  /** On-chain `claim_nonce + 1`. */
  expectedNonce: bigint;
  maxComputeUnitLimit: number;
  maxComputeUnitPriceMicroLamports: bigint;
}

/* =============================================================================================== decoding */

interface Ix {
  program: string;
  accounts: string[];
  data: Uint8Array;
}

interface Prepared {
  m: DecodedMessage;
  accounts: ResolvedAccount[];
  keys: string[];
  ixs: Ix[];
}

function prepare(bytes: Uint8Array, opts: { numSigners: number; alt: LookupTable | null; allowLookups: boolean }, errs: string[]): Prepared | null {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    errs.push('empty message');
    return null;
  }
  // 1 (shortvec) + 64 per signature + message
  const txSize = 1 + 64 * opts.numSigners + bytes.length;
  if (txSize > TX_MAX_BYTES) {
    errs.push(`transaction would be ${txSize} B (limit ${TX_MAX_BYTES})`);
    return null;
  }
  let m: DecodedMessage;
  try {
    m = decodeMessage(bytes);
  } catch (e) {
    errs.push(`undecodable message: ${e instanceof DecodeError ? e.message : 'malformed'}`);
    return null;
  }
  if (m.version !== 0) {
    errs.push('message must be v0');
    return null;
  }
  if (!isCanonical(bytes, m)) {
    errs.push('non-canonical message');
    return null;
  }
  const tables = new Map<string, readonly string[]>();
  if (m.addressTableLookups.length > 0) {
    if (!opts.allowLookups) {
      errs.push('this message must not use an address lookup table');
      return null;
    }
    if (m.addressTableLookups.length > 1) {
      errs.push('more than one address lookup table');
      return null;
    }
    if (!opts.alt) {
      errs.push('message uses a lookup table but none is configured');
      return null;
    }
    tables.set(opts.alt.address, opts.alt.keys);
  }
  let accounts: ResolvedAccount[];
  try {
    accounts = resolveAccounts(m, tables);
  } catch (e) {
    errs.push(`invalid account layout: ${e instanceof DecodeError ? e.message : 'malformed'}`);
    return null;
  }
  const keys = accounts.map((a) => a.key);
  const ixs = m.instructions.map((ci) => ({ program: keys[ci.programIdIndex]!, accounts: ci.accountKeyIndexes.map((i) => keys[i]!), data: ci.data }));
  return { m, accounts, keys, ixs };
}

/** Leading ComputeBudget instructions (≤ 1 limit, ≤ 1 price, no accounts, within caps). Returns their count. */
function computeBudget(ixs: Ix[], maxUnits: number, maxPrice: bigint, errs: string[]): number {
  let i = 0;
  const seen = new Set<number>();
  while (i < ixs.length && ixs[i]!.program === COMPUTE_BUDGET_PROGRAM) {
    const ix = ixs[i]!;
    const d = ix.data;
    if (ix.accounts.length !== 0) errs.push(`ix ${i}: compute budget instruction has accounts`);
    if (d[0] === 2 && d.length === 5) {
      const units = readU32(d, 1);
      if (units > maxUnits) errs.push(`ix ${i}: compute unit limit ${units} > ${maxUnits}`);
    } else if (d[0] === 3 && d.length === 9) {
      const price = readU64(d, 1);
      if (price > maxPrice) errs.push(`ix ${i}: compute unit price ${price} > ${maxPrice}`);
    } else {
      errs.push(`ix ${i}: compute budget instruction kind ${d[0] ?? '?'} (len ${d.length}) not allowed`);
    }
    if (d.length > 0) {
      if (seen.has(d[0]!)) errs.push(`ix ${i}: duplicate compute budget instruction kind ${d[0]}`);
      seen.add(d[0]!);
    }
    i++;
  }
  return i;
}

function sameAccounts(ix: Ix, want: string[], what: string, errs: string[]): void {
  if (ix.accounts.length !== want.length) {
    errs.push(`${what}: ${ix.accounts.length} accounts, expected ${want.length}`);
    return;
  }
  for (let i = 0; i < want.length; i++) {
    if (ix.accounts[i] !== want[i]) errs.push(`${what}: account ${i} is ${ix.accounts[i]}, expected ${want[i]}`);
  }
}

/**
 * Exact writability (SPEC §8.1 / §5.2): every account of the message must be writable iff the allowed shape needs it
 * writable (e.g. Config and pump Global stay read-only, so launches never contend for their write locks). Signer
 * writability is checked by the header rules; this covers every account, static and loaded.
 */
function exactWritability(accounts: ResolvedAccount[], writable: ReadonlySet<string>, errs: string[]): void {
  for (const a of accounts) {
    const want = writable.has(a.key);
    if (a.writable !== want) errs.push(`account ${a.key} is ${a.writable ? 'writable' : 'read-only'}; must be ${want ? 'writable' : 'read-only'}`);
  }
}

/** The attestor key may appear exactly once: as account `account` of instruction `ixIndex`, never as a program. */
function attestorOnlyAt(ixs: Ix[], attestor: string, ixIndex: number, account: number, errs: string[]): void {
  ixs.forEach((ix, i) => {
    if (ix.program === attestor) errs.push(`ix ${i}: attestor used as a program id`);
    ix.accounts.forEach((a, j) => {
      if (a === attestor && !(i === ixIndex && j === account)) errs.push(`ix ${i}: attestor referenced as account ${j}`);
    });
  });
}

function startsWith(d: Uint8Array, hex: string): boolean {
  if (d.length < hex.length / 2) return false;
  for (let i = 0; i < hex.length / 2; i++) if (d[i] !== parseInt(hex.slice(2 * i, 2 * i + 2), 16)) return false;
  return true;
}

/* ============================================================================================ create_v2 args */

export interface CreateV2Raw {
  name: Uint8Array;
  symbol: Uint8Array;
  uri: Uint8Array;
  creator: Uint8Array;
  isMayhemMode: number;
  isCashbackEnabled: number;
  creatorFeeBps: bigint;
  isHolderReward: number;
}

/**
 * Strict pump `create_v2` data decoder (IDL 3.2.0): disc ‖ string name ‖ string symbol ‖ string uri ‖ creator(32) ‖
 * is_mayhem_mode(bool) ‖ OptionBool(bool) ‖ OptionU64(u64) ‖ OptionBool(bool). Returns null on any malformation
 * (truncation, trailing byte, overlong length).
 */
export function decodeCreateV2(d: Uint8Array): CreateV2Raw | null {
  if (!startsWith(d, DISC.pumpCreateV2)) return null;
  let o = 8;
  const str = (): Uint8Array | null => {
    if (o + 4 > d.length) return null;
    const n = readU32(d, o);
    o += 4;
    if (n > 1024 || o + n > d.length) return null;
    const s = d.subarray(o, o + n);
    o += n;
    return s;
  };
  const name = str();
  const symbol = str();
  const uri = str();
  if (!name || !symbol || !uri) return null;
  if (o + 32 + 1 + 1 + 8 + 1 !== d.length) return null;
  const creator = d.subarray(o, o + 32);
  o += 32;
  const isMayhemMode = d[o++]!;
  const isCashbackEnabled = d[o++]!;
  const creatorFeeBps = readU64(d, o);
  o += 8;
  const isHolderReward = d[o++]!;
  return { name, symbol, uri, creator, isMayhemMode, isCashbackEnabled, creatorFeeBps, isHolderReward };
}

/* ================================================================================================ launch */

/**
 * Launch rules (SPEC §8.4 launch 1-7 + the strictness above). Allowed shape:
 *   [SetComputeUnitLimit] [SetComputeUnitPrice]  create_v2  register_launch  [ATA CreateIdempotent  buy_exact_quote_in_v3]
 * with the dev-buy pair present iff `devBuyLamports > 0`.
 */
export function launchViolations(bytes: Uint8Array, x: LaunchExpect): string[] {
  const errs: string[] = [];
  const p = prepare(bytes, { numSigners: 3, alt: x.alt, allowLookups: true }, errs);
  if (!p) return errs;
  const { m, keys, ixs, accounts } = p;

  // 1. signers: exactly [launcher (fee payer, writable), mint (writable), attestor (read-only)]
  if (m.header.numRequiredSignatures !== 3) errs.push(`numRequiredSignatures ${m.header.numRequiredSignatures} != 3`);
  if (m.header.numReadonlySignedAccounts !== 1) errs.push(`numReadonlySignedAccounts ${m.header.numReadonlySignedAccounts} != 1 (only the attestor)`);
  if (keys[0] !== x.launcher) errs.push(`fee payer ${keys[0]} is not the launcher ${x.launcher}`);
  if (keys[1] !== x.mint) errs.push(`signer 1 ${keys[1]} is not the reserved mint ${x.mint}`);
  if (keys[2] !== x.attestor) errs.push(`signer 2 ${keys[2]} is not the attestor (read-only signer)`);
  if (errs.length) return errs;

  // 3. instructions: compute budget, then exactly the §8.1 sequence
  const cb = computeBudget(ixs, x.maxComputeUnitLimit, x.maxComputeUnitPriceMicroLamports, errs);
  const rest = ixs.slice(cb);
  const withBuy = x.devBuyLamports > 0n;
  const want = withBuy ? 4 : 2;
  if (rest.length !== want) {
    errs.push(`expected ${withBuy ? 'create_v2, register_launch, ATA, dev buy' : 'create_v2, register_launch'}; got ${rest.length} non-budget instructions`);
    return errs;
  }

  // 4. create_v2
  const create = rest[0]!;
  if (create.program !== PUMP_PROGRAM) errs.push(`ix ${cb}: must be pump create_v2 (program ${create.program})`);
  const args = decodeCreateV2(create.data);
  if (!args) {
    errs.push(`ix ${cb}: not a well-formed pump create_v2`);
  } else {
    if (!bytesEq(args.name, utf8.encode(x.name))) errs.push('create_v2.name differs from the moderated name');
    if (!bytesEq(args.symbol, utf8.encode(x.symbol))) errs.push('create_v2.symbol differs from the moderated symbol');
    if (!bytesEq(args.uri, utf8.encode(x.uri))) errs.push('create_v2.uri differs from the stored metadata uri');
    const vault = b58decodeLen(x.vault, 32);
    if (!vault || !bytesEq(args.creator, vault)) errs.push('create_v2.creator is not the place vault');
    if (args.isMayhemMode !== 0) errs.push('create_v2.is_mayhem_mode must be false');
    if (args.isCashbackEnabled !== 0) errs.push('create_v2 cashback must be false');
    if (args.creatorFeeBps !== 0n) errs.push('create_v2.creator_fee_bps must be 0 (pump default)');
    if (args.isHolderReward !== 0) errs.push('create_v2.is_holder_reward must be false');
  }
  sameAccounts(
    create,
    [
      x.mint,
      PUMP_MINT_AUTHORITY,
      x.bondingCurve,
      x.curveBaseAta,
      PUMP_GLOBAL,
      x.launcher,
      SYSTEM_PROGRAM,
      TOKEN_2022_PROGRAM,
      ATA_PROGRAM,
      MAYHEM_PROGRAM,
      MAYHEM_GLOBAL_PARAMS,
      MAYHEM_SOL_VAULT,
      x.mayhemState,
      x.mayhemTokenVault,
      PUMP_EVENT_AUTHORITY,
      PUMP_PROGRAM,
    ],
    'create_v2',
    errs,
  );

  // 5. register_launch
  const reg = rest[1]!;
  if (reg.program !== x.programId) errs.push(`ix ${cb + 1}: must be shop_vault.register_launch (program ${reg.program})`);
  if (x.placeHash.length !== 32 || !bytesEq(reg.data, Uint8Array.of(SHOP_VAULT_IX.registerLaunch, ...x.placeHash))) {
    errs.push('register_launch data / place_hash mismatch');
  }
  sameAccounts(
    reg,
    [x.launcher, x.attestor, x.config, x.vaultState, x.vault, x.mint, x.bondingCurve, SYSTEM_PROGRAM, INSTRUCTIONS_SYSVAR],
    'register_launch',
    errs,
  );

  // 7. the attestor is referenced only as register_launch account #1
  attestorOnlyAt(ixs, x.attestor, cb + 1, 1, errs);

  // 6. dev buy
  if (withBuy) {
    const ata = rest[2]!;
    if (ata.program !== ATA_PROGRAM || !bytesEq(ata.data, Uint8Array.of(1))) errs.push(`ix ${cb + 2}: must be ATA CreateIdempotent`);
    sameAccounts(ata, [x.launcher, x.launcherAta, x.launcher, x.mint, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM], 'ATA', errs);
    const buy = rest[3]!;
    if (buy.program !== PUMP_PROGRAM) errs.push(`ix ${cb + 3}: dev buy must be pump`);
    const d = buy.data;
    if (d.length !== 25 || !startsWith(d, DISC.pumpBuyExactQuoteInV3)) {
      errs.push(`ix ${cb + 3}: dev buy must be buy_exact_quote_in_v3`);
    } else {
      const spend = readU64(d, 8);
      if (spend > x.maxDevBuyLamports) errs.push(`dev buy ${spend} > cap ${x.maxDevBuyLamports}`);
      if (spend !== x.devBuyLamports) errs.push(`dev buy ${spend} != reserved ${x.devBuyLamports}`);
      if (readU64(d, 16) === 0n) errs.push('dev buy min_tokens_out must be ≥ 1');
      if (d[24] !== 0) errs.push('dev buy partial_fill must be off');
    }
    sameAccounts(
      buy,
      [
        PUMP_GLOBAL,
        x.mint,
        NATIVE_MINT,
        TOKEN_2022_PROGRAM,
        SPL_TOKEN_PROGRAM,
        x.bondingCurve,
        x.curveBaseAta,
        x.curveQuoteAta,
        x.launcher,
        x.launcherAta,
        x.launcherWsolAta,
        x.userVolumeAccumulator,
        PUMP_FEE_CONFIG,
        BUYBACK_FEE_RECIPIENT,
        SYSTEM_PROGRAM,
        PUMP_EVENT_AUTHORITY,
        PUMP_PROGRAM,
      ],
      'dev buy',
      errs,
    );
  } else if (x.devBuyLamports < 0n) {
    errs.push('negative dev buy');
  }

  // 8. exact writability: the writable accounts of create_v2, register_launch (+ ATA and dev buy), nothing else
  const writable = new Set<string>([
    x.launcher,
    x.mint,
    x.bondingCurve,
    x.curveBaseAta,
    MAYHEM_PROGRAM, // pump IDL 3.2.0 marks create_v2's mayhem_program_id writable (the SDK builder does too)
    MAYHEM_SOL_VAULT,
    x.mayhemState,
    x.mayhemTokenVault,
    x.vaultState,
    x.vault,
  ]);
  if (withBuy) for (const k of [x.launcherAta, x.curveQuoteAta, x.launcherWsolAta, x.userVolumeAccumulator, BUYBACK_FEE_RECIPIENT]) writable.add(k);
  exactWritability(accounts, writable, errs);
  return errs;
}

/* ================================================================================================= claim */

/**
 * Claim rules (SPEC §8.4 claim): [SetComputeUnitLimit] [SetComputeUnitPrice] + exactly one request_claim
 * `[attestor, new_owner, config, vault_state, instructions_sysvar]` with nonce == on-chain claim_nonce + 1.
 * No lookup tables, no relayer in v1: signers are exactly [new_owner (fee payer), attestor (read-only)].
 */
export function claimViolations(bytes: Uint8Array, x: ClaimExpect): string[] {
  const errs: string[] = [];
  const p = prepare(bytes, { numSigners: 2, alt: null, allowLookups: false }, errs);
  if (!p) return errs;
  const { m, keys, ixs, accounts } = p;
  if (m.header.numRequiredSignatures !== 2) errs.push(`numRequiredSignatures ${m.header.numRequiredSignatures} != 2`);
  if (m.header.numReadonlySignedAccounts !== 1) errs.push(`numReadonlySignedAccounts ${m.header.numReadonlySignedAccounts} != 1 (only the attestor)`);
  if (keys[0] !== x.newOwner) errs.push(`fee payer ${keys[0]} is not the new owner ${x.newOwner}`);
  if (keys[1] !== x.attestor) errs.push(`signer 1 ${keys[1]} is not the attestor (read-only signer)`);
  if (errs.length) return errs;
  const cb = computeBudget(ixs, x.maxComputeUnitLimit, x.maxComputeUnitPriceMicroLamports, errs);
  const rest = ixs.slice(cb);
  if (rest.length !== 1) {
    errs.push(`expected exactly one request_claim, got ${rest.length} non-budget instructions`);
    return errs;
  }
  const rc = rest[0]!;
  if (rc.program !== x.programId) errs.push(`ix ${cb}: must be shop_vault.request_claim (program ${rc.program})`);
  if (x.expectedNonce < 1n || !bytesEq(rc.data, Uint8Array.of(SHOP_VAULT_IX.requestClaim, ...u64le(x.expectedNonce)))) {
    errs.push(`request_claim data / nonce mismatch (expected nonce ${x.expectedNonce})`);
  }
  sameAccounts(rc, [x.attestor, x.newOwner, x.config, x.vaultState, INSTRUCTIONS_SYSVAR], 'request_claim', errs);
  attestorOnlyAt(ixs, x.attestor, cb, 0, errs);
  // exact writability: only the fee payer (new owner) and the VaultState are written (Config stays read-only)
  exactWritability(accounts, new Set([x.newOwner, x.vaultState]), errs);
  return errs;
}

/* ============================================================================================ approval tokens */

export interface Approved {
  readonly kind: 'launch' | 'claim';
  /** Length of the approved message (informational; the bytes themselves stay private to this module). */
  readonly length: number;
}

/** token → private copy of exactly the bytes that passed (not reachable from outside this module, so not mutable). */
const APPROVED = new WeakMap<Approved, Uint8Array>();

export type Approval = { ok: true; approved: Approved } | { ok: false; violations: string[] };

/** Independent second gate (worker/policyRef.ts: the shop-vault client's checker over web3.js). */
export type ReferenceCheck = (bytes: Uint8Array) => Promise<string[]>;

async function approve(kind: 'launch' | 'claim', bytes: Uint8Array, violations: string[], reference?: ReferenceCheck): Promise<Approval> {
  if (violations.length) return { ok: false, violations };
  const copy = bytes.slice();
  if (reference) {
    let ref: string[];
    try {
      ref = await reference(copy.slice());
    } catch (e) {
      ref = [`reference check failed: ${e instanceof Error ? e.message : 'error'}`];
    }
    if (ref.length) return { ok: false, violations: ref.map((v) => `reference: ${v}`) };
  }
  const approved: Approved = Object.freeze({ kind, length: copy.length });
  APPROVED.set(approved, copy);
  return { ok: true, approved };
}

export function approveLaunch(bytes: Uint8Array, x: LaunchExpect, reference?: ReferenceCheck): Promise<Approval> {
  return approve('launch', bytes, launchViolations(bytes, x), reference);
}

export function approveClaim(bytes: Uint8Array, x: ClaimExpect, reference?: ReferenceCheck): Promise<Approval> {
  return approve('claim', bytes, claimViolations(bytes, x), reference);
}

/**
 * Consumes an approval token (one signature per approval) and returns the bytes to sign. Throws for anything that
 * did not come out of approveLaunch / approveClaim. Used only by worker/attestor.ts.
 */
export function consumeApproved(a: Approved): Uint8Array {
  const bytes = a && typeof a === 'object' ? APPROVED.get(a) : undefined;
  if (!bytes) throw new Error('attestor: refusing to sign an unapproved message');
  APPROVED.delete(a);
  return bytes;
}
