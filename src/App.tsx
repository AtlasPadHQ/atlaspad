/**
 * CORNERSHOP app composition (DESIGN §4). SHARED file (scaffold / integrator only).
 *
 * DOM order follows the tab order in DESIGN §15: skip links → rail → search → chips →
 * DEMO + wallet → This area / hero → panel → map controls → Layers → map. Visual stacking is
 * driven by the z-index tokens, not DOM order.
 *
 * App owns: seeding + hydration + simulator lifecycle, URL sync, body state classes,
 * online/offline, the `cs:layout` event (map resize after panel/sheet changes), and the
 * DEV-only mock QA states (?state=hero|unlaunched|launch|live, ?search=1).
 */
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import './App.css';
import { LOW_ZOOM, STORAGE_KEYS } from './config';
import Hero from './landing/Hero';
import { createDemoPlaces, getDemoPlace, loadDemoData } from './lib/demoBridge';
import { LAYOUT_EVENT } from './lib/events';
import { loadJSON } from './lib/storage';
import { useIsMobile } from './lib/media';
import { placeFromCoin, devTestPlace } from './lib/place';
import { startRouter } from './lib/router';
import LayersTile from './map/LayersTile';
import MapControls from './map/MapControls';
import MapView from './map/MapView';
import { whenMapPainted } from './map/mapBridge';
import PanelHost from './PanelHost';
import { IS_REAL } from './mode';
import { getPlaceDetails } from './places';
import { ensurePlace, findCoinByMint, startRealData, whenConfig } from './realdata';
import Rail from './rail/Rail';
import ThisAreaCard from './rail/ThisAreaCard';
import CategoryChips from './search/CategoryChips';
import NearMe from './search/NearMe';
import SearchBar from './search/SearchBar';
import { useStore } from './store';
import type { Place } from './types';
import { BasicMapChip, ChainBanner, ErrorBoundary, MapCrash, ModalBoundary, ModeChip, SharedModals, SkipLinks, Toasts, TooltipLayer, Watermark } from './ui';
import { DEV_TEST_PLACE_RE } from '../worker/wire';
import { LiveAnnouncer } from './ui/LiveAnnouncer';
import ConnectWalletPill from './wallet/ConnectWalletPill';
import { setExtraWalletLoader } from './wallet/solanaWallets';
import WalletModal from './wallet/WalletModal';


async function resolvePlace(id: string, source: Place['source']): Promise<Place | null> {
  if (IS_REAL) {
    // real mode: the registry first (a coin opens the launched panel even before the map loads it)
    if (source === 'demo') return null;
    try {
      const r = await ensurePlace(id);
      const coin = useStore.getState().coins[r.placeId];
      if (coin) return placeFromCoin(coin);
    } catch {
      /* registry unreachable: still show the place */
    }
    const test = isDevTestPlace(id) ? devTestPlace(id) : null;
    if (test) return test;
    return getPlaceDetails(id, source);
  }
  if (source === 'demo') return getDemoPlace(id, useStore.getState().coins) ?? getPlaceDetails(id, source);
  return getPlaceDetails(id, source);
}

/** Devnet-only synthetic places for automated E2E (`/p/cornershop-test:cafe-1`). */
function isDevTestPlace(id: string): boolean {
  return IS_REAL && import.meta.env.VITE_CLUSTER === 'devnet' && DEV_TEST_PLACE_RE.test(id);
}

/**
 * The devnet test wallet (INTEGRATION.md §6), loaded ON DEMAND: when a wallet list opens, or right away when the saved
 * session is this wallet (silent restore). Visitors who never connect a wallet never download it or web3.js, so it
 * stays off the first paint (INTEGRATION.md §8). It does not depend on the faucet: `features.testWallet` is true on
 * every devnet build with dev endpoints. Inline-guarded: absent from every other build.
 */
function installTestWallet(isCancelled: () => boolean): void {
  if (import.meta.env.VITE_TEST_WALLET === '1' && import.meta.env.VITE_CLUSTER === 'devnet') {
    if (!IS_REAL) return;
    const NAME = 'Devnet Test Wallet';
    let loading: Promise<void> | null = null;
    const load = (walletName?: string): Promise<void> => {
      if (walletName && walletName !== NAME) return Promise.resolve();
      loading ??= whenConfig()
        .then(async (config) => {
          if (isCancelled() || !config || config.cluster !== 'devnet' || !config.features.testWallet) return;
          const m = await import('./dev/index');
          m.installDevTools(config);
        })
        .catch((e: unknown) => {
          loading = null; // a failed chunk load can be retried by the next wallet list
          console.warn('[cornershop] test wallet failed to load', e);
        });
      return loading;
    };
    setExtraWalletLoader(load);
    const saved = loadJSON<{ kind?: string; walletName?: string } | null>(STORAGE_KEYS.wallet, null);
    if (saved?.kind === 'standard' && saved.walletName === NAME) void load(NAME);
  }
}

