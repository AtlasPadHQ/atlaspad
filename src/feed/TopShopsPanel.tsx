/**
 * Top shops panel (DESIGN §10.3): leaderboard (top 50) sorted by `Market cap` (default) or
 * `Fees earned`, scoped `Everywhere` or `This area` (coins inside the current map bounds — the
 * "This area" card opens it with that scope). Rows: rank · sticker · `$TICKER` (+ verified tick)
 * · coin name · category · fees / mcap · change. Click → fly to the coin + open it (back chip).
 * Ticker + launcher-typed coin name only; never Google data.
 * OWNED BY RAIL+FEED. Rendered by PanelHost inside PanelShell when store.panel === 'top'.
 */
import { useAreaBounds } from '../rail/useAreaBounds';
import { coinsInBounds, topByFees, topByMc, useShallow, useStore } from '../store';
import { Button, EmptyState, Seg, SkRows } from '../ui';
import { ScopeTabs, TopRow } from './rows';
import { SORT_OPTIONS, useFreshness } from './util';

const LIMIT = 50;

export default function TopShopsPanel() {
  const { sort, scope } = useStore((s) => s.topShops);
  const setTopShops = useStore((s) => s.setTopShops);
  const solUsd = useStore((s) => s.solUsd);
  const seeded = useStore((s) => s.dataReady || Object.keys(s.coins).length > 0);
  const area = useAreaBounds();
  const areaPending = scope === 'area' && !area.ready;

  const list = useStore(
    useShallow((s) => {
      if (scope === 'area' && !area.ready) return [];
      const pool = scope === 'area' ? coinsInBounds(s.coins, area.bounds) : s.coins;
      return sort === 'mcap' ? topByMc(pool, LIMIT) : topByFees(pool, LIMIT);
    }),
  );
  const isFresh = useFreshness(list.map((c) => c.placeId));

  return (
    <div className="top-panel">
      <div className="lp-h feed-h" data-sheet-drag>
        <h1>Top shops</h1>
        <Seg options={SORT_OPTIONS} value={sort} onChange={(v) => setTopShops({ sort: v })} ariaLabel="Rank top shops by" />
      </div>
      <ScopeTabs value={scope} onChange={(v) => setTopShops({ scope: v })} label="Where" />

      {!seeded || areaPending ? (
        <div aria-busy="true">
          <SkRows n={6} />
        </div>
      ) : list.length === 0 ? (
        scope === 'area' ? (
          <EmptyState icon="leaderboard" title="No coins in this area" body="Zoom out or move the map, or launch the first one here.">
            <Button variant="tonal" onClick={() => setTopShops({ scope: 'everywhere' })}>
              Show everywhere
            </Button>
          </EmptyState>
        ) : (
          <EmptyState icon="leaderboard" title="No coins yet" body="Be the first — tap any shop on the map." />
        )
      ) : (
        <ul className="feed" aria-label={sort === 'mcap' ? 'Top shops by market cap' : 'Top shops by fees earned'}>
          {list.map((c, i) => (
            <TopRow key={c.placeId} coin={c} rank={i + 1} sort={sort} solUsd={solUsd} fresh={isFresh(c.placeId)} />
          ))}
        </ul>
      )}
    </div>
  );
}
