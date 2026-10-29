/**
 * Event decoding from `getTransaction(encoding: 'json')` (INTEGRATION §3.7):
 *  - pump / pump-amm Anchor event-CPI: an inner instruction to the program itself whose data is
 *    `e445a52e51cb9a1d` ‖ event discriminator ‖ body (base58 in json encoding);
 *  - shop-vault `sol_log_data` events: "Program data: <b64> <b64>…" lines emitted while our program is the
 *    innermost running program (segment 0 = ASCII event name, SPEC §7).
 * Pure functions over the RPC JSON.
 */
import { b58decode, b64ToBytesSafe, bytesEq, fromHex, key32, readI64, readU64, toHex } from './bytes';
import { lamportsPerToken } from '../src/chain/curve';
import { EVENT, PUMP_AMM_PROGRAM, PUMP_PROGRAM } from './consts';
import { txAccountKeys, type RpcTransaction } from './solana';

const TAG = fromHex(EVENT.cpiTag);
const D_TRADE = fromHex(EVENT.pumpTrade);
const D_COMPLETE = fromHex(EVENT.pumpComplete);
const D_AMM_BUY = fromHex(EVENT.ammBuy);
const D_AMM_SELL = fromHex(EVENT.ammSell);
const D_ADMIN_CTO = fromHex(EVENT.pumpAdminCto);
const D_SET_CREATOR = fromHex(EVENT.pumpSetCreator);

export interface CurveTrade {
  kind: 'curve';
  index: number;
  mint: string;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: string;
  timestamp: number;
  virtualSol: bigint;
  virtualToken: bigint;
  realSol: bigint;
  realToken: bigint;
  creator: string;
  creatorFee: bigint;
  /** pump protocol fee (TradeEvent @161; includes the buyback slice). */
  fee: bigint;
}

/** Lamports the trader paid (buy) / received (sell): curve amount ± protocol fee ± creator fee (pump TradeEvent). */
export function curveUserLamports(e: Pick<CurveTrade, 'isBuy' | 'solAmount' | 'fee' | 'creatorFee'>): bigint {
  const fees = e.fee + e.creatorFee;
  return e.isBuy ? e.solAmount + fees : e.solAmount > fees ? e.solAmount - fees : 0n;
}

export interface AmmTrade {
  kind: 'amm';
  index: number;
  isBuy: boolean;
  timestamp: number;
  baseAmount: bigint;
  quoteAmount: bigint;
  pool: string;
  user: string;
  coinCreator: string;
  coinCreatorFee: bigint;
}

export interface CompleteEvt {
  kind: 'complete';
  index: number;
  mint: string;
}

export interface CreatorChangeEvt {
  kind: 'creator_change';
  index: number;
  /** Raw body (hex) for the alert; mint located best-effort. */
  mintGuess: string | null;
  name: 'AdminCtoEvent' | 'SetCreatorEvent';
}

export type PumpEvent = CurveTrade | AmmTrade | CompleteEvt | CreatorChangeEvt;

function prefixed(d: Uint8Array, disc: Uint8Array): boolean {
  return d.length >= 16 && bytesEq(d.subarray(0, 8), TAG) && bytesEq(d.subarray(8, 16), disc);
}

