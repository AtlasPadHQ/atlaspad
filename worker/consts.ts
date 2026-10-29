/**
 * On-chain constants shared by both clusters (INTEGRATION.md §1.1, SPEC §2). Plain base58 strings, no web3.js.
 * worker/addresses.test.ts re-derives every PDA here and compares with the pump SDK / shop-vault client.
 */

export const GENESIS = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const;

export const SHOP_VAULT_PROGRAM_ID = '6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x';
export const CONFIG_PDA = 'FbgtYWxSdefazpfMBXMJMZZbYRodxcJCQid8K2Fd7kMY';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const PUMP_FEES_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
export const MAYHEM_PROGRAM = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const INSTRUCTIONS_SYSVAR = 'Sysvar1nstructions1111111111111111111111111';
export const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112';

/** pump fixed accounts (same on both clusters). */
export const PUMP_GLOBAL = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
export const PUMP_EVENT_AUTHORITY = 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';
export const PUMP_FEE_CONFIG = '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt';
export const PUMP_MINT_AUTHORITY = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
export const MAYHEM_GLOBAL_PARAMS = '13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ';
export const MAYHEM_SOL_VAULT = 'BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s';
/** `Global.buybackFeeRecipients[0]` (fixed so it can live in the ALT). */
export const BUYBACK_FEE_RECIPIENT = '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD';
/** pump-amm event authority (`PDA(["__event_authority"], pump-amm)`). */
export const PUMP_AMM_EVENT_AUTHORITY = 'GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR';
export const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';

/** The exact 14 keys of the frozen CORNERSHOP ALT, in order (INTEGRATION.md §1.1). */
export const ALT_KEYS: readonly string[] = [
  PUMP_GLOBAL,
  PUMP_EVENT_AUTHORITY,
  PUMP_FEE_CONFIG,
  MAYHEM_GLOBAL_PARAMS,
  MAYHEM_SOL_VAULT,
  PUMP_MINT_AUTHORITY,
  TOKEN_2022_PROGRAM,
  SPL_TOKEN_PROGRAM,
  NATIVE_MINT,
  BUYBACK_FEE_RECIPIENT,
  SYSTEM_PROGRAM,
  CONFIG_PDA,
  MAYHEM_PROGRAM,
  INSTRUCTIONS_SYSVAR,
];

/** Instruction discriminators (8 bytes, hex). */
export const DISC = {
  pumpCreateV2: 'd6904cec5f8b31b4',
  pumpBuyExactQuoteInV3: 'e1f7501ed5b38488',
  pumpCollectCreatorFee: '1416567bc61cdb84',
  pumpSweepCreatorFee: '20f6bf3408c949ba',
  pumpSellV3: '1c92de7726c469d5',
  ammTransferCreatorFeesToPump: '8b348655e4e56cf1',
} as const;

/** Anchor event-CPI tag + event discriminators (hex). */
export const EVENT = {
  cpiTag: 'e445a52e51cb9a1d',
  pumpTrade: 'bddb7fd34ee661ee',
  pumpComplete: '5f72619cd42e9808',
  pumpAdminCto: '6e7ce262aaff1178',
  pumpSetCreator: 'ed347b25f5fb48d2',
  pumpCollectCreatorFee: '7a027f010ebf0caf',
  ammBuy: '67f4521f2cf57777',
  ammSell: '3e2f370aa503dc2a',
} as const;

/** Account discriminators (hex). */
export const ACCOUNT_DISC = {
  bondingCurve: '17b7f83760d8ac60',
  pool: 'f19a6d0411b16dbc',
} as const;

/** shop-vault (SPEC §3). */
export const CONFIG_LEN = 256;
export const VAULT_STATE_LEN = 208;
export const SHOP_VAULT_IX = { registerLaunch: 1, requestClaim: 2, finalizeClaim: 4, withdraw: 5, unwrapWsol: 6 } as const;
export const TAG_CONFIG = 1;
export const TAG_VAULT_STATE = 2;
export const LAYOUT_VERSION = 1;
/** SPL token account size (WSOL ATA rent minimum). */
export const TOKEN_ACCOUNT_LEN = 165;

export const TX_MAX_BYTES = 1232;
export const LAUNCH_CU_LIMIT = 400_000;
export const POLICY_MAX_CU_LAUNCH = 600_000;
export const POLICY_MAX_CU_CLAIM = 50_000;
export const POLICY_MAX_CU_PRICE = 5_000_000n;
export const CLAIM_CU_LIMIT = 30_000;
