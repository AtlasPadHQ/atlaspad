/**
 * Quotes and trades (INTEGRATION.md §4.3, §4.5). Curve coins use pump v3 (`buy_exact_quote_in_v3` / `sell_v3`) built
 * by the pinned SDK on fresh state; graduated coins go to PumpSwap directly (`amm.ts`, own chunk). Heavy module.
 *
 * Accuracy (INTEGRATION.md §9): the quote is the SDK's exact answer for the state it read (≤ 2 s old when the UI
 * refreshes every 5 s); min-out = quote × (1 − slippage), rounded DOWN exactly as the SDK builder computes it.
 */
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import { BUYBACK_FEE_RECIPIENT, CU, DEFAULT_SLIPPAGE_BPS, FEE_RESERVE_LAMPORTS, MAX_PRICE_IMPACT_PCT, TOKEN_2022 } from './constants';
import { assertCanSign, backend, connection, loadPump } from './context';
import { lamportsPerToken } from './curve';
import { toTxError, TxFail } from './errors';
import { fillFromTx } from './events';
import { explorerTx } from './explorer';
import { readCurve, type MarketRead } from './market';
import type { CurveSnapshot } from './pumpOps';
import { executeWithRetry, fetchTx, latestBlockhash, simulate, type Built } from './send';
import type { BuyQuote, OnProgress, SellQuote, TradeFill, TxOutcome, WalletSigner } from './types';

const T22 = new PublicKey(TOKEN_2022);
const BUYBACK = new PublicKey(BUYBACK_FEE_RECIPIENT);
/** Snapshots behind recent quotes, reused to build the trade (refreshed when older than this). */
const SNAPSHOT_MAX_AGE_MS = 15_000;
const snapshots = new Map<string, { snapshot: CurveSnapshot; at: number }>();

type AmmModule = typeof import('./amm');
let ammP: Promise<AmmModule> | null = null;
function loadAmm(): Promise<AmmModule> {
  ammP ??= import('./amm').catch((e: unknown) => {
    ammP = null;
    throw e;
  });
  return ammP;
}

function impact(before: number, after: number): number {
  return before > 0 && after > 0 ? ((after - before) / before) * 100 : 0;
}

function remember(mint: string, r: MarketRead): void {
  snapshots.set(mint, { snapshot: r.snapshot, at: r.at });
  if (snapshots.size > 50) snapshots.delete(snapshots.keys().next().value as string);
}

async function snapshotFor(mint: string, fresh: boolean): Promise<CurveSnapshot> {
  const hit = snapshots.get(mint);
  if (!fresh && hit && Date.now() - hit.at < SNAPSHOT_MAX_AGE_MS) return hit.snapshot;
  const r = await readCurve(mint);
  if (r.curve.complete) throw new TxFail('graduated');
  remember(mint, r);
  return r.snapshot;
}

/** INTEGRATION.md §4.2 `quoteBuy` (default slippage 200 bps). Throws on network failures; map with toTxError. */
export async function quoteBuy(mint: string, lamportsIn: bigint, slippageBps = DEFAULT_SLIPPAGE_BPS): Promise<BuyQuote> {
  const r = await readCurve(mint);
  if (r.curve.complete) return (await loadAmm()).quoteBuyAmm(connection(), mint, lamportsIn, slippageBps);
  remember(mint, r);
  const q = r.ops.quoteBuy(r.snapshot, lamportsIn);
  const vQ = r.curve.virtualQuoteReserves;
  const vT = r.curve.virtualTokenReserves;
  const priceBefore = lamportsPerToken(vQ, vT);
  const priceAfter = q.tokensOut > 0n && vT > q.tokensOut ? lamportsPerToken(vQ + q.netLamports, vT - q.tokensOut) : priceBefore;
  return {
    mint,
    venue: 'curve',
    lamportsIn,
    tokensOut: q.tokensOut,
    minTokensOut: q.tokensOut > 0n ? r.ops.lessSlippage(q.tokensOut, slippageBps, 1n) : 0n,
    slippageBps,
    priceImpactPct: impact(priceBefore, priceAfter),
    feeLamports: q.protocolFee + q.creatorFee,
    creatorFeeLamports: q.creatorFee,
    priceBefore,
    priceAfter,
    at: r.at,
  };
}

