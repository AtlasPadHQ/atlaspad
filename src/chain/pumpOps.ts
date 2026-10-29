/**
 * Everything that needs @pump-fun/pump-sdk (3.2.0, pinned) or bn.js. Loaded ONLY through `loadPump()` (pumpLoad.ts),
 * which dynamic-imports the SDK so it stays in its own chunk (INTEGRATION.md §4.1, §8). The SDK module is passed in
 * (`makePumpOps(sdk, BN)`) so Node tests/e2e can inject its CJS build (its ESM build does not load under plain Node).
 *
 * All money in and out of this module is bigint; BN stays inside.
 */
import type BNType from 'bn.js';
import type * as PumpSdkNs from '@pump-fun/pump-sdk';
import type { AccountInfo, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';

export type PumpSdkModule = typeof PumpSdkNs;
type BNCtor = typeof BNType;
export type SdkGlobal = PumpSdkNs.Global;
export type SdkFeeConfig = PumpSdkNs.FeeConfig;
export type SdkCurve = PumpSdkNs.BondingCurve;

/** Fresh curve state for quoting/building (one getMultipleAccounts; Global/FeeConfig cached 60 s). */
export interface CurveSnapshot {
  curve: SdkCurve;
  global: SdkGlobal;
  feeConfig: SdkFeeConfig;
  /** Curve's base-token ATA balance (both token programs), prices v3's pool-to-be leg. */
  curveBaseTokenBalance: bigint;
}

export interface CurveBuyQuote {
  tokensOut: bigint;
  /** Net quote into the curve after fees (exact v3 exact-quote-in split). */
  netLamports: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
}
export interface CurveSellQuote {
  lamportsOut: bigint;
  /** Curve-side proceeds before fees. */
  grossLamports: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
}

function account(data: Uint8Array, owner: PublicKey): AccountInfo<Buffer> {
  return { data: Buffer.from(data), owner, lamports: 0, executable: false, rentEpoch: 0 };
}

export function makePumpOps(sdkModule: PumpSdkModule, BN: BNCtor) {
  const sdk = sdkModule.PUMP_SDK ?? new sdkModule.PumpSdk();
  const bn = (v: bigint) => new BN(v.toString());
  const big = (v: BNType) => BigInt(v.toString());
  const ONE_BILLION = new BN('1000000000000000');

  /** pump's ceil fee: `ceil(amount × bps / 10_000)` (SDK `fee()` / program `ceil_div`). */
  const ceilFee = (amount: bigint, bps: bigint) => (amount * bps + 9_999n) / 10_000n;

  /** The rates a curve trade pays right now (SDK `computeFeesBps`, creator rate 0 when the creator is unset). */
  function rates(s: CurveSnapshot): { protocolFeeBps: bigint; creatorFeeBps: bigint } {
    const r = sdkModule.computeFeesBps({
      global: s.global,
      feeConfig: s.feeConfig,
      mintSupply: s.curve.isMayhemMode ? s.curve.tokenTotalSupply : ONE_BILLION,
      virtualQuoteReserves: s.curve.virtualQuoteReserves,
      virtualTokenReserves: s.curve.virtualTokenReserves,
      quoteMint: s.curve.quoteMint,
      creatorFeeBps: s.curve.creatorFeeBps,
    });
    return { protocolFeeBps: big(r.protocolFeeBps), creatorFeeBps: isZeroKey(s.curve.creator) ? 0n : big(r.creatorFeeBps) };
  }

  function isZeroKey(k: PublicKey): boolean {
    return k.toBytes().every((b) => b === 0);
  }

  return {
    sdkModule,
    sdk,

    decodeGlobal: (data: Uint8Array, owner: PublicKey): SdkGlobal => sdk.decodeGlobal(account(data, owner)),
    decodeFeeConfig: (data: Uint8Array, owner: PublicKey): SdkFeeConfig => sdk.decodeFeeConfig(account(data, owner)),
    decodeCurve: (data: Uint8Array, owner: PublicKey): SdkCurve => sdk.decodeBondingCurve(account(data, owner)),

    /* ---------------------------------------------------------------------------------------------- launch */

    /** pump `create_v2` with `creator` = the shop vault, SOL quote, no mayhem/cashback/holder-reward (SPEC §8.1). */
    createV2Ix(p: { mint: PublicKey; name: string; symbol: string; uri: string; creator: PublicKey; user: PublicKey }): Promise<TransactionInstruction> {
      return sdk.createV2Instruction({ ...p, mayhemMode: false });
    },

    /**
     * The launch dev buy: `buy_exact_quote_in_v3(spendable, min_tokens_out = 1)`. min 1 is safe: `register_launch`
     * (earlier in the same tx) proves the curve is untraded (SPEC §8.1).
     */
    devBuyIx(p: { user: PublicKey; mint: PublicKey; spendableLamports: bigint; buybackFeeRecipient: PublicKey }): Promise<TransactionInstruction> {
      return sdk.getBuyExactQuoteInV3InstructionRaw({
        user: p.user,
        mint: p.mint,
        spendableQuoteIn: bn(p.spendableLamports),
        minTokensOut: new BN(1),
        buybackFeeRecipient: p.buybackFeeRecipient,
      });
    },

    /** Tokens a fresh curve gives for the dev buy (display: Review step "First buy ≈"). */
    quoteFreshCurveBuy(global: SdkGlobal, feeConfig: SdkFeeConfig, lamports: bigint, creator: PublicKey): bigint {
      const curve = sdkModule.newBondingCurve(global);
      return big(
        sdkModule.getBuyV3TokenAmountFromQuoteAmount({
          global,
          feeConfig,
          mintSupply: curve.tokenTotalSupply,
          // Our coins' creator is the shop vault (non-zero), so the creator fee applies to the dev buy.
          bondingCurve: { ...curve, creator },
          amount: bn(lamports),
          curveBaseTokenBalance: curve.tokenTotalSupply,
        }),
      );
    },

    /* ---------------------------------------------------------------------------------------------- quotes */

    /** `buy_exact_quote_in_v3` quote (SDK `getBuyV3TokenAmountFromQuoteAmount`, fee tiers included). */
    quoteBuy(s: CurveSnapshot, lamportsIn: bigint): CurveBuyQuote {
      const tokensOut = big(
        sdkModule.getBuyV3TokenAmountFromQuoteAmount({
          global: s.global,
          feeConfig: s.feeConfig,
          mintSupply: s.curve.tokenTotalSupply,
          bondingCurve: s.curve,
          amount: bn(lamportsIn),
          curveBaseTokenBalance: bn(s.curveBaseTokenBalance),
        }),
      );
      // pump `exact_quote_in_fees`: net = budget × 10⁴ / (10⁴ + bps), shaved until net + ceil fees fits.
      const { protocolFeeBps, creatorFeeBps } = rates(s);
      let net = (lamportsIn * 10_000n) / (10_000n + protocolFeeBps + creatorFeeBps);
      const cost = net + ceilFee(net, protocolFeeBps) + ceilFee(net, creatorFeeBps);
      if (cost > lamportsIn) net -= cost - lamportsIn;
      if (net < 0n) net = 0n;
      return { tokensOut, netLamports: net, protocolFee: ceilFee(net, protocolFeeBps), creatorFee: ceilFee(net, creatorFeeBps) };
    },

    /** `sell_v3` quote: net lamports to the seller (SDK `getSellSolAmountFromTokenAmount`). */
    quoteSell(s: CurveSnapshot, tokensIn: bigint): CurveSellQuote {
      const lamportsOut = big(
        sdkModule.getSellSolAmountFromTokenAmount({
          global: s.global,
          feeConfig: s.feeConfig,
          mintSupply: s.curve.tokenTotalSupply,
          bondingCurve: s.curve,
          amount: bn(tokensIn),
        }),
      );
      const vQ = big(s.curve.virtualQuoteReserves);
      const vT = big(s.curve.virtualTokenReserves);
      const gross = vT + tokensIn > 0n ? (vQ * tokensIn) / (vT + tokensIn) : 0n;
      const { protocolFeeBps, creatorFeeBps } = rates(s);
      return { lamportsOut, grossLamports: gross, protocolFee: ceilFee(gross, protocolFeeBps), creatorFee: ceilFee(gross, creatorFeeBps) };
    },

    /* ---------------------------------------------------------------------------------------------- trades */

    /** Curve buy: [idempotent user ATA] + `buy_exact_quote_in_v3(lamportsIn, tokensOut − slippage)`. */
    buyIxs(p: {
      s: CurveSnapshot;
      mint: PublicKey;
      user: PublicKey;
      tokensOut: bigint;
      lamportsIn: bigint;
      slippageBps: number;
      tokenProgram: PublicKey;
      buybackFeeRecipient: PublicKey;
    }): Promise<TransactionInstruction[]> {
      return sdk.buyExactQuoteInV3Instructions({
        bondingCurve: p.s.curve,
        associatedUserAccountInfo: null, // always add the idempotent ATA create: saves an RPC round trip
        mint: p.mint,
        user: p.user,
        amount: bn(p.tokensOut),
        quoteAmount: bn(p.lamportsIn),
        slippage: p.slippageBps / 100,
        tokenProgram: p.tokenProgram,
        buybackFeeRecipient: p.buybackFeeRecipient,
      });
    },

    /** Curve sell: `sell_v3(tokensIn, lamportsOut − slippage)`. */
    sellIxs(p: {
      s: CurveSnapshot;
      mint: PublicKey;
      user: PublicKey;
      tokensIn: bigint;
      lamportsOut: bigint;
      slippageBps: number;
      tokenProgram: PublicKey;
      buybackFeeRecipient: PublicKey;
    }): Promise<TransactionInstruction[]> {
      return sdk.sellV3Instructions({
        bondingCurve: p.s.curve,
        mint: p.mint,
        user: p.user,
        amount: bn(p.tokensIn),
        quoteAmount: bn(p.lamportsOut),
        slippage: p.slippageBps / 100,
        tokenProgram: p.tokenProgram,
        buybackFeeRecipient: p.buybackFeeRecipient,
      });
    },

    /* ---------------------------------------------------------------------------------------------- fees */

    /** Permissionless `sweep_creator_fee`: the v3 curve bucket → pump's creator_vault(creator). */
    sweepCreatorFeeIx(p: { payer: PublicKey; mint: PublicKey; creator: PublicKey; quoteMint: PublicKey }): Promise<TransactionInstruction> {
      return sdk.sweepCreatorFeeInstruction(p);
    },

    /** Permissionless pump-amm `sweep_creator_fee` (via the pump SDK): the canonical pool's `creatorFees` bucket → the
     *  coin creator's WSOL vault. Must precede `transfer_creator_fees_to_pump_v2` (SDK docs). */
    sweepPoolCreatorFeeIx(p: { payer: PublicKey; mint: PublicKey; coinCreator: PublicKey; quoteMint: PublicKey }): Promise<TransactionInstruction> {
      return sdk.sweepPoolCreatorFeeInstruction(p);
    },

    /** min-out after slippage exactly as the SDK builders compute it (`lessSlippage`: per-mille, floored). */
    lessSlippage(amount: bigint, slippageBps: number, floor: bigint): bigint {
      const perMille = BigInt(Math.floor((slippageBps / 100) * 10));
      const v = amount - (amount * perMille) / 1000n;
      return v > floor ? v : floor;
    },
  };
}

export type PumpOps = ReturnType<typeof makePumpOps>;
