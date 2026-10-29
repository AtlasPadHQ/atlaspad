/**
 * Search results list (store.panel === 'results'). OWNED BY SEARCH. Rendered by PanelHost inside
 * PanelShell (desktop side panel / mobile sheet). Uses the shared list CSS (DESIGN §10.1).
 *
 * Rows: places that already have a coin show OUR data (sticker, $TICKER · coin name, mcap, change);
 * other places show their name / type / address (Google content, display only, on the Google map
 * with the "Google Maps" credit) or OSM data on the fallback map, plus a distance and a `Launch`
 * button for launchable places. Row → fly + open the place (back chip "Results"); `Launch` → also
 * opens the launch modal. States: loading skeleton · error + Try again · empty + paste-a-link.
 * Contract: default export, no props.
 */
import { useLayoutEffect, useRef } from 'react';
import { distanceM } from '../lib/geo';
import { usdCompact } from '../lib/format';
import { isLaunchableSource, knownIneligibility, placeFromCoin } from '../lib/place';
import { distanceLabel, placeTypeLabel } from '../places';
import { coinCategoryLabel, useShallow, useStore } from '../store';
import type { Coin, LatLng, Place } from '../types';
import { Button, Change, EmptyState, Icon, IconButton, SkRows, Sticker } from '../ui';
import { closeResults, retryResults } from './actions';
import { useSearchUi } from './searchState';
import './search.css';

function ResultRow({ place, coin, from }: { place: Place; coin?: Coin; from: LatLng | null }) {
  const dist = from ? distanceLabel(distanceM(from, place.location)) : '';
  const launchable = !coin && isLaunchableSource(place.source) && !knownIneligibility(place);
  const open = (launch: boolean) => {
    const st = useStore.getState();
    if (coin) st.openPlace(placeFromCoin(coin), { fly: true });
    else st.openPlace(place, { fly: true, launch });
  };

  if (coin) {
    return (
      <li className="rl-item">
        <button type="button" className="frow" onClick={() => open(false)}>
          <Sticker logo={coin.logo} size={40} alt={`${coin.name} coin art`} />
          <span className="tx">
            <span className="t1">
              <b translate="no">${coin.ticker}</b> · {coin.name}
            </span>
            <span className="t2">
              {coinCategoryLabel(coin)}
              {dist ? ` · ${dist}` : ''}
            </span>
          </span>
          <span className="rt">
            {usdCompact(coin.marketCapUsd)}
            <small>
              <Change value={coin.change24h} />
            </small>
          </span>
        </button>
      </li>
    );
  }

  const type = placeTypeLabel(place);
  const sub = [type, place.address].filter(Boolean).join(' · ');
  return (
    <li className={`rl-item${launchable ? ' has-cta' : ''}`}>
      <button type="button" className="frow" onClick={() => open(false)}>
        <span className="av rl-pin" aria-hidden="true">
          <Icon name="location_on" size={22} />
        </span>
        <span className="tx">
          <span className="t1">
            <b>{place.name || 'Unnamed place'}</b>
          </span>
          {sub ? <span className="t2">{sub}</span> : null}
        </span>
        {dist ? <span className="rt rt-dist">{dist}</span> : null}
      </button>
      {launchable ? (
        <Button variant="tonal" icon="rocket_launch" iconFill className="rl-cta" onClick={() => open(true)} aria-label={`Launch a coin for ${place.name || 'this shop'}`}>
          Launch
        </Button>
      ) : null}
    </li>
  );
}

export default function ResultsList() {
  const status = useStore((s) => s.resultsStatus);
  const query = useStore((s) => s.resultsQuery);
  const results = useStore((s) => s.results);
  const provider = useStore((s) => s.provider);
  const coins = useStore(useShallow((s) => results.map((p) => s.coins[p.id])));
  const origin = useSearchUi((s) => s.origin);
  const from: LatLng | null = origin?.kind === 'chip' ? origin.center : (origin?.near?.center ?? null);

  const title = origin?.kind === 'chip' ? origin.label : query || 'Results';
  const n = results.length;
  const caption =
    status === 'loading'
      ? 'Searching…'
      : status === 'error'
        ? ''
        : origin?.kind === 'chip'
          ? `${n} ${n === 1 ? 'place' : 'places'} near the map centre`
          : `${n} ${n === 1 ? 'result' : 'results'}`;
  const googleContent = provider === 'google' && results.some((p) => p.source === 'google');

  // PanelHost keys the results panel scroll on the mode only, so a new search starts at the top here
  // (going Back from a place doesn't start a run, so the saved position is kept).
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (status !== 'loading') return;
    const scroller = rootRef.current?.closest('.panel-scroll');
    if (scroller) scroller.scrollTop = 0;
  }, [status, query]);

  return (
    <div className="rl" ref={rootRef} aria-busy={status === 'loading' || undefined}>
      <div className="lp-h rl-h" data-sheet-drag>
        <div className="rl-titles">
          <h1>{title}</h1>
          {caption ? <p className="rl-cap">{caption}</p> : null}
        </div>
        <IconButton icon="close" label="Close results" className="rl-close" onClick={() => closeResults()} />
      </div>

      {status === 'loading' ? (
        <SkRows n={6} />
      ) : status === 'error' ? (
        <EmptyState icon="wifi_off" title="Search is unavailable right now" body="Check your connection, then try again.">
          <Button variant="outline" icon="refresh" onClick={retryResults}>
            Try again
          </Button>
        </EmptyState>
      ) : n === 0 ? (
        <EmptyState
          icon="search_off"
          title={origin?.kind === 'chip' ? `No ${origin.label.toLowerCase()} near here` : `No shops match "${query}"`}
          body={origin?.kind === 'chip' ? 'Move the map and try again, or paste a Google Maps link.' : 'Paste a Google Maps link instead'}
        >
          <Button
            variant="outline"
            icon="link"
            onClick={() => {
              closeResults();
              useStore.getState().focusSearch({ text: '', tip: true });
            }}
          >
            Paste a link
          </Button>
        </EmptyState>
      ) : (
        <>
          <ul className="rl-list">
            {results.map((p, i) => (
              <ResultRow key={p.id} place={p} coin={coins[i]} from={from} />
            ))}
          </ul>
          {googleContent ? (
            <p className="rl-credit" translate="no">
              Google Maps
            </p>
          ) : provider === 'demo' ? (
            <p className="rl-credit">© OpenStreetMap contributors</p>
          ) : null}
        </>
      )}
    </div>
  );
}