/** DEV-only mock QA states (DESIGN §18.4). */
function applyQaState(): void {
  if (!import.meta.env.DEV) return;
  const qs = new URLSearchParams(location.search);
  const st = useStore.getState();
  const crumb = createDemoPlaces()[0];
  switch (qs.get('state')) {
    case 'hero':
      useStore.setState({ heroDismissed: false });
      break;
    case 'unlaunched':
      if (crumb) st.openPlace(crumb, { fly: true });
      break;
    case 'launch':
      if (crumb) {
        st.openPlace(crumb, { fly: true });
        st.openModal({ kind: 'launch', place: crumb });
      }
      break;
    case 'live':
      st.setPanel('live');
      break;
    default:
      break;
  }
  if (qs.get('search') === '1') st.focusSearch({ text: 'https://maps.app.goo.gl/' });
}

function useBodyState(): void {
  const mobile = useIsMobile();
  const panel = useStore((s) => s.panel);
  const collapsed = useStore((s) => s.panelCollapsed);
  const heroDismissed = useStore((s) => s.heroDismissed);
  const lowzoom = useStore((s) => (s.viewport ? s.viewport.zoom < LOW_ZOOM : false));
  const searchOpen = useStore((s) => s.searchOpen);
  const modalOpen = useStore((s) => s.modal != null);
  const railOpen = useStore((s) => s.railOpen);
  const online = useStore((s) => s.online);
  const provider = useStore((s) => s.provider);
  const sheetSnap = useStore((s) => s.sheetSnap);

  const isCollapsed = panel !== 'none' && collapsed && !mobile;
  const panelOpen = panel !== 'none' && !isCollapsed;

  useEffect(() => {
    const b = document.body;
    b.classList.toggle('panel-open', panelOpen);
    b.classList.toggle('panel-collapsed', isCollapsed);
    b.classList.toggle('live-on', panel !== 'none' && panel !== 'place');
    b.classList.toggle('hero-on', !heroDismissed);
    b.classList.toggle('lowzoom', lowzoom);
    b.classList.toggle('search-open', searchOpen);
    b.classList.toggle('modal-open', modalOpen);
    b.classList.toggle('drawer-open', railOpen);
    b.classList.toggle('offline', !online);
    b.dataset.provider = provider;
    b.dataset.sheet = panelOpen && mobile ? sheetSnap : 'none';
  }, [panelOpen, isCollapsed, panel, heroDismissed, lowzoom, searchOpen, modalOpen, railOpen, online, provider, sheetSnap, mobile]);

  // Map resize after layout transitions: desktop panel 320ms, mobile sheet 460ms (DESIGN §4.2, §8.3).
  useEffect(() => {
    const t = setTimeout(() => window.dispatchEvent(new Event(LAYOUT_EVENT)), mobile ? 460 : 320);
    return () => clearTimeout(t);
  }, [panelOpen, isCollapsed, sheetSnap, heroDismissed, mobile]);
}

/**
 * Publish the width of the desktop top-right group (DEMO chip, Basic map chip, wallet pill) as
 * `--topright-w`, so the chips row ends 20px before it whatever it contains (DESIGN §4.1: the
 * default `right:396px` assumes DEMO + "Connect wallet"; the Basic map chip or a connected pill
 * change that width).
 */
function useToprightWidth(): void {
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('.topright');
    if (!el || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const apply = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) root.style.setProperty('--topright-w', `${Math.ceil(w)}px`);
    };
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    apply();
    return () => {
      ro.disconnect();
      root.style.removeProperty('--topright-w');
    };
  }, []);
}

/*
 * Launch / claim / share modals load on first use (INTEGRATION.md §8: initial JS ≤ 170 KB gz) and
 * are prefetched on idle, so the first open is still instant. Real mode loads the chain-backed claim
 * flow; demo mode the simulated one — never both.
 */
const loadLaunch = () => import('./launch/LaunchFlow');
// Two separate loaders (not one ternary around two import() calls, which the bundler folds into ONE preload carrying
// the demo chunk's list): real mode then never preloads the demo claim chunk, demo mode never the chain-backed one.
const loadRealClaim = () => import('./claim/RealClaimFlow');
const loadDemoClaim = () => import('./claim/ClaimFlow');
const loadClaim: () => Promise<{ default: () => ReactNode }> = IS_REAL ? loadRealClaim : loadDemoClaim;
const loadShare = () => import('./share/ShareModal');
const LaunchFlow = lazy(loadLaunch);
const ClaimFlow = lazy(loadClaim);
const ShareModal = lazy(loadShare);

