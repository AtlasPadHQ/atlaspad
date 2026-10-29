/**
 * The src/chain decoders and curve math against TODAY'S MAINNET pump.fun (__fixtures__/mainnet.json, captured
 * read-only by `node src/chain/__fixtures__/capture-devnet.mjs --cluster mainnet`, 2026-10-26). Mainnet upgraded pump
 * and pump-amm on 2026-10-19 (pump-fees on 2026-10-12): every trade event now ends with a `quote_transfer_fee` u64
 * (pump SDK 4.x; zero on SOL curves) and pump Global grew to 1,088 bytes. Instruction layouts did not change. Our
 * decoders read fixed offsets, so they must still agree with @pump-fun/pump-sdk 3.2.0 field by field on real mainnet
 * data. Re-capture after every pump upgrade (docs/OPS-AUTOMATION.md "pump.fun upgrades").
 */
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import fixture from './__fixtures__/mainnet.json';
import { decodeBondingCurve, decodePumpPool, mcapLamports, poolPrice } from './curve';
import { ammTradeEvents, decodePumpTradeEvent, pumpTradeEvents, type TxJson } from './events';
import { b64ToBytes } from './rpc';

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-require-imports */
const pump = require('@pump-fun/pump-sdk');
const amm = require('@pump-fun/pump-swap-sdk');
const { PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58').default ?? require('bs58');
/* eslint-enable @typescript-eslint/no-require-imports */
const big = (v: { toString(): string }) => BigInt(v.toString());
const TAG = 'e445a52e51cb9a1d';
const TRADE = 'bddb7fd34ee661ee';
const SOL_QUOTES = new Set(['11111111111111111111111111111111', 'So11111111111111111111111111111111111111112']);

/** Raw bodies of the Anchor CPI events with discriminator `disc`. */
function bodies(tx: TxJson, disc: string): Buffer[] {
  const out: Buffer[] = [];
  for (const g of tx.meta?.innerInstructions ?? []) {
    for (const ix of g.instructions) {
      const d = Buffer.from(bs58.decode(ix.data));
      if (d.length >= 16 && d.subarray(0, 8).toString('hex') === TAG && d.subarray(8, 16).toString('hex') === disc) out.push(d.subarray(16));
    }
  }
  return out;
}

const txs = (fixture.txs as unknown as { signature: string; tx: TxJson }[]).map((t) => t.tx);
const accountInfo = (b64: string, owner = pump.PUMP_PROGRAM_ID) => ({ data: Buffer.from(b64, 'base64'), owner, lamports: 0, executable: false });

describe('mainnet pump TradeEvent (after the 2026-10-19 upgrade)', () => {
  test('every field matches SDK decodeTradeEventBc', () => {
    let n = 0;
    for (const tx of txs) {
      const mine = pumpTradeEvents(tx);
      const sdk = bodies(tx, TRADE).map((b) => pump.PUMP_SDK.decodeTradeEventBc(b) as Record<string, { toString(): string; toBase58?: () => string }>);
      expect(mine.length).toBe(sdk.length);
      mine.forEach((e, i) => {
        const s = sdk[i]!;
        expect(e.mint).toBe(s.mint!.toBase58!());
        expect(e.solAmount).toBe(big(s.solAmount!));
        expect(e.tokenAmount).toBe(big(s.tokenAmount!));
        expect(e.user).toBe(s.user!.toBase58!());
        expect(e.virtualSolReserves).toBe(big(s.virtualSolReserves!));
        expect(e.virtualTokenReserves).toBe(big(s.virtualTokenReserves!));
        expect(e.realTokenReserves).toBe(big(s.realTokenReserves!));
        expect(e.fee).toBe(big(s.fee!));
        expect(e.feeBasisPoints).toBe(big(s.feeBasisPoints!));
        expect(e.creator).toBe(s.creator!.toBase58!());
        expect(e.creatorFee).toBe(big(s.creatorFee!));
        expect(e.creatorFeeBasisPoints).toBe(big(s.creatorFeeBasisPoints!));
        expect(e.ixName).toBe(s.ixName as unknown as string);
        expect(e.buybackFee).toBe(big(s.buybackFee!));
        expect(e.cashback).toBe(big(s.cashback!));
        n++;
      });
    }
    expect(n).toBeGreaterThanOrEqual(6);
  });

  test('events end with the new quote_transfer_fee u64: zero on SOL curves, and ignored by both decoders', () => {
    let n = 0;
    for (const tx of txs) {
      for (const b of bodies(tx, TRADE)) {
        const full = pump.PUMP_SDK.decodeTradeEventBc(b);
        if (!SOL_QUOTES.has(full.quoteMint.toBase58())) continue;
        expect(b.readBigUInt64LE(b.length - 8)).toBe(0n);
        // Without its last 8 bytes the event is exactly the 3.2.0 layout: the same values come out.
        const cut = pump.PUMP_SDK.decodeTradeEventBc(b.subarray(0, b.length - 8));
        expect(big(cut.creatorFee)).toBe(big(full.creatorFee));
        expect(big(cut.creatorFeeUnclaimed)).toBe(big(full.creatorFeeUnclaimed));
        expect(decodePumpTradeEvent(b.subarray(0, b.length - 8))).toEqual(decodePumpTradeEvent(b));
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(3);
  });
});

describe('mainnet pump accounts', () => {
  const global = pump.PUMP_SDK.decodeGlobal(accountInfo(fixture.global));

  test('Global: 1,088 bytes now, and the constants we assume', () => {
    expect(Buffer.from(fixture.global, 'base64').length).toBe(1088);
    expect(big(global.initialRealTokenReserves)).toBe(793_100_000_000_000n);
    expect(big(global.tokenTotalSupply)).toBe(1_000_000_000_000_000n);
    expect(big(global.initialVirtualTokenReserves)).toBe(1_073_000_000_000_000n);
    expect(big(global.initialVirtualSolReserves)).toBe(30_000_000_000n);
  });

  test('FeeConfig decodes with fee tiers (unchanged since the 2026-10-08 dump)', () => {
    const fc = pump.PUMP_SDK.decodeFeeConfig(accountInfo(fixture.feeConfig, new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ')));
    expect(fc.feeTiers.length).toBeGreaterThan(0);
    expect(Buffer.from(fixture.feeConfig, 'base64').length).toBe(4097);
  });

  test('bonding curves: decode and market cap match the SDK', () => {
    expect(fixture.curves.length).toBeGreaterThanOrEqual(1);
    for (const c of fixture.curves) {
      const mine = decodeBondingCurve(b64ToBytes(c.data));
      const sdk = pump.PUMP_SDK.decodeBondingCurve(accountInfo(c.data));
      expect(mine.virtualTokenReserves).toBe(big(sdk.virtualTokenReserves));
      expect(mine.virtualQuoteReserves).toBe(big(sdk.virtualQuoteReserves));
      expect(mine.realTokenReserves).toBe(big(sdk.realTokenReserves));
      expect(mine.creator).toBe(sdk.creator.toBase58());
      expect(mine.complete).toBe(sdk.complete);
      if (mine.virtualTokenReserves > 0n) {
        const sdkMcap = pump.bondingCurveMarketCap({ mintSupply: sdk.tokenTotalSupply, virtualQuoteReserves: sdk.virtualQuoteReserves, virtualTokenReserves: sdk.virtualTokenReserves });
        expect(mcapLamports(mine)).toBe(big(sdkMcap));
      }
    }
  });

  test('create_v2 still creates a 166-byte bonding curve and 170-byte Token-2022 ATAs (launch rent estimate)', () => {
    const created = fixture.create!.created as { owner: string | null; size: number | null }[];
    expect(created.filter((c) => c.owner === pump.PUMP_PROGRAM_ID.toBase58()).map((c) => c.size)).toEqual([166]);
    const atas = created.filter((c) => c.owner === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' && c.size === 170);
    expect(atas.length).toBeGreaterThanOrEqual(1);
  });
});

describe('mainnet pump-amm', () => {
  const ammFx = fixture.amm as unknown as { tx: TxJson; side: 'buy' | 'sell'; poolData: string; baseVault: { data: string }; quoteVault: { data: string } } | null;

  test.skipIf(!ammFx)('Buy/Sell event decode matches the SDK (the event also gained quote_transfer_fee)', () => {
    const disc = ammFx!.side === 'buy' ? '67f4521f2cf57777' : '3e2f370aa503dc2a';
    const sdk = bodies(ammFx!.tx, disc).map((b) => (ammFx!.side === 'buy' ? pump.PUMP_SDK.decodeBuyEventAmm(b) : pump.PUMP_SDK.decodeSellEventAmm(b)) as Record<string, { toString(): string; toBase58?: () => string }>);
    const mine = ammTradeEvents(ammFx!.tx).filter((e) => e.side === ammFx!.side);
    expect(mine.length).toBe(sdk.length);
    const e = mine[0]!;
    const s = sdk[0]!;
    expect(e.baseAmount).toBe(big(ammFx!.side === 'buy' ? s.baseAmountOut! : s.baseAmountIn!));
    expect(e.userQuoteAmount).toBe(big(ammFx!.side === 'buy' ? s.userQuoteAmountIn! : s.userQuoteAmountOut!));
    expect(e.pool).toBe(s.pool!.toBase58!());
    expect(e.coinCreator).toBe(s.coinCreator!.toBase58!());
    expect(e.coinCreatorFee).toBe(big(s.coinCreatorFee!));
    expect(e.protocolFee).toBe(big(s.protocolFee!));
  });

  test.skipIf(!ammFx)('canonical pool decodes like the SDK and prices from its vaults', () => {
    const mine = decodePumpPool(b64ToBytes(ammFx!.poolData));
    const sdk = amm.PUMP_AMM_SDK.decodePool(accountInfo(ammFx!.poolData, amm.PUMP_AMM_PROGRAM_ID));
    expect(mine.baseMint).toBe(sdk.baseMint.toBase58());
    expect(mine.quoteMint).toBe(sdk.quoteMint.toBase58());
    expect(mine.baseVault).toBe(sdk.poolBaseTokenAccount.toBase58());
    expect(mine.quoteVault).toBe(sdk.poolQuoteTokenAccount.toBase58());
    expect(mine.coinCreator).toBe(sdk.coinCreator.toBase58());
    expect(mine.virtualQuoteReserves).toBe(big(sdk.virtualQuoteReserves ?? 0));
    expect(pump.canonicalPumpPoolPda(new PublicKey(mine.baseMint)).toBase58()).toBe(fixture.amm!.pool);
    const base = Buffer.from(ammFx!.baseVault.data, 'base64').readBigUInt64LE(64);
    const quote = Buffer.from(ammFx!.quoteVault.data, 'base64').readBigUInt64LE(64);
    expect(poolPrice(base, quote, mine.virtualQuoteReserves).lamportsPerToken).toBeGreaterThan(0);
  });
});
