/**
 * pump.fun market math. PURE + WORKER-SAFE (INTEGRATION.md §0.2, §4.3): the Worker imports this file, so it must stay
 * environment-free: no DOM types, no `import.meta.env`, no `window`, no Buffer, no web3.js. It only imports ./base58.
 *
 * `CurveState` and `PriceView` are declared here with exactly the shape of the contract types in ./types.ts (that
 * file imports ../mode, which uses `import.meta.env`, so the Worker cannot compile it). curve.test.ts asserts at
 * compile time that both declarations stay mutually assignable.
 *
 * Every formula matches @pump-fun/pump-sdk 3.2.0 bit for bit (curve.test.ts checks them against the SDK on real
 * devnet accounts captured in __fixtures__/devnet.json):
 *   mcap        = vQuote × supply / vToken                  (SDK bondingCurveMarketCap, integer division)
 *   price       = vQuote × 10^6 / vToken lamports per whole token, computed in bigint with 15 extra digits (≥ 1e-12
 *                 relative even at devnet's sub-lamport prices; INTEGRATION.md §4.3 asked for ≥ 6), converted once
 *   progress    = (initialRealTokenReserves − realTokenReserves) / initialRealTokenReserves, 100 when complete
 */
import { base58Encode } from './base58';

/** pump coins all have 6 decimals; 1 whole token = 10^6 base units. */
export const TOKEN_DECIMALS = 6;
export const TOKEN_UNIT = 1_000_000n;
/** 1B tokens × 10^6: every pump coin's total supply (and the SDK's fee-tier supply for non-mayhem curves). */
export const ONE_BILLION_SUPPLY = 1_000_000_000_000_000n;
/** pump Global.initialRealTokenReserves (793.1M tokens; identical on devnet and mainnet as of 2026-10-08). */
export const DEFAULT_INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;
/** `sha256("account:BondingCurve")[..8]`. */
export const BONDING_CURVE_DISCRIMINATOR = Uint8Array.from([0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60]);
/** The zero key: a SOL curve stores it as its `quote_mint`, and a never-set creator reads as it. */
export const ZERO_KEY = '11111111111111111111111111111111';

/** Byte offsets of the pump BondingCurve account (discriminator included; IDL 3.2.0). */
export const CURVE_OFFSETS = {
  virtualTokenReserves: 8,
  virtualQuoteReserves: 16,
  realTokenReserves: 24,
  realQuoteReserves: 32,
  tokenTotalSupply: 40,
  complete: 48,
  creator: 49,
  isMayhemMode: 81,
  isCashbackCoin: 82,
  quoteMint: 83,
  creatorFeeBps: 115,
  canEditCreatorFee: 123,
  isHolderReward: 124,
  creatorFee: 125,
  protocolFees: 133,
  depth: 141,
  initialVirtualQuoteReserves: 142,
} as const;

/** Same shape as `CurveState` in ./types.ts (contract). */
export interface CurveState {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: string;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  quoteMint: string;
  isHolderReward: boolean;
  /** v3 creator-fee bucket (@125); 0n if the account is shorter. */
  creatorFeeBucket: bigint;
}

/** Same shape as `PriceView` in ./types.ts (contract). */
export interface PriceView {
  /** Lamports per 1 whole token (10^6 base units). */
  lamportsPerToken: number;
  solPerToken: number;
  mcapLamports: bigint;
  progressPct: number;
}

function u64(data: Uint8Array, offset: number): bigint {
  if (data.length < offset + 8) return 0n;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}
function flag(data: Uint8Array, offset: number): boolean {
  return data.length > offset && data[offset] !== 0;
}
function key(data: Uint8Array, offset: number): string {
  if (data.length < offset + 32) return ZERO_KEY;
  return base58Encode(data.subarray(offset, offset + 32));
}

export function isBondingCurveAccount(data: Uint8Array): boolean {
  return data.length >= 49 && BONDING_CURVE_DISCRIMINATOR.every((b, i) => data[i] === b);
}

/**
 * Decodes a pump BondingCurve account. Older (shorter) accounts decode with the missing fields at their defaults
 * (false / zero / zero key). Throws on a wrong discriminator or an account shorter than 49 bytes.
 */
export function decodeBondingCurve(data: Uint8Array): CurveState {
  if (!isBondingCurveAccount(data)) throw new Error('not a pump BondingCurve account');
  const o = CURVE_OFFSETS;
  return {
    virtualTokenReserves: u64(data, o.virtualTokenReserves),
    virtualQuoteReserves: u64(data, o.virtualQuoteReserves),
    realTokenReserves: u64(data, o.realTokenReserves),
    realQuoteReserves: u64(data, o.realQuoteReserves),
    tokenTotalSupply: u64(data, o.tokenTotalSupply),
    complete: flag(data, o.complete),
    creator: key(data, o.creator),
    isMayhemMode: flag(data, o.isMayhemMode),
    isCashbackCoin: flag(data, o.isCashbackCoin),
    quoteMint: key(data, o.quoteMint),
    isHolderReward: flag(data, o.isHolderReward),
    creatorFeeBucket: u64(data, o.creatorFee),
  };
}

/** `initial_virtual_quote_reserves` (@142), 0n when the account predates the field. */
export function curveInitialVirtualQuoteReserves(data: Uint8Array): bigint {
  return u64(data, CURVE_OFFSETS.initialVirtualQuoteReserves);
}

const PRICE_SCALE = 10n ** 15n;

