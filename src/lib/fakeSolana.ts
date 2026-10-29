/**
 * Deterministic fake Solana identifiers for the simulation (never real keys, never signed).
 * SHARED (src/lib). Pure.
 *
 *  - fakeWallet(seed): base58 of 32 pseudo-random bytes (43–44 chars, decodes to 32 bytes).
 *  - fakeMint(seed):   44-char base58 string ending in "pump" (pump.fun vanity), decodes to 32 bytes.
 *  - fakeSignature(seed): base58 of 64 bytes (87–88 chars).
 */
import bs58 from 'bs58';
import { createRng } from './rand';

export const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 wallet address from a seed (same seed → same address). */
export function fakeWallet(seed: string | number): string {
  const rng = createRng(`wallet:${seed}`);
  const bytes = rng.bytes(32);
  bytes[0] = (bytes[0] ?? 0) | 0x01; // no leading zero byte → no leading "1"
  return bs58.encode(bytes);
}

/**
 * pump.fun-style mint: 40 base58 chars + "pump" = 44 chars. The first char is kept in the
 * alphabet range [2..H] so the value is < 2^256 and ≥ 2^248, i.e. it decodes to exactly 32 bytes.
 */
export function fakeMint(seed: string | number): string {
  const rng = createRng(`mint:${seed}`);
  const firstChars = BASE58_ALPHABET.slice(1, 17); // '2'…'H'
  let s = firstChars[Math.floor(rng.next() * firstChars.length)] ?? '2';
  for (let i = 0; i < 39; i++) s += BASE58_ALPHABET[Math.floor(rng.next() * 58)] ?? '1';
  return `${s}pump`;
}

/** Fake transaction signature (64 bytes, base58). */
export function fakeSignature(seed: string | number): string {
  const rng = createRng(`sig:${seed}`);
  const bytes = rng.bytes(64);
  bytes[0] = (bytes[0] ?? 0) | 0x01;
  return bs58.encode(bytes);
}

/** Random (non-deterministic) wallet for simulated traders. */
export function randomWallet(): string {
  return fakeWallet(`${Date.now()}:${Math.random()}`);
}

/** Random (non-deterministic) signature. */
export function randomSignature(): string {
  return fakeSignature(`${Date.now()}:${Math.random()}`);
}

/**
 * Solana address validation for user input (claim payout "Another address"):
 * base58, 32–44 chars, decodes to exactly 32 bytes.
 */
export function isValidSolanaAddress(input: string): boolean {
  const s = input.trim();
  if (s.length < 32 || s.length > 44) return false;
  if (![...s].every((ch) => BASE58_ALPHABET.includes(ch))) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}
