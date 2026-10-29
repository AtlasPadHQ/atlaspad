/**
 * Number & text formatting (DESIGN §3.4). Apply these everywhere — never hand-format.
 * SHARED (src/lib). Pure, locale fixed to en-GB.
 */
import type { TradeSide } from '../types';

const LOCALE = 'en-GB';
const UP = '▲'; // ▲
const DOWN = '▼'; // ▼
const MINUS = '−'; // − (U+2212)
const ELLIPSIS = '…'; // …
const SUBSCRIPT = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];

function fin(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function group(v: number, decimals = 0): string {
  return v.toLocaleString(LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Subscript digits for a number, e.g. 6 → "₆", 12 → "₁₂". */
export function subscript(n: number): string {
  return String(Math.trunc(Math.abs(n)))
    .split('')
    .map((d) => SUBSCRIPT[Number(d)] ?? d)
    .join('');
}

/**
 * A positive price with 3 significant figures and never more than 6 decimals, without a currency sign. When 3
 * significant figures would need more than 6 decimals (4+ zeros after the point), subscript-zero notation:
 * 0.000000123 → `0.0₆123`, 0.0000042 → `0.0₅42`. Never scientific notation.
 */
function priceDigits(a: number): string {
  // ≥ 999.5 rounds to 4 digits: toPrecision(3) would print `1.00e+3`
  if (a >= 999.5) return group(a, 0);
  if (a >= 1) return a.toPrecision(3);
  // zeros between the decimal point and the first significant digit
  let zeros = Math.max(0, -Math.floor(Math.log10(a)) - 1);
  if (zeros <= 3) {
    return a.toFixed(zeros + 3);
  }
  let mantissa = Math.round(a * 10 ** (zeros + 3)); // 3 significant digits as an integer
  if (mantissa >= 1000) {
    // rounding carried into the next magnitude (e.g. 9.996e-7 → 1.00e-6)
    zeros -= 1;
    mantissa = 100;
    if (zeros <= 3) return (mantissa / 10 ** (zeros + 3)).toFixed(zeros + 3);
  }
  const digits = String(mantissa).replace(/0+$/, '') || '0';
  return `0.0${subscript(zeros)}${digits}`;
}

/**
 * Coin price in USD: `$` + 3 significant figures, never more than 6 decimals.
 * When 3 significant figures would need more than 6 decimals (4+ zeros after the point),
 * use subscript-zero notation: 0.000000123 → `$0.0₆123`, 0.0000042 → `$0.0₅42`.
 * Examples: `$0.000212`, `$0.0184`, `$1.27`, `$1,234`.
 */
export function usdPrice(v: number): string {
  const x = fin(v);
  if (x === 0) return '$0';
  return `${x < 0 ? '-' : ''}$${priceDigits(Math.abs(x))}`;
}

/**
 * Coin price in SOL (shown when USD is unknown or stale, INTEGRATION §9): same 3-significant-figure, subscript-zero
 * style as `usdPrice`, without a unit. Pump curve prices are ~1e-9 SOL per token: `0.0₈111`, never `1.11e-9`.
 */
export function solPrice(v: number): string {
  const x = fin(v);
  if (x === 0) return '0';
  return `${x < 0 ? '-' : ''}${priceDigits(Math.abs(x))}`;
}

/**
 * Compact USD for market caps, volumes and compact fee figures: ≤3 significant figures,
 * lowercase `k`, uppercase `M`/`B`. `$212k`, `$48.1k`, `$1.2k`, `$1.2M`, `$412`, `$7.50`.
 */
export function usdCompact(v: number): string {
  const x = fin(v);
  const sign = x < 0 ? '-' : '';
  const a = Math.abs(x);
  const unit = (n: number, suffix: string) => `${sign}$${n < 100 ? trimZeros(n.toFixed(1)) : n.toFixed(0)}${suffix}`;
  if (a >= 1e9) return unit(a / 1e9, 'B');
  if (a >= 1e6) return unit(a / 1e6, 'M');
  if (a >= 999.5) {
    const k = a / 1e3;
    // 999,950 would print as "1000k": promote to M
    if (k >= 999.5) return unit(a / 1e6, 'M');
    return unit(k, 'k');
  }
  if (a >= 10) return `${sign}$${a.toFixed(0)}`;
  if (a === 0) return '$0';
  return `${sign}$${a.toFixed(2)}`;
}

/**
 * `usdCompact` for money OWED (fees waiting): the same look, but every step rounds DOWN, so the figure is never more
 * than what is actually there (INTEGRATION.md §9). `$0.61`, `$12`, `$1.2k` (for 1,299), `<$0.01` for a non-zero amount
 * under a cent, `$0` for nothing.
 */
export function usdCompactFloor(v: number): string {
  const a = Math.max(0, fin(v));
  if (a === 0) return '$0';
  const down = (n: number, dp: number) => Math.floor(n * 10 ** dp + 1e-9) / 10 ** dp;
  const unit = (n: number, suffix: string) => `$${n < 100 ? trimZeros(down(n, 1).toFixed(1)) : down(n, 0).toFixed(0)}${suffix}`;
  if (a >= 1e9) return unit(a / 1e9, 'B');
  if (a >= 1e6) return unit(a / 1e6, 'M');
  if (a >= 1e3) return unit(a / 1e3, 'k');
  if (a >= 10) return `$${down(a, 0).toFixed(0)}`;
  const c = down(a, 2);
  return c > 0 ? `$${c.toFixed(2)}` : '<$0.01';
}

/**
 * Full USD with en-GB thousands separators: `$1,240`, `$3,410`; below $100 keeps cents: `$84.20`. A positive amount
 * under a cent reads `<$0.01` (never `$0.00`).
 */
export function usdFull(v: number): string {
  const x = fin(v);
  const sign = x < 0 ? '-' : '';
  const a = Math.abs(x);
  if (a === 0) return '$0';
  if (x > 0 && a < 0.01) return '<$0.01';
  return `${sign}$${a >= 100 ? group(Math.round(a), 0) : group(a, 2)}`;
}

/**
 * `usdFull` for money OWED that was already rounded down to the cent (realdata `lamportsToUsdFloor`): a non-zero
 * amount that floored to `$0` reads `<$0.01`. Mainnet fees start at a few thousand lamports; `$0 earned` would be wrong.
 */
export function usdOwed(usdFloored: number, nonZero: boolean): string {
  return nonZero && !(fin(usdFloored) >= 0.01) ? '<$0.01' : usdFull(usdFloored);
}

/**
 * Bonding-curve progress of a coin that has NOT graduated, rounded DOWN so it never reads `100%` before the curve
 * completes (pump migrates at 100%): `0%`, `<0.1%`, `0.3%`, `9.9%`, `42%`, `99.6%`. 1 decimal below 10% and from 99%.
 */
export function curvePct(p: number): string {
  const x = Math.min(100, Math.max(0, fin(p)));
  if (x === 0) return '0%';
  if (x >= 100) return '100%';
  if (x < 0.1) return '<0.1%';
  if (x < 10 || x >= 99) return `${(Math.floor(x * 10 + 1e-9) / 10).toFixed(1)}%`;
  return `${Math.floor(x + 1e-9)}%`;
}

/** SOL number: trim trailing zeros, max 3 decimals. `1.2`, `0.05`, `2.41`. */
export function solNumber(v: number): string {
  const a = fin(v);
  if (a > 0 && a < 0.001) return '<0.001';
  const s = trimZeros(Math.abs(a).toFixed(3));
  const [int, dec] = s.split('.');
  const intGrouped = Number(int).toLocaleString(LOCALE);
  return `${a < 0 ? '-' : ''}${intGrouped}${dec ? `.${dec}` : ''}`;
}

/** SOL amount with suffix: `1.2 SOL`, `0.05 SOL`. */
export function solAmount(v: number): string {
  return `${solNumber(v)} SOL`;
}

/**
 * Secondary SOL figure after a USD value: `≈ 8.27 SOL` (0 decimals ≥ 100 SOL). Amounts that
 * would round to 0.00 read `< 0.01 SOL`, and nothing at all reads `0 SOL` (never `≈ 0.00 SOL`).
 */
export function solApprox(sol: number): string {
  const a = Math.abs(fin(sol));
  if (a === 0) return '0 SOL';
  if (a < 0.005) return '< 0.01 SOL';
  return `≈ ${a >= 100 ? group(Math.round(a), 0) : group(a, 2)} SOL`;
}

/** USD → `≈ x SOL` using the given SOL price. */
export function usdToSolApprox(usd: number, solUsd: number): string {
  return solApprox(solUsd > 0 ? usd / solUsd : 0);
}

/** Buy/sell flash tag: `+1.2 SOL` / `−2.5 SOL` (U+2212). */
export function flashLabel(side: TradeSide, sol: number): string {
  return `${side === 'buy' ? '+' : MINUS}${solNumber(Math.abs(sol))} SOL`;
}

/** Percent change for panels/lists: `▲ 12.4%` / `▼ 3.2%`. */
export function pct(v: number): string {
  const x = fin(v);
  return `${x >= 0 ? UP : DOWN} ${Math.abs(x).toFixed(1)}%`;
}

/** Percent change for pins: `▲12%`. */
export function pctPin(v: number): string {
  const x = fin(v);
  return `${x >= 0 ? UP : DOWN}${Math.abs(x).toFixed(0)}%`;
}

/** Spoken form for aria-labels: "up 12 percent". */
export function pctSpoken(v: number): string {
  const x = fin(v);
  return `${x >= 0 ? 'up' : 'down'} ${Math.abs(x).toFixed(0)} percent`;
}

/** Token amounts: 3 significant figures, compact. `2.36M`, `4.1M`, `812k`, `1.2B`, `950`. */
export function tokenAmount(v: number): string {
  const a = Math.abs(fin(v));
  const sign = v < 0 ? '-' : '';
  const fmt = (n: number, suffix: string) => `${sign}${trimZeros(n.toPrecision(3))}${suffix}`;
  if (a >= 1e9) return fmt(a / 1e9, 'B');
  if (a >= 1e6) return fmt(a / 1e6, 'M');
  if (a >= 1e3) {
    const k = a / 1e3;
    if (Number(k.toPrecision(3)) >= 1000) return fmt(a / 1e6, 'M');
    return fmt(k, 'k');
  }
  if (a === 0) return '0';
  if (a < 1) return `${sign}${trimZeros(a.toPrecision(3))}`;
  return `${sign}${trimZeros(a.toPrecision(3))}`;
}

/**
 * `tokenAmount` for a guaranteed minimum (the buy's `Min`): 3 significant figures rounded DOWN before the k/M/B
 * suffix, so it never reads more than the trade promises. `2.369M` → `2.36M`, `999,999` → `999k`, `0.1239` → `0.123`.
 */
export function tokenAmountFloor(v: number): string {
  const a = Math.max(0, fin(v));
  if (a === 0) return '0';
  // 3 significant figures, down (the 1e-9 absorbs float error such as 4.1 × 100 = 409.99999999999994)
  const down3 = (n: number) => {
    const e = Math.floor(Math.log10(n));
    if (e >= 2) {
      const q = 10 ** (e - 2);
      return Math.floor(n / q + 1e-9) * q;
    }
    const p = 10 ** (2 - e);
    return Math.floor(n * p + 1e-9) / p;
  };
  const fmt = (n: number, suffix: string) => {
    const d = down3(n);
    return `${d >= 100 ? String(d) : trimZeros(d.toPrecision(3))}${suffix}`;
  };
  if (a >= 1e9) return fmt(a / 1e9, 'B');
  if (a >= 1e6) return fmt(a / 1e6, 'M');
  if (a >= 1e3) return fmt(a / 1e3, 'k');
  return fmt(a, '');
}

/** Integer with en-GB separators: `1,284`. */
export function int(v: number): string {
  return group(Math.round(fin(v)), 0);
}

/** Holders count: `1,284`. */
export const holders = int;

function ageParts(ts: number, now: number): { n: number; u: 's' | 'm' | 'h' | 'd' } {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return { n: s, u: 's' };
  const m = Math.floor(s / 60);
  if (m < 60) return { n: m, u: 'm' };
  const h = Math.floor(m / 60);
  if (h < 24) return { n: h, u: 'h' };
  return { n: Math.floor(h / 24), u: 'd' };
}

/** Relative time for rows: `12s`, `48s`, `2m`, `3h`, `3d`. */
export function timeAgo(ts: number, now: number = Date.now()): string {
  const { n, u } = ageParts(ts, now);
  return `${n}${u}`;
}

/** Relative time for the feed: `12s ago`. */
export function timeAgoLong(ts: number, now: number = Date.now()): string {
  return `${timeAgo(ts, now)} ago`;
}

/** Panel meta: `launched 3d ago`. */
export function launchedAgo(ts: number, now: number = Date.now()): string {
  return `launched ${timeAgo(ts, now)} ago`;
}

/** Base58 address / mint: first 4 + `…` + last 4 (`7xKX…3pQa`, `BkT7…pump`). */
export function shortAddr(address: string | null | undefined): string {
  if (!address) return '';
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}${ELLIPSIS}${address.slice(-4)}`;
}

/** Long date: `4 Oct 2026`. */
export function dateLong(ts: number): string {
  return new Date(ts).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** 24h local time: `14:20`. */
export function time24(ts: number): string {
  return new Date(ts).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** A wait for "Try again in …" copy, rounded UP: `39 seconds`, `3 minutes`, `11 hours`, `1 hour`. */
export function waitFor(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 90) return `${s} ${s === 1 ? 'second' : 'seconds'}`;
  const m = Math.ceil(s / 60);
  if (m < 90) return `${m} minutes`;
  const h = Math.ceil(s / 3600);
  return `${h} ${h === 1 ? 'hour' : 'hours'}`;
}

/**
 * A ticking countdown, the two largest units with the smaller one truncated, so it reads well from a 45-second call
 * cooldown to a 72-hour claim window and a 7-day probation: `45 s`, `59 m 12 s`, `23 h 59 m`, `2 d 23 h`, `9 d 23 h`.
 * Never `4320:00`. Seconds are rounded up (0.2 s left still reads `1 s`); nothing left reads `0 s`.
 */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(fin(seconds)));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m ${s % 60} s`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} m`;
  return `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`;
}

/**
 * Mask a listing phone (DESIGN §12.3): country code + first 2 national digits, `•` for the
 * rest except the last 2, keeping the original grouping. `+44 20 7946 0123` → `+44 20 •••• ••23`.
 * National-format input (`020 7946 0123`) is treated as `defaultCc`.
 */
export function maskPhone(phone: string, defaultCc = '+44'): string {
  const raw = phone.trim();
  let cc = defaultCc;
  let rest = raw;
  const m = raw.match(/^\+(\d{1,3})[\s-]*(.*)$/);
  if (m) {
    cc = `+${m[1]}`;
    rest = m[2] ?? '';
  } else {
    rest = raw.replace(/^0/, '');
  }
  const groups = rest.replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  const total = groups.join('').replace(/\D/g, '').length;
  let seen = 0;
  const masked = groups.map((g) =>
    g
      .split('')
      .map((ch) => {
        if (!/\d/.test(ch)) return ch;
        const idx = seen++;
        return idx < 2 || idx >= total - 2 ? ch : '•';
      })
      .join(''),
  );
  return [cc, ...masked].join(' ');
}

/** Pluralise: plural(3, 'shop') → "3 shops". */
export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${int(n)} ${n === 1 ? word : pluralWord}`;
}
