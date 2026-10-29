/**
 * Graduated coins: trades directly on the canonical PumpSwap pool with @pump-fun/pump-swap-sdk 2.1.0 (pinned), on
 * BOTH clusters (INTEGRATION.md §4.5: a deliberate deviation from "Jupiter after graduation" — Jupiter has no devnet,
 * so that path could not be tested; Jupiter stays a mainnet-only P2 fallback). Own lazy chunk: loaded only when a
 * coin's curve is complete. P1: exercised on devnet by the e2e with GRADUATE=1 once a pool exists.
 *
 * Pool spot price (INTEGRATION.md §4.3, curve.ts `poolPrice`): `(quoteVault + Pool.virtual_quote_reserves) × 10^6 /
 * baseVault`. pump-swap-sdk prices swaps on exactly that effective quote reserve (`buyQuoteInput`:
 * `effectiveQuoteReserve = quoteReserve + virtualQuoteReserves`; the virtual part is a signed i128 that v2 fee
 * accruals decrease). curve.test.ts checks the formula against a real devnet pool captured in __fixtures__/devnet.json
 * (a tiny SDK quote converges to the spot price), and the devnet e2e quotes + simulates a PumpSwap buy live.
 *
 * Buys use `buy_exact_quote_in_v2` (spend exactly `lamportsIn`, min base out after slippage) when the pool supports
 * v2 trades (every non-cashback pool), else v1 `buy` sized so the max quote stays within `lamportsIn`.
 */
import BN from 'bn.js';
import { PublicKey, type Connection, type TransactionInstruction } from '@solana/web3.js';
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  buyQuoteInput,
  canonicalPumpPoolPda,
  coinCreatorVaultAtaPda,
  coinCreatorVaultAuthorityPda,
  sellBaseInput,
  supportsTradeV2,
  type SwapSolanaState,
} from '@pump-fun/pump-swap-sdk';
import { lamportsPerToken } from './curve';
import { TxFail } from './errors';
import type { BuyQuote, SellQuote } from './types';
import { TOKEN_PROGRAM, WSOL_MINT } from './constants';

const big = (v: BN | bigint | number | string) => BigInt(v.toString());
const bn = (v: bigint) => new BN(v.toString());
const QUOTE_USER = new PublicKey('11111111111111111111111111111111');

/** pump-swap-sdk's `lessSlippage` equivalent (per-mille, floored). */
function lessSlippage(amount: bigint, slippageBps: number, floor: bigint): bigint {
  const perMille = BigInt(Math.floor((slippageBps / 100) * 10));
  const v = amount - (amount * perMille) / 1000n;
  return v > floor ? v : floor;
}

export function poolOf(mint: string): PublicKey {
  return canonicalPumpPoolPda(new PublicKey(mint));
}

async function state(conn: Connection, mint: string, user: PublicKey): Promise<SwapSolanaState> {
  try {
    return await new OnlinePumpAmmSdk(conn).swapSolanaState(poolOf(mint), user);
  } catch (e) {
    // Curve complete but pump's migration bot hasn't created the pool yet.
    if (/Pool account not found/i.test(String((e as Error)?.message))) throw new TxFail('graduated');
    throw e;
  }
}

function spot(s: SwapSolanaState): number {
  return lamportsPerToken(big(s.poolQuoteAmount) + big(s.pool.virtualQuoteReserves ?? 0), big(s.poolBaseAmount));
}

function inputs(s: SwapSolanaState) {
  return {
    baseReserve: s.poolBaseAmount,
    quoteReserve: s.poolQuoteAmount,
    virtualQuoteReserves: s.pool.virtualQuoteReserves,
    globalConfig: s.globalConfig,
    baseMintAccount: s.baseMintAccount,
    baseMint: s.baseMint,
    coinCreator: s.pool.coinCreator,
    creator: s.pool.creator,
    feeConfig: s.feeConfig,
    quoteMint: s.pool.quoteMint,
    isMayhemMode: s.pool.isMayhemMode,
    creatorFeeBps: s.pool.creatorFeeBps,
  };
}

export async function quoteBuyAmm(conn: Connection, mint: string, lamportsIn: bigint, slippageBps: number): Promise<BuyQuote> {
  const s = await state(conn, mint, QUOTE_USER);
  const r = buyQuoteInput({ quote: bn(lamportsIn), slippage: slippageBps / 100, ...inputs(s) });
  const tokensOut = big(r.base);
  const net = big(r.internalQuoteWithoutFees);
  const before = spot(s);
  const base = big(s.poolBaseAmount);
  const quote = big(s.poolQuoteAmount) + big(s.pool.virtualQuoteReserves ?? 0);
  const after = base > tokensOut ? lamportsPerToken(quote + net, base - tokensOut) : before;
  return {
    mint,
    venue: 'amm',
    lamportsIn,
    tokensOut,
    minTokensOut: lessSlippage(tokensOut, slippageBps, 1n),
    slippageBps,
    priceImpactPct: before > 0 ? ((after - before) / before) * 100 : 0,
    feeLamports: lamportsIn > net ? lamportsIn - net : 0n,
    creatorFeeLamports: 0n,
    priceBefore: before,
    priceAfter: after,
    at: Date.now(),
  };
}

