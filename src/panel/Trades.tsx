/**
 * Recent trades (DESIGN §8.12), Top holders (§8.5 Coin tab), mint copy row + Solscan /
 * DexScreener / pump.fun link rows. Simulated coins: trade rows are plain text and link rows
 * toast `Simulated coin — it isn't on <site>. Real coins open there.` instead of navigating.
 */
import { useEffect, useRef, useState } from 'react';
import { links } from '../config';
import { copyText } from '../lib/clipboard';
import { shortAddr, solAmount, timeAgo } from '../lib/format';
import { solFloor } from '../realdata/units';
import { topHoldersFor } from '../lib/market';
import { coinSiteUrl, isSimulatedCoin, openCoinSite, type CoinSite } from '../lib/nav';
import { thirdPartyCoinLinksSupported } from '../realdata/explorer';
import { useStore, useTrades } from '../store';
import type { Coin, Trade } from '../types';
import { AddrBlob, Button, Icon } from '../ui';
import { useNow } from './util';

/* ------------------------------------------------------------------ recent trades */

/** IDs that appeared after mount get `.new` for 700ms (row-in background, DESIGN §14). */
function useNewIds(trades: readonly Trade[]): Set<string> {
  // id → first time this list saw it (0 = present at mount, never animated)
  const seen = useRef<Map<string, number> | null>(null);
  if (seen.current === null) seen.current = new Map(trades.map((t) => [t.id, 0]));
  const map = seen.current;
  const t0 = Date.now();
  const fresh = new Set<string>();
  for (const t of trades) {
    const at = map.get(t.id);
    if (at === undefined) {
      map.set(t.id, t0);
      fresh.add(t.id);
    } else if (at > 0 && t0 - at < 700) fresh.add(t.id);
  }
  if (map.size > 400) for (const id of [...map.keys()].slice(0, map.size - 300)) map.delete(id);
  return fresh;
}

function TradeRow({ t, now, isNew, me, real }: { t: Trade; now: number; isNew: boolean; me: string | null; real: boolean }) {
  const buy = t.side === 'buy';
  const content = (
    <>
      <span className="who">
        <AddrBlob address={t.wallet} />
        <span className="mono trow-addr" translate="no">
          {me && t.wallet === me ? 'You' : shortAddr(t.wallet)}
        </span>
      </span>
      <span className={['side', buy ? 'up' : 'down'].join(' ')}>{buy ? 'Bought' : 'Sold'}</span>
      <span className="amt">{tradeSol(t)}</span>
      <span className="ago">{timeAgo(t.ts, now)}</span>
    </>
  );
  const cls = ['trow', isNew ? 'new' : ''].filter(Boolean).join(' ');
  if (real) {
    return (
      <li>
        <a className={`${cls} is-link`} href={links.solscanTx(t.signature)} target="_blank" rel="noopener noreferrer">
          {content}
        </a>
      </li>
    );
  }
  return <li className={cls}>{content}</li>;
}

/** Real trades: the exact SOL the trader paid / received (fees included), 4 dp, rounded down (INTEGRATION.md §9). */
export function tradeSol(t: { sol: number; lamports?: string }): string {
  if (!t.lamports) return solAmount(t.sol);
  const v = solFloor(t.lamports, 4);
  return v === '0' ? '<0.0001 SOL' : `${v} SOL`;
}

export function RecentTrades({ coin, initial = 5, pageable = false }: { coin: Coin; initial?: number; pageable?: boolean }) {
  const trades = useTrades(coin.placeId);
  const me = useStore((s) => s.wallet.address);
  const now = useNow(10_000);
  const [limit, setLimit] = useState(initial);
  const fresh = useNewIds(trades);
  const shown = trades.slice(0, limit);
  const real = !isSimulatedCoin(coin);

  return (
    <section className="trades" aria-label="Recent trades">
      <h4 className="sec-h">Recent trades</h4>
      {shown.length === 0 ? (
        <p className="trades-empty">No trades yet. Be the first to buy.</p>
      ) : (
        <ul className="trows">
          {shown.map((t) => (
            <TradeRow key={t.id} t={t} now={now} isNew={fresh.has(t.id)} me={me} real={real} />
          ))}
        </ul>
      )}
      {pageable && trades.length > limit ? (
        <div className="trades-more">
          <Button variant="text" onClick={() => setLimit((l) => l + 20)}>
            Show more
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ top holders */

export function TopHolders({ coin }: { coin: Coin }) {
  const me = useStore((s) => s.wallet.address);
  const list = topHoldersFor(coin);
  return (
    <section className="holders" aria-label="Top holders">
      <h4 className="sec-h">Top holders</h4>
      <ol className="trows">
        {list.map((h, i) => (
          <li key={h.address} className="trow">
            <span className="rank">{i + 1}</span>
            <span className="who">
              <AddrBlob address={h.address} />
              <span className="mono trow-addr" translate="no">
                {me && h.address === me ? 'You' : shortAddr(h.address)}
              </span>
              {h.address === coin.launcher ? <span className="holder-tag">Launcher</span> : null}
            </span>
            <span className="amt">{h.pct.toFixed(1)}% of supply</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------------ CA + links */

const SITES: { site: CoinSite; icon: string; label: string }[] = [
  { site: 'Solscan', icon: 'public', label: 'View on Solscan' },
  { site: 'DexScreener', icon: 'candlestick_chart', label: 'Chart on DexScreener' },
  { site: 'pump.fun', icon: 'rocket_launch', label: 'Trade on pump.fun' },
];

export function CoinLinks({ coin }: { coin: Coin }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const simulated = isSimulatedCoin(coin);

  const copy = async () => {
    const ok = await copyText(coin.mint);
    const st = useStore.getState();
    if (!ok) {
      st.toast("Couldn't copy. Select and copy it manually.", 'error');
      return;
    }
    st.toast('Mint address copied', 'ok');
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="info coin-links">
      <button type="button" className="irow" aria-label="Copy mint address" onClick={() => void copy()}>
        <Icon name="toll" />
        <span className="main">
          <span className="mono" translate="no">
            {shortAddr(coin.mint)}
          </span>
          <small translate="no">
            ${coin.ticker} mint · {coin.real && !thirdPartyCoinLinksSupported() ? 'Solana devnet' : 'Solana'} · pump.fun
          </small>
        </span>
        <Icon name={copied ? 'check' : 'content_copy'} className={['trail', copied ? 'ok' : ''].filter(Boolean).join(' ')} />
      </button>
      {SITES.filter((s) => s.site === 'Solscan' || simulated || thirdPartyCoinLinksSupported()).map((s) =>
        simulated ? (
          <button key={s.site} type="button" className="irow" onClick={() => openCoinSite(coin, s.site)}>
            <Icon name={s.icon} />
            <span className="main">{s.label}</span>
            <Icon name="open_in_new" className="trail" />
          </button>
        ) : (
          <a key={s.site} className="irow" href={coinSiteUrl(coin, s.site)} target="_blank" rel="noopener noreferrer">
            <Icon name={s.icon} />
            <span className="main">{s.label}</span>
            <Icon name="open_in_new" className="trail" />
          </a>
        ),
      )}
    </div>
  );
}
