/** Account decoders (SPEC §3.2, §3.3; pump BondingCurve prefix §2). Fixed offsets, little-endian. */
import { PublicKey } from "@solana/web3.js";
import {
  BONDING_CURVE_DISCRIMINATOR,
  CONFIG_LEN,
  ConfigFlag,
  LAYOUT_VERSION,
  TAG_CONFIG,
  TAG_VAULT_STATE,
  VAULT_STATE_LEN,
} from "./constants.ts";

/** Config byte offsets (attestor and guardian are `{ current, pending, eta }` rotation slots of 72 B). */
export const CONFIG_OFFSETS = {
  tag: 0,
  version: 1,
  bump: 2,
  paused: 3,
  flavor: 4,
  flags: 5,
  attestor: 8,
  pendingAttestor: 40,
  pendingAttestorEta: 72,
  guardian: 80,
  pendingGuardian: 112,
  pendingGuardianEta: 144,
  governance: 152,
  pendingGovernance: 184,
  pendingGovernanceEta: 216,
  claimWindowSecs: 224,
  probationUntil: 232,
  rotationDelaySecs: 240,
  reserved: 248,
} as const;

/** VaultState byte offsets. */
export const VAULT_STATE_OFFSETS = {
  tag: 0,
  version: 1,
  stateBump: 2,
  vaultBump: 3,
  hasOwner: 4,
  hasPending: 5,
  governanceCancels: 6,
  pendingFlags: 7,
  placeHash: 8,
  mint: 40,
  launcher: 72,
  owner: 104,
  pendingOwner: 136,
  unlockTs: 168,
  claimNonce: 176,
  totalWithdrawn: 184,
  createdAt: 192,
  ownerSince: 200,
} as const;

export interface ConfigAccount {
  bump: number;
  paused: boolean;
  /** Build that initialised this Config. */
  flavor: "mainnet" | "devnet";
  /** Raw `flags` byte (`ConfigFlag` bits). */
  flags: number;
  /** The guardian vetoed an attestor proposal: the pending/next one is escalated (no veto, longer delay). */
  attestorProposalEscalated: boolean;
  guardianProposalEscalated: boolean;
  attestor: PublicKey;
  guardian: PublicKey;
  governance: PublicKey;
  /** null when no proposal is pending. */
  pendingAttestor: PublicKey | null;
  pendingAttestorEta: bigint;
  pendingGuardian: PublicKey | null;
  pendingGuardianEta: bigint;
  pendingGovernance: PublicKey | null;
  /** Accept window is `[eta, eta + 30 d)`. */
  pendingGovernanceEta: bigint;
  /** The pending governance proposal is a recovery proposed by the guardian. */
  pendingGovernanceByGuardian: boolean;
  claimWindowSecs: bigint;
  /** Claims requested before this unix time unlock at `probationUntil + claimWindowSecs` at the earliest. */
  probationUntil: bigint;
  rotationDelaySecs: bigint;
}

export interface VaultStateAccount {
  stateBump: number;
  vaultBump: number;
  placeHash: Uint8Array;
  mint: PublicKey;
  launcher: PublicKey;
  /** The verified owner, null until the first claim is finalized. */
  owner: PublicKey | null;
  /** The pending claimant and the unix time it can be finalized; `inProbation`: the owner may cancel it. */
  pending: { owner: PublicKey; unlockTs: bigint; inProbation: boolean } | null;
  /** Claims governance cancelled here so far (after `MAX_GOVERNANCE_SOLO_CANCELS`, only the guardian can cancel). */
  governanceCancels: number;
  /** Last consumed claim nonce; the next `request_claim` must use `claimNonce + 1n`. */
  claimNonce: bigint;
  totalWithdrawn: bigint;
  createdAt: bigint;
  ownerSince: bigint;
}

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const key = (d: Uint8Array, o: number) => new PublicKey(d.subarray(o, o + 32));
const isZero = (d: Uint8Array, o: number, n = 32) => d.subarray(o, o + n).every((b) => b === 0);
const optKey = (d: Uint8Array, o: number) => (isZero(d, o) ? null : key(d, o));

