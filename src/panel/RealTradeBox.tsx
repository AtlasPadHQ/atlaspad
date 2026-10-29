/**
 * Buy / sell box in REAL mode (DESIGN §8.11 layout, INTEGRATION.md §7.3 states). Same markup and
 * classes as the demo box; the numbers come from the chain:
 *
 *  - `You receive ≈` = the pump SDK quote on fresh curve state (src/chain quoteBuy / quoteSell),
 *    debounced 250 ms and refreshed every 5 s while the box is mounted; min-out rounds DOWN.
 *  - `Balance` / `You hold` = exact lamports / token base units (src/realdata wallet reads).
 *    Sell 25/50/100% are computed in bigint from the raw holding; 100% sells exactly that.
 *  - Disabled states: `Not enough SOL` (amount + 0.005 SOL fee reserve > balance; devnet adds
 *    `Get test SOL`), `Not enough $X`, `Price impact too high` (> 15%).
 *  - The primary button walks the tx phases (Preparing… → Approve in Phantom… → Sending… →
 *    Confirming…). Errors show under it with `Try again` / `View tx`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BuyQuote, SellQuote, TxError } from '../chain/types';
import { QUICK_BUY_SOL } from '../config';
import { solNumber, tokenAmount, tokenAmountFloor } from '../lib/format';
import { openExternal } from '../lib/nav';
import { prefersReducedMotion, useIsMobile } from '../lib/media';
import { CLUSTER } from '../mode';
import { chain, MAX_PRICE_IMPACT_PCT, prefetchChain, prefetchPump, SLIPPAGE_BPS } from '../realdata/chain';
import { explorerTx } from '../realdata/explorer';
import { useTx, useWalletPolling } from '../realdata/hooks';
import { refreshAfterTx } from '../realdata/index';
import { clearTx, getTestSol, insufficientMessage, isBusyPhase, phaseHelper, phaseLabel, runTx, shortfall } from '../realdata/tx';
import { formatUnits, FEE_RESERVE_LAMPORTS, parseSol, parseTokens, pctOf, solCeil, solFloor, u64, unitsToTokens } from '../realdata/units';
import { useStore } from '../store';
import type { Coin, TradeSide } from '../types';
import { Button, ModeNote, SolGlyph } from '../ui';
import type { TradeIntent } from './TradeBox';
import { OFFLINE_TIP, panelScroller } from './util';

const SELL_PCTS = [25, 50, 100] as const;
const QUOTE_DEBOUNCE_MS = 250;
const QUOTE_REFRESH_MS = 5_000;
/** A quote older than this is refreshed right before signing (INTEGRATION.md §9: state ≤ 2 s old). */
const QUOTE_MAX_AGE_MS = 2_000;

type Quote = BuyQuote | SellQuote;
type QuoteState = { status: 'idle' } | { status: 'loading'; prev: Quote | null } | { status: 'ready'; q: Quote } | { status: 'error' };

/** Digits and one `.`, at most `maxDec` decimals. */
function sanitizeAmount(raw: string, maxDec: number): string {
  let s = raw.replace(/,/g, '.').replace(/[^\d.]/g, '');
  const dot = s.indexOf('.');
  if (dot >= 0) s = `${s.slice(0, dot + 1)}${s.slice(dot + 1).replace(/\./g, '').slice(0, maxDec)}`;
  if (s.startsWith('.')) s = `0${s}`;
  s = s.replace(/^0+(?=\d)/, '');
  return s.slice(0, 24);
}

function isBuyQuote(q: Quote): q is BuyQuote {
  return 'tokensOut' in q;
}

/** `Bought 2.36M $KEBAB for 0.1 SOL` from what actually happened (fill) — real mode has no "· Demo". */
/**
 * `Bought 2.36M $KEBAB for 0.1 SOL` / `Sold 20.8M $QAR3 for 0.0195 SOL`: the fill's exact lamports (fees included) at
 * 4 dp. Money received is rounded DOWN, money paid UP, so neither is ever flattered (INTEGRATION.md §9).
 */
export function realTradeToast(side: TradeSide, tokens: bigint, lamports: bigint, ticker: string): string {
  const t = tokenAmount(unitsToTokens(tokens));
  return side === 'buy' ? `Bought ${t} $${ticker} for ${solCeil(lamports, 4)} SOL` : `Sold ${t} $${ticker} for ${solFloor(lamports, 4)} SOL`;
}

