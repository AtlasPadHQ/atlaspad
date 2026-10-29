/**
 * Place panel content (DESIGN §8, §9), rendered inside PanelShell by PanelHost when
 * store.panel === 'place'. Contract: default export, no props.
 *
 * Variants: Launched (place has a coin) · Launchable (real Google POI / demo shop, no coin) ·
 * fallback (OSM / unresolved link: not launchable) · loading skeleton · error.
 * Block order per DESIGN §8.5 (desktop vs mobile). The Google UI Kit block lives in the Overview
 * tab panel, which stays mounted (hidden) while other tabs show, so it is requested once.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { usePreClaim } from '../claim/preclaims';
import { useDraftTicker } from '../launch/drafts';
import { useIsMobile } from '../lib/media';
import { useStore } from '../store';
import type { Coin, Place, PlaceTab, TradeSide } from '../types';
import { tabId, tabPanelId, Tabs, type TabDef } from '../ui';
import { LaunchableActions, LaunchedActions } from './Actions';
import { CoinSummary } from './CoinSummary';
import { FeesCard, MobileStrip } from './Fees';
import { GooglePlaceBlock } from './GoogleBlock';
import { CoinHero, LaunchableHeader, LaunchedHeader, LaunchHero } from './Header';
import { DemoPlaceBlock, OsmPlaceBlock, PlaceUnavailableBlock } from './PlaceBlocks';
import { AboutCoin, PanelError, PanelFoot, PanelSkeleton, Steps } from './Sections';
import { TradeBox, type TradeIntent } from './TradeBox';
import { CoinLinks, RecentTrades, TopHolders } from './Trades';
import { isDevTestPlaceId } from '../lib/place';
import { NOT_LAUNCHABLE, NOT_LAUNCHABLE_CLOSED, ownerState, panelScroller, useLaunchBlockReason } from './util';
import './panel.css';

const ID = 'place';

/* ------------------------------------------------------------------ shared bits */

/** Google's element (real places on the Google map), demo lookalike, or the OSM block. */
function PlaceInfoBlock({ place, coin }: { place: Place; coin?: Coin }) {
  const provider = useStore((s) => s.provider);
  const source = coin?.place.source ?? place.source;
  if (source === 'demo') {
    const demo = place.demo ?? coin?.place.demo;
    return demo ? <DemoPlaceBlock name={coin?.name ?? place.name} category={coin?.place.category ?? place.category} demo={demo} /> : null;
  }
  if (source === 'google') {
    if (isDevTestPlaceId(place.id)) return <p className="pp-devtest">Devnet test place — it has no Google listing.</p>;
    return provider === 'google' ? <GooglePlaceBlock key={place.id} placeId={place.id} /> : <PlaceUnavailableBlock place={place} />;
  }
  if (source === 'osm') return <OsmPlaceBlock place={place} />;
  return null;
}

/**
 * How far the tabs bar has been pushed down by `position: sticky` (0 = not stuck). The sentinel is
 * a 0-height element right above the bar, so it marks where the bar's margin box would start
 * without sticking (the bar's own margin-top is not "pushed").
 */
function stuckOffset(sentinel: HTMLElement | null): number {
  const bar = sentinel?.nextElementSibling;
  if (!sentinel || !(bar instanceof HTMLElement)) return 0;
  const marginTop = parseFloat(getComputedStyle(bar).marginTop) || 0;
  return Math.max(0, bar.getBoundingClientRect().top - sentinel.getBoundingClientRect().top - marginTop);
}

/**
 * Tab switching (DESIGN §8.8): scroll so the tabs bar is at the top only if it was already
 * stuck; otherwise keep the scroll position.
 */
