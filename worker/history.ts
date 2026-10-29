/**
 * Price history for the coin detail (INTEGRATION §3.2): 48 × 30-minute buckets of the last trade price in each
 * bucket, forward-filled, seeded with the price before the window (or the initial curve price), the newest bucket =
 * the current price. 24 h aggregates: volume = Σ sol_lamports of trades in the last 24 h; change = price now vs the
 * last price at or before 24 h ago (initial price when the coin is younger), in SOL terms. Pure.
 */
export const BUCKET_MS = 30 * 60_000;
export const BUCKETS = 48;

export interface PricePoint {
  ts: number;
  price: number;
}

/** `trades` sorted by ts ascending, all inside the window; `seed` = last price before the window. */
export function priceHistory(trades: readonly PricePoint[], seed: number, current: number, now: number): { history: number[]; historyAt: number } {
  const historyAt = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  const start = historyAt - (BUCKETS - 1) * BUCKET_MS;
  const out = new Array<number>(BUCKETS).fill(0);
  let last = seed;
  let ti = 0;
  for (let b = 0; b < BUCKETS; b++) {
    const end = start + (b + 1) * BUCKET_MS;
    while (ti < trades.length && trades[ti]!.ts < end) {
      if (trades[ti]!.ts >= start) last = trades[ti]!.price;
      ti++;
    }
    out[b] = last;
  }
  if (current > 0) out[BUCKETS - 1] = current;
  return { history: out, historyAt };
}

export function change24h(priceNow: number, price24hAgo: number | null): number | null {
  if (!price24hAgo || price24hAgo <= 0 || priceNow <= 0) return null;
  return Math.round(((priceNow - price24hAgo) / price24hAgo) * 1000) / 10;
}
