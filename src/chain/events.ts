/**
 * Event decoding from confirmed transactions (`getTransaction`, `encoding: 'json'`). Pure, no web3.js.
 *
 *  - pump `TradeEvent` and pump-amm `BuyEvent`/`SellEvent` are Anchor event-CPI inner instructions: data (base58) =
 *    `e445a52e51cb9a1d` ‖ 8-byte event discriminator ‖ Borsh body. Offsets below are into the body (IDL 3.2.0 /
 *    pump-swap-sdk 2.1.0); events.test.ts checks them field by field against the SDK decoders on real devnet txs.
 *  - shop-vault events are `Program data:` log lines (SPEC §7: segment 0 = ASCII name, then one segment per field).
 */
import { base58Decode, base58Encode } from './base58';
import { lamportsPerToken } from './curve';
import type { TradeFill } from './types';

const EVENT_TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];
const DISC = {
  pumpTrade: [0xbd, 0xdb, 0x7f, 0xd3, 0x4e, 0xe6, 0x61, 0xee],
  ammBuy: [0x67, 0xf4, 0x52, 0x1f, 0x2c, 0xf5, 0x77, 0x77],
  ammSell: [0x3e, 0x2f, 0x37, 0x0a, 0xa5, 0x03, 0xdc, 0x2a],
} as const;

/** Minimal `getTransaction` (json) shape used here. */
export interface TxJson {
  slot?: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    logMessages?: string[] | null;
    innerInstructions?: { index: number; instructions: { programIdIndex: number; data: string; accounts?: number[] }[] }[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
    computeUnitsConsumed?: number;
  } | null;
  transaction: { signatures: string[]; message: { accountKeys: string[]; instructions?: { programIdIndex: number; data: string; accounts: number[] }[] } };
}

export interface PumpTradeEvent {
  mint: string;
  /** Curve-side SOL (before fees). */
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: string;
  timestamp: number;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realSolReserves: bigint;
  realTokenReserves: bigint;
  feeRecipient: string;
  feeBasisPoints: bigint;
  fee: bigint;
  creator: string;
  creatorFeeBasisPoints: bigint;
  creatorFee: bigint;
  /** Variable tail (after `ix_name`): present on current pump versions. */
  ixName?: string;
  buybackFee?: bigint;
  cashback?: bigint;
}

export interface AmmTradeEvent {
  side: 'buy' | 'sell';
  timestamp: number;
  /** base_amount_out (buy) / base_amount_in (sell). */
  baseAmount: bigint;
  /** quote_amount_in (buy) / quote_amount_out (sell): the pool-side amount before fees. */
  quoteAmount: bigint;
  /** user_quote_amount_in (buy, total paid) / user_quote_amount_out (sell, net received). */
  userQuoteAmount: bigint;
  poolBaseReserves: bigint;
  poolQuoteReserves: bigint;
  lpFee: bigint;
  protocolFee: bigint;
  pool: string;
  user: string;
  coinCreator: string;
  coinCreatorFee: bigint;
}

function u64(b: Uint8Array, o: number): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o, true);
}
function i64(b: Uint8Array, o: number): number {
  return Number(new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(o, true));
}
function key(b: Uint8Array, o: number): string {
  return base58Encode(b.subarray(o, o + 32));
}
function startsWith(b: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (b.length < at + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (b[at + i] !== prefix[i]) return false;
  return true;
}

/** Bodies of every Anchor CPI event with discriminator `disc` in the tx's inner instructions. */
function cpiEvents(tx: TxJson, disc: readonly number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const g of tx.meta?.innerInstructions ?? []) {
    for (const ix of g.instructions) {
      let d: Uint8Array;
      try {
        d = base58Decode(ix.data);
      } catch {
        continue;
      }
      if (startsWith(d, EVENT_TAG) && startsWith(d, disc, 8)) out.push(d.subarray(16));
    }
  }
  return out;
}

export function decodePumpTradeEvent(body: Uint8Array): PumpTradeEvent | null {
  if (body.length < 217) return null;
  const ev: PumpTradeEvent = {
    mint: key(body, 0),
    solAmount: u64(body, 32),
    tokenAmount: u64(body, 40),
    isBuy: body[48] !== 0,
    user: key(body, 49),
    timestamp: i64(body, 81),
    virtualSolReserves: u64(body, 89),
    virtualTokenReserves: u64(body, 97),
    realSolReserves: u64(body, 105),
    realTokenReserves: u64(body, 113),
    feeRecipient: key(body, 121),
    feeBasisPoints: u64(body, 153),
    fee: u64(body, 161),
    creator: key(body, 169),
    creatorFeeBasisPoints: u64(body, 201),
    creatorFee: u64(body, 209),
  };
  // Tail: track_volume(1) total_unclaimed(8) total_claimed(8) current_sol_volume(8) last_update(8) = @250,
  // then ix_name (u32 len + utf8), mayhem_mode(1), cashback_fee_bps(8), cashback(8), buyback_fee_bps(8), buyback_fee(8).
  try {
    let o = 250;
    if (body.length >= o + 4) {
      const n = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(o, true);
      o += 4;
      if (n <= 64 && body.length >= o + n) {
        ev.ixName = new TextDecoder().decode(body.subarray(o, o + n));
        o += n;
        if (body.length >= o + 1 + 32) {
          o += 1; // mayhem_mode
          o += 8; // cashback_fee_basis_points
          ev.cashback = u64(body, o);
          o += 8;
          o += 8; // buyback_fee_basis_points
          ev.buybackFee = u64(body, o);
        }
      }
    }
  } catch {
    /* older event layout: tail fields stay undefined */
  }
  return ev;
}

