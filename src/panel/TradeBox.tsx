/**
 * Buy / sell box (DESIGN §8.11). Real mode: see RealTradeBox (chain quotes + wallet signing).
 * Demo: simulated: after a 1.2s spinner it calls store.userBuy /
 * userSell, toasts `Bought 2.36M $KEBAB for 0.5 SOL · Demo` (action View) and clears the input.
 * Buy needs a wallet (wallet modal, then the buy continues); Sell is limited to the wallet's
 * simulated holdings. Never signs or sends anything.
 */
import { useEffect, useRef, useState } from 'react';
import { QUICK_BUY_SOL, SIM_TRADE_MS, SLIPPAGE_PCT } from '../config';
import { solApprox, solNumber, tokenAmount } from '../lib/format';
import { placeFromCoin } from '../lib/place';
import { prefersReducedMotion, useIsMobile } from '../lib/media';
import { quoteBuy, quoteSell } from '../lib/market';
import { tradeToast, useStore } from '../store';
import type { Coin, TradeSide } from '../types';
import { Button, DemoNote, SolGlyph } from '../ui';
import { RealTradeBox } from './RealTradeBox';
import { OFFLINE_TIP, panelScroller } from './util';

export interface TradeIntent {
  side: TradeSide;
  nonce: number;
}

const SELL_PCTS = [25, 50, 100] as const;

/** Digits and one `.`, at most `maxDec` decimals. */
function sanitizeAmount(raw: string, maxDec: number): string {
  let s = raw.replace(/,/g, '.').replace(/[^\d.]/g, '');
  const dot = s.indexOf('.');
  if (dot >= 0) s = `${s.slice(0, dot + 1)}${s.slice(dot + 1).replace(/\./g, '').slice(0, maxDec)}`;
  if (s.startsWith('.')) s = `0${s}`;
  s = s.replace(/^0+(?=\d)/, '');
  return s.slice(0, 20);
}

function floorStr(v: number, dec: number): string {
  if (!(v > 0)) return '';
  const f = 10 ** dec;
  const x = Math.floor(v * f) / f;
  return x.toFixed(dec).replace(/\.?0+$/, '');
}

/** "View" toast action: open that coin's Coin tab (wherever the user is now). */
export function viewCoinTab(placeId: string): void {
  const st = useStore.getState();
  const coin = st.coins[placeId];
  if (!coin) return;
  if (st.panel === 'place' && st.selected.place?.id === placeId) {
    st.setPanelCollapsed(false);
    st.setPlaceTab('coin');
  } else st.openPlace(placeFromCoin(coin), { fly: true, tab: 'coin' });
}

/** Real-mode coins (`coin.real`) get the chain-backed box; demo coins keep the simulated one. */
export function TradeBox(props: { coin: Coin; intent: TradeIntent | null; onIntentDone: () => void }) {
  return props.coin.real ? <RealTradeBox {...props} /> : <DemoTradeBox {...props} />;
}

