/**
 * Instruction builders (SPEC §5). Byte 0 is the discriminator, then fixed-size little-endian args; account order and
 * signer/writable flags exactly as the tables in §5. The program rejects any other data length.
 */
import { Buffer } from "buffer";
import { type AccountMeta, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { INSTRUCTIONS_SYSVAR_ID, Ix, SHOP_VAULT_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID } from "./constants.ts";
import { bondingCurvePda, configPda, programDataPda, vaultPda, vaultStatePda } from "./pda.ts";

const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const ros = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: false });
const ws = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: true });

function ix(keys: AccountMeta[], data: Uint8Array, programId: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}

export function u64le(v: bigint | number): Uint8Array {
  const b = new Uint8Array(8);
  const n = BigInt(v);
  if (n < 0n || n > 0xffff_ffff_ffff_ffffn) throw new RangeError("u64 out of range");
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

export function i64le(v: bigint | number): Uint8Array {
  const b = new Uint8Array(8);
  const n = BigInt(v);
  if (n < -(2n ** 63n) || n > 2n ** 63n - 1n) throw new RangeError("i64 out of range");
  new DataView(b.buffer).setBigInt64(0, n, true);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function hash32(h: Uint8Array): Uint8Array {
  if (h.length !== 32) throw new Error("place hash must be 32 bytes");
  return h;
}

export interface ProgramOpt {
  programId?: PublicKey;
}

/**
 * disc 0 — `[0] attestor:32 governance:32 guardian:32 claim_window_secs:i64` (105 B). The payer must be the upgrade
 * authority. The three keys must be distinct: attestor = online Worker co-signer, governance = Squads vault,
 * guardian = offline ops key (never the Worker's key).
 */
export function initializeConfig(
  p: {
    payer: PublicKey;
    attestor: PublicKey;
    governance: PublicKey;
    guardian: PublicKey;
    claimWindowSecs: bigint | number;
  } & ProgramOpt,
): TransactionInstruction {
  const programId = p.programId ?? SHOP_VAULT_PROGRAM_ID;
  const data = concat(
    Uint8Array.of(Ix.InitializeConfig),
    p.attestor.toBytes(),
    p.governance.toBytes(),
    p.guardian.toBytes(),
    i64le(p.claimWindowSecs),
  );
  return ix([ws(p.payer), w(configPda(programId)[0]), ro(programDataPda(programId)), ro(SYSTEM_PROGRAM_ID)], data, programId);
}

/**
 * disc 1 — `[1] place_hash:32` (33 B). Goes right after pump `create_v2(creator = vaultPda(placeHash))` in the launch
 * tx and before the dev buy; the attestor co-signs the whole tx (SPEC §8.1). The 9th account is the Instructions
 * sysvar: the program refuses the tx if any other top-level instruction calls shop-vault.
 */
export function registerLaunch(
  p: { launcher: PublicKey; attestor: PublicKey; placeHash: Uint8Array; mint: PublicKey } & ProgramOpt,
): TransactionInstruction {
  const programId = p.programId ?? SHOP_VAULT_PROGRAM_ID;
  const ph = hash32(p.placeHash);
  return ix(
    [
      ws(p.launcher),
      ros(p.attestor),
      ro(configPda(programId)[0]),
      w(vaultStatePda(ph, programId)[0]),
      w(vaultPda(ph, programId)[0]),
      ro(p.mint),
      ro(bondingCurvePda(p.mint)),
      ro(SYSTEM_PROGRAM_ID),
      ro(INSTRUCTIONS_SYSVAR_ID),
    ],
    concat(Uint8Array.of(Ix.RegisterLaunch), ph),
    programId,
  );
}

/**
 * disc 2 — `[2] nonce:u64` (9 B); `nonce` must be the on-chain `claim_nonce + 1`. Signers: attestor, new owner.
 * Must be the only shop-vault instruction of its tx (Instructions sysvar, account 4).
 */
export function requestClaim(
  p: { attestor: PublicKey; newOwner: PublicKey; placeHash: Uint8Array; nonce: bigint | number } & ProgramOpt,
): TransactionInstruction {
  const programId = p.programId ?? SHOP_VAULT_PROGRAM_ID;
  return ix(
    [
      ros(p.attestor),
      ros(p.newOwner),
      ro(configPda(programId)[0]),
      w(vaultStatePda(hash32(p.placeHash), programId)[0]),
      ro(INSTRUCTIONS_SYSVAR_ID),
    ],
    concat(Uint8Array.of(Ix.RequestClaim), u64le(p.nonce)),
    programId,
  );
}

/**
 * disc 3 — the guardian (always), governance (at most `MAX_GOVERNANCE_SOLO_CANCELS` per place, ever), the pending
 * claimant, or the current owner for a claim requested during a probation. Never the attestor.
 */
export function cancelClaim(p: { authority: PublicKey; placeHash: Uint8Array } & ProgramOpt): TransactionInstruction {
  const programId = p.programId ?? SHOP_VAULT_PROGRAM_ID;
  return ix(
    [ros(p.authority), ro(configPda(programId)[0]), w(vaultStatePda(hash32(p.placeHash), programId)[0])],
    Uint8Array.of(Ix.CancelClaim),
    programId,
  );
}

/** disc 4 — permissionless once `now >= unlock_ts`. */
export function finalizeClaim(p: { placeHash: Uint8Array } & ProgramOpt): TransactionInstruction {
  const programId = p.programId ?? SHOP_VAULT_PROGRAM_ID;
  return ix([w(vaultStatePda(hash32(p.placeHash), programId)[0])], Uint8Array.of(Ix.FinalizeClaim), programId);
}

/** disc 5 — owner-signed; pays everything above rent to the owner. Any fee payer may submit it. */
export function withdraw(p: { owner: PublicKey; placeHash: Uint8Array } & ProgramOpt): TransactionInstruction {
  const programId = p.programId ?? SHOP_VAULT_PROGRAM_ID;
  const ph = hash32(p.placeHash);
  return ix(
    [ws(p.owner), w(vaultStatePda(ph, programId)[0]), w(vaultPda(ph, programId)[0]), ro(SYSTEM_PROGRAM_ID)],
    Uint8Array.of(Ix.Withdraw),
    programId,
  );
}

/** disc 6 — permissionless; closes a vault-owned WSOL account into the vault. */
export function unwrapWsol(p: { placeHash: Uint8Array; wsolAccount: PublicKey } & ProgramOpt): TransactionInstruction {
  const programId = p.programId ?? SHOP_VAULT_PROGRAM_ID;
  const ph = hash32(p.placeHash);
  return ix(
    [ro(vaultStatePda(ph, programId)[0]), w(vaultPda(ph, programId)[0]), w(p.wsolAccount), ro(SPL_TOKEN_PROGRAM_ID)],
    Uint8Array.of(Ix.UnwrapWsol),
    programId,
  );
}

function admin(disc: number, signer: PublicKey, programId: PublicKey, arg?: Uint8Array): TransactionInstruction {
  return ix([ros(signer), w(configPda(programId)[0])], arg ? concat(Uint8Array.of(disc), arg) : Uint8Array.of(disc), programId);
}

/** disc 7 — guardian or governance; blocks `register_launch` only. */
export function setPaused(p: { authority: PublicKey; paused: boolean } & ProgramOpt): TransactionInstruction {
  return admin(Ix.SetPaused, p.authority, p.programId ?? SHOP_VAULT_PROGRAM_ID, Uint8Array.of(p.paused ? 1 : 0));
}

/**
 * disc 8 — governance proposes a new attestor. Applied at once by the guardian (`acceptAttestor`), or by anyone after
 * 7 d (14 d if the guardian vetoed the previous proposal; devnet 300 s / 600 s). Every attestor change starts a
 * 7-day probation for new claims.
 */
export function proposeAttestor(p: { governance: PublicKey; newAttestor: PublicKey } & ProgramOpt): TransactionInstruction {
  return admin(Ix.ProposeAttestor, p.governance, p.programId ?? SHOP_VAULT_PROGRAM_ID, p.newAttestor.toBytes());
}

/** disc 9 — the guardian applies at once (consent); anyone after the eta. */
export function acceptAttestor(p: { caller: PublicKey } & ProgramOpt): TransactionInstruction {
  return admin(Ix.AcceptAttestor, p.caller, p.programId ?? SHOP_VAULT_PROGRAM_ID);
}

/** disc 10 — governance withdraws its proposal, or the guardian vetoes it (not an escalated one). */
export function cancelAttestorProposal(p: { authority: PublicKey } & ProgramOpt): TransactionInstruction {
  return admin(Ix.CancelAttestorProposal, p.authority, p.programId ?? SHOP_VAULT_PROGRAM_ID);
}

/**
 * disc 11 — governance hands over to `newGovernance` (accept within 30 d), or the guardian proposes a recovery
 * (acceptable after 30 d unless governance withdraws it). `PublicKey.default` withdraws the pending proposal (the
 * guardian may only withdraw its own).
 */
export function proposeGovernance(
  p: { governance?: PublicKey; authority?: PublicKey; newGovernance: PublicKey } & ProgramOpt,
): TransactionInstruction {
  const signer = p.authority ?? p.governance;
  if (!signer) throw new Error("proposeGovernance: authority (governance or guardian) required");
  return admin(Ix.ProposeGovernance, signer, p.programId ?? SHOP_VAULT_PROGRAM_ID, p.newGovernance.toBytes());
}

/** disc 11 with the zero key — withdraw the pending governance proposal. */
export function withdrawGovernanceProposal(p: { authority: PublicKey } & ProgramOpt): TransactionInstruction {
  return proposeGovernance({ authority: p.authority, newGovernance: PublicKey.default, programId: p.programId });
}

/** disc 12 — signed by the pending governance. Clears every pending attestor/guardian proposal. */
export function acceptGovernance(p: { newGovernance: PublicKey } & ProgramOpt): TransactionInstruction {
  return admin(Ix.AcceptGovernance, p.newGovernance, p.programId ?? SHOP_VAULT_PROGRAM_ID);
}

/** disc 13 — governance proposes a new guardian (same delays and veto rules as the attestor). */
export function proposeGuardian(p: { governance: PublicKey; newGuardian: PublicKey } & ProgramOpt): TransactionInstruction {
  return admin(Ix.ProposeGuardian, p.governance, p.programId ?? SHOP_VAULT_PROGRAM_ID, p.newGuardian.toBytes());
}

/** disc 14 — the current guardian applies at once (consent); anyone after the eta. */
export function acceptGuardian(p: { caller: PublicKey } & ProgramOpt): TransactionInstruction {
  return admin(Ix.AcceptGuardian, p.caller, p.programId ?? SHOP_VAULT_PROGRAM_ID);
}

/** disc 15 — governance withdraws its proposal, or the guardian vetoes it (not an escalated one). */
export function cancelGuardianProposal(p: { authority: PublicKey } & ProgramOpt): TransactionInstruction {
  return admin(Ix.CancelGuardianProposal, p.authority, p.programId ?? SHOP_VAULT_PROGRAM_ID);
}