export function decodeAmmTradeEvent(body: Uint8Array, side: 'buy' | 'sell'): AmmTradeEvent | null {
  if (body.length < 352) return null;
  return {
    side,
    timestamp: i64(body, 0),
    baseAmount: u64(body, 8),
    quoteAmount: u64(body, 56),
    userQuoteAmount: u64(body, 104),
    poolBaseReserves: u64(body, 40),
    poolQuoteReserves: u64(body, 48),
    lpFee: u64(body, 72),
    protocolFee: u64(body, 88),
    pool: key(body, 112),
    user: key(body, 144),
    coinCreator: key(body, 304),
    coinCreatorFee: u64(body, 344),
  };
}

export function pumpTradeEvents(tx: TxJson): PumpTradeEvent[] {
  return cpiEvents(tx, DISC.pumpTrade)
    .map(decodePumpTradeEvent)
    .filter((e): e is PumpTradeEvent => e !== null);
}

export function ammTradeEvents(tx: TxJson): AmmTradeEvent[] {
  return [
    ...cpiEvents(tx, DISC.ammBuy).map((b) => decodeAmmTradeEvent(b, 'buy')),
    ...cpiEvents(tx, DISC.ammSell).map((b) => decodeAmmTradeEvent(b, 'sell')),
  ].filter((e): e is AmmTradeEvent => e !== null);
}

/**
 * Lamports the user paid (buy) / received (sell) in a curve trade: curve amount ± protocol fee ± creator fee.
 * (The buyback slice is part of the protocol `fee`; events.test.ts checks this against the signer's balance change.)
 */
export function pumpUserLamports(e: PumpTradeEvent): bigint {
  const fees = e.fee + e.creatorFee;
  return e.isBuy ? e.solAmount + fees : e.solAmount - fees;
}

/**
 * The fill of `user`'s trade on `mint` in this tx (curve or pool). Several events (e.g. a buy that crosses into the
 * pool-to-be) are summed. Null when the tx has no matching event.
 */
export function fillFromTx(tx: TxJson, p: { mint: string; user: string; side: 'buy' | 'sell'; pool?: string | null }): TradeFill | null {
  const curve = pumpTradeEvents(tx).filter((e) => e.mint === p.mint && e.user === p.user && e.isBuy === (p.side === 'buy'));
  const amm = ammTradeEvents(tx).filter((e) => e.user === p.user && e.side === p.side && (!p.pool || e.pool === p.pool));
  if (curve.length === 0 && amm.length === 0) return null;
  let lamports = 0n;
  let tokens = 0n;
  for (const e of curve) {
    lamports += pumpUserLamports(e);
    tokens += e.tokenAmount;
  }
  for (const e of amm) {
    lamports += e.userQuoteAmount;
    tokens += e.baseAmount;
  }
  return { side: p.side, lamports, tokens, priceLamportsPerToken: lamportsPerToken(lamports, tokens), estimated: false };
}

/* ------------------------------------------------------------------------------------------ shop-vault logs */

export interface ShopVaultEvent {
  name: string;
  fields: Uint8Array[];
}

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** `Program data:` lines whose first segment is an ASCII event name (SPEC §7). */
export function shopVaultEvents(logs: readonly string[] | null | undefined): ShopVaultEvent[] {
  const out: ShopVaultEvent[] = [];
  for (const l of logs ?? []) {
    if (!l.startsWith('Program data: ')) continue;
    try {
      const segs = l.slice('Program data: '.length).split(' ').map(b64);
      const name = String.fromCharCode(...segs[0]);
      if (/^[A-Za-z]{3,32}$/.test(name)) out.push({ name, fields: segs.slice(1) });
    } catch {
      /* not ours */
    }
  }
  return out;
}

/** `Withdrawn { place_hash, owner, amount, total_withdrawn }` → amount (lamports), or null. */
export function withdrawnAmount(logs: readonly string[] | null | undefined): bigint | null {
  const ev = shopVaultEvents(logs).find((e) => e.name === 'Withdrawn');
  const amt = ev?.fields[2];
  return amt && amt.length === 8 ? u64(amt, 0) : null;
}

/** The lamport change of `address` in the tx (post − pre), plus the fee when it paid it. Null if not in the tx. */
export function lamportDelta(tx: TxJson, address: string, addFeeIfPayer = false): bigint | null {
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  const i = keys.indexOf(address);
  if (i < 0 || !tx.meta) return null;
  const d = BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
  return addFeeIfPayer && i === 0 ? d + BigInt(tx.meta.fee) : d;
}