export function RealTradeBox({ coin, intent, onIntentDone }: { coin: Coin; intent: TradeIntent | null; onIntentDone: () => void }) {
  const wallet = useStore((s) => s.wallet.address);
  const balanceLamports = useStore((s) => s.balanceLamports);
  const heldRaw = useStore((s) => s.holdingsRaw[coin.placeId] ?? '0');
  const online = useStore((s) => s.online);
  const mobile = useIsMobile();
  const tx = useTx(['buy', 'sell'], coin.placeId);
  const [side, setSide] = useState<TradeSide>('buy');
  const [input, setInput] = useState('');
  /** Exact raw amount chosen with a % button (100% = the whole holding). Cleared when typing. */
  const [pctRaw, setPctRaw] = useState<bigint | null>(null);
  const [quote, setQuote] = useState<QuoteState>({ status: 'idle' });
  const [error, setError] = useState<TxError | null>(null);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  runningRef.current = running;
  const boxRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusTimer = useRef<number | undefined>(undefined);
  const alive = useRef(true);
  const placeId = coin.placeId;
  const ticker = coin.ticker;
  const held = u64(heldRaw);

  useWalletPolling(true);
  // the chain layer owns the limit (it may differ per cluster); 15% until it has loaded
  const [impactLimit, setImpactLimit] = useState(MAX_PRICE_IMPACT_PCT);
  useEffect(() => {
    alive.current = true;
    prefetchChain();
    chain()
      .then((api) => alive.current && setImpactLimit(api.MAX_PRICE_IMPACT_PCT))
      .catch(() => {});
    return () => {
      alive.current = false;
      window.clearTimeout(focusTimer.current);
      clearTx('buy');
      clearTx('sell');
    };
  }, []);

  // Buy / Sell actions in the panel: switch side, focus the amount, scroll it into view
  useEffect(() => {
    if (!intent) return;
    setSide(intent.side);
    setPctRaw(null);
    onIntentDone();
    prefetchPump();
    const go = () => {
      inputRef.current?.focus({ preventScroll: true });
      const box = boxRef.current;
      if (box && panelScroller(box)) box.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    };
    window.clearTimeout(focusTimer.current);
    focusTimer.current = window.setTimeout(go, mobile ? 470 : 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.nonce]);

  /* ---------------- amounts (bigint, no float maths on money) */
  const amountRaw: bigint | null = useMemo(() => {
    if (side === 'sell' && pctRaw != null) return pctRaw;
    if (!input) return null;
    return side === 'buy' ? parseSol(input) : parseTokens(input);
  }, [side, input, pctRaw]);
  const valid = amountRaw != null && amountRaw > 0n;
  const lamportsIn = side === 'buy' && valid ? amountRaw : 0n;
  const tokensIn = side === 'sell' && valid ? amountRaw : 0n;
  const short = side === 'buy' && valid && wallet ? shortfall(lamportsIn, balanceLamports, FEE_RESERVE_LAMPORTS) : null;
  const tooManyTokens = side === 'sell' && valid && tokensIn > held;

  /* ---------------- quotes: debounced, refreshed every 5 s */
  const quoteKey = valid ? `${side}:${amountRaw}` : '';
  const quoteSeq = useRef(0);
  useEffect(() => {
    if (!quoteKey || tooManyTokens) {
      setQuote({ status: 'idle' });
      return;
    }
    let timer: number | undefined;
    let refresh: number | undefined;
    const seq = ++quoteSeq.current;
    const fetchQuote = async () => {
      // no background re-quotes while a trade is in flight: the trade read fresh state itself, and each re-quote is an
      // /api/rpc request (INTEGRATION §8: one trade ≤ 12)
      if (runningRef.current) {
        refresh = window.setTimeout(() => void fetchQuote(), QUOTE_REFRESH_MS);
        return;
      }
      try {
        const api = await chain();
        const q = side === 'buy' ? await api.quoteBuy(coin.mint, lamportsIn, SLIPPAGE_BPS) : await api.quoteSell(coin.mint, tokensIn, SLIPPAGE_BPS);
        if (alive.current && seq === quoteSeq.current) setQuote({ status: 'ready', q });
      } catch {
        if (alive.current && seq === quoteSeq.current) setQuote({ status: 'error' });
      }
      if (alive.current && seq === quoteSeq.current) refresh = window.setTimeout(() => void fetchQuote(), QUOTE_REFRESH_MS);
    };
    setQuote((cur) => ({ status: 'loading', prev: cur.status === 'ready' ? cur.q : cur.status === 'loading' ? cur.prev : null }));
    timer = window.setTimeout(() => void fetchQuote(), QUOTE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey, tooManyTokens, coin.mint]);

  const q: Quote | null = quote.status === 'ready' ? quote.q : quote.status === 'loading' ? quote.prev : null;
  const qMatches = !!q && (side === 'buy' ? isBuyQuote(q) && q.lamportsIn === lamportsIn : !isBuyQuote(q) && q.tokensIn === tokensIn);
  const impactHigh = qMatches && !!q && q.priceImpactPct > impactLimit;

  /* ---------------- actions */
  const switchSide = (s: TradeSide) => {
    if (s === side || running) return;
    setSide(s);
    setPctRaw(null);
    setError(null);
    // DESIGN §18.2: switch mode, keep the input if valid — but the unit changes (SOL ↔ tokens)
    setInput('');
  };

  const quick = (sol: number) => {
    setInput(String(sol));
    setPctRaw(null);
    setError(null);
  };
  const quickPct = (p: number) => {
    if (!(held > 0n)) return;
    const raw = pctOf(held, p);
    setPctRaw(raw);
    setInput(formatUnits(raw, 6, 6));
    setError(null);
  };

  const execute = async () => {
    if (running || !valid) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    const s = side;
    const amount = amountRaw;
    const out = await runTx(s, placeId, async (signer, onProgress) => {
      const api = await chain();
      // re-quote on fresh state right before the wallet opens (≤ 2 s old)
      let fresh: Quote | null = qMatches && q && Date.now() - q.at <= QUOTE_MAX_AGE_MS ? q : null;
      if (!fresh) fresh = s === 'buy' ? await api.quoteBuy(coin.mint, amount, SLIPPAGE_BPS) : await api.quoteSell(coin.mint, amount, SLIPPAGE_BPS);
      if (fresh.priceImpactPct > api.MAX_PRICE_IMPACT_PCT) {
        return {
          ok: false as const,
          error: { code: 'price-impact' as const, message: `That trade would move the price more than ${api.MAX_PRICE_IMPACT_PCT}%. Try a smaller amount.`, retryable: false, sent: false },
        };
      }
      return s === 'buy' ? api.buy(fresh as BuyQuote, signer, onProgress) : api.sell(fresh as SellQuote, signer, onProgress);
    });
    runningRef.current = false;
    if (!alive.current) return;
    setRunning(false);
    const st = useStore.getState();
    if (out.ok) {
      const fill = out.value;
      setInput('');
      setPctRaw(null);
      setQuote({ status: 'idle' });
      st.toast(realTradeToast(fill.side, fill.tokens, fill.lamports, ticker), 'ok', { label: 'View tx', run: () => openExternal(out.explorerUrl || explorerTx(out.signature)) });
      void refreshAfterTx('trade', coin.mint);
      return;
    }
    const err = out.error;
    if (err.code === 'rejected') {
      // a cancelled wallet prompt resolves quietly
      setError(null);
      clearTx(s);
      return;
    }
    setError(err);
    if (err.code === 'graduated' || err.code === 'slippage') void refreshAfterTx('trade', coin.mint);
  };

  const submit = () => {
    if (running) return;
    const st = useStore.getState();
    if (!st.wallet.address) {
      st.requireWallet(() => window.setTimeout(() => inputRef.current?.focus(), 60));
      return;
    }
    if (!valid || short || tooManyTokens || impactHigh || !online) return;
    void execute();
  };

  /* ---------------- labels */
  const progress = tx?.progress ?? null;
  const busy = running || isBusyPhase(progress);
  let label: string;
  let disabled = false;
  if (running) label = phaseLabel(progress, side);
  else if (!wallet) label = side === 'buy' ? 'Connect wallet to buy' : 'Connect wallet to sell';
  else if (!valid) {
    label = 'Enter an amount';
    disabled = true;
  } else if (short) {
    label = 'Not enough SOL';
    disabled = true;
  } else if (tooManyTokens) {
    label = `Not enough $${ticker}`;
    disabled = true;
  } else if (impactHigh) {
    label = 'Price impact too high';
    disabled = true;
  } else label = side === 'buy' ? `Buy $${ticker}` : `Sell $${ticker}`;
  if (!online && wallet && !running) disabled = true;

  let receive: string;
  if (!valid || tooManyTokens) receive = side === 'buy' ? `— $${ticker}` : '— SOL';
  else if (q && qMatches) receive = isBuyQuote(q) ? `≈ ${tokenAmount(unitsToTokens(q.tokensOut))} $${ticker}` : `≈ ${solFloor(q.lamportsOut, 4)} SOL`;
  else if (quote.status === 'error') receive = 'Price unavailable';
  else receive = '…';

  const minLine =
    q && qMatches
      ? isBuyQuote(q)
        ? `Min ${tokenAmountFloor(unitsToTokens(q.minTokensOut))} $${ticker} · Fee ${solFloor(q.feeLamports, 6)} SOL`
        : `Min ${solFloor(q.minLamportsOut, 4)} SOL · Fee ${solFloor(q.feeLamports, 6)} SOL`
      : null;

  const helper = running ? phaseHelper(progress) : null;
  const errMsg = error ? (error.code === 'insufficient-sol' ? insufficientMessage(error) : error.message) : null;
  const errSig = error?.signature ?? null;

  return (
    <section ref={boxRef} className="trade" aria-label={`Trade $${ticker}`} aria-busy={busy || undefined}>
      <div className="trade-tabs" role="tablist" aria-label="Trade side">
        <button type="button" role="tab" aria-selected={side === 'buy'} className={side === 'buy' ? 'hit on' : 'hit'} disabled={running} onClick={() => switchSide('buy')}>
          Buy
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={side === 'sell'}
          className={side === 'sell' ? 'hit on sell' : 'hit sell'}
          disabled={running}
          onClick={() => switchSide('sell')}
        >
          Sell
        </button>
      </div>
      <label className="field">
        <span className="sr">{side === 'buy' ? 'Amount in SOL' : `Amount of $${ticker}`}</span>
        <input
          ref={inputRef}
          inputMode="decimal"
          autoComplete="off"
          placeholder={side === 'buy' ? '0.0' : '0'}
          value={input}
          disabled={running}
          onFocus={() => prefetchPump()}
          onChange={(e) => {
            setInput(sanitizeAmount(e.target.value, side === 'buy' ? 9 : 6));
            setPctRaw(null);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        {side === 'buy' ? (
          <span className="unit">
            <SolGlyph />
            SOL
          </span>
        ) : (
          <span className="unit" translate="no">
            <span className="unit-coin" aria-hidden="true" style={{ background: coin.logo.bg }}>
              {coin.logo.emoji}
            </span>
            ${ticker}
          </span>
        )}
      </label>
      <div className="quick">
        {side === 'buy'
          ? QUICK_BUY_SOL.map((v) => (
              <button key={v} type="button" disabled={running} onClick={() => quick(v)}>
                {solNumber(v)} SOL
              </button>
            ))
          : SELL_PCTS.map((p) => (
              <button key={p} type="button" disabled={running || !(held > 0n)} onClick={() => quickPct(p)}>
                {p}%
              </button>
            ))}
      </div>
      <div className="receive">
        <span>You receive</span>
        <b translate="no" aria-live="polite">
          {receive}
        </b>
      </div>
      {minLine ? (
        <div className="receive receive-2 receive-min">
          <span translate="no">{minLine}</span>
        </div>
      ) : null}
      <div className="receive receive-2">
        <span>
          {side === 'buy'
            ? wallet
              ? balanceLamports != null
                ? `Balance ${solFloor(balanceLamports, 4)} SOL`
                : 'Balance …'
              : 'Balance —'
            : `You hold ${tokenAmount(unitsToTokens(held))} $${ticker}`}
        </span>
        <span>Slippage {SLIPPAGE_BPS / 100}%</span>
      </div>
      <Button
        variant={side === 'buy' ? 'primary' : 'danger'}
        block
        loading={running}
        disabled={disabled}
        tip={!online && wallet ? OFFLINE_TIP : undefined}
        onClick={submit}
      >
        {label}
      </Button>
      {helper ? <p className="tx-help">{helper}</p> : null}
      {short && !running ? (
        <div className="tx-short" role="status">
          <b>{short.message}</b>
          {CLUSTER === 'devnet' ? (
            <span className="tx-short-a">
              <button type="button" className="link hit" onClick={() => void getTestSol()}>
                Get test SOL
              </button>
            </span>
          ) : (
            <span>Add SOL to your wallet to continue</span>
          )}
        </div>
      ) : null}
      {impactHigh && !running ? (
        <p className="tx-help">That trade would move the price more than {impactLimit}%. Try a smaller amount.</p>
      ) : null}
      {errMsg && !running ? (
        <p className="tx-err" role="alert">
          <span>{errMsg}</span>
          {error?.retryable ? (
            <button type="button" className="link hit" onClick={submit}>
              Try again
            </button>
          ) : null}
          {error?.code === 'insufficient-sol' && CLUSTER === 'devnet' ? (
            <button type="button" className="link hit" onClick={() => void getTestSol()}>
              Get test SOL
            </button>
          ) : null}
          {errSig ? (
            <button type="button" className="link hit" onClick={() => openExternal(error?.explorerUrl ?? explorerTx(errSig))}>
              View tx
            </button>
          ) : null}
        </p>
      ) : null}
      <ModeNote />
    </section>
  );
}
