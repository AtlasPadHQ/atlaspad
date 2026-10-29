/**
 * My coins panel (DESIGN §10.5) for the connected wallet (balances are simulated):
 *  - disconnected → empty state with `Connect wallet` (opens the wallet modal);
 *  - connected → header `My coins` + `2.41 SOL · $361`, then (empty sections omitted):
 *    `Your shops` (claimed by this wallet; desktop `Payout settings` → Claim modal at Payout),
 *    `Holding` (USD value + 24h change), `Launched by you` (mcap), `Watching` (watched places,
 *    place IDs only — no Google content is stored or shown);
 *  - nothing at all → `No coins yet` + `Find a shop` (close the panel, focus the map) and
 *    `Launch a coin` (focus search with the link tip).
 * OWNED BY RAIL+FEED. Rendered by PanelHost inside PanelShell when store.panel === 'mine'.
 */
import { getDemoPlace } from '../lib/demoBridge';
import { isMobileNow } from '../lib/media';
import { pct, solNumber, timeAgo, tokenAmount, usdCompact, usdFull } from '../lib/format';
import { sourceFromId } from '../lib/place';
import { getPlaceDetails } from '../places';
import { useWalletPolling } from '../realdata/hooks';
import { coinCategoryLabel, isOwner, useShallow, useStore } from '../store';
import type { Coin } from '../types';
import { Button, EmptyState, Icon } from '../ui';
import { Avatar, ListRow, Tick } from './rows';
import { openCoin, ownerFeesUsd } from './util';

const NOT_FOUND = "That coin or place wasn't found.";

/** Open a watched place that has no coin yet (place ID only: resolve it again). */
async function openWatched(placeId: string): Promise<void> {
  const st = useStore.getState();
  if (st.coins[placeId]) {
    openCoin(placeId);
    return;
  }
  const source = sourceFromId(placeId);
  if (source === 'demo') {
    const p = getDemoPlace(placeId, st.coins);
    if (p) st.openPlace(p, { fly: true });
    else st.toast(NOT_FOUND, 'error');
    return;
  }
  if (source !== 'google') {
    st.toast(NOT_FOUND, 'error');
    return;
  }
  st.setPlaceLoading(null, { launchable: !st.coins[placeId] });
  try {
    const place = await getPlaceDetails(placeId, 'google');
    const cur = useStore.getState();
    // the user may have navigated elsewhere meanwhile
    if (cur.panel !== 'place' || cur.selected.status !== 'loading') return;
    if (place) cur.openPlace(place, { fly: true });
    else {
      if (!cur.back()) cur.closePanel();
      cur.toast(NOT_FOUND, 'error');
    }
  } catch {
    const cur = useStore.getState();
    if (cur.panel === 'place' && cur.selected.status === 'loading' && !cur.back()) cur.closePanel();
    cur.toast(NOT_FOUND, 'error');
  }
}

function CoinLine({ coin }: { coin: Coin }) {
  return (
    <>
      <Tick ticker={coin.ticker} /> · {coin.name}
    </>
  );
}

