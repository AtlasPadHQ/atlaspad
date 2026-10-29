/**
 * Seeded PRNG helpers (deterministic demo data: mints, wallets, sparklines, holders).
 * SHARED (src/lib). Pure, no DOM.
 */

/** 32-bit string hash (FNV-1a with a final avalanche). Stable across runs. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // avalanche (murmur3 fmix32)
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32: fast, decent-quality 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniform pick from a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Approximately normal (mean 0, sd 1) via Box–Muller. */
  normal(): number;
  /** n random bytes. */
  bytes(n: number): Uint8Array;
}

/** Create a seeded RNG from a string or number seed. */
export function createRng(seed: string | number): Rng {
  const next = mulberry32(typeof seed === 'number' ? seed >>> 0 : hashString(seed));
  const rng: Rng = {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error('pick() from empty array');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    normal: () => {
      let u = 0;
      let v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    bytes: (n) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = Math.floor(next() * 256);
      return out;
    },
  };
  return rng;
}

/** Non-deterministic RNG for live simulation (seeded from time + Math.random). */
export function liveRng(): Rng {
  return createRng((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0);
}