export function decodeConfig(data: Uint8Array): ConfigAccount {
  if (data.length !== CONFIG_LEN) throw new Error(`Config must be ${CONFIG_LEN} bytes, got ${data.length}`);
  if (data[0] !== TAG_CONFIG || data[1] !== LAYOUT_VERSION) throw new Error("not a shop-vault Config (tag/version)");
  const v = view(data);
  const o = CONFIG_OFFSETS;
  const flags = data[o.flags];
  return {
    bump: data[o.bump],
    paused: data[o.paused] === 1,
    flavor: data[o.flavor] === 1 ? "devnet" : "mainnet",
    flags,
    attestorProposalEscalated: (flags & ConfigFlag.AttestorVetoed) !== 0,
    guardianProposalEscalated: (flags & ConfigFlag.GuardianVetoed) !== 0,
    attestor: key(data, o.attestor),
    guardian: key(data, o.guardian),
    governance: key(data, o.governance),
    pendingAttestor: optKey(data, o.pendingAttestor),
    pendingAttestorEta: v.getBigInt64(o.pendingAttestorEta, true),
    pendingGuardian: optKey(data, o.pendingGuardian),
    pendingGuardianEta: v.getBigInt64(o.pendingGuardianEta, true),
    pendingGovernance: optKey(data, o.pendingGovernance),
    pendingGovernanceEta: v.getBigInt64(o.pendingGovernanceEta, true),
    pendingGovernanceByGuardian: (flags & ConfigFlag.GovernanceByGuardian) !== 0,
    claimWindowSecs: v.getBigInt64(o.claimWindowSecs, true),
    probationUntil: v.getBigInt64(o.probationUntil, true),
    rotationDelaySecs: v.getBigInt64(o.rotationDelaySecs, true),
  };
}

export function decodeVaultState(data: Uint8Array): VaultStateAccount {
  if (data.length !== VAULT_STATE_LEN) throw new Error(`VaultState must be ${VAULT_STATE_LEN} bytes, got ${data.length}`);
  if (data[0] !== TAG_VAULT_STATE || data[1] !== LAYOUT_VERSION) throw new Error("not a shop-vault VaultState (tag/version)");
  const v = view(data);
  const o = VAULT_STATE_OFFSETS;
  return {
    stateBump: data[o.stateBump],
    vaultBump: data[o.vaultBump],
    placeHash: data.slice(o.placeHash, o.placeHash + 32),
    mint: key(data, o.mint),
    launcher: key(data, o.launcher),
    owner: data[o.hasOwner] === 1 ? key(data, o.owner) : null,
    pending:
      data[o.hasPending] === 1
        ? { owner: key(data, o.pendingOwner), unlockTs: v.getBigInt64(o.unlockTs, true), inProbation: (data[o.pendingFlags] & 1) === 1 }
        : null,
    governanceCancels: data[o.governanceCancels],
    claimNonce: v.getBigUint64(o.claimNonce, true),
    totalWithdrawn: v.getBigUint64(o.totalWithdrawn, true),
    createdAt: v.getBigInt64(o.createdAt, true),
    ownerSince: v.getBigInt64(o.ownerSince, true),
  };
}

/** The BondingCurve prefix fields `register_launch` checks (bytes 0..125) plus the v3 creator-fee bucket at 125. */
export interface BondingCurvePrefix {
  realQuoteReserves: bigint;
  complete: boolean;
  creator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  quoteMint: PublicKey;
  isHolderReward: boolean;
  /** Creator fees left on the curve by v3 trades (swept by `sweep_creator_fee`); 0 if the account is shorter. */
  creatorFeeBucket: bigint;
}

export function decodeBondingCurvePrefix(data: Uint8Array): BondingCurvePrefix {
  if (data.length < 125) throw new Error("bonding curve too short");
  if (!BONDING_CURVE_DISCRIMINATOR.every((b, i) => data[i] === b)) throw new Error("not a pump BondingCurve");
  const v = view(data);
  return {
    realQuoteReserves: v.getBigUint64(32, true),
    complete: data[48] !== 0,
    creator: key(data, 49),
    isMayhemMode: data[81] !== 0,
    isCashbackCoin: data[82] !== 0,
    quoteMint: key(data, 83),
    isHolderReward: data[124] !== 0,
    creatorFeeBucket: data.length >= 133 ? v.getBigUint64(125, true) : 0n,
  };
}

/**
 * "Fees waiting for this shop" (SPEC §8.5) from raw lamports/data, rent minimums supplied by the caller (read them
 * from the cluster: devnet, mainnet and LiteSVM differ).
 */
export function feesWaiting(p: {
  vaultLamports: bigint;
  vaultStateLamports: bigint;
  rentMin0: bigint;
  rentMinVaultState: bigint;
  pumpCreatorVaultLamports?: bigint;
  curveCreatorFeeBucket?: bigint;
  wsolLamports?: bigint;
}): { withdrawableNow: bigint; collectable: bigint; total: bigint } {
  const pos = (x: bigint) => (x > 0n ? x : 0n);
  const withdrawableNow = pos(p.vaultLamports - p.rentMin0) + pos(p.vaultStateLamports - p.rentMinVaultState);
  const collectable = pos((p.pumpCreatorVaultLamports ?? 0n) - p.rentMin0) + (p.curveCreatorFeeBucket ?? 0n) + (p.wsolLamports ?? 0n);
  return { withdrawableNow, collectable, total: withdrawableNow + collectable };
}