export default function MyCoinsPanel() {
  const address = useStore((s) => s.wallet.address);
  // real mode: re-read balance + holdings every 30 s while this panel is open (§5.2)
  useWalletPolling();
  const solBalance = useStore((s) => s.solBalance);
  const solUsd = useStore((s) => s.solUsd);
  const openModal = useStore((s) => s.openModal);

  const shops = useStore(useShallow((s) => (s.wallet.address ? Object.values(s.coins).filter((c) => isOwner(c, s.wallet.address)) : [])));
  const holdings = useStore(
    useShallow((s) =>
      Object.entries(s.holdings)
        .filter(([id, amt]) => amt > 0 && !!s.coins[id])
        .map(([id]) => s.coins[id] as Coin),
    ),
  );
  const amounts = useStore((s) => s.holdings);
  const launched = useStore(
    useShallow((s) =>
      Object.values(s.coins)
        .filter((c) => !!s.wallet.address && c.launcher === s.wallet.address)
        .sort((a, b) => b.launchedAt - a.launchedAt),
    ),
  );
  const watch = useStore((s) => s.watch);
  const watchedCoins = useStore(useShallow((s) => s.watch.map((id) => s.coins[id] ?? null)));

  if (!address) {
    return (
      <div className="mine-panel">
        <div className="lp-h feed-h" data-sheet-drag>
          <h1>My coins</h1>
        </div>
        <EmptyState
          icon="account_balance_wallet"
          title="Connect a wallet to see your coins"
          body="Your holdings, coins you launched and shops you own show up here."
        >
          <Button variant="primary" icon="account_balance_wallet" onClick={() => openModal({ kind: 'wallet' })}>
            Connect wallet
          </Button>
        </EmptyState>
      </div>
    );
  }

  const holdingsSorted = [...holdings].sort((a, b) => (amounts[b.placeId] ?? 0) * b.priceUsd - (amounts[a.placeId] ?? 0) * a.priceUsd);
  const empty = shops.length === 0 && holdingsSorted.length === 0 && launched.length === 0 && watch.length === 0;
  const now = Date.now();

  return (
    <div className="mine-panel">
      <div className="lp-h feed-h" data-sheet-drag>
        <div className="feed-h-title">
          <h1>My coins</h1>
          <span className="lp-cap num">
            {solNumber(solBalance)} SOL · {usdFull(solBalance * solUsd)}
          </span>
        </div>
      </div>

      {empty ? (
        <EmptyState icon="account_balance_wallet" title="No coins yet" body="Buy a shop's coin or launch one.">
          <Button
            variant="outline"
            icon="storefront"
            onClick={() => {
              useStore.getState().closePanel();
              document.getElementById('map')?.focus({ preventScroll: true });
            }}
          >
            Find a shop
          </Button>
          <Button
            variant="primary"
            icon="rocket_launch"
            onClick={() => {
              const st = useStore.getState();
              // on mobile the sheet would cover the full-screen search dropdown
              if (isMobileNow()) st.closePanel();
              st.focusSearch({ tip: true });
            }}
          >
            Launch a coin
          </Button>
        </EmptyState>
      ) : null}

      {shops.length > 0 ? (
        <section aria-labelledby="mine-shops">
          <h2 className="sec-h" id="mine-shops">
            Your shops
          </h2>
          <ul className="feed">
            {shops.map((c) => (
              <ListRow
                key={c.placeId}
                onClick={() => openCoin(c.placeId)}
                avatar={<Avatar emoji={c.logo.emoji} bg={c.logo.bg} badge={{ icon: 'verified', color: 'var(--cs-green)' }} />}
                t1={<CoinLine coin={c} />}
                t2={`${coinCategoryLabel(c)} · verified owner`}
                rt={<span className="amb">{usdFull(ownerFeesUsd(c))}</span>}
                rtSmall="available"
                trailing={
                  <Button variant="tonal" className="mc-payout d-only" onClick={() => openModal({ kind: 'claim', placeId: c.placeId, step: 'payout' })}>
                    Payout settings
                  </Button>
                }
              />
            ))}
          </ul>
        </section>
      ) : null}

      {holdingsSorted.length > 0 ? (
        <section aria-labelledby="mine-holding">
          <h2 className="sec-h" id="mine-holding">
            Holding
          </h2>
          <ul className="feed">
            {holdingsSorted.map((c) => {
              const amt = amounts[c.placeId] ?? 0;
              return (
                <ListRow
                  key={c.placeId}
                  onClick={() => openCoin(c.placeId)}
                  avatar={<Avatar emoji={c.logo.emoji} bg={c.logo.bg} />}
                  t1={<CoinLine coin={c} />}
                  t2={
                    <>
                      {coinCategoryLabel(c)} · {tokenAmount(amt)}{' '}
                      <span translate="no">${c.ticker}</span>
                    </>
                  }
                  rt={usdFull(amt * c.priceUsd)}
                  rtSmall={pct(c.change24h)}
                  rtSmallClass={c.change24h < 0 ? 'down' : 'up'}
                />
              );
            })}
          </ul>
        </section>
      ) : null}

      {launched.length > 0 ? (
        <section aria-labelledby="mine-launched">
          <h2 className="sec-h" id="mine-launched">
            Launched by you
          </h2>
          <ul className="feed">
            {launched.map((c) => (
              <ListRow
                key={c.placeId}
                onClick={() => openCoin(c.placeId)}
                avatar={<Avatar emoji={c.logo.emoji} bg={c.logo.bg} badge={{ icon: 'rocket_launch', color: 'var(--cs-green)' }} />}
                t1={<CoinLine coin={c} />}
                t2={`${coinCategoryLabel(c)} · launched ${timeAgo(c.launchedAt, now)} ago`}
                rt={usdCompact(c.marketCapUsd)}
                rtSmall="mcap"
              />
            ))}
          </ul>
        </section>
      ) : null}

      {watch.length > 0 ? (
        <section aria-labelledby="mine-watching">
          <h2 className="sec-h" id="mine-watching">
            Watching
          </h2>
          <ul className="feed">
            {watch.map((id, i) => {
              const coin = watchedCoins[i];
              if (coin) {
                return (
                  <ListRow
                    key={id}
                    onClick={() => openCoin(coin.placeId)}
                    avatar={<Avatar emoji={coin.logo.emoji} bg={coin.logo.bg} badge={{ icon: 'rocket_launch', color: 'var(--cs-green)' }} />}
                    t1={<CoinLine coin={coin} />}
                    t2={`${coinCategoryLabel(coin)} · launched ${timeAgo(coin.launchedAt, now)} ago`}
                    rt={usdCompact(coin.marketCapUsd)}
                    rtSmall="mcap"
                  />
                );
              }
              const demo = sourceFromId(id) === 'demo' ? getDemoPlace(id) : null;
              return (
                <ListRow
                  key={id}
                  onClick={() => void openWatched(id)}
                  avatar={
                    <span className="mc-watch-ic" aria-hidden="true">
                      <Icon name="notifications_active" />
                    </span>
                  }
                  t1={demo ? demo.name : 'Watched shop'}
                  t2="No coin yet"
                  rt={<Icon name="chevron_right" size={20} />}
                />
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