function prefetchModals(): void {
  const run = () => {
    void loadLaunch().catch(() => {});
    void loadClaim().catch(() => {});
    void loadShare().catch(() => {});
  };
  const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  // after the map's first view has painted: on a slow connection these chunks would otherwise share the bandwidth
  // with the map tiles (INTEGRATION §8, LCP); never earlier than 2.5 s after boot
  const start = Date.now();
  void whenMapPainted(12_000).then(() =>
    setTimeout(() => (w.requestIdleCallback ? w.requestIdleCallback(run, { timeout: 4000 }) : run()), Math.max(0, 2500 - (Date.now() - start))),
  );
}

/** Mounts a lazy modal once it has been opened (then keeps it mounted for its exit animation). */
function WhenOpened({ kind, children }: { kind: 'launch' | 'claim' | 'share'; children: ReactNode }) {
  const open = useStore((s) => s.modal?.kind === kind);
  const [ever, setEver] = useState(open);
  if (open && !ever) setEver(true);
  if (!open && !ever) return null;
  return <Suspense fallback={null}>{children}</Suspense>;
}

/** One independent region: if it throws, only it disappears (logged), the rest keeps working. */
function Region({ name, children }: { name: string; children: ReactNode }) {
  return (
    <ErrorBoundary name={name} autoRetry>
      {children}
    </ErrorBoundary>
  );
}

export default function App() {
  useBodyState();
  useToprightWidth();

  useEffect(() => {
    let cancelled = false;
    let stopSim = () => {};
    let stopRouter = () => {};
    let stopReal = () => {};
    if (IS_REAL) {
      // Real mode (INTEGRATION.md §5): chain + D1 registry only. The demo data module is never loaded.
      stopReal = startRealData();
      stopRouter = startRouter({ resolvePlace, resolveCoin: findCoinByMint, isExtraPlaceId: isDevTestPlace });
      installTestWallet(() => cancelled);
    } else {
      // Demo mode: the Phase-1 prototype, unchanged — its data + simulator load as their own chunk.
      void Promise.all([loadDemoData(), import('./data/simulator')]).then(([demo, sim]) => {
        if (cancelled) return;
        const st = useStore.getState();
        st.seedCoins(demo.createMockCoins(st.solUsd));
        st.hydrateUserCoins();
        stopSim = sim.startSimulator();
        stopRouter = startRouter({ resolvePlace });
        if (location.pathname === '/') applyQaState();
        st.setDataReady(true);
      });
    }

    prefetchModals();
    // QA helper: `window.__csHitAudit()` lists controls under 44×44 (dev builds or ?qa=1)
    if (import.meta.env.DEV || /[?&]qa=1\b/.test(location.search)) void import('./ui/hitAudit').then((m) => m.installHitAudit());

    const onOnline = () => useStore.getState().setOnline(true);
    const onOffline = () => useStore.getState().setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      cancelled = true;
      stopSim();
      stopReal();
      stopRouter();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return (
    <>
      <Region name="skip-links">
        <SkipLinks />
      </Region>
      <Region name="rail">
        <Rail />
      </Region>
      <Region name="search">
        <SearchBar />
      </Region>
      <Region name="chips">
        <CategoryChips />
      </Region>
      <div className="topright">
        <Region name="topright">
          <BasicMapChip />
          <ModeChip />
          <ConnectWalletPill />
        </Region>
      </div>
      <div className="m-chrome">
        <Region name="m-chrome">
          <ModeChip className="m-demo" />
          <BasicMapChip className="m-basic" />
        </Region>
      </div>
      <Region name="chain-banner">
        <ChainBanner />
      </Region>
      <Region name="this-area">
        <ThisAreaCard />
      </Region>
      <Region name="hero">
        <Hero />
      </Region>
      <Region name="panel">
        <PanelHost />
      </Region>
      <Region name="map-controls">
        <MapControls />
        <LayersTile />
        <NearMe />
        <Watermark />
      </Region>
      <ErrorBoundary name="map" fallback={({ reset }) => <MapCrash reset={reset} />}>
        <MapView />
      </ErrorBoundary>

      <ModalBoundary name="launch">
        <WhenOpened kind="launch">
          <LaunchFlow />
        </WhenOpened>
      </ModalBoundary>
      <ModalBoundary name="claim">
        <WhenOpened kind="claim">
          <ClaimFlow />
        </WhenOpened>
      </ModalBoundary>
      <ModalBoundary name="share">
        <WhenOpened kind="share">
          <ShareModal />
        </WhenOpened>
      </ModalBoundary>
      <ModalBoundary name="wallet">
        <WalletModal />
      </ModalBoundary>
      <ModalBoundary name="shared-modals">
        <SharedModals />
      </ModalBoundary>

      <Region name="toasts">
        <Toasts />
      </Region>
      <Region name="tooltips">
        <TooltipLayer />
      </Region>
      <Region name="announcer">
        <LiveAnnouncer />
      </Region>
    </>
  );
}