/** INTEGRATION.md §4.2 `quoteSell`. `tokensIn` in base units (a 100% sell passes the exact raw holding). */
export async function quoteSell(mint: string, tokensIn: bigint, slippageBps = DEFAULT_SLIPPAGE_BPS): Promise<SellQuote> {
  const r = await readCurve(mint);
  if (r.curve.complete) return (await loadAmm()).quoteSellAmm(connection(), mint, tokensIn, slippageBps);
  remember(mint, r);
  const q = r.ops.quoteSell(r.snapshot, tokensIn);
  const vQ = r.curve.virtualQuoteReserves;
  const vT = r.curve.virtualTokenReserves;
  const priceBefore = lamportsPerToken(vQ, vT);
  const priceAfter = tokensIn > 0n && vQ > q.grossLamports ? lamportsPerToken(vQ - q.grossLamports, vT + tokensIn) : priceBefore;
  return {
    mint,
    venue: 'curve',
    tokensIn,
    lamportsOut: q.lamportsOut,
    minLamportsOut: r.ops.lessSlippage(q.lamportsOut, slippageBps, 0n),
    slippageBps,
    priceImpactPct: impact(priceBefore, priceAfter),
    feeLamports: q.protocolFee + q.creatorFee,
    creatorFeeLamports: q.creatorFee,
    priceBefore,
    priceAfter,
    at: r.at,
  };
}

async function buildTrade(user: PublicKey, ixs: TransactionInstruction[], cuLimit: number, priority: number, needLamports?: bigint): Promise<Built> {
  const { blockhash, lastValidBlockHeight } = await latestBlockhash({ maxAgeMs: 10_000 });
  const msg = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }), ...ixs],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  await simulate(tx, { needLamports });
  return { tx, lastValidBlockHeight };
}

function progressTracker(onProgress: OnProgress) {
  const state = { sent: false, signature: undefined as string | undefined };
  const progress: OnProgress = (p) => {
    if (p.phase === 'preparing' || p.phase === 'awaiting-signature') {
      state.sent = false;
      state.signature = undefined;
    }
    if (p.signature) {
      state.sent = true;
      state.signature = p.signature;
    }
    onProgress(p);
  };
  return { state, progress };
}

async function finishTrade(signature: string, mint: string, user: string, side: 'buy' | 'sell', estimate: TradeFill, pool?: string | null): Promise<TradeFill> {
  void backend().indexTx({ signature });
  const tx = await fetchTx(signature);
  return (tx && fillFromTx(tx, { mint, user, side, pool })) ?? estimate;
}

