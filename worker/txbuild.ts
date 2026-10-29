/**
 * Minimal transaction builder for the few transactions the Worker itself sends (crank `finalize_claim`, the fee
 * crank, the devnet faucet). Legacy messages, compiled like web3.js (payer first, then writable signers, read-only
 * signers, writable non-signers, read-only non-signers), signed with WebCrypto keys (worker/keys.ts).
 * The attestor NEVER signs through this module (H7).
 */
import { b58decode, toB64 } from './bytes';
import type { SigningKey } from './keys';
import { encodeMessage, encodeTransaction, type DecodedMessage } from './txcodec';

export interface AccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Instruction {
  programId: string;
  keys: AccountMeta[];
  data: Uint8Array;
}

export function compileLegacy(payer: string, ixs: Instruction[], recentBlockhash: string): DecodedMessage {
  const metas = new Map<string, { signer: boolean; writable: boolean }>();
  const touch = (k: string, signer: boolean, writable: boolean) => {
    const m = metas.get(k) ?? { signer: false, writable: false };
    m.signer ||= signer;
    m.writable ||= writable;
    metas.set(k, m);
  };
  touch(payer, true, true);
  for (const ix of ixs) {
    for (const k of ix.keys) touch(k.pubkey, k.isSigner, k.isWritable);
    touch(ix.programId, false, false);
  }
  const all = [...metas.entries()].filter(([k]) => k !== payer);
  const order = (s: boolean, w: boolean) => all.filter(([, m]) => m.signer === s && m.writable === w).map(([k]) => k);
  const keys = [payer, ...order(true, true), ...order(true, false), ...order(false, true), ...order(false, false)];
  const index = new Map(keys.map((k, i) => [k, i]));
  const numSigners = 1 + order(true, true).length + order(true, false).length;
  return {
    version: 'legacy',
    header: {
      numRequiredSignatures: numSigners,
      numReadonlySignedAccounts: order(true, false).length,
      numReadonlyUnsignedAccounts: order(false, false).length,
    },
    staticAccountKeys: keys.map((k) => b58decode(k)),
    recentBlockhash: b58decode(recentBlockhash),
    instructions: ixs.map((ix) => ({
      programIdIndex: index.get(ix.programId)!,
      accountKeyIndexes: ix.keys.map((k) => index.get(k.pubkey)!),
      data: ix.data,
    })),
    addressTableLookups: [],
  };
}

/** Compiles and signs; `signers` must cover every required signer (payer first). Returns base64 tx + first signature. */
export async function buildSignedTx(
  payer: SigningKey,
  ixs: Instruction[],
  recentBlockhash: string,
  extraSigners: SigningKey[] = [],
): Promise<{ base64: string; signature: Uint8Array; size: number }> {
  const msg = compileLegacy(payer.publicKey, ixs, recentBlockhash);
  const bytes = encodeMessage(msg);
  const signerKeys = msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures);
  const all = [payer, ...extraSigners];
  const sigs: Uint8Array[] = [];
  for (const k of signerKeys) {
    const pk = all.find((s) => bytesEqual(b58decode(s.publicKey), k));
    if (!pk) throw new Error('missing signer');
    sigs.push(await pk.sign(bytes));
  }
  const tx = encodeTransaction(sigs, bytes);
  return { base64: toB64(tx), signature: sigs[0]!, size: tx.length };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/* ------------------------------------------------------------------------------------- common instructions */

export function systemTransfer(from: string, to: string, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const v = new DataView(data.buffer);
  v.setUint32(0, 2, true);
  v.setBigUint64(4, lamports, true);
  return {
    programId: '11111111111111111111111111111111',
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data,
  };
}

export function setComputeUnitLimit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programId: 'ComputeBudget111111111111111111111111111111', keys: [], data };
}

export function setComputeUnitPrice(microLamports: bigint): Instruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return { programId: 'ComputeBudget111111111111111111111111111111', keys: [], data };
}