function useTabSwitch(sentinel: RefObject<HTMLDivElement | null>) {
  const tab = useStore((s) => s.placeTab);
  const setPlaceTab = useStore((s) => s.setPlaceTab);
  const pending = useRef<number | null>(null);

  const change = useCallback(
    (t: PlaceTab) => {
      const el = sentinel.current;
      const sc = panelScroller(el);
      pending.current = null;
      const pushed = stuckOffset(el);
      // keep the bar exactly where it is stuck (below the search pill / the sheet's header)
      if (sc && pushed > 1) pending.current = Math.max(0, sc.scrollTop - pushed);
      setPlaceTab(t);
    },
    [sentinel, setPlaceTab],
  );

  useLayoutEffect(() => {
    const top = pending.current;
    pending.current = null;
    if (top == null) return;
    const sc = panelScroller(sentinel.current);
    if (sc) sc.scrollTop = top;
  }, [tab, sentinel]);

  // `stuck` = the tabs bar is pinned under the panel's header zone (it then gets a white band
  // above it, so content never shows through behind the search pill / sheet handle)
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = sentinel.current;
    const sc = panelScroller(el);
    if (!el || !sc) return;
    const check = () => setStuck(stuckOffset(el) > 1);
    check();
    sc.addEventListener('scroll', check, { passive: true });
    return () => sc.removeEventListener('scroll', check);
  }, [sentinel]);

  return { tab, change, stuck };
}

