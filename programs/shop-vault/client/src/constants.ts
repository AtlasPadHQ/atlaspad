/**
 * Constants of the shop-vault program (SPEC.md §2, §3, §5, §6). Byte layouts here must match the Rust program
 * exactly; test/vectors.json is checked by both the TS tests and the Rust LiteSVM tests.
 */
import { PublicKey } from "@solana/web3.js";

/** Program id (same on devnet and mainnet): `.keys/shop-vault-program.json`. */
export const SHOP_VAULT_PROGRAM_ID = new PublicKey("6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x");

export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
export const SPL_TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey("ComputeBudget111111111111111111111111111111");
export const ED25519_PROGRAM_ID = new PublicKey("Ed25519SigVerify111111111111111111111111111");
/** Instructions sysvar: `register_launch` and `request_claim` read it to bind the attestor's co-signature. */
export const INSTRUCTIONS_SYSVAR_ID = new PublicKey("Sysvar1nstructions1111111111111111111111111");

/** pump.fun (reference only; the program reads bonding curves in `register_launch`). */
export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const PUMP_FEES_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");

/** `sha256("account:BondingCurve")[..8]`. */
export const BONDING_CURVE_DISCRIMINATOR = Uint8Array.from([0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60]);
/** pump `create_v2` / `buy_exact_quote_in_v3` discriminators (`sha256("global:<name>")[..8]`). */
export const PUMP_CREATE_V2_DISCRIMINATOR = Uint8Array.from([0xd6, 0x90, 0x4c, 0xec, 0x5f, 0x8b, 0x31, 0xb4]);
export const PUMP_BUY_EXACT_QUOTE_IN_V3_DISCRIMINATOR = Uint8Array.from([0xe1, 0xf7, 0x50, 0x1e, 0xd5, 0xb3, 0x84, 0x88]);

export const SEED_CONFIG = "config";
export const SEED_VAULT = "vault";
export const SEED_VAULT_STATE = "vault_state";

export const CONFIG_LEN = 256;
export const VAULT_STATE_LEN = 208;
export const TAG_CONFIG = 1;
export const TAG_VAULT_STATE = 2;
export const LAYOUT_VERSION = 1;

/** Build-profile constants (SPEC §2). Config records the build: `flavor` (0 mainnet, 1 devnet), `rotationDelaySecs`. */
export const BuildConstants = {
  mainnet: {
    minClaimWindowSecs: 259_200, // 72 h
    maxClaimWindowSecs: 2_592_000, // 30 d
    rotationDelaySecs: 604_800, // 7 d: attestor / guardian proposal applied by anyone after this
    escalatedRotationDelaySecs: 1_209_600, // 14 d: proposal made after a guardian veto (not vetoable)
    probationSecs: 604_800, // 7 d after every attestor change
    governanceRecoveryDelaySecs: 2_592_000, // 30 d: guardian-proposed governance recovery
    governanceAcceptWindowSecs: 2_592_000, // 30 d
  },
  devnet: {
    minClaimWindowSecs: 60,
    maxClaimWindowSecs: 86_400, // below the mainnet minimum: a devnet binary refuses the mainnet window
    rotationDelaySecs: 300,
    escalatedRotationDelaySecs: 600,
    probationSecs: 300,
    governanceRecoveryDelaySecs: 900,
    governanceAcceptWindowSecs: 2_592_000,
  },
} as const;
export const MAINNET_MIN_CLAIM_WINDOW_SECS = BuildConstants.mainnet.minClaimWindowSecs;
export const DEVNET_MIN_CLAIM_WINDOW_SECS = BuildConstants.devnet.minClaimWindowSecs;
export const MAINNET_MAX_CLAIM_WINDOW_SECS = BuildConstants.mainnet.maxClaimWindowSecs;
export const DEVNET_MAX_CLAIM_WINDOW_SECS = BuildConstants.devnet.maxClaimWindowSecs;
export const MAINNET_ROTATION_DELAY_SECS = BuildConstants.mainnet.rotationDelaySecs;
export const DEVNET_ROTATION_DELAY_SECS = BuildConstants.devnet.rotationDelaySecs;
/** Per place, governance may cancel this many claims (lifetime); after that only the guardian can. */
export const MAX_GOVERNANCE_SOLO_CANCELS = 2;
/** Config `flags` bits. */
export const ConfigFlag = { AttestorVetoed: 1, GuardianVetoed: 2, GovernanceByGuardian: 4 } as const;
/** `ClaimCancelled` role byte (and the role byte of AdminChanged cancel events: 0 guardian, 1 governance). */
export const CancelRole = { Guardian: 0, Governance: 1, Claimant: 2, OwnerInProbation: 3 } as const;
/** `AdminChanged` kind byte (SPEC §7). */
export const AdminChangedKind = {
  Paused: 0,
  AttestorProposed: 1,
  AttestorApplied: 2,
  AttestorProposalCancelled: 3,
  GovernanceProposed: 4,
  GovernanceApplied: 5,
  GuardianProposed: 6,
  GuardianApplied: 7,
  GuardianProposalCancelled: 8,
  GovernanceProposalCancelled: 9,
} as const;

