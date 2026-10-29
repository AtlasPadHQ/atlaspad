/**
 * Attestation.
 *
 * v1 (SPEC D2, §8.4): the attestation IS the attestor's co-signature on the whole transaction. The Worker signs a
 * launch or claim message only if `checkLaunchMessage` / `checkClaimMessage` return no violations; any later change
 * to the message invalidates that signature, and the blockhash bounds its lifetime (~60-90 s). On-chain, the attestor
 * can only authorize `register_launch` / `request_claim` (it has no admin power), and each must be the only top-level
 * shop-vault instruction of its tx; these policies stay as defence in depth. Sign exactly `message.serialize()` of
 * the object you validated, never other bytes.
 *
 * Appendix A (reserved, NOT verified by the v1 program): fixed-size messages for an Ed25519SigVerify-precompile
 * attestation, kept byte-exact for when 4 KB v1 transactions are usable in wallets.
 */
import { Buffer } from "buffer";
import {
  type AddressLookupTableAccount,
  type MessageV0,
  PublicKey,
  TransactionInstruction,
  type VersionedMessage,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  ED25519_PROGRAM_ID,
  INSTRUCTIONS_SYSVAR_ID,
  Ix,
  PUMP_BUY_EXACT_QUOTE_IN_V3_DISCRIMINATOR,
  PUMP_CREATE_V2_DISCRIMINATOR,
  PUMP_PROGRAM_ID,
  SHOP_VAULT_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "./constants.ts";
import { i64le, u64le } from "./instructions.ts";
import { associatedTokenAddress, bondingCurvePda, configPda, placeHash as hashPlace, vaultPda, vaultStatePda } from "./pda.ts";

// ------------------------------------------------------------------------------------------- Appendix A (reserved)

export const LAUNCH_ATTESTATION_TAG = "CORNERSHOP:LNCH1";
export const CLAIM_ATTESTATION_TAG = "CORNERSHOP:CLAM1";
export const LAUNCH_ATTESTATION_LEN = 153;
export const CLAIM_ATTESTATION_LEN = 129;
/** Cluster byte of the Appendix A messages (client convention; each cluster also has its own attestor key). */
export const Cluster = { mainnet: 0, devnet: 1, localnet: 2 } as const;
export type ClusterName = keyof typeof Cluster;

const ascii = (s: string) => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** `"CORNERSHOP:LNCH1"(16) ‖ program_id ‖ cluster u8 ‖ place_hash ‖ launcher ‖ mint ‖ expiry i64` = 153 B. */
export function encodeLaunchAttestation(p: {
  cluster: ClusterName;
  placeHash: Uint8Array;
  launcher: PublicKey;
  mint: PublicKey;
  expiry: bigint | number;
  programId?: PublicKey;
}): Uint8Array {
  if (p.placeHash.length !== 32) throw new Error("place hash must be 32 bytes");
  const m = concat(
    ascii(LAUNCH_ATTESTATION_TAG),
    (p.programId ?? SHOP_VAULT_PROGRAM_ID).toBytes(),
    Uint8Array.of(Cluster[p.cluster]),
    p.placeHash,
    p.launcher.toBytes(),
    p.mint.toBytes(),
    i64le(p.expiry),
  );
  if (m.length !== LAUNCH_ATTESTATION_LEN) throw new Error("internal: launch attestation length");
  return m;
}

/** `"CORNERSHOP:CLAM1"(16) ‖ program_id ‖ cluster u8 ‖ place_hash ‖ new_owner ‖ nonce u64 ‖ expiry i64` = 129 B. */
export function encodeClaimAttestation(p: {
  cluster: ClusterName;
  placeHash: Uint8Array;
  newOwner: PublicKey;
  nonce: bigint | number;
  expiry: bigint | number;
  programId?: PublicKey;
}): Uint8Array {
  if (p.placeHash.length !== 32) throw new Error("place hash must be 32 bytes");
  const m = concat(
    ascii(CLAIM_ATTESTATION_TAG),
    (p.programId ?? SHOP_VAULT_PROGRAM_ID).toBytes(),
    Uint8Array.of(Cluster[p.cluster]),
    p.placeHash,
    p.newOwner.toBytes(),
    u64le(p.nonce),
    i64le(p.expiry),
  );
  if (m.length !== CLAIM_ATTESTATION_LEN) throw new Error("internal: claim attestation length");
  return m;
}

/**
 * Appendix A Ed25519SigVerify instruction with everything inline: header (16 B) ‖ pubkey @16 ‖ signature @48 ‖
 * message @112, every instruction index 0xFFFF.
 */
export function ed25519AttestationInstruction(p: { attestor: PublicKey; signature: Uint8Array; message: Uint8Array }): TransactionInstruction {
  if (p.signature.length !== 64) throw new Error("signature must be 64 bytes");
  const header = new Uint8Array(16);
  const v = new DataView(header.buffer);
  header[0] = 1; // num_signatures
  header[1] = 0; // padding
  v.setUint16(2, 48, true); // signature_offset
  v.setUint16(4, 0xffff, true); // signature_instruction_index
  v.setUint16(6, 16, true); // public_key_offset
  v.setUint16(8, 0xffff, true); // public_key_instruction_index
  v.setUint16(10, 112, true); // message_data_offset
  v.setUint16(12, p.message.length, true); // message_data_size
  v.setUint16(14, 0xffff, true); // message_instruction_index
  return new TransactionInstruction({
    programId: ED25519_PROGRAM_ID,
    keys: [],
    data: Buffer.from(concat(header, p.attestor.toBytes(), p.signature, p.message)),
  });
}

// ------------------------------------------------------------------------------------- v1 signing policy (§8.4)

/** A decoded pump `create_v2` instruction's arguments. */
export interface CreateV2Args {
  name: string;
  symbol: string;
  uri: string;
  creator: PublicKey;
  isMayhemMode: boolean;
  isCashbackEnabled: boolean;
  creatorFeeBps: bigint;
  isHolderReward: boolean;
}

/** Strict decoder for pump `create_v2` data (IDL 3.2.0); throws on any trailing or missing byte. */
export function decodeCreateV2Args(data: Uint8Array): CreateV2Args {
  if (data.length < 8 || !PUMP_CREATE_V2_DISCRIMINATOR.every((b, i) => data[i] === b)) throw new Error("not create_v2");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8;
  const dec = new TextDecoder("utf-8", { fatal: true });
  const str = () => {
    if (o + 4 > data.length) throw new Error("create_v2: truncated");
    const n = v.getUint32(o, true);
    o += 4;
    if (o + n > data.length) throw new Error("create_v2: truncated string");
    const s = dec.decode(data.subarray(o, o + n));
    o += n;
    return s;
  };
  const name = str();
  const symbol = str();
  const uri = str();
  if (o + 32 + 1 + 1 + 8 + 1 !== data.length) throw new Error("create_v2: unexpected length");
  const creator = new PublicKey(data.subarray(o, o + 32));
  o += 32;
  const bool = () => {
    const b = data[o++];
    if (b > 1) throw new Error("create_v2: bad bool");
    return b === 1;
  };
  const isMayhemMode = bool();
  const isCashbackEnabled = bool();
  const creatorFeeBps = v.getBigUint64(o, true);
  o += 8;
  const isHolderReward = bool();
  return { name, symbol, uri, creator, isMayhemMode, isCashbackEnabled, creatorFeeBps, isHolderReward };
}

export interface LaunchPolicy {
  /** The attestor key the Worker signs with. */
  attestor: PublicKey;
  /** From the reservation: fee payer, signer #0. */
  launcher: PublicKey;
  /** From the reservation. */
  mint: PublicKey;
  /** Either the place id (hashed here) or its hash. */
  placeId?: string;
  placeHash?: Uint8Array;
  /** Moderated metadata from the reservation; must match create_v2 exactly. */
  name: string;
  symbol: string;
  uri: string;
  /** Max dev buy (lamports, `spendable_quote_in`). 0n forbids a dev buy. */
  maxDevBuyLamports: bigint;
  /** The official CORNERSHOP lookup table of this cluster (required if the message uses one). */
  lookupTable?: AddressLookupTableAccount;
  maxComputeUnitLimit?: number; // default 600_000
  maxComputeUnitPriceMicroLamports?: bigint; // default 5_000_000
  programId?: PublicKey;
}

export interface ClaimPolicy {
  attestor: PublicKey;
  newOwner: PublicKey;
  placeId?: string;
  placeHash?: Uint8Array;
  /** On-chain `claim_nonce + 1`. */
  expectedNonce: bigint;
  /** Optional relayer allowed as fee payer instead of the new owner. */
  relayer?: PublicKey;
  maxComputeUnitLimit?: number; // default 50_000
  maxComputeUnitPriceMicroLamports?: bigint; // default 5_000_000
  programId?: PublicKey;
}

interface DecodedIx {
  programId: PublicKey;
  accounts: { pubkey: PublicKey; index: number }[];
  data: Uint8Array;
}

function resolve(msg: MessageV0, alt: AddressLookupTableAccount | undefined, errs: string[]): { keys: PublicKey[]; ixs: DecodedIx[] } | null {
  const lookups = msg.addressTableLookups;
  if (lookups.length > 1) {
    errs.push("more than one address lookup table");
    return null;
  }
  if (lookups.length === 1) {
    if (!alt) {
      errs.push("message uses a lookup table but none was supplied");
      return null;
    }
    if (!lookups[0].accountKey.equals(alt.key)) {
      errs.push(`lookup table ${lookups[0].accountKey.toBase58()} is not the official ${alt.key.toBase58()}`);
      return null;
    }
  }
  let keys: PublicKey[];
  try {
    const ak = msg.getAccountKeys({ addressLookupTableAccounts: alt ? [alt] : [] });
    keys = [...ak.staticAccountKeys, ...(ak.accountKeysFromLookups?.writable ?? []), ...(ak.accountKeysFromLookups?.readonly ?? [])];
  } catch (e) {
    errs.push(`cannot resolve account keys: ${(e as Error).message}`);
    return null;
  }
  const ixs = msg.compiledInstructions.map((ci) => ({
    programId: keys[ci.programIdIndex],
    accounts: ci.accountKeyIndexes.map((i) => ({ pubkey: keys[i], index: i })),
    data: ci.data,
  }));
  return { keys, ixs };
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Leading ComputeBudget instructions: at most one limit and one price, within caps. Returns how many there are. */
function checkComputeBudget(ixs: DecodedIx[], maxUnits: number, maxPrice: bigint, errs: string[]): number {
  let i = 0;
  const seen = new Set<number>();
  while (i < ixs.length && ixs[i].programId.equals(COMPUTE_BUDGET_PROGRAM_ID)) {
    const d = ixs[i].data;
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (ixs[i].accounts.length !== 0) errs.push("compute budget ix has accounts");
    if (d[0] === 2 && d.length === 5) {
      if (v.getUint32(1, true) > maxUnits) errs.push(`compute unit limit ${v.getUint32(1, true)} > ${maxUnits}`);
    } else if (d[0] === 3 && d.length === 9) {
      if (v.getBigUint64(1, true) > maxPrice) errs.push(`compute unit price ${v.getBigUint64(1, true)} > ${maxPrice}`);
    } else {
      errs.push(`compute budget ix kind ${d[0]} not allowed`);
    }
    if (seen.has(d[0])) errs.push(`duplicate compute budget ix kind ${d[0]}`);
    seen.add(d[0]);
    i++;
  }
  return i;
}

function signerChecks(msg: MessageV0, keys: PublicKey[], want: PublicKey[], feePayer: PublicKey[], attestor: PublicKey, errs: string[]) {
  const h = msg.header;
  if (h.numRequiredSignatures !== want.length) errs.push(`numRequiredSignatures ${h.numRequiredSignatures} != ${want.length}`);
  const signers = keys.slice(0, h.numRequiredSignatures);
  for (const k of want) if (!signers.some((s) => s.equals(k))) errs.push(`missing signer ${k.toBase58()}`);
  for (const s of signers) if (!want.some((k) => k.equals(s))) errs.push(`unexpected signer ${s.toBase58()}`);
  if (!feePayer.some((k) => keys[0]?.equals(k))) errs.push(`fee payer ${keys[0]?.toBase58()} not allowed`);
  const ai = signers.findIndex((s) => s.equals(attestor));
  if (ai >= 0 && ai < h.numRequiredSignatures - h.numReadonlySignedAccounts) errs.push("attestor must be a read-only signer");
  if (ai === 0) errs.push("attestor must not be the fee payer");
}

function attestorReferencedOnlyBy(ixs: DecodedIx[], attestor: PublicKey, ixIndex: number, accountIndex: number, errs: string[]) {
  ixs.forEach((ix, i) => {
    if (ix.programId.equals(attestor)) errs.push("attestor used as a program id");
    ix.accounts.forEach((a, j) => {
      if (a.pubkey.equals(attestor) && !(i === ixIndex && j === accountIndex)) errs.push(`attestor referenced by ix ${i} account ${j}`);
    });
  });
}

function sameKeys(got: { pubkey: PublicKey }[], want: PublicKey[], what: string, errs: string[]) {
  if (got.length !== want.length) {
    errs.push(`${what}: ${got.length} accounts, expected ${want.length}`);
    return;
  }
  want.forEach((k, i) => {
    if (!got[i].pubkey.equals(k)) errs.push(`${what}: account ${i} is ${got[i].pubkey.toBase58()}, expected ${k.toBase58()}`);
  });
}

/**
 * SPEC §8.4 launch rules. Returns the list of violations; the Worker co-signs only when it is empty.
 * Allowed shape: [ComputeBudget…] create_v2 · register_launch · [ATA CreateIdempotent · buy_exact_quote_in_v3].
 */
export function checkLaunchMessage(message: VersionedMessage, p: LaunchPolicy): string[] {
  const errs: string[] = [];
  if (message.version !== 0) return ["message must be v0"];
  const msg = message as MessageV0;
  const programId = p.programId ?? SHOP_VAULT_PROGRAM_ID;
  const ph = p.placeHash ?? (p.placeId !== undefined ? hashPlace(p.placeId) : undefined);
  if (!ph || ph.length !== 32) return ["placeId or placeHash required"];
  const r = resolve(msg, p.lookupTable, errs);
  if (!r) return errs;
  const { keys, ixs } = r;
  signerChecks(msg, keys, [p.launcher, p.mint, p.attestor], [p.launcher], p.attestor, errs);

  const i = checkComputeBudget(ixs, p.maxComputeUnitLimit ?? 600_000, p.maxComputeUnitPriceMicroLamports ?? 5_000_000n, errs);
  const rest = ixs.slice(i);
  if (rest.length !== 2 && rest.length !== 4) {
    errs.push(`expected create_v2, register_launch[, ATA, dev buy]; got ${rest.length} non-budget instructions`);
    return errs;
  }
  const [vault] = vaultPda(ph, programId);

  // create_v2
  const create = rest[0];
  if (!create.programId.equals(PUMP_PROGRAM_ID)) errs.push("ix: create_v2 must be the pump program");
  try {
    const a = decodeCreateV2Args(create.data);
    if (a.name !== p.name) errs.push("create_v2.name differs from the moderated name");
    if (a.symbol !== p.symbol) errs.push("create_v2.symbol differs from the moderated symbol");
    if (a.uri !== p.uri) errs.push("create_v2.uri differs from the moderated uri");
    if (!a.creator.equals(vault)) errs.push("create_v2.creator is not the place vault");
    if (a.isMayhemMode || a.isCashbackEnabled || a.isHolderReward) errs.push("create_v2 mayhem/cashback/holder_reward must be false");
  } catch (e) {
    errs.push((e as Error).message);
  }
  if (create.accounts.length !== 16) errs.push(`create_v2 has ${create.accounts.length} accounts (SOL quote = 16)`);
  if (!create.accounts[0]?.pubkey.equals(p.mint)) errs.push("create_v2.mint is not the reserved mint");
  if (!create.accounts[5]?.pubkey.equals(p.launcher)) errs.push("create_v2.user is not the launcher");

  // register_launch
  const reg = rest[1];
  if (!reg.programId.equals(programId)) errs.push("ix after create_v2 must be shop_vault.register_launch");
  if (!eqBytes(reg.data, Uint8Array.of(Ix.RegisterLaunch, ...ph))) errs.push("register_launch data/place_hash mismatch");
  sameKeys(
    reg.accounts,
    [
      p.launcher,
      p.attestor,
      configPda(programId)[0],
      vaultStatePda(ph, programId)[0],
      vault,
      p.mint,
      bondingCurvePda(p.mint),
      SYSTEM_PROGRAM_ID,
      INSTRUCTIONS_SYSVAR_ID,
    ],
    "register_launch",
    errs,
  );
  attestorReferencedOnlyBy(ixs, p.attestor, i + 1, 1, errs);

  // optional dev buy
  if (rest.length === 4) {
    const ata = rest[2];
    const buy = rest[3];
    if (!ata.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || !eqBytes(ata.data, Uint8Array.of(1))) errs.push("ix 3 must be ATA CreateIdempotent");
    sameKeys(
      ata.accounts,
      [p.launcher, associatedTokenAddress(p.launcher, p.mint, TOKEN_2022_PROGRAM_ID), p.launcher, p.mint, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID],
      "ATA",
      errs,
    );
    if (!buy.programId.equals(PUMP_PROGRAM_ID)) errs.push("dev buy must be pump");
    const d = buy.data;
    if (d.length !== 25 || !PUMP_BUY_EXACT_QUOTE_IN_V3_DISCRIMINATOR.every((b, k) => d[k] === b)) {
      errs.push("dev buy must be buy_exact_quote_in_v3");
    } else {
      const spend = new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(8, true);
      if (spend > p.maxDevBuyLamports) errs.push(`dev buy ${spend} > cap ${p.maxDevBuyLamports}`);
    }
    if (buy.accounts.length !== 17) errs.push("dev buy account count");
    if (!buy.accounts[1]?.pubkey.equals(p.mint)) errs.push("dev buy base_mint is not the reserved mint");
    if (!buy.accounts[8]?.pubkey.equals(p.launcher)) errs.push("dev buy user is not the launcher");
  }
  return errs;
}

/**
 * SPEC §8.4 claim rules: [ComputeBudget…] + exactly one request_claim `[attestor, new_owner, config, vault_state,
 * instructions_sysvar]` with
 * `nonce == on-chain claim_nonce + 1`; fee payer = new owner or the relayer; attestor referenced only there.
 */
export function checkClaimMessage(message: VersionedMessage, p: ClaimPolicy): string[] {
  const errs: string[] = [];
  const programId = p.programId ?? SHOP_VAULT_PROGRAM_ID;
  const ph = p.placeHash ?? (p.placeId !== undefined ? hashPlace(p.placeId) : undefined);
  if (!ph || ph.length !== 32) return ["placeId or placeHash required"];
  if (message.version !== 0) return ["message must be v0"];
  const msg = message as MessageV0;
  if (msg.addressTableLookups.length) return ["claim messages must not use lookup tables"];
  const r = resolve(msg, undefined, errs);
  if (!r) return errs;
  const { keys, ixs } = r;
  const payers = p.relayer ? [p.newOwner, p.relayer] : [p.newOwner];
  const relayed = !!p.relayer && keys[0]?.equals(p.relayer);
  signerChecks(msg, keys, relayed ? [p.relayer!, p.newOwner, p.attestor] : [p.newOwner, p.attestor], payers, p.attestor, errs);
  const i = checkComputeBudget(ixs, p.maxComputeUnitLimit ?? 50_000, p.maxComputeUnitPriceMicroLamports ?? 5_000_000n, errs);
  const rest = ixs.slice(i);
  if (rest.length !== 1) {
    errs.push(`expected exactly one request_claim, got ${rest.length} non-budget instructions`);
    return errs;
  }
  const rc = rest[0];
  if (!rc.programId.equals(programId)) errs.push("ix must be shop_vault.request_claim");
  if (!eqBytes(rc.data, Uint8Array.of(Ix.RequestClaim, ...u64le(p.expectedNonce)))) errs.push("request_claim data/nonce mismatch");
  sameKeys(
    rc.accounts,
    [p.attestor, p.newOwner, configPda(programId)[0], vaultStatePda(ph, programId)[0], INSTRUCTIONS_SYSVAR_ID],
    "request_claim",
    errs,
  );
  attestorReferencedOnlyBy(ixs, p.attestor, i, 0, errs);
  return errs;
}
