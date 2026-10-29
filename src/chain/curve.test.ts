/**
 * Curve + pool math against pump's own SDK on REAL devnet accounts (captured read-only by
 * __fixtures__/capture-devnet.mjs into __fixtures__/devnet.json).
 */
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import fixture from './__fixtures__/devnet.json';
import { b64ToBytes } from './rpc';
import {
  curvePrice,
  decodeBondingCurve,
  decodePumpPool,
  lamportsPerToken,
  mcapLamports,
  poolPrice,
  progressPct,
  type CurveState as LightCurveState,
  type PriceView as LightPriceView,
} from './curve';
import type { CurveState, PriceView } from './types';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pump = require('@pump-fun/pump-sdk');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const amm = require('@pump-fun/pump-swap-sdk');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const BN = require('bn.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PublicKey } = require('@solana/web3.js');

/** Compile-time: curve.ts (Worker-safe copy) and types.ts (contract) declare the same shapes. */
const a1: CurveState = {} as LightCurveState;
const a2: LightCurveState = {} as CurveState;
const a3: PriceView = {} as LightPriceView;
const a4: LightPriceView = {} as PriceView;
void [a1, a2, a3, a4];

const big = (v: { toString(): string }) => BigInt(v.toString());
const accountInfo = (b64: string, owner = pump.PUMP_PROGRAM_ID) => ({ data: Buffer.from(b64, 'base64'), owner, lamports: 0, executable: false });
const global = pump.PUMP_SDK.decodeGlobal(accountInfo(fixture.global));

describe('bonding curve (devnet fixtures vs @pump-fun/pump-sdk 3.2.0)', () => {
  test('fixture has real curves', () => {
    expect(fixture.curves.length).toBeGreaterThanOrEqual(3);
  });

  for (const c of fixture.curves) {
    describe(`curve of ${c.mint.slice(0, 8)}…`, () => {
      const data = b64ToBytes(c.data);
      const mine = decodeBondingCurve(data);
      const sdk = pump.PUMP_SDK.decodeBondingCurve(accountInfo(c.data));

      test('decode matches the SDK field by field', () => {
        expect(mine.virtualTokenReserves).toBe(big(sdk.virtualTokenReserves));
        expect(mine.virtualQuoteReserves).toBe(big(sdk.virtualQuoteReserves));
        expect(mine.realTokenReserves).toBe(big(sdk.realTokenReserves));
        expect(mine.realQuoteReserves).toBe(big(sdk.realQuoteReserves));
        expect(mine.tokenTotalSupply).toBe(big(sdk.tokenTotalSupply));
        expect(mine.complete).toBe(sdk.complete);
        expect(mine.creator).toBe(sdk.creator.toBase58());
        expect(mine.isMayhemMode).toBe(sdk.isMayhemMode);
        expect(mine.isCashbackCoin).toBe(sdk.isCashbackCoin);
        expect(mine.quoteMint).toBe(sdk.quoteMint.toBase58());
        expect(mine.isHolderReward).toBe(sdk.isHolderReward);
        expect(mine.creatorFeeBucket).toBe(big(sdk.creatorFee ?? 0));
      });

      test('market cap == SDK bondingCurveMarketCap (integer, exact)', () => {
        if (mine.virtualTokenReserves === 0n) {
          // A migrated curve: the SDK throws (division by zero), we read 0 (the pool prices it instead).
          expect(mcapLamports(mine)).toBe(0n);
          expect(mine.complete).toBe(true);
          return;
        }
        const sdkMcap = pump.bondingCurveMarketCap({
          mintSupply: sdk.tokenTotalSupply,
          virtualQuoteReserves: sdk.virtualQuoteReserves,
          virtualTokenReserves: sdk.virtualTokenReserves,
        });
        expect(mcapLamports(mine)).toBe(big(sdkMcap));
        expect(curvePrice(mine).mcapLamports).toBe(big(sdkMcap));
      });

      test('price = vQuote × 10^6 / vToken to 1e-12 relative, and mcap ≈ price × supply', () => {
        const p = curvePrice(mine);
        if (mine.virtualTokenReserves === 0n) {
          expect(p.lamportsPerToken).toBe(0);
          return;
        }
        // Independent high-precision reference: 30 extra digits in bigint.
        const ref = Number((mine.virtualQuoteReserves * 10n ** 36n) / mine.virtualTokenReserves) / 1e30;
        expect(Math.abs(p.lamportsPerToken - ref) / ref).toBeLessThan(1e-12);
        expect(p.solPerToken).toBeCloseTo(p.lamportsPerToken / 1e9, 18);
        const fromPrice = (p.lamportsPerToken * Number(mine.tokenTotalSupply)) / 1e6;
        expect(Math.abs(fromPrice - Number(p.mcapLamports)) / Number(p.mcapLamports)).toBeLessThan(1e-9);
      });

      test('progress = (initialRealTokenReserves − realTokenReserves) / initial, from pump Global', () => {
        const initial = big(global.initialRealTokenReserves);
        const expected = mine.complete ? 100 : Math.max(0, Math.min(100, Number(((initial - mine.realTokenReserves) * 10_000n) / initial) / 100));
        expect(progressPct(mine, initial)).toBe(expected);
        expect(curvePrice(mine, initial).progressPct).toBe(expected);
      });
    });
  }

  test('pump Global matches the constants we assume (793.1M initial real tokens, 1B supply)', () => {
    expect(big(global.initialRealTokenReserves)).toBe(793_100_000_000_000n);
    expect(big(global.tokenTotalSupply)).toBe(1_000_000_000_000_000n);
  });

  test('a fresh curve (newBondingCurve) prices at initialVirtualQuote / initialVirtualToken', () => {
    // Devnet's pump Global seeds ~1 SOL virtual quote (curves graduate at ~2.8 SOL); mainnet seeds 30 SOL (~28 lamports/token).
    const fresh = pump.newBondingCurve(global);
    const p = lamportsPerToken(big(fresh.virtualQuoteReserves), big(fresh.virtualTokenReserves));
    // SOL curves start at Global.initialVirtualSolReserves (initialVirtualQuoteReserves is the token-quote seed).
    expect(big(fresh.virtualQuoteReserves)).toBe(big(global.initialVirtualSolReserves));
    const ref = (Number(big(global.initialVirtualSolReserves)) * 1e6) / Number(big(global.initialVirtualTokenReserves));
    expect(Math.abs(p - ref) / ref).toBeLessThan(1e-12);
    expect(mcapLamports({ virtualQuoteReserves: big(fresh.virtualQuoteReserves), virtualTokenReserves: big(fresh.virtualTokenReserves), tokenTotalSupply: big(fresh.tokenTotalSupply) })).toBe(
      big(pump.bondingCurveMarketCap({ mintSupply: fresh.tokenTotalSupply, virtualQuoteReserves: fresh.virtualQuoteReserves, virtualTokenReserves: fresh.virtualTokenReserves })),
    );
  });

  test('TradeEvent post-trade reserves give the same price formula the indexer uses', () => {
    // Indexer (INTEGRATION.md §3.7): price_lamports = virtual_sol_reserves × 10^6 / virtual_token_reserves.
    const TAG = 'e445a52e51cb9a1d';
    const TRADE = 'bddb7fd34ee661ee';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bs58 = require('bs58').default ?? require('bs58');
    let n = 0;
    for (const { tx } of fixture.txs as { tx: { meta: { innerInstructions: { instructions: { data: string }[] }[] } } }[]) {
      for (const g of tx.meta.innerInstructions) {
        for (const ix of g.instructions) {
          const d = Buffer.from(bs58.decode(ix.data));
          if (d.subarray(0, 8).toString('hex') !== TAG || d.subarray(8, 16).toString('hex') !== TRADE) continue;
          const e = pump.PUMP_SDK.decodeTradeEventBc(d.subarray(16));
          const p = lamportsPerToken(big(e.virtualSolReserves), big(e.virtualTokenReserves));
          const ref = Number(big(e.virtualSolReserves) * 10n ** 36n / big(e.virtualTokenReserves)) / 1e30;
          expect(Math.abs(p - ref) / ref).toBeLessThan(1e-12);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(0);
  });
});

describe('PumpSwap pool (devnet fixture vs @pump-fun/pump-swap-sdk 2.1.0)', () => {
  test('virtual_quote_reserves is a SIGNED i128 (v2 fee accruals push it below zero) and still prices the pool', () => {
    const d = new Uint8Array(301);
    if (fixture.amm) d.set(b64ToBytes(fixture.amm.poolData).subarray(0, 8), 0); // Pool discriminator for the SDK decoder
    const v = new DataView(d.buffer);
    v.setBigInt64(245, -1_234_567n, true); // low 8 bytes
    v.setBigInt64(253, -1n, true); // sign extension
    v.setBigUint64(279, 42n, true);
    const p = decodePumpPool(d);
    expect(p.virtualQuoteReserves).toBe(-1_234_567n);
    expect(p.creatorFees).toBe(42n);
    if (fixture.amm) {
      const sdk = amm.PUMP_AMM_SDK.decodePool({ data: Buffer.from(d), owner: amm.PUMP_AMM_PROGRAM_ID, lamports: 0, executable: false });
      expect(big(sdk.virtualQuoteReserves)).toBe(-1_234_567n);
      expect(big(sdk.creatorFees)).toBe(42n);
    }
    // (vault + virtual) prices it: 85 SOL in the vault, −1.23 mSOL virtual.
    expect(poolPrice(200_000_000_000_000n, 85_000_000_000n, -1_234_567n).lamportsPerToken).toBeCloseTo(((85_000_000_000 - 1_234_567) * 1e6) / 200_000_000_000_000, 9);
  });

  const f = fixture.amm as null | {
    pool: string;
    poolData: string;
    globalConfig: string;
    feeConfig: string | null;
    baseVault: { data: string };
    quoteVault: { data: string };
    baseMint: { address: string; data: string };
  };
  test.skipIf(!f)('decodePumpPool matches the SDK', () => {
    const mine = decodePumpPool(b64ToBytes(f!.poolData));
    const sdk = amm.PUMP_AMM_SDK.decodePool(accountInfo(f!.poolData, amm.PUMP_AMM_PROGRAM_ID));
    expect(mine.baseMint).toBe(sdk.baseMint.toBase58());
    expect(mine.quoteMint).toBe(sdk.quoteMint.toBase58());
    expect(mine.baseVault).toBe(sdk.poolBaseTokenAccount.toBase58());
    expect(mine.quoteVault).toBe(sdk.poolQuoteTokenAccount.toBase58());
    expect(mine.coinCreator).toBe(sdk.coinCreator.toBase58());
    expect(mine.virtualQuoteReserves).toBe(big(sdk.virtualQuoteReserves ?? 0));
    expect(mine.protocolFees).toBe(big(sdk.protocolFees ?? 0));
    expect(mine.creatorFees).toBe(big(sdk.creatorFees ?? 0));
    expect(pump.canonicalPumpPoolPda(new PublicKey(mine.baseMint)).toBase58()).toBe(f!.pool);
  });

  test.skipIf(!f)('poolPrice (quote + virtual) / base is the limit of an SDK buy quote as the amount → 0', () => {
    const pool = amm.PUMP_AMM_SDK.decodePool(accountInfo(f!.poolData, amm.PUMP_AMM_PROGRAM_ID));
    const baseAmt = new DataView(b64ToBytes(f!.baseVault.data).buffer).getBigUint64(64, true);
    const quoteAmt = new DataView(b64ToBytes(f!.quoteVault.data).buffer).getBigUint64(64, true);
    const spot = poolPrice(baseAmt, quoteAmt, big(pool.virtualQuoteReserves ?? 0));
    // SPL Mint layout via spl-token (supply etc.), as swapSolanaState decodes it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const spl = require('@solana/spl-token');
    const baseMintAccount = spl.MintLayout.decode(Buffer.from(f!.baseMint.data, 'base64'));
    const globalConfig = amm.PUMP_AMM_SDK.decodeGlobalConfig(accountInfo(f!.globalConfig, amm.PUMP_AMM_PROGRAM_ID));
    const feeConfig = f!.feeConfig ? amm.PUMP_AMM_SDK.decodeFeeConfig(accountInfo(f!.feeConfig, amm.PUMP_AMM_PROGRAM_ID)) : null;
    const quoteIn = 1_000_000n; // 0.001 SOL
    const r = amm.buyQuoteInput({
      quote: new BN(quoteIn.toString()),
      slippage: 1,
      baseReserve: new BN(baseAmt.toString()),
      quoteReserve: new BN(quoteAmt.toString()),
      virtualQuoteReserves: pool.virtualQuoteReserves,
      globalConfig,
      baseMintAccount,
      baseMint: pool.baseMint,
      coinCreator: pool.coinCreator,
      creator: pool.creator,
      feeConfig,
      quoteMint: pool.quoteMint,
      isMayhemMode: pool.isMayhemMode,
      creatorFeeBps: pool.creatorFeeBps,
    });
    // Execution price excluding fees (net quote into the pool per whole token).
    const exec = lamportsPerToken(big(r.internalQuoteWithoutFees), big(r.base));
    const impactBound = (Number(quoteIn) / Number(quoteAmt + big(pool.virtualQuoteReserves ?? 0))) * 2 + 1e-6;
    expect(Math.abs(exec - spot.lamportsPerToken) / spot.lamportsPerToken).toBeLessThan(impactBound);
    expect(spot.progressPct).toBe(100);
    expect(spot.mcapLamports).toBe(((quoteAmt + big(pool.virtualQuoteReserves ?? 0)) * 1_000_000_000_000_000n) / baseAmt);
  });
});
