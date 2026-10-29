/** Dependency-free base58 (Bitcoin alphabet) for addresses, signatures and key encodings. */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function b58encode(bytes) {
  const b = Uint8Array.from(bytes);
  let n = 0n;
  for (const x of b) n = (n << 8n) + BigInt(x);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function b58decode(s) {
  if (typeof s !== 'string' || s.length === 0) throw new Error('bad base58');
  let n = 0n;
  for (const c of s) {
    const v = INDEX.get(c);
    if (v === undefined) throw new Error('bad base58');
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** A base58 string that decodes to exactly 32 bytes (a Solana address). */
export function isAddress(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return b58decode(s).length === 32;
  } catch {
    return false;
  }
}

/** A base58 transaction signature (64 bytes). */
export function isSignature(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s)) return false;
  try {
    return b58decode(s).length === 64;
  } catch {
    return false;
  }
}
