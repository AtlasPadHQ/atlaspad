/**
 * Chain constants (addresses as base58 strings, limits, compute budgets). LIGHT and environment-free: no web3.js.
 * Every address here is identical on devnet and mainnet (INTEGRATION.md §1.1).
 */
export const SHOP_VAULT_PROGRAM = '6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x';
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const PUMP_FEES_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
export const MAYHEM_PROGRAM = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** pump Global, FeeConfig and event authority PDAs (also in the ALT). */
export const PUMP_GLOBAL = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
export const PUMP_FEE_CONFIG = '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt';
export const PUMP_EVENT_AUTHORITY = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';
/** `Global.buybackFeeRecipients[0]` (fixed so it can live in the ALT; any listed one is valid for trades). */
export const BUYBACK_FEE_RECIPIENT = '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD';

/** The exact 14 keys of the frozen CORNERSHOP lookup table, in order (INTEGRATION.md §1.1, SPEC §8.1). */
export const ALT_KEYS: readonly string[] = [
  PUMP_GLOBAL,
  PUMP_EVENT_AUTHORITY,
  PUMP_FEE_CONFIG,
  '13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ', // mayhem global_params
  'BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s', // mayhem sol_vault
  'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM', // pump mint_authority
  TOKEN_2022,
  TOKEN_PROGRAM,
  WSOL_MINT,
  BUYBACK_FEE_RECIPIENT,
  SYSTEM_PROGRAM,
  'FbgtYWxSdefazpfMBXMJMZZbYRodxcJCQid8K2Fd7kMY', // shop-vault Config
  MAYHEM_PROGRAM,
  'Sysvar1nstructions1111111111111111111111111',
];

export const GENESIS = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const;

/** Solana's packet limit for a serialized transaction. */
export const TX_SIZE_LIMIT = 1232;
export const LAMPORTS_PER_SIGNATURE = 5000n;

/**
 * Compute-unit limits for launches and trades (measured on devnet 2026-10-08 with margin; policy caps: launch 600k,
 * claim 50k). Vault operations (claim, finalize, withdraw) are sized per instruction in ./budget.
 */
export const CU = {
  launch: 400_000, // measured 182k–205k
  trade: 200_000, // v3 buy 72–76k, v3 sell 47–52k, + idempotent ATA create
  ammTrade: 300_000,
} as const;

/**
 * Refuse a trade whose quoted price impact exceeds this (INTEGRATION.md §4.3).
 * Per cluster: devnet pump curves start from 1 SOL of virtual reserves (mainnet: 30 SOL), so a 0.1 SOL buy moves a
 * fresh devnet curve about 21%. 15% would block the basic devnet test trades; 60% still lets testers see the refusal
 * (a 0.5 SOL buy on a fresh devnet curve is refused). Mainnet keeps 15%.
 */
export const MAX_PRICE_IMPACT_PCT = import.meta.env?.VITE_CLUSTER === 'devnet' ? 60 : 15;
export const DEFAULT_SLIPPAGE_BPS = 200;
/**
 * Kept free for fees/rent when checking "enough SOL" (INTEGRATION.md §7.7 says 0.003 SOL). A first-time buyer also
 * pays the Token-2022 ATA (170 B) and pump's UserVolumeAccumulator (137 B): ≈0.0039 SOL at mainnet rent, so the chain
 * layer reserves 0.005 SOL in its "you need about" figure.
 */
export const FEE_RESERVE_LAMPORTS = 5_000_000n;

/**
 * Accounts a launch creates (measured from a devnet create_v2 launch, 2026-10-08; rent is read from the cluster):
 * the Token-2022 mint with inline metadata (318 B + name + symbol + uri), the bonding curve (pump-sdk
 * BONDING_CURVE_NEW_SIZE = 166), the curve's Token-2022 ATA (170), VaultState (208), the vault top-up (0) and,
 * with a dev buy, the launcher's Token-2022 ATA (170).
 */
export const LAUNCH_ACCOUNT_SIZES = {
  mintBase: 318,
  bondingCurve: 166,
  token2022Ata: 170,
  vaultState: 208,
  vault: 0,
  /** pump `UserVolumeAccumulator` ["user_volume_accumulator", user]: created on a wallet's FIRST pump buy (137 B). */
  userVolumeAccumulator: 137,
} as const;
export const NAME_MAX_BYTES = 32;
export const SYMBOL_MAX_BYTES = 10;
