/**
 * On-chain account decoders (SPEC §3.2/§3.3, pump Global, ALT) and the per-isolate cached reads the routes share:
 * shop-vault Config (30 s), the frozen ALT (forever, verified), pump Global (10 min) and rent minimums.
 * Pure decoders take bytes; cached readers take an Rpc.
 */
import { b58encode, key32, readI64, readU64 } from './bytes';
import { ALT_KEYS, CONFIG_LEN, LAYOUT_VERSION, TAG_CONFIG, TAG_VAULT_STATE, TOKEN_ACCOUNT_LEN, VAULT_STATE_LEN } from './consts';
import { DEFAULT_INITIAL_REAL_TOKEN_RESERVES } from '../src/chain/curve';
import type { AccountRaw, Rpc } from './solana';
import type { Cluster } from './wire';

/* ------------------------------------------------------------------------------------------------ Config */

export interface ConfigView {
  paused: boolean;
  flavor: 'mainnet' | 'devnet';
  attestor: string;
  guardian: string;
  governance: string;
  claimWindowSecs: number;
  probationUntil: number;
  rotationDelaySecs: number;
}

export function decodeConfig(d: Uint8Array): ConfigView {
  if (d.length !== CONFIG_LEN || d[0] !== TAG_CONFIG || d[1] !== LAYOUT_VERSION) throw new Error('not a shop-vault Config');
  return {
    paused: d[3] === 1,
    flavor: d[4] === 1 ? 'devnet' : 'mainnet',
    attestor: key32(d, 8),
    guardian: key32(d, 80),
    governance: key32(d, 152),
    claimWindowSecs: Number(readI64(d, 224)),
    probationUntil: Number(readI64(d, 232)),
    rotationDelaySecs: Number(readI64(d, 240)),
  };
}

/* ------------------------------------------------------------------------------------------------ VaultState */

export interface VaultStateView {
  placeHash: string;
  mint: string;
  launcher: string;
  owner: string | null;
  pendingOwner: string | null;
  unlockTs: number | null;
  inProbation: boolean;
  claimNonce: bigint;
  totalWithdrawn: bigint;
  createdAt: number;
  ownerSince: number | null;
}

export function decodeVaultState(d: Uint8Array): VaultStateView {
  if (d.length !== VAULT_STATE_LEN || d[0] !== TAG_VAULT_STATE || d[1] !== LAYOUT_VERSION) throw new Error('not a shop-vault VaultState');
  const hasOwner = d[4] === 1;
  const hasPending = d[5] === 1;
  let ph = '';
  for (const x of d.subarray(8, 40)) ph += x.toString(16).padStart(2, '0');
  return {
    placeHash: ph,
    mint: key32(d, 40),
    launcher: key32(d, 72),
    owner: hasOwner ? key32(d, 104) : null,
    pendingOwner: hasPending ? key32(d, 136) : null,
    unlockTs: hasPending ? Number(readI64(d, 168)) : null,
    inProbation: hasPending && (d[7]! & 1) === 1,
    claimNonce: readU64(d, 176),
    totalWithdrawn: readU64(d, 184),
    createdAt: Number(readI64(d, 192)),
    ownerSince: hasOwner ? Number(readI64(d, 200)) : null,
  };
}

/* ------------------------------------------------------------------------------------------------ ALT */

export interface AltView {
  frozen: boolean;
  active: boolean;
  addresses: string[];
}

/** Address lookup table account: 56-byte meta (type u32, deactivation u64, last slot u64, start u8, Option<auth>, pad) + keys. */
export function decodeAlt(d: Uint8Array): AltView {
  if (d.length < 56 || (d.length - 56) % 32 !== 0) throw new Error('not a lookup table');
  const typ = d[0]! | (d[1]! << 8) | (d[2]! << 16) | (d[3]! << 24);
  if (typ !== 1) throw new Error('not an initialized lookup table');
  const deactivation = readU64(d, 4);
  const frozen = d[21] === 0;
  const addresses: string[] = [];
  for (let o = 56; o < d.length; o += 32) addresses.push(b58encode(d.subarray(o, o + 32)));
  return { frozen, active: deactivation === 0xffff_ffff_ffff_ffffn, addresses };
}

export function altProblems(a: AltView | null): string[] {
  if (!a) return ['lookup table not found'];
  const p: string[] = [];
  if (!a.frozen) p.push('lookup table is not frozen');
  if (!a.active) p.push('lookup table is deactivated');
  if (a.addresses.length !== ALT_KEYS.length || a.addresses.some((k, i) => k !== ALT_KEYS[i])) p.push('lookup table does not hold exactly ALT_KEYS');
  return p;
}

/* ------------------------------------------------------------------------------------------------ pump Global */

export interface PumpGlobalView {
  initialVirtualTokenReserves: bigint;
  initialVirtualQuoteReserves: bigint;
  initialRealTokenReserves: bigint;
  tokenTotalSupply: bigint;
}

export function decodePumpGlobal(d: Uint8Array): PumpGlobalView {
  if (d.length < 105) throw new Error('not a pump Global');
  return {
    initialVirtualTokenReserves: readU64(d, 73),
    // SOL-quoted coins (all of ours) start from initial_virtual_sol_reserves (@81). `initial_virtual_quote_reserves`
    // (@1005) is for whitelisted non-SOL quote mints only (pump-sdk 3.2.0 `initialVirtualQuoteReservesFor`).
    initialVirtualQuoteReserves: readU64(d, 81),
    initialRealTokenReserves: readU64(d, 89),
    tokenTotalSupply: readU64(d, 97),
  };
}

