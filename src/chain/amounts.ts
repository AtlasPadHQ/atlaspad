/**
 * Money parsing and formatting without floats (INTEGRATION.md §9 "Input parsing"). Light module: no web3.js.
 * Inputs are parsed from strings straight to bigint base units; floats appear only in `lamportsToSol` (display).
 */
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const SOL_DECIMALS = 9;
export const TOKEN_DECIMALS = 6;

/**
 * Decimal string → base units, or null when it is not a plain non-negative decimal with at most `decimals` places.
 * Accepts "1", "0.5", ".5", "1.", "1,000.25" (thousands commas), surrounding spaces. Rejects signs, exponents, NaN.
 */
export function parseUnits(text: string, decimals: number): bigint | null {
  const t = String(text ?? '').trim().replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const [whole = '', frac = ''] = t.split('.');
  if (frac.length > decimals) return null;
  const digits = `${whole || '0'}${frac.padEnd(decimals, '0')}`;
  return BigInt(digits);
}

/** "0.1" → 100_000_000n. At most 9 decimal places. */
export function parseSol(text: string): bigint | null {
  return parseUnits(text, SOL_DECIMALS);
}

/** "1.5" → 1_500_000n (6 decimals by default). */
export function parseTokens(text: string, decimals = TOKEN_DECIMALS): bigint | null {
  return parseUnits(text, decimals);
}

/**
 * Base units → decimal string, ROUNDED DOWN to `maxDecimals` (never overstates money), trailing zeros trimmed.
 * formatUnits(123_456_789n, 9, 4) === '0.1234'.
 */
export function formatUnits(amount: bigint, decimals: number, maxDecimals = decimals): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const keep = Math.max(0, Math.min(decimals, maxDecimals));
  const fracFull = (abs % unit).toString().padStart(decimals, '0');
  const frac = fracFull.slice(0, keep).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`;
}

/** Lamports → SOL string, rounded down to 4 decimals by default ("0.1234"). */
export function formatLamports(lamports: bigint, maxDecimals = 4): string {
  return formatUnits(lamports, SOL_DECIMALS, maxDecimals);
}

/** Token base units → whole-token string, rounded down (6 decimals by default). */
export function formatTokenUnits(amount: bigint, maxDecimals = TOKEN_DECIMALS, decimals = TOKEN_DECIMALS): string {
  return formatUnits(amount, decimals, maxDecimals);
}

/** Display only: lamports → SOL as a float. */
export function lamportsToSol(lamports: bigint | number | string): number {
  return Number(BigInt(lamports)) / 1e9;
}

/** Display only: token base units → whole tokens as a float. */
export function tokensToNumber(amount: bigint | number | string, decimals = TOKEN_DECIMALS): number {
  return Number(BigInt(amount)) / 10 ** decimals;
}

/** `amount × bps / 10_000`, rounded down. For "sell 25% / 50% / 100%" use `portion(raw, 2500n)` etc. */
export function portion(amount: bigint, bps: bigint): bigint {
  if (bps >= 10_000n) return amount;
  if (bps <= 0n) return 0n;
  return (amount * bps) / 10_000n;
}