function DemoTradeBox({ coin, intent, onIntentDone }: { coin: Coin; intent: TradeIntent | null; onIntentDone: () => void }) {
  const wallet = useStore((s) => s.wallet.address);
  const sol = useStore((s) => s.solBalance);
  const held = useStore((s) => s.holdings[coin.placeId] ?? 0);
  const solUsd = useStore((s) => s.solUsd);
  const online = useStore((s) => s.online);
  const mobile = useIsMobile();
  const [side, setSide] = useState<TradeSide>('buy');
  const [input, setInput] = useState('');
  const [maxSell, setMaxSell] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const placeId = coin.placeId;
  const ticker = coin.ticker;

  const focusTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(focusTimer.current);
    },
    [],
  );

  // Buy / Sell actions in the panel: switch side, focus the amount, scroll it into view
  useEffect(() => {
    if (!intent) return;
    setSide(intent.side);
    if (intent.side === 'sell') setMaxSell(false);
    onIntentDone();
    const go = () => {
      inputRef.current?.focus({ preventScroll: true });
      const box = boxRef.current;
      if (box && panelScroller(box)) box.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    };
    // after the wallet modal hands focus back; mobile: after the sheet reaches Full (450ms)
    window.clearTimeout(focusTimer.current);
    focusTimer.current = window.setTimeout(go, mobile ? 470 : 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.nonce]);

  const amount = Number(input);
  const valid = input !== '' && Number.isFinite(amount) && amount > 0;
  const sellTokens = maxSell ? held : amount;
  const q = valid ? (side === 'buy' ? quoteBuy(coin, amount, solUsd) : quoteSell(coin, sellTokens, solUsd)) : null;
  const tooMuch = side === 'buy' ? valid && amount > sol + 1e-9 : valid && sellTokens > held * (1 + 1e-9);

  const switchSide = (s: TradeSide) => {
    if (s === side) return;
    setSide(s);
    setMaxSell(false);
    // DESIGN §18.2: switch mode, keep the input if valid
    if (!valid) setInput('');
  };

  const run = (s: TradeSide, amt: number) => {
    setBusy(true);
    timer.current = window.setTimeout(() => {
      const st = useStore.getState();
      const r = s === 'buy' ? st.userBuy(placeId, amt) : st.userSell(placeId, amt);
      setBusy(false);
      if (r.ok) {
        setInput('');
        setMaxSell(false);
        st.toast(tradeToast(r, ticker), 'ok', { label: 'View', run: () => viewCoinTab(placeId) });
      } else {
        st.toast(r.message, 'error');
      }
    }, SIM_TRADE_MS);
  };

  const submit = () => {
    if (busy) return;
    const st = useStore.getState();
    if (!st.wallet.address) {
      // Connect first, then continue the same action when the amount fits the new balance.
      const s = side;
      const amt = s === 'sell' && maxSell ? null : amount;
      st.requireWallet(() => {
        const after = useStore.getState();
        const ok =
          amt != null &&
          amt > 0 &&
          (s === 'buy' ? amt <= after.solBalance + 1e-9 : amt <= (after.holdings[placeId] ?? 0) * (1 + 1e-9));
        if (ok && after.online) run(s, amt);
        else window.setTimeout(() => inputRef.current?.focus(), 60);
      });
      return;
    }
    if (!valid || tooMuch || !online) return;
    run(side, side === 'sell' ? sellTokens : amount);
  };

  const quick = (v: number) => {
    setInput(floorStr(v, 9));
    setMaxSell(false);
  };
  const quickPct = (p: number) => {
    if (!(held > 0)) return;
    setInput(floorStr((held * p) / 100, held >= 1000 ? 0 : 6));
    setMaxSell(p === 100);
  };

  let label: string;
  let disabled = false;
  if (busy) label = side === 'buy' ? 'Buying…' : 'Selling…';
  else if (!wallet) label = side === 'buy' ? 'Connect wallet to buy' : 'Connect wallet to sell';
  else if (!valid) {
    label = 'Enter an amount';
    disabled = true;
  } else if (tooMuch) {
    label = side === 'buy' ? 'Not enough SOL' : `Not enough $${ticker}`;
    disabled = true;
  } else label = side === 'buy' ? `Buy $${ticker}` : `Sell $${ticker}`;
  if (!online && wallet) disabled = true;

  return (
    <section ref={boxRef} className="trade" aria-label={`Trade $${ticker}`}>
      <div className="trade-tabs" role="tablist" aria-label="Trade side">
        <button type="button" role="tab" aria-selected={side === 'buy'} className={side === 'buy' ? 'hit on' : 'hit'} onClick={() => switchSide('buy')}>
          Buy
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={side === 'sell'}
          className={side === 'sell' ? 'hit on sell' : 'hit sell'}
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
          disabled={busy}
          onChange={(e) => {
            setInput(sanitizeAmount(e.target.value, side === 'buy' ? 9 : 6));
            setMaxSell(false);
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
              <button key={v} type="button" disabled={busy} onClick={() => quick(v)}>
                {solNumber(v)} SOL
              </button>
            ))
          : SELL_PCTS.map((p) => (
              <button key={p} type="button" disabled={busy || !(held > 0)} onClick={() => quickPct(p)}>
                {p}%
              </button>
            ))}
      </div>
      <div className="receive">
        <span>You receive</span>
        <b translate="no">
          {q ? (side === 'buy' ? `≈ ${tokenAmount(q.tokens)} $${ticker}` : solApprox(q.sol)) : side === 'buy' ? `— $${ticker}` : '— SOL'}
        </b>
      </div>
      <div className="receive receive-2">
        <span>
          {side === 'buy' ? (wallet ? `Balance ${solNumber(sol)} SOL` : 'Balance —') : `You hold ${tokenAmount(held)} $${ticker}`}
        </span>
        <span>Slippage {SLIPPAGE_PCT}%</span>
      </div>
      <Button
        variant={side === 'buy' ? 'primary' : 'danger'}
        block
        loading={busy}
        disabled={disabled}
        tip={!online && wallet ? OFFLINE_TIP : undefined}
        onClick={submit}
      >
        {label}
      </Button>
      <DemoNote />
    </section>
  );
}