export async function quoteSellAmm(conn: Connection, mint: string, tokensIn: bigint, slippageBps: number): Promise<SellQuote> {
  const s = await state(conn, mint, QUOTE_USER);
  const r = sellBaseInput({ base: bn(tokensIn), slippage: slippageBps / 100, feeBucketsTotal: s.pool.protocolFees.add(s.pool.creatorFees), ...inputs(s) });
  const lamportsOut = big(r.uiQuote);
  const gross = big(r.internalQuoteAmountOut);
  const before = spot(s);
  const base = big(s.poolBaseAmount);
  const quote = big(s.poolQuoteAmount) + big(s.pool.virtualQuoteReserves ?? 0);
  const after = quote > gross ? lamportsPerToken(quote - gross, base + tokensIn) : before;
  return {
    mint,
    venue: 'amm',
    tokensIn,
    lamportsOut,
    minLamportsOut: big(r.minQuote),
    slippageBps,
    priceImpactPct: before > 0 ? ((after - before) / before) * 100 : 0,
    feeLamports: gross > lamportsOut ? gross - lamportsOut : 0n,
    creatorFeeLamports: 0n,
    priceBefore: before,
    priceAfter: after,
    at: Date.now(),
  };
}

export async function buyAmmIxs(conn: Connection, q: BuyQuote, user: PublicKey): Promise<{ ixs: TransactionInstruction[]; pool: string }> {
  const s = await state(conn, q.mint, user);
  const pool = s.poolKey.toBase58();
  if (supportsTradeV2(s.pool)) {
    return { pool, ixs: await PUMP_AMM_SDK.buyExactQuoteInV2Instructions(s, bn(q.lamportsIn), bn(q.minTokensOut > 0n ? q.minTokensOut : 1n)) };
  }
  // v1: the quote budget is the MAX quote in; size it so max ≤ lamportsIn.
  const budget = (q.lamportsIn * 1000n) / (1000n + BigInt(Math.floor((q.slippageBps / 100) * 10)));
  return { pool, ixs: await PUMP_AMM_SDK.buyQuoteInput(s, bn(budget), q.slippageBps / 100) };
}

export async function sellAmmIxs(conn: Connection, q: SellQuote, user: PublicKey): Promise<{ ixs: TransactionInstruction[]; pool: string }> {
  const s = await state(conn, q.mint, user);
  const pool = s.poolKey.toBase58();
  const ixs = supportsTradeV2(s.pool)
    ? await PUMP_AMM_SDK.sellV2Instructions(s, bn(q.tokensIn), bn(q.minLamportsOut))
    : await PUMP_AMM_SDK.sellInstructions(s, bn(q.tokensIn), bn(q.minLamportsOut));
  return { pool, ixs };
}

/** The pump-amm coin-creator WSOL vault of a creator (graduated creator fees land here). */
export function ammCreatorVaultAta(creator: PublicKey): PublicKey {
  return coinCreatorVaultAtaPda(coinCreatorVaultAuthorityPda(creator), new PublicKey(WSOL_MINT), new PublicKey(TOKEN_PROGRAM));
}

/**
 * Collect-path steps for a graduated coin (SPEC §8.3): pool-level creator-fee sweep (v2 trades leave the creator fee in
 * the pool, `Pool.creatorFees`) is done by the pump SDK; then `transfer_creator_fees_to_pump_v2` moves the coin
 * creator's WSOL vault into pump's creator_vault(vault), from where `collect_creator_fee` pays the shop vault.
 */
export async function transferCreatorFeesToPumpIx(payer: PublicKey, creator: PublicKey): Promise<TransactionInstruction> {
  return PUMP_AMM_SDK.transferCreatorFeesToPumpV2Instruction({
    payer,
    coinCreator: creator,
    quoteMint: new PublicKey(WSOL_MINT),
    quoteTokenProgram: new PublicKey(TOKEN_PROGRAM),
  });
}

/** Pool creator-fee bucket (lamports) of the canonical pool, or 0n when there is no pool yet. */
export async function poolCreatorFees(conn: Connection, mint: string): Promise<bigint> {
  const ai = await conn.getAccountInfo(poolOf(mint), 'confirmed');
  if (!ai) return 0n;
  try {
    return big(PUMP_AMM_SDK.decodePool(ai).creatorFees);
  } catch {
    return 0n;
  }
}
