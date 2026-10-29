/**
 * Byte helpers (pure, Worker- and Node-safe): base58, base64, hex, little-endian ints, utf8.
 */
import bs58 from 'bs58';

export const utf8 = new TextEncoder();
const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodeUtf8Strict(b: Uint8Array): string {
  return utf8Strict.decode(b);
}

export function b58encode(b: Uint8Array): string {
  return bs58.encode(b);
}

/** Decodes base58; throws on invalid characters. */
export function b58decode(s: string): Uint8Array {
  return bs58.decode(s);
}

/** A base58 string that decodes to exactly `len` bytes (32 for keys, 64 for signatures), else null. */
export function b58decodeLen(s: unknown, len: number): Uint8Array | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > 100) return null;
  try {
    const b = bs58.decode(s);
    return b.length === len ? b : null;
  } catch {
    return null;
  }
}

export function isPubkey(s: unknown): s is string {
  return b58decodeLen(s, 32) !== null;
}

export function isSignature(s: unknown): s is string {
  return b58decodeLen(s, 64) !== null;
}

/** Canonical base58 form of a 32-byte key string (rejects non-canonical spellings such as extra leading '1's). */
export function canonicalPubkey(s: unknown): string | null {
  const b = b58decodeLen(s, 32);
  if (!b) return null;
  const c = bs58.encode(b);
  return c === s ? c : null;
}

export function toB64(b: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) s += String.fromCharCode(...b.subarray(i, i + CH));
  return btoa(s);
}

/** Strict base64 (standard alphabet, padding optional); throws on anything else. */
export function fromB64(s: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('bad base64');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toB64Url(b: Uint8Array): string {
  return toB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return fromB64(b + '='.repeat((4 - (b.length % 4)) % 4));
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(h: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(h)) throw new Error('bad hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Constant-time compare for equal-length secrets (hash outputs). */
export function timingSafeEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);

export function readU64(d: Uint8Array, o: number): bigint {
  return view(d).getBigUint64(o, true);
}
export function readI64(d: Uint8Array, o: number): bigint {
  return view(d).getBigInt64(o, true);
}
export function readU32(d: Uint8Array, o: number): number {
  return view(d).getUint32(o, true);
}
export function readU16(d: Uint8Array, o: number): number {
  return view(d).getUint16(o, true);
}
/** Signed 128-bit little-endian. */
export function readI128(d: Uint8Array, o: number): bigint {
  const lo = view(d).getBigUint64(o, true);
  const hi = view(d).getBigInt64(o + 8, true);
  return (hi << 64n) + lo;
}

export function u64le(v: bigint | number): Uint8Array {
  const n = BigInt(v);
  if (n < 0n || n > 0xffff_ffff_ffff_ffffn) throw new RangeError('u64 out of range');
  const b = new Uint8Array(8);
  view(b).setBigUint64(0, n, true);
  return b;
}

export function u32le(v: number): Uint8Array {
  const b = new Uint8Array(4);
  view(b).setUint32(0, v, true);
  return b;
}

export function key32(d: Uint8Array, o: number): string {
  return bs58.encode(d.subarray(o, o + 32));
}

export function isZero(d: Uint8Array): boolean {
  for (const x of d) if (x !== 0) return false;
  return true;
}

/** Decimal string of a non-negative integer that fits u64 → bigint, else null. */
export function parseU64(s: unknown): bigint | null {
  if (typeof s !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(s)) return null;
  const n = BigInt(s);
  return n <= 0xffff_ffff_ffff_ffffn ? n : null;
}

/** Base64 → bytes, or null when the input is not strict base64. */
export function b64ToBytesSafe(s: string): Uint8Array | null {
  try {
    return fromB64(s);
  } catch {
    return null;
  }
}
