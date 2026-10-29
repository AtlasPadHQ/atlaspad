/**
 * Live panel (DESIGN §10.2): live stream of launches / trades / pumps / claims (newest first,
 * max 100 shown, new rows play `rowin`), a global stats line, filter tabs, and a Top shops
 * preview (Market cap | Fees earned, top 5, "See all top shops").
 *
 *  - Rows open the coin (fly to zoom 16 + panel with a "Live" back chip).
 *  - While the browser tab is hidden no rows are inserted; on return a single
 *    "<n> new events · Show" row appears at the top (the simulator also catches up).
 *  - The feed itself is not a live region: the app-wide LiveAnnouncer (src/ui) announces a
 *    throttled summary at most every 10s ("3 new trades").
 * OWNED BY RAIL+FEED. Rendered by PanelHost inside PanelShell when store.panel === 'live'.
 */
import { useEffect, useState } from 'react';
import { DEMO } from '../config';
import { usdCompact } from '../lib/format';
import { feedHealth, topByFees, topByMc, totals, useShallow, useStore } from '../store';
import type { FeedEvent } from '../types';
import { Button, EmptyState, Icon, Seg, SkRows } from '../ui';
import { FeedRow, TopRow } from './rows';
import { SORT_OPTIONS, useFreshness } from './util';
import { useTicker } from './useTicker';

type Filter = 'all' | 'trade' | 'launch' | 'claim';

const FILTERS: { key: Filter; label: string; none: string }[] = [
  { key: 'all', label: 'All', none: '' },
  { key: 'trade', label: 'Trades', none: 'trades' },
  { key: 'launch', label: 'Launches', none: 'launches' },
  { key: 'claim', label: 'Claims', none: 'claims' },
];

const MAX_ROWS = 100;

function matches(ev: FeedEvent, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'trade') return ev.kind === 'trade' || ev.kind === 'pump';
  return ev.kind === f;
}

/** "simulated · updating" / "reconnecting…" / "offline" live indicator (DESIGN §10.2, §13.5). */
export function LiveIndicator() {
  useTicker(5000);
  const simLastTickAt = useStore((s) => s.simLastTickAt);
  const online = useStore((s) => s.online);
  const health = feedHealth({ simLastTickAt, online });
  const text = health === 'live' ? (DEMO ? 'simulated · updating' : 'updating') : health === 'stalled' ? 'reconnecting…' : 'offline';
  return (
    <span className={['area-live', health === 'live' ? '' : 'idle'].filter(Boolean).join(' ')}>
      <i aria-hidden="true" />
      {text}
    </span>
  );
}

export default function LivePanel() {
  useTicker(1000);
  const feed = useStore((s) => s.feed);
  const seeded = useStore((s) => s.dataReady || Object.keys(s.coins).length > 0);
  const stats = useStore(
    useShallow((s) => {
      const t = totals(s.coins);
      return { shops: t.shops, fees: t.feesWaitingUsd, volume: t.volume24hUsd };
    }),
  );
  const you = useStore((s) => s.wallet.address);
  const sort = useStore((s) => s.topShops.sort);
  const setTopShops = useStore((s) => s.setTopShops);
  const setPanel = useStore((s) => s.setPanel);
  const solUsd = useStore((s) => s.solUsd);
  const top = useStore(useShallow((s) => (sort === 'mcap' ? topByMc(s.coins, 5) : topByFees(s.coins, 5))));

  const [filter, setFilter] = useState<Filter>('all');
  /** Snapshot of the feed taken when the tab was hidden; rows stop being inserted until "Show". */
  const [held, setHeld] = useState<FeedEvent[] | null>(null);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onVis = () => {
      clearTimeout(t);
      if (document.visibilityState === 'hidden') {
        setHeld((prev) => prev ?? useStore.getState().feed);
        return;
      }
      // give the simulator's catch-up batch a moment, then keep the snapshot only if something arrived
      t = setTimeout(() => {
        setHeld((prev) => {
          if (!prev) return null;
          const cur = useStore.getState().feed;
          return cur[0]?.id === prev[0]?.id ? null : prev;
        });
      }, 120);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  const source = held ?? feed;
  const isFresh = useFreshness(source.map((e) => e.id));
  const rows = source.filter((e) => matches(e, filter)).slice(0, MAX_ROWS);
  let newCount = 0;
  if (held) {
    const idx = held[0] ? feed.findIndex((e) => e.id === held[0]?.id) : -1;
    newCount = idx >= 0 ? idx : feed.length;
  }
  const now = Date.now();
  const f = FILTERS.find((x) => x.key === filter) ?? FILTERS[0]!;

  return (
    <div className="live-panel">
      <div className="lp-h feed-h" data-sheet-drag>
        <h1>Live</h1>
        <LiveIndicator />
      </div>
      {/* demo-only extra (not in DESIGN §10.2): real mode only holds part of the registry in memory,
          so these totals would not be global */}
      {seeded && DEMO ? (
        <p className="lp-sub">
          {stats.shops} {stats.shops === 1 ? 'shop' : 'shops'} · {usdCompact(stats.volume)} volume 24h · <b>{usdCompact(stats.fees)}</b> waiting for owners
        </p>
      ) : null}
      <div className="lp-tabs" role="group" aria-label="Filter the live feed">
        {FILTERS.map((x) => (
          <button key={x.key} type="button" className={['hit', filter === x.key ? 'on' : ''].filter(Boolean).join(' ')} aria-pressed={filter === x.key} onClick={() => setFilter(x.key)}>
            {x.label}
          </button>
        ))}
      </div>

      {!seeded ? (
        <div aria-busy="true">
          <SkRows n={6} />
        </div>
      ) : (
        <ul className="feed" aria-label="Live activity">
          {newCount > 0 ? (
            <li className="frow-li">
              <button type="button" className="frow feed-more" onClick={() => setHeld(null)}>
                <Icon name="arrow_upward" />
                {newCount} new {newCount === 1 ? 'event' : 'events'} · Show
              </button>
            </li>
          ) : null}
          {rows.map((ev) => (
            <FeedRow key={ev.id} ev={ev} now={now} fresh={isFresh(ev.id)} you={you} />
          ))}
        </ul>
      )}

      {seeded && rows.length === 0 ? (
        filter === 'all' ? (
          <EmptyState icon="bolt" title="Quiet right now" body="Launches, trades and claims show up here live." />
        ) : (
          <EmptyState icon="bolt" title="Nothing here yet" body={`No recent ${f.none}.`}>
            <Button variant="tonal" onClick={() => setFilter('all')}>
              Show all
            </Button>
          </EmptyState>
        )
      ) : null}

      {seeded ? (
        <>
          <div className="sec-title lp-top">
            <h2 className="sec-title-h">Top shops</h2>
            <Seg options={SORT_OPTIONS} value={sort} onChange={(v) => setTopShops({ sort: v })} ariaLabel="Rank top shops by" />
          </div>
          <ul className="feed" aria-label="Top shops">
            {top.map((c, i) => (
              <TopRow key={c.placeId} coin={c} rank={i + 1} sort={sort} solUsd={solUsd} />
            ))}
          </ul>
          <div className="see-all">
            <Button variant="text" trailingIcon="chevron_right" onClick={() => setPanel('top')}>
              See all top shops
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
