/**
 * Strict Solana message / transaction codec (legacy + v0), dependency-free.
 *
 * The decoder is stricter than web3.js `VersionedMessage.deserialize`: non-minimal or oversized compact-u16
 * ("shortvec") lengths, unknown versions, trailing bytes and truncated input all throw. `encodeMessage` produces the
 * canonical bytes, so `encodeMessage(decodeMessage(b))` equal to `b` proves `b` is canonical (SPEC §8.4: the Worker
 * signs exactly the bytes of the message it decoded itself).
 *
 * Wire format (https://solana.com/docs/core/transactions):
 *   message   = [0x80 | version]? header(3) shortvec<key32> blockhash32 shortvec<ix> (v0: shortvec<lookup>)
 *   ix        = programIdIndex u8, shortvec<u8 accountIndex>, shortvec<u8 data>
 *   lookup    = key32, shortvec<u8 writableIndex>, shortvec<u8 readonlyIndex>
 *   transaction = shortvec<sig64> message
 */
import { b58encode, bytesEq, concat } from './bytes';

export class DecodeError extends Error {}

export interface MessageHeader {
  numRequiredSignatures: number;
  numReadonlySignedAccounts: number;
  numReadonlyUnsignedAccounts: number;
}
export interface CompiledInstruction {
  programIdIndex: number;
  accountKeyIndexes: number[];
  data: Uint8Array;
}
export interface AddressTableLookup {
  accountKey: Uint8Array;
  writableIndexes: number[];
  readonlyIndexes: number[];
}
export interface DecodedMessage {
  version: 'legacy' | 0;
  header: MessageHeader;
  staticAccountKeys: Uint8Array[];
  recentBlockhash: Uint8Array;
  instructions: CompiledInstruction[];
  addressTableLookups: AddressTableLookup[];
}

class Reader {
  o = 0;
  constructor(readonly b: Uint8Array) {}
  u8(): number {
    if (this.o >= this.b.length) throw new DecodeError('truncated');
    return this.b[this.o++]!;
  }
  bytes(n: number): Uint8Array {
    if (this.o + n > this.b.length) throw new DecodeError('truncated');
    const out = this.b.slice(this.o, this.o + n);
    this.o += n;
    return out;
  }
  /** compact-u16: 1..3 bytes, minimal encoding only, value ≤ 0xffff. */
  shortvec(): number {
    let len = 0;
    for (let i = 0; i < 3; i++) {
      const byte = this.u8();
      len |= (byte & 0x7f) << (7 * i);
      if ((byte & 0x80) === 0) {
        if (i > 0 && byte === 0) throw new DecodeError('non-minimal shortvec');
        if (i === 2 && byte > 0x03) throw new DecodeError('shortvec overflow');
        return len;
      }
    }
    throw new DecodeError('shortvec too long');
  }
}

export function encodeShortvec(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError('shortvec out of range');
  const out: number[] = [];
  let rem = n;
  for (;;) {
    let elem = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) {
      out.push(elem);
      break;
    }
    elem |= 0x80;
    out.push(elem);
  }
  return Uint8Array.from(out);
}

function u8s(r: Reader): number[] {
  const n = r.shortvec();
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(r.u8());
  return out;
}

function decodeFrom(r: Reader): DecodedMessage {
  const first = r.u8();
  let version: 'legacy' | 0;
  let numRequiredSignatures: number;
  if (first & 0x80) {
    const v = first & 0x7f;
    if (v !== 0) throw new DecodeError(`unsupported message version ${v}`);
    version = 0;
    numRequiredSignatures = r.u8();
  } else {
    version = 'legacy';
    numRequiredSignatures = first;
  }
  const header: MessageHeader = {
    numRequiredSignatures,
    numReadonlySignedAccounts: r.u8(),
    numReadonlyUnsignedAccounts: r.u8(),
  };
  const nKeys = r.shortvec();
  const staticAccountKeys: Uint8Array[] = [];
  for (let i = 0; i < nKeys; i++) staticAccountKeys.push(r.bytes(32));
  const recentBlockhash = r.bytes(32);
  const nIx = r.shortvec();
  const instructions: CompiledInstruction[] = [];
  for (let i = 0; i < nIx; i++) {
    const programIdIndex = r.u8();
    const accountKeyIndexes = u8s(r);
    const dataLen = r.shortvec();
    instructions.push({ programIdIndex, accountKeyIndexes, data: r.bytes(dataLen) });
  }
  const addressTableLookups: AddressTableLookup[] = [];
  if (version === 0) {
    const nL = r.shortvec();
    for (let i = 0; i < nL; i++) {
      const accountKey = r.bytes(32);
      addressTableLookups.push({ accountKey, writableIndexes: u8s(r), readonlyIndexes: u8s(r) });
    }
  }
  return { version, header, staticAccountKeys, recentBlockhash, instructions, addressTableLookups };
}

/** Decodes a serialized message; throws DecodeError on any malformation or trailing byte. */
export function decodeMessage(bytes: Uint8Array): DecodedMessage {
  const r = new Reader(bytes);
  const m = decodeFrom(r);
  if (r.o !== bytes.length) throw new DecodeError('trailing bytes');
  return m;
}

