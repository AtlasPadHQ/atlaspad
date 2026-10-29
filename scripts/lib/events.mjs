/**
 * pump / pump-amm Anchor event-CPI decoding (INTEGRATION §3.7) from `getTransaction` (json encoding) metadata, and
 * bonding-curve account decoding (§4.3). Pure; used by accuracy-audit.mjs and tests.
 */
import { b58decode, b58encode } from './b58.mjs';

export const EVENT_IX_TAG = Buffer.from('e445a52e51cb9a1d', 'hex');
export const DISC = {
  trade: Buffer.from('bddb7fd34ee661ee', 'hex'),
  ammBuy: Buffer.from('67f4521f2cf57777', 'hex'),
  ammSell: Buffer.from('3e2f370aa503dc2a', 'hex'),
  complete: Buffer.from('5f72619cd42e9808', 'hex'),
};

/** @returns {{kind:'trade'|'amm', mint?:string, pool?:string, sol:bigint, tokens:bigint, isBuy:boolean, user:string, ts:number, creator?:string, creatorFee:bigint, vSol?:bigint, vTok?:bigint, ix:number}[]} */
export function decodeEvents(meta) {
  const out = [];
  let ix = 0;
  for (const g of meta?.innerInstructions ?? []) {
    for (const inner of g.instructions ?? []) {
      let d;
      try {
        d = Buffer.from(b58decode(inner.data));
      } catch {
        continue;
      }
      if (d.length < 16 || !d.subarray(0, 8).equals(EVENT_IX_TAG)) continue;
      const disc = d.subarray(8, 16);
      const e = d.subarray(16);
      if (disc.equals(DISC.trade) && e.length >= 217) {
        out.push({
          kind: 'trade',
          ix: ix++,
          mint: b58encode(e.subarray(0, 32)),
          sol: e.readBigUInt64LE(32),
          tokens: e.readBigUInt64LE(40),
          isBuy: e[48] !== 0,
          user: b58encode(e.subarray(49, 81)),
          ts: Number(e.readBigInt64LE(81)) * 1000,
          vSol: e.readBigUInt64LE(89),
          vTok: e.readBigUInt64LE(97),
          creator: b58encode(e.subarray(169, 201)),
          creatorFee: e.readBigUInt64LE(209),
        });
      } else if ((disc.equals(DISC.ammBuy) || disc.equals(DISC.ammSell)) && e.length >= 352) {
        const isBuy = disc.equals(DISC.ammBuy);
        out.push({
          kind: 'amm',
          ix: ix++,
          ts: Number(e.readBigInt64LE(0)) * 1000,
          tokens: e.readBigUInt64LE(8),
          sol: e.readBigUInt64LE(104),
          pool: b58encode(e.subarray(112, 144)),
          user: b58encode(e.subarray(144, 176)),
          isBuy,
          creatorFee: e.readBigUInt64LE(344),
        });
      }
    }
  }
  return out;
}

/** BondingCurve fields (offsets include the 8-byte discriminator, INTEGRATION §4.3). */
export function decodeCurve(data) {
  const d = Buffer.from(data);
  if (d.length < 81) throw new Error('bonding curve account too short');
  return {
    vTok: d.readBigUInt64LE(8),
    vSol: d.readBigUInt64LE(16),
    realTok: d.readBigUInt64LE(24),
    realSol: d.readBigUInt64LE(32),
    supply: d.readBigUInt64LE(40),
    complete: d[48] === 1,
    creator: b58encode(d.subarray(49, 81)),
    creatorFeeBucket: d.length >= 133 ? d.readBigUInt64LE(125) : 0n,
  };
}

/**
 * Exact price maths, identical to src/chain/curve.ts `lamportsPerToken` (INTEGRATION §4.3): lamports per WHOLE token
 * (10^6 base units) with 15 extra fractional digits (devnet prices are below 1 lamport/token); progress to 2 dp.
 */
const TOKEN_UNIT = 1_000_000n;
const PRICE_SCALE = 10n ** 15n;
export function lamportsPerToken(quote, base) {
  if (base <= 0n || quote <= 0n) return 0;
  const scaled = (quote * TOKEN_UNIT * PRICE_SCALE) / base;
  return Number(scaled / PRICE_SCALE) + Number(scaled % PRICE_SCALE) / 1e15;
}

export function curveNumbers(c, initialRealTokenReserves) {
  const init = BigInt(initialRealTokenReserves);
  let progressPct;
  if (c.complete) progressPct = 100;
  else if (init <= 0n) progressPct = 0;
  else {
    const sold = init - c.realTok;
    progressPct = sold <= 0n ? 0 : sold >= init ? 100 : Number((sold * 10_000n) / init) / 100;
  }
  return {
    priceLamports: lamportsPerToken(c.vSol, c.vTok),
    mcapLamports: c.vTok > 0n ? (c.vSol * c.supply) / c.vTok : 0n,
    progressPct,
  };
}

/**
 * PumpSwap pool price from vault balances + Pool.virtual_quote_reserves (a SIGNED i128 that v2 fee accruals push
 * negative; same as src/chain/curve.ts `poolPrice`); supply = 10^15 base units.
 */
export function poolNumbers(baseAmount, quoteAmount, virtualQuote = 0n, supply = 1_000_000_000_000_000n) {
  const sum = quoteAmount + virtualQuote;
  const quote = sum > 0n ? sum : 0n;
  return { priceLamports: lamportsPerToken(quote, baseAmount), mcapLamports: baseAmount > 0n ? (quote * supply) / baseAmount : 0n, progressPct: 100 };
}

/** SPL token account amount (offset 64) or null. */
export function tokenAmount(data) {
  const d = Buffer.from(data);
  return d.length >= 72 ? d.readBigUInt64LE(64) : null;
}