/** Decodes every pump / pump-amm event of a confirmed transaction, in execution order. */
export function decodePumpEvents(tx: RpcTransaction): PumpEvent[] {
  const out: PumpEvent[] = [];
  if (!tx.meta || tx.meta.err) return out;
  const keys = txAccountKeys(tx);
  const inner = [...(tx.meta.innerInstructions ?? [])].sort((a, b) => a.index - b.index);
  let index = 0;
  for (const group of inner) {
    for (const ix of group.instructions) {
      const program = keys[ix.programIdIndex];
      if (program !== PUMP_PROGRAM && program !== PUMP_AMM_PROGRAM) continue;
      let d: Uint8Array;
      try {
        d = b58decode(ix.data);
      } catch {
        continue;
      }
      if (d.length < 16 || !bytesEq(d.subarray(0, 8), TAG)) continue;
      const body = d.subarray(16);
      try {
        if (program === PUMP_PROGRAM && prefixed(d, D_TRADE) && body.length >= 217) {
          out.push({
            kind: 'curve',
            index: index++,
            mint: key32(body, 0),
            solAmount: readU64(body, 32),
            tokenAmount: readU64(body, 40),
            isBuy: body[48] === 1,
            user: key32(body, 49),
            timestamp: Number(readI64(body, 81)),
            virtualSol: readU64(body, 89),
            virtualToken: readU64(body, 97),
            realSol: readU64(body, 105),
            realToken: readU64(body, 113),
            creator: key32(body, 169),
            creatorFee: readU64(body, 209),
            fee: readU64(body, 161),
          });
        } else if (program === PUMP_PROGRAM && prefixed(d, D_COMPLETE) && body.length >= 64) {
          out.push({ kind: 'complete', index: index++, mint: key32(body, 32) });
        } else if (program === PUMP_PROGRAM && (prefixed(d, D_ADMIN_CTO) || prefixed(d, D_SET_CREATOR))) {
          const isSet = prefixed(d, D_SET_CREATOR);
          out.push({ kind: 'creator_change', index: index++, mintGuess: isSet && body.length >= 40 ? key32(body, 8) : null, name: isSet ? 'SetCreatorEvent' : 'AdminCtoEvent' });
        } else if (program === PUMP_AMM_PROGRAM && (prefixed(d, D_AMM_BUY) || prefixed(d, D_AMM_SELL)) && body.length >= 352) {
          const isBuy = prefixed(d, D_AMM_BUY);
          out.push({
            kind: 'amm',
            index: index++,
            isBuy,
            timestamp: Number(readI64(body, 0)),
            baseAmount: readU64(body, 8),
            quoteAmount: readU64(body, 104),
            pool: key32(body, 112),
            user: key32(body, 144),
            coinCreator: key32(body, 304),
            coinCreatorFee: readU64(body, 344),
          });
        }
      } catch {
        /* malformed event body: skip */
      }
    }
  }
  return out;
}

/** Lamports per whole token from reserves / amounts: src/chain/curve.ts `lamportsPerToken` (the browser's function). */
export function priceOf(quote: bigint, base: bigint): number {
  return lamportsPerToken(quote, base);
}

/* ------------------------------------------------------------------------------------------- shop-vault logs */

export interface VaultEvent {
  index: number;
  name: string;
  fields: Uint8Array[];
}

/**
 * Extracts shop-vault `sol_log_data` events: "Program data:" lines while `programId` is the innermost invoked
 * program (tracked through "Program X invoke [n]" / "Program X success|failed" lines).
 */
export function decodeVaultLogEvents(logs: readonly string[] | null | undefined, programId: string): VaultEvent[] {
  const out: VaultEvent[] = [];
  if (!logs) return out;
  const stack: string[] = [];
  let index = 0;
  for (const line of logs) {
    let m = /^Program (\w{32,44}) invoke \[\d+\]$/.exec(line);
    if (m) {
      stack.push(m[1]!);
      continue;
    }
    m = /^Program (\w{32,44}) (success|failed.*)$/.exec(line);
    if (m) {
      if (stack[stack.length - 1] === m[1]) stack.pop();
      continue;
    }
    if (line.startsWith('Program data: ') && stack[stack.length - 1] === programId) {
      const segs = line.slice('Program data: '.length).trim().split(/\s+/).map(b64ToBytesSafe);
      if (segs.length === 0 || segs.some((s) => s === null)) continue;
      const fields = segs as Uint8Array[];
      const name = String.fromCharCode(...fields[0]!);
      if (!/^[A-Za-z]{3,40}$/.test(name)) continue;
      out.push({ index: index++, name, fields: fields.slice(1) });
    }
  }
  return out;
}

/** Field helpers for SPEC §7 event payloads (each field is its own log segment). */
export const evKey = (f: Uint8Array | undefined): string | null => (f && f.length === 32 ? key32(f, 0) : null);
export const evHex = (f: Uint8Array | undefined): string | null => (f && f.length === 32 ? toHex(f) : null);
export const evU64 = (f: Uint8Array | undefined): bigint | null => (f && f.length === 8 ? readU64(f, 0) : null);
export const evI64 = (f: Uint8Array | undefined): bigint | null => (f && f.length === 8 ? readI64(f, 0) : null);
export const evU8 = (f: Uint8Array | undefined): number | null => (f && f.length === 1 ? f[0]! : null);
