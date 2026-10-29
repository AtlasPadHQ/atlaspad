/** Place hashing and PDA helpers (SPEC §3.1). */
import { sha256 } from "@noble/hashes/sha2";
import { PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BPF_LOADER_UPGRADEABLE_ID,
  NATIVE_MINT,
  PUMP_PROGRAM_ID,
  SEED_CONFIG,
  SEED_VAULT,
  SEED_VAULT_STATE,
  SHOP_VAULT_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
} from "./constants.ts";

const utf8 = new TextEncoder();

/**
 * `place_hash = sha256(utf8(placeId))` where `placeId` is the bare Places API (New) `place.id`
 * (no `places/` prefix, no trimming or normalisation). The backend hashes the place it looked up itself.
 */
export function placeHash(placeId: string): Uint8Array {
  if (placeId.length === 0) throw new Error("placeId is empty");
  if (placeId.startsWith("places/")) throw new Error("pass the bare place.id, without the places/ prefix");
  return sha256(utf8.encode(placeId));
}

export function placeHashHex(placeId: string): string {
  return toHex(placeHash(placeId));
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function check32(h: Uint8Array): Uint8Array {
  if (h.length !== 32) throw new Error(`place hash must be 32 bytes, got ${h.length}`);
  return h;
}

export function configPda(programId: PublicKey = SHOP_VAULT_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8.encode(SEED_CONFIG)], programId);
}

/** The ShopVault: system-owned, zero-data PDA that is the pump.fun `creator` of the place's coin. */
export function vaultPda(placeHash: Uint8Array, programId: PublicKey = SHOP_VAULT_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8.encode(SEED_VAULT), check32(placeHash)], programId);
}

/** The program-owned VaultState of a place. */
export function vaultStatePda(placeHash: Uint8Array, programId: PublicKey = SHOP_VAULT_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([utf8.encode(SEED_VAULT_STATE), check32(placeHash)], programId);
}

/** ProgramData account of the upgradeable program (read by `initialize_config`). */
export function programDataPda(programId: PublicKey = SHOP_VAULT_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBytes()], BPF_LOADER_UPGRADEABLE_ID)[0];
}

/** Convenience: every address of a place. */
export function placeAddresses(placeId: string, programId: PublicKey = SHOP_VAULT_PROGRAM_ID) {
  const ph = placeHash(placeId);
  const [vault, vaultBump] = vaultPda(ph, programId);
  const [vaultState, stateBump] = vaultStatePda(ph, programId);
  return { placeHash: ph, vault, vaultBump, vaultState, stateBump };
}

// pump.fun PDAs used around the vault (reference; the SDK has its own copies).

export function bondingCurvePda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([utf8.encode("bonding-curve"), mint.toBytes()], PUMP_PROGRAM_ID)[0];
}

/** pump's per-creator fee vault; for our coins `creatorVaultPda(vault)`. */
export function pumpCreatorVaultPda(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([utf8.encode("creator-vault"), creator.toBytes()], PUMP_PROGRAM_ID)[0];
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

/** The vault's WSOL ATA (where pump-amm `collect_coin_creator_fee` can push graduated fees; see `unwrapWsol`). */
export function vaultWsolAta(vault: PublicKey): PublicKey {
  return associatedTokenAddress(vault, NATIVE_MINT, SPL_TOKEN_PROGRAM_ID);
}