/** INTEGRATION.md §4.2 `buy`. Never throws for expected failures. */
export async function buy(q: BuyQuote, signer: WalletSigner, onProgress: OnProgress): Promise<TxOutcome<TradeFill>> {
  const { state, progress } = progressTracker(onProgress);
  try {
    const cfg = assertCanSign('Buying');
    if (q.priceImpactPct > MAX_PRICE_IMPACT_PCT) throw new TxFail('price-impact');
    if (q.tokensOut <= 0n) throw new TxFail('unknown', { message: 'That amount is too small to buy anything.', retryable: false });
    const user = new PublicKey(signer.address);
    const mint = new PublicKey(q.mint);
    const need = q.lamportsIn + FEE_RESERVE_LAMPORTS;
    let pool: string | null = null;
    const landed = await executeWithRetry(
      async (attempt) => {
        progress({ phase: 'preparing', step: 'build' });
        if (q.venue === 'amm') {
          const amm = await loadAmm();
          const built = await amm.buyAmmIxs(connection(), q, user);
          pool = built.pool;
          return buildTrade(user, built.ixs, CU.ammTrade, cfg.priorityFeeMicroLamports, need);
        }
        const s = await snapshotFor(q.mint, attempt > 1);
        const ops = await loadPump();
        const ixs = await ops.buyIxs({
          s,
          mint,
          user,
          tokensOut: q.tokensOut,
          lamportsIn: q.lamportsIn,
          slippageBps: q.slippageBps,
          tokenProgram: T22,
          buybackFeeRecipient: BUYBACK,
        });
        return buildTrade(user, ixs, CU.trade, cfg.priorityFeeMicroLamports, need);
      },
      signer,
      progress,
    );
    const estimate: TradeFill = { side: 'buy', lamports: q.lamportsIn, tokens: q.tokensOut, priceLamportsPerToken: lamportsPerToken(q.lamportsIn, q.tokensOut), estimated: true };
    const fill = await finishTrade(landed.signature, q.mint, signer.address, 'buy', estimate, pool);
    const explorerUrl = explorerTx(landed.signature);
    progress({ phase: 'done', walletName: signer.walletName, signature: landed.signature, explorerUrl });
    return { ok: true, signature: landed.signature, explorerUrl, value: fill };
  } catch (e) {
    return { ok: false, error: toTxError(e, { ...state, walletName: signer.walletName, needLamports: q.lamportsIn + FEE_RESERVE_LAMPORTS }) };
  }
}

/** INTEGRATION.md §4.2 `sell`. Never throws for expected failures. */
export async function sell(q: SellQuote, signer: WalletSigner, onProgress: OnProgress): Promise<TxOutcome<TradeFill>> {
  const { state, progress } = progressTracker(onProgress);
  try {
    const cfg = assertCanSign('Selling');
    if (q.priceImpactPct > MAX_PRICE_IMPACT_PCT) throw new TxFail('price-impact');
    if (q.tokensIn <= 0n) throw new TxFail('insufficient-tokens');
    const user = new PublicKey(signer.address);
    const mint = new PublicKey(q.mint);
    let pool: string | null = null;
    const landed = await executeWithRetry(
      async (attempt) => {
        progress({ phase: 'preparing', step: 'build' });
        if (q.venue === 'amm') {
          const amm = await loadAmm();
          const built = await amm.sellAmmIxs(connection(), q, user);
          pool = built.pool;
          return buildTrade(user, built.ixs, CU.ammTrade, cfg.priorityFeeMicroLamports, FEE_RESERVE_LAMPORTS);
        }
        const s = await snapshotFor(q.mint, attempt > 1);
        const ops = await loadPump();
        const ixs = await ops.sellIxs({
          s,
          mint,
          user,
          tokensIn: q.tokensIn,
          lamportsOut: q.lamportsOut,
          slippageBps: q.slippageBps,
          tokenProgram: T22,
          buybackFeeRecipient: BUYBACK,
        });
        return buildTrade(user, ixs, CU.trade, cfg.priorityFeeMicroLamports, FEE_RESERVE_LAMPORTS);
      },
      signer,
      progress,
    );
    const estimate: TradeFill = { side: 'sell', lamports: q.lamportsOut, tokens: q.tokensIn, priceLamportsPerToken: lamportsPerToken(q.lamportsOut, q.tokensIn), estimated: true };
    const fill = await finishTrade(landed.signature, q.mint, signer.address, 'sell', estimate, pool);
    const explorerUrl = explorerTx(landed.signature);
    progress({ phase: 'done', walletName: signer.walletName, signature: landed.signature, explorerUrl });
    return { ok: true, signature: landed.signature, explorerUrl, value: fill };
  } catch (e) {
    return { ok: false, error: toTxError(e, { ...state, walletName: signer.walletName, needLamports: FEE_RESERVE_LAMPORTS }) };
  }
}
