/**
 * "This area" card (DESIGN §6.5), desktop/tablet only, while no panel, hero or rail panel is
 * showing. Counts coins inside the current map bounds (recomputed on map idle, 300ms debounce)
 * — only those matching the active chip filter — and the fees waiting for their owners.
 *
 *   coins in view, fees > 0 → `7 shops have coins` / `$1.2k waiting for owners` + chevron
 *   coins in view, fees = 0 → t2 `No fees waiting yet`
 *   no coins in view        → green rocket icon, `No coins here yet` / `Tap any shop on the map to launch one`
 *   zoomed out (< 11)       → `Zoom in to see shops`, not clickable
 *   live indicator          → `<n> trading now` (5 min window) · `quiet right now` · `reconnecting…`
 * Row click → Top shops with scope `This area`. Before the map reports bounds: header-only
 * skeleton for at most 600ms. OWNED BY RAIL+FEED.
 */
import { useIsMobile } from '../lib/media';
import { coinsInBounds, feesTotalLabel, feesWaitingTotal, filterCoins, useShallow, useStore } from '../store';
import { Icon, Sk } from '../ui';
import { useAreaBounds } from './useAreaBounds';
import { useLiveHealth } from './railState';
import './rail.css';

const TRADING_WINDOW_MS = 5 * 60_000;

export default function ThisAreaCard() {
  const mobile = useIsMobile();
  const hidden = useStore((s) => s.panel !== 'none' || !s.heroDismissed);
  if (mobile || hidden) return null;
  return <AreaCard />;
}

function AreaCard() {
  const area = useAreaBounds();
  const health = useLiveHealth();
  const setTopShops = useStore((s) => s.setTopShops);
  const setPanel = useStore((s) => s.setPanel);

  const stats = useStore(
    useShallow((s) => {
      if (!area.ready) return { count: 0, fees: null as string | null, trading: 0 };
      const list = filterCoins(coinsInBounds(s.coins, area.bounds), s.category);
      const t = Date.now();
      let trading = 0;
      for (const c of list) if (c.lastTradeAt && t - c.lastTradeAt <= TRADING_WINDOW_MS) trading++;
      // exact lamports, rounded DOWN (INTEGRATION.md §9); compare on the shown string so fee ticks don't re-render
      return { count: list.length, fees: feesTotalLabel(feesWaitingTotal(list, s.solUsd, s.solUsdAt, t)), trading };
    }),
  );

  if (!area.ready) {
    return (
      <section className="area" aria-label="This area" aria-busy="true">
        <div className="area-h">
          <h2>This area</h2>
        </div>
        <div className="area-sk">
          <Sk w="100%" h={16} />
        </div>
      </section>
    );
  }

  const openArea = () => {
    setTopShops({ scope: 'area' });
    setPanel('top');
  };

  let live: { text: string; idle: boolean } | null = null;
  if (!area.zoomedOut && stats.count > 0) {
    if (health === 'stalled') live = { text: 'reconnecting…', idle: true };
    else if (health === 'paused' || stats.trading === 0) live = { text: 'quiet right now', idle: true };
    else live = { text: `${stats.trading} trading now`, idle: false };
  }

  return (
    <section className="area" aria-label="This area">
      <div className="area-h">
        <h2>This area</h2>
        {live ? (
          <span className={['area-live', live.idle ? 'idle' : ''].filter(Boolean).join(' ')}>
            <i aria-hidden="true" />
            {live.text}
          </span>
        ) : null}
      </div>
      {area.zoomedOut ? (
        <div className="area-row">
          <span className="area-ic green" aria-hidden="true">
            <Icon name="public" />
          </span>
          <span className="tx">
            <span className="t1">Zoom in to see shops</span>
          </span>
        </div>
      ) : stats.count === 0 ? (
        <button type="button" className="area-row" onClick={openArea}>
          <span className="area-ic green" aria-hidden="true">
            <Icon name="rocket_launch" fill />
          </span>
          <span className="tx">
            <span className="t1">No coins here yet</span>
            <span className="t2">Tap any shop on the map to launch one</span>
          </span>
          <Icon name="chevron_right" />
        </button>
      ) : (
        <button type="button" className="area-row" onClick={openArea}>
          <span className="area-ic" aria-hidden="true">
            <Icon name="payments" fill />
          </span>
          <span className="tx">
            <span className="t1">
              {stats.count} {stats.count === 1 ? 'shop has a coin' : 'shops have coins'}
            </span>
            <span className="t2">
              {stats.fees ? (
                <>
                  <b>{stats.fees}</b> waiting for owners
                </>
              ) : (
                'No fees waiting yet'
              )}
            </span>
          </span>
          <Icon name="chevron_right" />
        </button>
      )}
    </section>
  );
}
