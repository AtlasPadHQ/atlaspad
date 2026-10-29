/**
 * Launched panel (DESIGN §10.4): header `Launched` + caption `Newest first`, then every coin,
 * newest first (no scope chips: §10.4 / §18.3 define none for this panel).
 * Rows: sticker (+ `rocket_launch` badge for launches in the last hour) · `$TICKER · coin name`
 * · `<category> · launched by 7xKX…3pQa` (`by you` for your own) · mcap / age.
 * Opening the panel marks launches as seen (store.setPanel → markLaunchedSeen, clears the rail
 * badge); launches that arrive while it is open are marked seen too.
 * OWNED BY RAIL+FEED. Rendered by PanelHost inside PanelShell when store.panel === 'launched'.
 */
import { useEffect } from 'react';
import { shortAddr, timeAgoLong, usdCompact } from '../lib/format';
import { coinCategoryLabel, newestCoins, useShallow, useStore } from '../store';
import type { Coin } from '../types';
import { EmptyState, SkRows } from '../ui';
import { Avatar, ListRow, Tick } from './rows';
import { useTicker } from './useTicker';
import { openCoin, useFreshness } from './util';

const HOUR = 3_600_000;

function LaunchedRow({ coin, now, you, fresh }: { coin: Coin; now: number; you: string | null; fresh: boolean }) {
  // `by you` only for the connected wallet's launches (not every coin launched in this browser)
  const mine = !!you && coin.launcher === you;
  return (
    <ListRow
      fresh={fresh}
      onClick={() => openCoin(coin.placeId)}
      avatar={<Avatar emoji={coin.logo.emoji} bg={coin.logo.bg} badge={now - coin.launchedAt < HOUR ? { icon: 'rocket_launch', color: 'var(--cs-green)' } : null} />}
      t1={
        <>
          <Tick ticker={coin.ticker} /> · {coin.name}
        </>
      }
      t2={
        <>
          {coinCategoryLabel(coin)} · launched by{' '}
          {mine ? (
            'you'
          ) : (
            <span className="mono" translate="no">
              {shortAddr(coin.launcher)}
            </span>
          )}
        </>
      }
      rt={usdCompact(coin.marketCapUsd)}
      rtSmall={timeAgoLong(coin.launchedAt, now)}
    />
  );
}

export default function LaunchedPanel() {
  useTicker(1000);
  const seeded = useStore((s) => s.dataReady || Object.keys(s.coins).length > 0);
  const you = useStore((s) => s.wallet.address);
  const list = useStore(useShallow((s) => newestCoins(s.coins)));
  const isFresh = useFreshness(list.map((c) => c.placeId));

  // keep the rail badge clear while this panel is showing new launches
  const newest = useStore((s) => {
    let m = 0;
    for (const c of Object.values(s.coins)) if (c.launchedAt > m) m = c.launchedAt;
    return m;
  });
  const seenAt = useStore((s) => s.launchedSeenAt);
  useEffect(() => {
    if (newest > seenAt) useStore.getState().markLaunchedSeen();
  }, [newest, seenAt]);

  const now = Date.now();
  return (
    <div className="launched-panel">
      <div className="lp-h feed-h" data-sheet-drag>
        <div className="feed-h-title">
          <h1>Launched</h1>
          <span className="lp-cap">Newest first</span>
        </div>
      </div>
      {!seeded ? (
        <div aria-busy="true">
          <SkRows n={6} />
        </div>
      ) : list.length === 0 ? (
        <EmptyState icon="rocket_launch" title="No launches yet" body="Be the first — tap any shop on the map." />
      ) : (
        <ul className="feed" aria-label="Launched coins, newest first">
          {list.map((c) => (
            <LaunchedRow key={c.placeId} coin={c} now={now} you={you} fresh={isFresh(c.placeId)} />
          ))}
        </ul>
      )}
    </div>
  );
}