/* ------------------------------------------------------------------------------------------------ token accounts */

/** SPL / Token-2022 account amount (u64 @64) and mint (@0); null when the data is not a token account. */
export function tokenAccount(d: Uint8Array): { mint: string; owner: string; amount: bigint } | null {
  if (d.length < TOKEN_ACCOUNT_LEN) return null;
  return { mint: key32(d, 0), owner: key32(d, 32), amount: readU64(d, 64) };
}

/* ------------------------------------------------------------------------------------------------ cached reads */

interface Cached<T> {
  at: number;
  v: T;
}
const configCache = new Map<Cluster, Cached<ConfigView | null>>();
const altCache = new Map<string, AltView>();
const globalCache = new Map<Cluster, Cached<PumpGlobalView>>();

export const CONFIG_TTL_MS = 30_000;

/** On-chain Config (30 s cache). null when the account does not exist yet (program not initialised). */
export async function chainConfig(rpc: Rpc, configPda: string, now: number, force = false): Promise<ConfigView | null> {
  const hit = configCache.get(rpc.cluster);
  if (hit && !force && now - hit.at < CONFIG_TTL_MS) return hit.v;
  return configFromAccount(rpc.cluster, await rpc.getAccount(configPda), now);
}

/** Decode the Config account from a read made elsewhere (e.g. batched with other accounts) and refresh the cache. */
export function configFromAccount(cluster: Cluster, acc: AccountRaw | null, now: number): ConfigView | null {
  let v: ConfigView | null = null;
  if (acc && acc.data.length === CONFIG_LEN) {
    try {
      v = decodeConfig(acc.data);
    } catch {
      v = null;
    }
  }
  configCache.set(cluster, { at: now, v });
  return v;
}

/** The frozen CORNERSHOP ALT (cached forever once verified). Returns its problems when it is not acceptable. */
export async function loadAlt(rpc: Rpc, address: string): Promise<{ alt: AltView | null; problems: string[] }> {
  if (!address) return { alt: null, problems: ['ALT_ADDRESS is not configured'] };
  const hit = cachedAlt(rpc.cluster, address);
  if (hit) return { alt: hit, problems: [] };
  return altFromAccount(rpc.cluster, address, await rpc.getAccount(address));
}

/** The ALT when it was already verified in this isolate (no read needed). */
export function cachedAlt(cluster: Cluster, address: string): AltView | null {
  return address ? (altCache.get(`${cluster}:${address}`) ?? null) : null;
}

/** Verify (and cache when acceptable) the ALT from an account read made elsewhere. */
export function altFromAccount(cluster: Cluster, address: string, acc: AccountRaw | null): { alt: AltView | null; problems: string[] } {
  if (!address) return { alt: null, problems: ['ALT_ADDRESS is not configured'] };
  let alt: AltView | null = null;
  try {
    alt = acc && acc.owner === 'AddressLookupTab1e1111111111111111111111111' ? decodeAlt(acc.data) : null;
  } catch {
    alt = null;
  }
  const problems = altProblems(alt);
  if (!problems.length && alt) altCache.set(`${cluster}:${address}`, alt);
  return { alt, problems };
}

export async function pumpGlobal(rpc: Rpc, globalPda: string, now: number): Promise<PumpGlobalView> {
  const hit = globalCache.get(rpc.cluster);
  if (hit && now - hit.at < 600_000) return hit.v;
  const acc = await rpc.getAccount(globalPda);
  const v = acc ? decodePumpGlobal(acc.data) : fallbackGlobal(rpc.cluster);
  globalCache.set(rpc.cluster, { at: now, v });
  return v;
}

/** Values observed on 2026-10-08 (research §devnet: devnet virtual SOL 1, mainnet 30). Used only if Global is unreadable. */
export function fallbackGlobal(cluster: Cluster): PumpGlobalView {
  return {
    initialVirtualTokenReserves: 1_073_000_000_000_000n,
    initialVirtualQuoteReserves: cluster === 'devnet' ? 1_000_000_000n : 30_000_000_000n,
    initialRealTokenReserves: DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
    tokenTotalSupply: 1_000_000_000_000_000n,
  };
}

export function cachedGlobal(cluster: Cluster): PumpGlobalView | null {
  return globalCache.get(cluster)?.v ?? null;
}

export interface RentMins {
  r0: bigint;
  rState: bigint;
  rToken: bigint;
}

/** Rent minimums for 0 / VaultState / token accounts: one batched RPC call the first time, then cached per isolate. */
export async function rentMins(rpc: Rpc): Promise<RentMins> {
  await rpc.prefetchRent([0, VAULT_STATE_LEN, TOKEN_ACCOUNT_LEN]);
  const [r0, rState, rToken] = [await rpc.rentMin(0), await rpc.rentMin(VAULT_STATE_LEN), await rpc.rentMin(TOKEN_ACCOUNT_LEN)];
  return { r0, rState, rToken };
}

/** Test helper. */
export function __resetChainCaches(): void {
  configCache.clear();
  altCache.clear();
  globalCache.clear();
}

export function accountExists(a: AccountRaw | null | undefined): a is AccountRaw {
  return !!a && (a.lamports > 0n || a.data.length > 0);
}