/** Instruction discriminators (byte 0 of the instruction data, SPEC §5). */
export const Ix = {
  InitializeConfig: 0,
  RegisterLaunch: 1,
  RequestClaim: 2,
  CancelClaim: 3,
  FinalizeClaim: 4,
  Withdraw: 5,
  UnwrapWsol: 6,
  SetPaused: 7,
  ProposeAttestor: 8,
  AcceptAttestor: 9,
  CancelAttestorProposal: 10,
  ProposeGovernance: 11,
  AcceptGovernance: 12,
  ProposeGuardian: 13,
  AcceptGuardian: 14,
  CancelGuardianProposal: 15,
} as const;
export type IxName = keyof typeof Ix;

/** Custom error codes (`ProgramError::Custom(n)`, SPEC §6). */
export const ShopVaultError = {
  InvalidInstruction: 100,
  InvalidConfig: 101,
  InvalidVaultState: 102,
  InvalidVault: 103,
  NotUpgradeAuthority: 104,
  AlreadyInitialized: 105,
  InvalidWindow: 106,
  InvalidAuthorityKey: 107,
  AttestorMismatch: 108,
  LaunchesPaused: 109,
  AlreadyRegistered: 110,
  InvalidAccountState: 111,
  InvalidBondingCurve: 112,
  CreatorMismatch: 113,
  UnsupportedCurve: 114,
  InvalidSystemProgram: 115,
  CurveNotFresh: 116,
  ClaimAlreadyPending: 117,
  NoPendingClaim: 118,
  BadNonce: 119,
  SameOwner: 120,
  InvalidOwner: 121,
  ClaimWindowActive: 122,
  ClaimWindowElapsed: 123,
  Unauthorized: 124,
  NoOwner: 125,
  NotOwner: 126,
  NothingToWithdraw: 127,
  ArithmeticOverflow: 128,
  NoPendingRotation: 129,
  RotationNotReady: 130,
  NoPendingGovernance: 131,
  InvalidTokenProgram: 132,
  InvalidTokenAccount: 133,
  AccountNotWritable: 134,
  InvalidInstructionsSysvar: 135,
  AttestorScope: 136,
  GovernanceCancelLimit: 137,
  ProposalEscalated: 138,
  ProposalExpired: 139,
} as const;
export type ShopVaultErrorName = keyof typeof ShopVaultError;

const ERROR_NAMES: Record<number, ShopVaultErrorName> = Object.fromEntries(
  Object.entries(ShopVaultError).map(([k, v]) => [v, k as ShopVaultErrorName]),
);

/** Name of a shop-vault custom error code, or undefined. */
export function shopVaultErrorName(code: number): ShopVaultErrorName | undefined {
  return ERROR_NAMES[code];
}

/**
 * Extracts `{ index, code, name }` from a web3.js transaction error such as
 * `{ InstructionError: [2, { Custom: 110 }] }`. Only codes ≥ 100 are shop-vault's (System errors are 0..=8).
 */
export function parseShopVaultError(err: unknown): { index: number; code: number; name?: ShopVaultErrorName } | undefined {
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  if (!ie) return undefined;
  const custom = (ie[1] as { Custom?: number } | null)?.Custom;
  if (typeof custom !== "number") return undefined;
  return { index: ie[0], code: custom, name: shopVaultErrorName(custom) };
}
