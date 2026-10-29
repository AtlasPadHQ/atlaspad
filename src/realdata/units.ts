/**
 * Exact money units for real mode (INTEGRATION.md §9 "Input parsing" / rounding rules). Pure.
 *
 *  - Inputs parse STRINGS to bigint (SOL ≤ 9 dp → lamports, tokens ≤ 6 dp → base units). No float
 *    maths on money before display.
 *  - Anything owed to a shop (fees waiting) and anything the user is told they have (balance,
 *    min-out) rounds DOWN; costs ("you need about x SOL") round UP.
 *  - Display goes through src/lib/format for the final string.
 */
import { LAMPORTS_PER_SOL, TOKEN_DECIMALS } from '../../worker/wire';

export const LAMPORTS = BigInt(LAMPORTS_PER_SOL);
export const TOKEN_UNIT = 10n ** BigInt(TOKEN_DECIMALS);

/**
 * Fee reserve kept back before any wallet prompt (INTEGRATION.md §7.3 / §7.7 said 0.003 SOL). A wallet's FIRST pump buy
 * also pays its Token-2022 ATA and pump's UserVolumeAccumulator (≈0.0039 SOL at mainnet rent), so the reserve is
 * 0.005 SOL, the same figure the chain layer uses (src/chain/constants FEE_RESERVE_LAMPORTS).
 */
export const FEE_RESERVE_LAMPORTS = 5_000_000n; // 0.005 SOL

/** Decimal string (u64 from the wire) → bigint; anything malformed → 0n. */
export function u64(v: string | number | bigint | null | undefined): bigint {
  if (typeof v === 'bigint') return v < 0n ? 0n : v;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? BigInt(Math.floor(v)) : 0n;
  if (typeof v !== 'string' || !/^\d{1,20}$/.test(v)) return 0n;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

/** Parse a decimal string with at most `decimals` fraction digits into base units. Null when invalid. */
export function parseUnits(text: string, decimals: number): bigint | null {
  const s = text.trim().replace(/,/g, '.');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [intPart = '', frac = ''] = s.split('.');
  if (frac.length > decimals) return null;
  const digits = `${intPart || '0'}${frac.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
  if (digits.length > 30) return null;
  return BigInt(digits);
}

/** "0.1" → 100000000n lamports (≤ 9 dp). */
export function parseSol(text: string): bigint | null {
  return parseUnits(text, 9);
}

/** "1234.5" → 1234500000n base units (≤ 6 dp). */
export function parseTokens(text: string): bigint | null {
  return parseUnits(text, TOKEN_DECIMALS);
}

/** Base units → plain decimal string (no grouping), trailing zeros trimmed: 1500000000n, 9 → "1.5". */
export function formatUnits(v: bigint, decimals: number, maxDp = decimals): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const unit = 10n ** BigInt(decimals);
  const whole = a / unit;
  let frac = (a % unit).toString().padStart(decimals, '0').slice(0, Math.max(0, maxDp)); // truncation = round down
  frac = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`;
}

/** Lamports → SOL number for DISPLAY ONLY (via src/lib/format). */
export function lamportsToSol(v: bigint | string): number {
  const b = typeof v === 'bigint' ? v : u64(v);
  // split to keep precision for large values
  return Number(b / LAMPORTS) + Number(b % LAMPORTS) / LAMPORTS_PER_SOL;
}

/** Base units → whole tokens for DISPLAY ONLY. */
export function unitsToTokens(v: bigint | string): number {
  const b = typeof v === 'bigint' ? v : u64(v);
  return Number(b / TOKEN_UNIT) + Number(b % TOKEN_UNIT) / Number(TOKEN_UNIT);
}

/** "0.0123 SOL"-style figure with `dp` decimals, ROUNDED DOWN (balances, fees owed). */
export function solFloor(v: bigint | string, dp = 4): string {
  const b = typeof v === 'bigint' ? v : u64(v);
  return formatUnits(b, 9, dp) || '0';
}

/** SOL string with `dp` decimals, rounded UP (costs: "you need about x SOL" is never an understatement). */
export function solCeil(v: bigint | string, dp = 4): string {
  const b = typeof v === 'bigint' ? v : u64(v);
  const step = 10n ** BigInt(9 - dp);
  const up = ((b + step - 1n) / step) * step;
  return formatUnits(up, 9, dp) || '0';
}

/** Decimals that show `sig` significant figures of `v` lamports in SOL: never fewer than `minDp`, never more than 9. */
function sigDp(v: bigint, sig: number, minDp: number): number {
  const digits = v.toString().length;
  // the first significant digit of v / 10^9 sits at decimal (10 − digits) when v < 1 SOL
  return digits >= 10 ? minDp : Math.min(9, Math.max(minDp, 10 - digits + sig - 1));
}

/**
 * SOL ROUNDED DOWN with at least `sig` significant figures (payouts, fees owed): 6_312_345n → "0.0063",
 * 12_345n → "0.000012", 1_234_567_890n → "1.2345". Mainnet-small amounts never read "0" the way `solFloor(v, 4)` does.
 */
export function solFloorSig(v: bigint | string, sig = 2, minDp = 4): string {
  const b = typeof v === 'bigint' ? v : u64(v);
  return b <= 0n ? '0' : solFloor(b, sigDp(b, sig, minDp));
}

/** `solFloorSig` ROUNDED UP (costs, network fees): 10_300n → "0.000011", 896_783n → "0.0009". */
export function solCeilSig(v: bigint | string, sig = 2, minDp = 4): string {
  const b = typeof v === 'bigint' ? v : u64(v);
  return b <= 0n ? '0' : solCeil(b, sigDp(b, sig, minDp));
}

/** lamports × SOL/USD → USD, rounded DOWN to the cent (money owed is never overstated). */
export function lamportsToUsdFloor(v: bigint | string, solUsd: number | null | undefined): number {
  if (!solUsd || !(solUsd > 0)) return 0;
  const b = typeof v === 'bigint' ? v : u64(v);
  // cents = lamports × (solUsd × 1e6) / 1e9 / 1e4 — integer maths on micro-dollars per SOL
  const microUsdPerSol = BigInt(Math.floor(solUsd * 1_000_000));
  const cents = (b * microUsdPerSol) / (LAMPORTS * 10_000n);
  return Number(cents) / 100;
}

/** lamports × SOL/USD → USD float for display (prices, market caps, volumes). */
export function lamportsToUsd(v: bigint | string | number, solUsd: number | null | undefined): number {
  if (!solUsd || !(solUsd > 0)) return 0;
  const sol = typeof v === 'number' ? v / LAMPORTS_PER_SOL : lamportsToSol(v);
  return sol * solUsd;
}

/** `pct`% of `amount` (bigint), rounded down. 100 returns `amount` exactly (sell 100% = the raw holding). */
export function pctOf(amount: bigint, pct: number): bigint {
  if (pct >= 100) return amount;
  if (!(pct > 0)) return 0n;
  return (amount * BigInt(Math.round(pct * 100))) / 10_000n;
}