export function encodeMessage(m: DecodedMessage): Uint8Array {
  const parts: Uint8Array[] = [];
  if (m.version === 0) parts.push(Uint8Array.of(0x80));
  parts.push(Uint8Array.of(m.header.numRequiredSignatures, m.header.numReadonlySignedAccounts, m.header.numReadonlyUnsignedAccounts));
  parts.push(encodeShortvec(m.staticAccountKeys.length));
  for (const k of m.staticAccountKeys) {
    if (k.length !== 32) throw new RangeError('key must be 32 bytes');
    parts.push(k);
  }
  if (m.recentBlockhash.length !== 32) throw new RangeError('blockhash must be 32 bytes');
  parts.push(m.recentBlockhash);
  parts.push(encodeShortvec(m.instructions.length));
  for (const ix of m.instructions) {
    parts.push(Uint8Array.of(ix.programIdIndex), encodeShortvec(ix.accountKeyIndexes.length), Uint8Array.from(ix.accountKeyIndexes));
    parts.push(encodeShortvec(ix.data.length), ix.data);
  }
  if (m.version === 0) {
    parts.push(encodeShortvec(m.addressTableLookups.length));
    for (const l of m.addressTableLookups) {
      parts.push(l.accountKey, encodeShortvec(l.writableIndexes.length), Uint8Array.from(l.writableIndexes));
      parts.push(encodeShortvec(l.readonlyIndexes.length), Uint8Array.from(l.readonlyIndexes));
    }
  } else if (m.addressTableLookups.length) {
    throw new RangeError('legacy messages have no lookups');
  }
  return concat(...parts);
}

/** True when the bytes are exactly the canonical encoding of what they decode to. */
export function isCanonical(bytes: Uint8Array, m: DecodedMessage): boolean {
  return bytesEq(encodeMessage(m), bytes);
}

export interface DecodedTransaction {
  signatures: Uint8Array[];
  message: DecodedMessage;
  messageBytes: Uint8Array;
}

export function decodeTransaction(bytes: Uint8Array): DecodedTransaction {
  const r = new Reader(bytes);
  const n = r.shortvec();
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < n; i++) signatures.push(r.bytes(64));
  const start = r.o;
  const message = decodeFrom(r);
  if (r.o !== bytes.length) throw new DecodeError('trailing bytes');
  if (signatures.length !== message.header.numRequiredSignatures) throw new DecodeError('signature count mismatch');
  return { signatures, message, messageBytes: bytes.slice(start) };
}

export function encodeTransaction(signatures: Uint8Array[], messageBytes: Uint8Array): Uint8Array {
  return concat(encodeShortvec(signatures.length), ...signatures, messageBytes);
}

/* ------------------------------------------------------------------------------------- resolution + sanitize */

export interface ResolvedAccount {
  key: string;
  signer: boolean;
  writable: boolean;
  /** 'static' or the lookup it came from. */
  source: 'static' | 'lookup';
}

/**
 * Resolves every account of a message in runtime order (static, then each lookup's writable indexes, then each
 * lookup's readonly indexes) and applies the runtime's sanitize rules. `tables` maps lookup-table address →
 * its addresses (base58). Throws DecodeError with a reason on any rule violation.
 */
export function resolveAccounts(m: DecodedMessage, tables: Map<string, readonly string[]> = new Map()): ResolvedAccount[] {
  const h = m.header;
  const ns = m.staticAccountKeys.length;
  if (h.numRequiredSignatures < 1) throw new DecodeError('no fee payer');
  if (h.numReadonlySignedAccounts >= h.numRequiredSignatures) throw new DecodeError('fee payer must be writable');
  if (h.numRequiredSignatures + h.numReadonlyUnsignedAccounts > ns) throw new DecodeError('header exceeds static keys');
  const out: ResolvedAccount[] = m.staticAccountKeys.map((k, i) => {
    const signer = i < h.numRequiredSignatures;
    const writable = signer ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts : i < ns - h.numReadonlyUnsignedAccounts;
    return { key: b58encode(k), signer, writable, source: 'static' as const };
  });
  const writableLoaded: ResolvedAccount[] = [];
  const readonlyLoaded: ResolvedAccount[] = [];
  for (const l of m.addressTableLookups) {
    const addr = b58encode(l.accountKey);
    const table = tables.get(addr);
    if (!table) throw new DecodeError(`unknown lookup table ${addr}`);
    if (l.writableIndexes.length === 0 && l.readonlyIndexes.length === 0) throw new DecodeError('empty lookup');
    for (const [list, sink, writable] of [
      [l.writableIndexes, writableLoaded, true],
      [l.readonlyIndexes, readonlyLoaded, false],
    ] as const) {
      for (const i of list) {
        const k = table[i];
        if (k === undefined) throw new DecodeError(`lookup index ${i} out of range`);
        sink.push({ key: k, signer: false, writable, source: 'lookup' });
      }
    }
  }
  const all = [...out, ...writableLoaded, ...readonlyLoaded];
  if (all.length > 256) throw new DecodeError('too many accounts');
  const seen = new Set<string>();
  for (const a of all) {
    if (seen.has(a.key)) throw new DecodeError(`duplicate account ${a.key}`);
    seen.add(a.key);
  }
  for (const ix of m.instructions) {
    if (ix.programIdIndex === 0 || ix.programIdIndex >= ns) throw new DecodeError('program id must be a static non-payer key');
    for (const i of ix.accountKeyIndexes) if (i >= all.length) throw new DecodeError(`account index ${i} out of range`);
  }
  return all;
}
