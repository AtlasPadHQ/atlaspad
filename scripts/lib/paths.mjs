/**
 * Absolute paths and public constants shared by every OPS script (INTEGRATION.md §1, §10).
 * Public data only: no secret ever lives in this file.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const KEYS_DIR = join(ROOT, '.keys');
export const DEPLOY_DIR = join(ROOT, 'deploy');
export const OUT_DIR = join(ROOT, 'scripts', 'out');
export const PROGRAM_DIR = join(ROOT, 'programs', 'shop-vault');
export const CLIENT_DIR = join(PROGRAM_DIR, 'client');
export const ENV_SERVER = join(ROOT, '.env.server');
export const ENV_LOCAL = join(ROOT, '.env.local');
export const WRANGLER_CONFIG = join(ROOT, 'wrangler.jsonc');
export const CHECKLIST = join(ROOT, 'MAINNET-CHECKLIST.md');

export const SOLANA_PATH_PREFIX = [
  join(process.env.HOME ?? '', '.cargo/bin'),
  join(process.env.HOME ?? '', '.local/share/solana/install/active_release/bin'),
].join(':');

/** Child processes get the Solana toolchain on PATH (INTEGRATION §10.1). */
export function toolEnv(extra = {}) {
  return { ...process.env, PATH: `${SOLANA_PATH_PREFIX}:${process.env.PATH ?? ''}`, ...extra };
}

export const GENESIS = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

/** Public RPC endpoints (no key). Used by the Solana CLI and for read-only fallbacks from this machine. */
export const PUBLIC_RPC = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};

/**
 * Default public origin per cluster: the canonical host the site is served at, written into coin metadata and the
 * Google key referrer. Scripts prefer wrangler.jsonc env.<cluster>.vars.PUBLIC_ORIGIN (lib/origin.mjs).
 */
export const ORIGINS = {
  devnet: 'https://cornershop-devnet.tiejiucai.workers.dev',
  mainnet: 'https://atlaspad.online',
};

/** The Workers' own workers.dev hosts. On mainnet it 301s pages to ORIGINS.mainnet and refuses API calls (421). */
export const WORKERS_DEV_ORIGINS = {
  devnet: 'https://cornershop-devnet.tiejiucai.workers.dev',
  mainnet: 'https://cornershop.tiejiucai.workers.dev',
};

export const WORKER_NAMES = { devnet: 'cornershop-devnet', mainnet: 'cornershop' };
export const D1_NAMES = { devnet: 'cornershop-devnet', mainnet: 'cornershop-mainnet' };
export const D1_PLACEHOLDERS = { devnet: '__D1_DEVNET_ID__', mainnet: '__D1_MAINNET_ID__' };

export const PROGRAM_ID = '6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x';
export const CONFIG_PDA = 'FbgtYWxSdefazpfMBXMJMZZbYRodxcJCQid8K2Fd7kMY';
export const PROGRAM_DATA_PDA = 'ELrnhgeGxW5TcJZM6a29Gyxem4SLSiN4q2ReAtoJ7PMs';
export const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
export const SQUADS_V4_PROGRAM = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';
/** SIMD-0500 ("disable deployment of SBPF v0-v2"); see programs/shop-vault/DEVNET.md "SBPF version". */
export const SIMD_0500_FEATURE = 'B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g';

/**
 * ALT_KEYS (INTEGRATION §1.1): the exact 14 shared keys, in this order, identical on both clusters.
 * create-alt.mjs cross-checks this list against the pump SDK derivations before it creates anything.
 */
export const ALT_KEYS = [
  ['4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf', 'pump Global'],
  ['Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1', 'pump event authority'],
  ['8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt', 'pump FeeConfig'],
  ['13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ', 'mayhem global_params'],
  ['BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s', 'mayhem sol_vault'],
  ['TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM', 'pump mint_authority'],
  ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'Token-2022'],
  ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'SPL Token'],
  ['So11111111111111111111111111111111111111112', 'WSOL mint'],
  ['5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD', 'buyback fee recipient'],
  ['11111111111111111111111111111111', 'System'],
  ['FbgtYWxSdefazpfMBXMJMZZbYRodxcJCQid8K2Fd7kMY', 'shop-vault Config'],
  ['MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e', 'mayhem program'],
  ['Sysvar1nstructions1111111111111111111111111', 'Instructions sysvar'],
];
export const ALT_KEY_LIST = ALT_KEYS.map(([k]) => k);

export const PUMP = {
  program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  amm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  fees: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  mayhem: 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e',
  global: '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',
  feeConfig: '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt',
  buyback: '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD',
};

/** Claim windows (SPEC §2): devnet 60 s, mainnet 72 h. */
export const CLAIM_WINDOW = { devnet: 60, mainnet: 259_200 };
export const MAINNET_ROTATION_DELAY_SECS = 604_800;
export const DEVNET_ROTATION_DELAY_SECS = 300;

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export function assertCluster(c) {
  if (c !== 'devnet' && c !== 'mainnet') throw new Error(`cluster must be devnet or mainnet (got ${JSON.stringify(c)})`);
  return c;
}

export function explorerTx(sig, cluster) {
  return `https://solscan.io/tx/${sig}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
}
export function explorerAddress(a, cluster) {
  return `https://solscan.io/account/${a}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
}
