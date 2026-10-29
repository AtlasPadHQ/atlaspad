/**
 * Ticker helpers (DESIGN §12.2): `^[A-Z0-9]{2,8}$`, always uppercase, shown with a `$`.
 * SHARED (src/lib). Pure.
 *
 * Note: DESIGN.md (definitive spec) fixes the length at 2–8; the task brief's "2–10" is superseded.
 */
import { LIMITS } from '../config';

export const TICKER_RE = new RegExp(`^[A-Z0-9]{${LIMITS.tickerMin},${LIMITS.tickerMax}}$`);

const STOP_WORDS = new Set(['THE', 'A', 'AN', 'LE', 'LA', 'EL', 'IL', 'DE', 'OF', 'AND']);

/** Force ticker input: uppercase, A–Z0–9 only, max length. Use on every keystroke. */
export function sanitizeTicker(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, LIMITS.tickerMax);
}

/**
 * Prefill a ticker from a coin name: first word, letters/digits only, uppercased, max 8.
 * Skips a leading article ("The Kettle & Crow" → KETTLE). Falls back to the initials or the
 * whole name when the first word is too short (one char).
 * "Crumb & Co. Bakery" → CRUMB, "Nonna Pepi's Pizza" → NONNA, "Café Lumière" → CAFE.
 */
export function tickerFromName(name: string): string {
  const words = name
    .split(/\s+/)
    .map((w) => sanitizeTicker(w))
    .filter(Boolean);
  if (words.length === 0) return '';
  const first = words.length > 1 && STOP_WORDS.has(words[0] as string) ? (words[1] as string) : (words[0] as string);
  if (first.length >= LIMITS.tickerMin) return first.slice(0, LIMITS.tickerMax);
  const initials = words.map((w) => w[0]).join('');
  if (initials.length >= LIMITS.tickerMin) return initials.slice(0, LIMITS.tickerMax);
  return sanitizeTicker(words.join(''));
}

export type TickerError = 'empty' | 'length' | 'chars';

/** Validate a ticker (without "$"). Returns null when valid. */
export function validateTicker(ticker: string): TickerError | null {
  if (!ticker) return 'empty';
  if (/[^A-Z0-9]/.test(ticker)) return 'chars';
  if (ticker.length < LIMITS.tickerMin || ticker.length > LIMITS.tickerMax) return 'length';
  return null;
}

/** The DESIGN error string for any ticker error. */
export const TICKER_ERROR_MESSAGE = 'Ticker must be 2–8 letters or numbers';

/** True when another coin already uses this ticker (warn only, not blocking — DESIGN §12.2). */
export function isTickerTaken(ticker: string, coins: Iterable<{ ticker: string; placeId: string }>, exceptPlaceId?: string): boolean {
  const t = ticker.toUpperCase();
  for (const c of coins) {
    if (c.ticker === t && c.placeId !== exceptPlaceId) return true;
  }
  return false;
}

/** Display form: `$KEBAB`. */
export function withDollar(ticker: string): string {
  return `$${ticker}`;
}
