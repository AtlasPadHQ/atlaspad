/** Exact SOL ↔ lamports for script arguments and output (no floats on money). */
import { LAMPORTS_PER_SOL } from './paths.mjs';

/** "1.5" → 1_500_000_000n. Throws on more than 9 decimals, negatives or junk. */
export function parseSol(s) {
  const t = String(s).trim();
  const m = /^(\d+)(?:\.(\d{0,9}))?$/.exec(t);
  if (!m) throw new Error(`bad SOL amount ${JSON.stringify(s)} (use digits with ≤ 9 decimals)`);
  return BigInt(m[1]) * LAMPORTS_PER_SOL + BigInt((m[2] ?? '').padEnd(9, '0') || '0');
}

export const min = (a, b) => (a < b ? a : b);
export const max = (a, b) => (a > b ? a : b);
