/**
 * Program-derived addresses without @solana/web3.js (Worker CPU budget: no bignum ed25519 point decompression).
 *
 * `isOnCurve` follows the Solana runtime exactly (curve25519-dalek `CompressedEdwardsY::decompress().is_some()`):
 * y = the low 255 bits (non-canonical values allowed), u = y² − 1, v = d·y² + 1, and the point exists iff u/v is a
 * square mod p (including u = 0). u/v is a square iff the Jacobi symbol (u·v | p) ≠ −1, which is far cheaper than a
 * modular square root. Cross-checked against web3.js `PublicKey.isOnCurve` in worker/pda.test.ts.
 */
import { b58decode, b58encode, concat, utf8 } from './bytes';

const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const LOW255 = (1n << 255n) - 1n;

function jacobi(a: bigint, n: bigint): number {
  a %= n;
  let t = 1;
  while (a !== 0n) {
    while ((a & 1n) === 0n) {
      a >>= 1n;
      const r = n & 7n;
      if (r === 3n || r === 5n) t = -t;
    }
    const tmp = a;
    a = n;
    n = tmp;
    if ((a & 3n) === 3n && (n & 3n) === 3n) t = -t;
    a %= n;
  }
  return n === 1n ? t : 0;
}

function leToBigint(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
}

/** True when the 32 bytes decompress to an ed25519 point (i.e. could have a private key). */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  const y = (leToBigint(bytes) & LOW255) % P;
  const yy = (y * y) % P;
  const u = (yy - 1n + P) % P;
  const v = (D * yy + 1n) % P;
  return jacobi((u * v) % P, P) !== -1;
}

const PDA_MARKER = utf8.encode('ProgramDerivedAddress');
const MAX_SEED_LEN = 32;
const MAX_SEEDS = 16;

export type Seed = Uint8Array | string;

function seedBytes(s: Seed): Uint8Array {
  return typeof s === 'string' ? utf8.encode(s) : s;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** `create_program_address`: null when the hash lands on the curve. */
export async function createProgramAddress(seeds: Seed[], programId: Uint8Array): Promise<Uint8Array | null> {
  const parts = seeds.map(seedBytes);
  if (parts.length > MAX_SEEDS || parts.some((p) => p.length > MAX_SEED_LEN)) throw new Error('invalid seeds');
  const h = await sha256(concat(...parts, programId, PDA_MARKER));
  return isOnCurve(h) ? null : h;
}

const cache = new Map<string, [string, number]>();
const CACHE_MAX = 4_000;

function cacheKey(seeds: Uint8Array[], programId: Uint8Array): string {
  let k = b58encode(programId);
  for (const s of seeds) k += `|${Array.from(s, (x) => x.toString(16).padStart(2, '0')).join('')}`;
  return k;
}

/** `find_program_address`: the canonical (highest-bump) PDA. Memoised per isolate. */
export async function findProgramAddress(seeds: Seed[], programId: string | Uint8Array): Promise<[string, number]> {
  const pid = typeof programId === 'string' ? b58decode(programId) : programId;
  const parts = seeds.map(seedBytes);
  const k = cacheKey(parts, pid);
  const hit = cache.get(k);
  if (hit) return hit;
  for (let bump = 255; bump >= 0; bump--) {
    const a = await createProgramAddress([...parts, Uint8Array.of(bump)], pid);
    if (a) {
      const out: [string, number] = [b58encode(a), bump];
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(k, out);
      return out;
    }
  }
  throw new Error('no viable bump');
}

export async function pda(seeds: Seed[], programId: string | Uint8Array): Promise<string> {
  return (await findProgramAddress(seeds, programId))[0];
}

/** Test helper. */
export function __clearPdaCache(): void {
  cache.clear();
}