function TabPanel({ k, hidden, children }: { k: PlaceTab; hidden?: boolean; children: ReactNode }) {
  return (
    <div role="tabpanel" id={tabPanelId(ID, k)} aria-labelledby={tabId(ID, k)} hidden={hidden} className="pp-tab">
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ launched */

const LAUNCHED_TABS: readonly TabDef<PlaceTab>[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'coin', label: 'Coin' },
  { key: 'about', label: 'About' },
];

function LaunchedView({ place, coin, mobile }: { place: Place; coin: Coin; mobile: boolean }) {
  const wallet = useStore((s) => s.wallet.address);
  const setSheetSnap = useStore((s) => s.setSheetSnap);
  const owner = ownerState(coin, wallet);
  const sentinel = useRef<HTMLDivElement>(null);
  const { tab, change, stuck } = useTabSwitch(sentinel);
  const [intent, setIntent] = useState<TradeIntent | null>(null);
  const nonce = useRef(0);

  const onTrade = (side: TradeSide) => {
    useStore.getState().setPanelCollapsed(false);
    change('coin');
    nonce.current += 1;
    setIntent({ side, nonce: nonce.current });
    if (mobile) setSheetSnap('full');
  };

  const actions = <LaunchedActions place={place} coin={coin} owner={owner} mobile={mobile} onTrade={onTrade} />;

  return (
    <div className="pp pp-launched">
      {mobile ? null : <CoinHero coin={coin} />}
      <LaunchedHeader coin={coin} state={owner} mobile={mobile} />
      {mobile ? actions : null}
      {mobile ? <MobileStrip coin={coin} owner={owner} onChart={() => change('coin')} /> : null}
      <div ref={sentinel} className="tabs-sentinel" aria-hidden="true" />
      <Tabs tabs={LAUNCHED_TABS} value={tab} onChange={change} idBase={ID} ariaLabel="Place sections" className={stuck ? 'is-stuck' : undefined} />

      <TabPanel k="overview" hidden={tab !== 'overview'}>
        {mobile ? null : actions}
        {mobile ? null : <FeesCard coin={coin} owner={owner} />}
        {mobile ? null : <CoinSummary coin={coin} />}
        <PlaceInfoBlock place={place} coin={coin} />
        <RecentTrades coin={coin} initial={5} />
        <CoinLinks coin={coin} />
        <PanelFoot placeId={coin.placeId} launched />
      </TabPanel>

      {tab === 'coin' ? (
        <TabPanel k="coin">
          <CoinSummary coin={coin} sparkHeight={mobile ? 120 : 84} className="coin-full" />
          <TradeBox coin={coin} intent={intent} onIntentDone={() => setIntent(null)} />
          <RecentTrades coin={coin} initial={20} pageable />
          {/* real mode has no top-holder source yet (holders count only, hourly) */}
          {coin.real ? null : <TopHolders coin={coin} />}
          <CoinLinks coin={coin} />
        </TabPanel>
      ) : null}

      {tab === 'about' ? (
        <TabPanel k="about">
          <AboutCoin coin={coin} owner={owner} />
          <PanelFoot placeId={coin.placeId} launched />
        </TabPanel>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ launchable */

function LaunchableView({ place, mobile }: { place: Place; mobile: boolean }) {
  const wallet = useStore((s) => s.wallet.address);
  const blocked = useLaunchBlockReason(place);
  const draftTicker = useDraftTicker(place.id);
  const pre = usePreClaim(place.id);
  const preclaimed = !!pre && !!wallet && pre.owner === wallet;
  const sentinel = useRef<HTMLDivElement>(null);
  const { tab: rawTab, change, stuck } = useTabSwitch(sentinel);
  const tab: PlaceTab = rawTab === 'coin' ? 'overview' : rawTab;

  const tabs: readonly TabDef<PlaceTab>[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'coin', label: 'Coin', disabled: true, disabledTip: 'No coin yet' },
    { key: 'about', label: 'About' },
  ];
  const notLaunchable = blocked === NOT_LAUNCHABLE || blocked === NOT_LAUNCHABLE_CLOSED;
  const actions = (
    <LaunchableActions place={place} mobile={mobile} launchBlocked={blocked} preclaimed={preclaimed} notBusiness={notLaunchable ? blocked : null} />
  );

  return (
    <div className="pp pp-launchable">
      {mobile ? null : <LaunchHero blocked={notLaunchable} />}
      <LaunchableHeader
        mobile={mobile}
        draftTicker={notLaunchable ? null : draftTicker}
        preclaimedBy={preclaimed ? pre.payoutWallet : null}
        notLaunchable={notLaunchable ? blocked : null}
      />
      {mobile ? actions : null}
      <div ref={sentinel} className="tabs-sentinel" aria-hidden="true" />
      <Tabs tabs={tabs} value={tab} onChange={change} idBase={ID} ariaLabel="Place sections" className={stuck ? 'is-stuck' : undefined} />

      <TabPanel k="overview" hidden={tab !== 'overview'}>
        {mobile ? null : actions}
        {/* the launch steps only where a launch is possible (non-businesses: INTEGRATION.md §7.4) */}
        {notLaunchable ? null : <Steps />}
        <PlaceInfoBlock place={place} />
        <PanelFoot placeId={place.id} launched={false} />
      </TabPanel>

      {tab === 'about' ? (
        <TabPanel k="about">
          <h4 className="sec-h">How it works</h4>
          {notLaunchable ? <p className="sec-p">Coins are for open businesses only: one coin per shop, and 100% of creator fees are held for its verified owner.</p> : <Steps full />}
          <PanelFoot placeId={place.id} launched={false} />
        </TabPanel>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ root */

/** "This shop already has a coin — $TICKER" when a coin appears for the open launchable place. */
function useRaceToast(place: Place | null, coin: Coin | undefined): void {
  const prev = useRef<{ id: string; had: boolean; at: number } | null>(null);
  const has = !!coin;
  useEffect(() => {
    if (!place) {
      prev.current = null;
      return;
    }
    const p = prev.current;
    // only a launch that happened while the panel was open is a race (real mode: the registry check
    // can reveal an older coin a moment after the panel opened — that is not news)
    if (p && p.id === place.id && !p.had && has && coin && coin.launchedAt >= p.at - 5_000) {
      const st = useStore.getState();
      if (coin.launcher !== st.wallet.address && st.modal?.kind !== 'launch') st.toast(`This shop already has a coin — $${coin.ticker}`);
    }
    prev.current = { id: place.id, had: has, at: p && p.id === place.id ? p.at : Date.now() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place?.id, has]);
}

export default function PlacePanel() {
  const selected = useStore((s) => s.selected);
  const mobile = useIsMobile();
  const place = selected.place;
  const coin = useStore((s) => (s.selected.place ? s.coins[s.selected.place.id] : undefined));
  useRaceToast(place, coin);

  if (selected.status === 'loading') return <PanelSkeleton launchable={place ? !coin : !!selected.launchable} mobile={mobile} />;
  if (selected.status === 'error') return <PanelError message={selected.error} />;
  if (!place) return null;
  if (coin) return <LaunchedView key={`c:${place.id}`} place={place} coin={coin} mobile={mobile} />;
  return <LaunchableView key={`p:${place.id}`} place={place} mobile={mobile} />;
}