/** Lamports per whole token: `quote × 10^6 / base`, exact in bigint to 15 decimals, converted to a float once. */
export function lamportsPerToken(quote: bigint, base: bigint): number {
  if (base <= 0n || quote <= 0n) return 0;
  const scaled = (quote * TOKEN_UNIT * PRICE_SCALE) / base;
  const whole = scaled / PRICE_SCALE;
  return Number(whole) + Number(scaled % PRICE_SCALE) / 1e15;
}

/** pump's market cap: `vQuote × supply / vToken` (SDK `bondingCurveMarketCap`). 0n for an emptied curve. */
export function mcapLamports(c: Pick<CurveState, 'virtualQuoteReserves' | 'virtualTokenReserves' | 'tokenTotalSupply'>): bigint {
  if (c.virtualTokenReserves <= 0n) return 0n;
  return (c.virtualQuoteReserves * c.tokenTotalSupply) / c.virtualTokenReserves;
}

/** Token-based progress like pump.fun, 0..100 with 2 decimals (100 when complete). */
export function progressPct(
  c: Pick<CurveState, 'realTokenReserves' | 'complete'>,
  initialRealTokenReserves: bigint = DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
): number {
  if (c.complete) return 100;
  if (initialRealTokenReserves <= 0n) return 0;
  const sold = initialRealTokenReserves - c.realTokenReserves;
  if (sold <= 0n) return 0;
  if (sold >= initialRealTokenReserves) return 100;
  return Number((sold * 10_000n) / initialRealTokenReserves) / 100;
}

/** Spot price, market cap and progress of a curve at read time. A completed (migrated) curve reads 0 / 0 / 100. */
export function curvePrice(c: CurveState, initialRealTokenReserves: bigint = DEFAULT_INITIAL_REAL_TOKEN_RESERVES): PriceView {
  const lpt = lamportsPerToken(c.virtualQuoteReserves, c.virtualTokenReserves);
  return {
    lamportsPerToken: lpt,
    solPerToken: lpt / 1e9,
    mcapLamports: mcapLamports(c),
    progressPct: progressPct(c, initialRealTokenReserves),
  };
}

/**
 * PumpSwap (pump-amm) spot price from the pool's vault balances: `(quoteVault + virtualQuote) × 10^6 / baseVault`.
 * `virtualQuote` is `Pool.virtual_quote_reserves`, a SIGNED i128: v2 trades leave their protocol/creator fees in the
 * quote vault (`Pool.protocolFees` / `creatorFees`) and subtract each accrual from `virtual_quote_reserves`, so
 * `vault + virtual` keeps pricing the pool while the virtual part can go negative (pump-swap-sdk 2.1.0 Pool docs;
 * `buyQuoteInput` prices on `quoteReserve + virtualQuoteReserves` the same way). Market cap = price × total supply.
 * Progress is 100 (graduated). curve.test.ts checks this against an SDK quote on a real devnet pool.
 */
export function poolPrice(baseAmount: bigint, quoteAmount: bigint, virtualQuote = 0n, supply: bigint = ONE_BILLION_SUPPLY): PriceView {
  const sum = quoteAmount + virtualQuote;
  const quote = sum > 0n ? sum : 0n;
  const lpt = lamportsPerToken(quote, baseAmount);
  return {
    lamportsPerToken: lpt,
    solPerToken: lpt / 1e9,
    mcapLamports: baseAmount > 0n ? (quote * supply) / baseAmount : 0n,
    progressPct: 100,
  };
}

/** SPL / Token-2022 account `amount` (u64 @64). */
export function tokenAccountAmount(data: Uint8Array): bigint {
  if (data.length < 72) throw new Error('not a token account');
  return u64(data, 64);
}

/** Byte offsets of the pump-amm Pool account (discriminator included; IDL pump-swap-sdk 2.1.0). */
export const POOL_OFFSETS = {
  baseMint: 43,
  quoteMint: 75,
  poolBaseTokenAccount: 139,
  poolQuoteTokenAccount: 171,
  coinCreator: 211,
  isMayhemMode: 243,
  isCashbackCoin: 244,
  /** SIGNED i128 (16 bytes, two's complement). */
  virtualQuoteReserves: 245,
  creatorFeeBps: 261,
  protocolFees: 271,
  /** v2 trades' coin-creator fees waiting in the quote vault (pump-amm `sweep_creator_fee` pays them out). */
  creatorFees: 279,
} as const;

export interface PoolInfo {
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  coinCreator: string;
  isMayhemMode: boolean;
  /** Signed: can be negative once v2 fee accruals exceed the seeded virtual quote. */
  virtualQuoteReserves: bigint;
  protocolFees: bigint;
  creatorFees: bigint;
}

function i128(data: Uint8Array, offset: number): bigint {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return (v.getBigInt64(offset + 8, true) << 64n) + v.getBigUint64(offset, true);
}

export function decodePumpPool(data: Uint8Array): PoolInfo {
  if (data.length < 243) throw new Error('not a pump-amm Pool account');
  const o = POOL_OFFSETS;
  return {
    baseMint: key(data, o.baseMint),
    quoteMint: key(data, o.quoteMint),
    baseVault: key(data, o.poolBaseTokenAccount),
    quoteVault: key(data, o.poolQuoteTokenAccount),
    coinCreator: key(data, o.coinCreator),
    isMayhemMode: flag(data, o.isMayhemMode),
    virtualQuoteReserves: data.length >= o.virtualQuoteReserves + 16 ? i128(data, o.virtualQuoteReserves) : 0n,
    protocolFees: u64(data, o.protocolFees),
    creatorFees: u64(data, o.creatorFees),
  };
}

