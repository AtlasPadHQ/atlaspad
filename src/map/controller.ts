/**
 * MapController: owns one adapter for one provider and keeps it in sync with the store
 * (CONTRACTS §7 "Map"):
 *   store → adapter: coins (+ chip filter + Layers "Coins") → setCoinPins · selected place (+ its
 *   coin) → setSelectedPlace · results → setResultPins · userLocation → setUserLocation ·
 *   flyTarget → flyTo / fitBounds (reduced motion: no animation) · layers → setMapType/setLayers ·
 *   new trade FeedEvents → flashCoin.
 *   adapter → store: Google POI → openPlace(googlePlaceStub) (no Places fetch: the panel renders
 *   Google's UI Kit) · OSM POI → openPlace(placeFromOsmFeature) · coin pin → openPlace(placeFromCoin)
 *   · idle/moveend → setViewport · drag → locateStatus 'idle' · empty-map tap (mobile, Full sheet) → Half.
 * Plus the §4.5 viewport rules after map selections, re-centring after panel/sheet layout changes,
 * keyboard panning on the #map container and Google → MapLibre fallback.
 */
import { shallow } from 'zustand/shallow';
import { FOCUS_ZOOM } from '../config';
import { LAUNCH_PULSE_EVENT, LAYOUT_EVENT, type LaunchPulseDetail } from '../lib/events';
import { flashLabel } from '../lib/format';
import { onGoogleFailure } from '../lib/google';
import { isMobileNow, prefersReducedMotion } from '../lib/media';
import { googlePlaceStub, isLaunchableSource, placeFromCoin } from '../lib/place';
import { placeFromOsmFeature } from '../places';
import { IS_REAL } from '../mode';
import { filterCoins, initialCamera, useStore, type AppState } from '../store';
import type { Bounds, ChipFilter, FeedEvent, FlyTarget, LatLng, MapProvider, Place, PlaceClickEvent, Viewport } from '../types';
import { GoogleAdapter } from './adapters/google';
import { MapLibreAdapter } from './adapters/maplibre';
import type { CsMapAdapter, MapPadding } from './adapters/types';
import { getActiveAdapter, publishZoom, setActiveAdapter, zoomBy } from './mapBridge';


const COINS_COALESCE_MS = 80;
const LIVE_REFRESH_MS = 30_000;
const RECENTER_WINDOW_MS = 1500;
const KEY_PAN_PX = 120;
const MAX_FLASHES_PER_UPDATE = 40;

/** Camera shared across provider switches (Google → MapLibre keeps the view). */
let lastCamera: { center: LatLng; zoom: number } | null = null;
/** Highest flyTarget nonce already executed (shared so a provider switch doesn't replay it). */
let appliedFlyNonce = 0;

const EMPTY_PLACES: Place[] = [];

/** A camera target to re-apply once a panel/sheet layout change settles (within RECENTER_WINDOW_MS). */
interface Recenter {
  until: number;
  center?: LatLng;
  zoom?: number;
  bounds?: Bounds;
}

export interface ControllerCallbacks {
  /** Google can't be used (no key / script / auth / timeout): switch the store to MapLibre. */
  onGoogleFailed(): void;
  /** No map could be shown at all. */
  onFatal(): void;
}

function fitPadding(): MapPadding {
  // Mobile: the search pill + chips cover the top ~110px of the map.
  return isMobileNow() ? { top: 124, right: 32, bottom: 32, left: 32 } : { top: 88, right: 72, bottom: 72, left: 72 };
}

/** Rough viewport for the This area card before the map reports a real one. */
function approxViewport(cam: { center: LatLng; zoom: number }, w: number, h: number): Viewport {
  const scale = 256 * 2 ** cam.zoom;
  const lngSpan = (w / scale) * 360;
  const latSpan = (h / scale) * 360 * Math.cos((cam.center.lat * Math.PI) / 180);
  return {
    center: cam.center,
    zoom: cam.zoom,
    bounds: {
      north: cam.center.lat + latSpan / 2,
      south: cam.center.lat - latSpan / 2,
      east: cam.center.lng + lngSpan / 2,
      west: cam.center.lng - lngSpan / 2,
    },
  };
}

/** Selected-pin balloon (54px) + label above the anchor, plus a little air (mobile focus, §4.5). */
const BALLOON_CLEARANCE = 62;

/** The first visible element matching one of the selectors (desktop action vs mobile pill). */
function firstVisible(root: ParentNode, selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    for (const el of root.querySelectorAll<HTMLElement>(sel)) {
      if (el.offsetParent !== null || el.getClientRects().length > 0) return el;
    }
  }
  return null;
}

/** Results shown as map pins: while the results list (or a place opened from it) is on screen. */
function visibleResults(st: AppState): Place[] {
  if (st.panel === 'results' || (st.panel === 'place' && st.panelHistory.includes('results'))) return st.results;
  return EMPTY_PLACES;
}

export class MapController {
  private adapter: CsMapAdapter | null = null;
  private canvas: HTMLDivElement | null = null;
  private unsubs: Array<() => void> = [];
  private disposed = false;
  private failedOver = false;
  private feedTop: string | null = null;
  private coinsTimer = 0;
  private liveTimer = 0;
  private focusTimer = 0;
  private pulseTimer = 0;
  private pendingFocus: LatLng | null = null;
  private recenter: Recenter | null = null;
  private ro: ResizeObserver | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly provider: MapProvider,
    private readonly cb: ControllerCallbacks,
  ) {}

  /* ================================================================ lifecycle */

  async start(): Promise<void> {
    const st = useStore.getState();
    const cam = this.startCamera();
    if (!st.viewport) st.setViewport(approxViewport(cam, this.host.clientWidth || 1024, this.host.clientHeight || 768));

    if (this.provider === 'google') this.unsubs.push(onGoogleFailure(() => this.failGoogle()));

    const canvas = document.createElement('div');
    canvas.className = 'map-canvas';
    this.host.append(canvas);
    this.canvas = canvas;

    const adapter: CsMapAdapter = this.provider === 'google' ? new GoogleAdapter() : new MapLibreAdapter();
    this.adapter = adapter;
    try {
      await adapter.mount(canvas, { center: cam.center, zoom: cam.zoom, mapType: st.layers.mapType });
    } catch (err) {
      if (this.disposed) return;
      if (this.provider === 'google') this.failGoogle();
      else {
        console.warn('[map] the basic map could not load', err);
        this.cb.onFatal();
      }
      return;
    }
    if (this.disposed || this.failedOver) return;
    this.wire(adapter, canvas);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.coinsTimer);
    window.clearTimeout(this.focusTimer);
    window.clearTimeout(this.pulseTimer);
    window.clearInterval(this.liveTimer);
    for (const u of this.unsubs.splice(0)) u();
    window.removeEventListener(LAYOUT_EVENT, this.onLayout);
    this.ro?.disconnect();
    this.ro = null;
    this.host.removeEventListener('keydown', this.onKeyDown);
    this.canvas?.removeEventListener('scroll', this.onScroll, true);
    if (this.adapter && getActiveAdapter() === this.adapter) setActiveAdapter(null);
    this.adapter?.destroy();
    this.adapter = null;
    this.canvas?.remove();
    this.canvas = null;
  }

  private failGoogle(): void {
    if (this.failedOver || this.disposed) return;
    this.failedOver = true;
    this.cb.onGoogleFailed();
  }

  /**
   * Initial camera: a pending fly target (deep link opened before the map mounted) → the camera
   * of the previous provider → last viewport this tab session / hero / Dalston. The fly target is
   * not marked as applied here: `wire()` applies it (a no-op move) only once this map is live.
   */
  private startCamera(): { center: LatLng; zoom: number } {
    const st = useStore.getState();
    const t = st.flyTarget;
    const base = lastCamera ?? initialCamera(!st.heroDismissed);
    if (t && t.nonce > appliedFlyNonce && t.center) return { center: t.center, zoom: t.zoom ?? base.zoom ?? FOCUS_ZOOM };
    return base;
  }

  /* ================================================================ wiring */

  private wire(a: CsMapAdapter, canvas: HTMLDivElement): void {
    const s = useStore;
    setActiveAdapter(a);

    // adapter → store
    this.unsubs.push(
      a.onPlaceClick((e) => this.onPlaceClick(e)),
      a.onCoinClick((id) => this.onCoinClick(id)),
      a.onResultClick((id) => this.onResultClick(id)),
      a.onSelectedClick((kbd) => this.onSelectedClick(kbd)),
      a.onMapClick(() => this.onEmptyMapClick()),
      a.onMoveEnd((v) => {
        lastCamera = { center: v.center, zoom: v.zoom };
        s.getState().setViewport(v);
        publishZoom(v.zoom);
      }),
      a.onZoomChange((z) => publishZoom(z)),
    );
    if (a.onUserGesture) this.unsubs.push(a.onUserGesture(() => this.onUserGesture()));

    // store → adapter
    this.pushCoins();
    this.unsubs.push(
      s.subscribe(
        (st) => [st.coins, st.category, st.layers.coins] as const,
        () => this.scheduleCoins(),
        { equalityFn: shallow },
      ),
      s.subscribe(
        (st) => [st.selected.place, st.selected.place ? st.coins[st.selected.place.id] : undefined] as const,
        ([place, coin]) => a.setSelectedPlace(place ? { place, ...(coin ? { coin } : {}) } : null),
        { equalityFn: shallow, fireImmediately: true },
      ),
      s.subscribe(visibleResults, (r) => a.setResultPins(r), { fireImmediately: true }),
      s.subscribe(
        (st) => st.userLocation,
        (loc) => a.setUserLocation(loc),
        { fireImmediately: true },
      ),
      s.subscribe(
        (st) => st.layers,
        (l) => {
          a.setMapType?.(l.mapType);
          a.setLayers?.(l);
        },
        { fireImmediately: true },
      ),
      s.subscribe(
        (st) => st.flyTarget,
        (t) => this.applyFly(t),
        { fireImmediately: true },
      ),
      s.subscribe(
        (st) => st.category,
        (c) => this.syncLiveTimer(c),
        { fireImmediately: true },
      ),
    );
    this.feedTop = s.getState().feed[0]?.id ?? null;
    this.unsubs.push(
      s.subscribe(
        (st) => st.feed,
        (f) => this.onFeed(f),
      ),
    );

    window.addEventListener(LAYOUT_EVENT, this.onLayout);
    this.host.addEventListener('keydown', this.onKeyDown);
    canvas.addEventListener('scroll', this.onScroll, true);
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.adapter?.resize());
      this.ro.observe(this.host);
    }
  }

  /* ================================================================ store → adapter */

  private scheduleCoins(): void {
    if (this.coinsTimer) return;
    this.coinsTimer = window.setTimeout(() => this.pushCoins(), COINS_COALESCE_MS);
  }

  private pushCoins(): void {
    window.clearTimeout(this.coinsTimer);
    this.coinsTimer = 0;
    const a = this.adapter;
    if (!a || this.disposed) return;
    const st = useStore.getState();
    // real coins the registry has no coordinates for yet get no pin (lists still show them)
    a.setCoinPins(st.layers.coins ? filterCoins(st.coins, st.category).filter((c) => !c.real || c.real.located) : []);
  }

  /** "Live coins" depends on the clock (traded in the last 60 min): refresh while it is on. */
  private syncLiveTimer(c: ChipFilter | null): void {
    if (c === 'live' && !this.liveTimer) this.liveTimer = window.setInterval(() => this.pushCoins(), LIVE_REFRESH_MS);
    else if (c !== 'live' && this.liveTimer) {
      window.clearInterval(this.liveTimer);
      this.liveTimer = 0;
    }
  }

  private applyFly(t: FlyTarget | null): void {
    if (!t || t.nonce <= appliedFlyNonce) return;
    const a = this.adapter;
    if (!a) return;
    appliedFlyNonce = t.nonce;
    const animate = !prefersReducedMotion();
    this.cancelFocus();
    const until = Date.now() + RECENTER_WINDOW_MS;
    if (t.bounds) {
      a.fitBoundsPadded(t.bounds, fitPadding(), animate);
      this.recenter = { bounds: t.bounds, until };
    } else if (t.center) {
      a.flyTo(t.center, t.zoom, { animate });
      this.recenter = { center: t.center, zoom: t.zoom, until };
      // Mobile: a flight to the selected place (lists, search, deep links) also ends with the pin at
      // 40% of the visible map, clear of the top chrome (§4.5) — not at the map's centre, which on
      // short phones is under the chips row. Runs after the sheet's layout settles (onLayout), or
      // once the flight is over when the layout doesn't change.
      const sel = useStore.getState().selected.place?.location;
      if (isMobileNow() && sel && Math.abs(sel.lat - t.center.lat) < 1e-9 && Math.abs(sel.lng - t.center.lng) < 1e-9) {
        this.pendingFocus = t.center;
        this.focusTimer = window.setTimeout(() => this.runFocus(), 600);
      }
    }
  }

  private onFeed(feed: FeedEvent[]): void {
    const prevTop = this.feedTop;
    this.feedTop = feed[0]?.id ?? null;
    const a = this.adapter;
    if (!a || prevTop === this.feedTop) return;
    // real mode flashes pins from market deltas instead (src/realdata → mapBridge.flashPin)
    if (IS_REAL) return;
    if (!useStore.getState().layers.flashes || document.hidden) return;
    let n = 0;
    for (const ev of feed) {
      if (ev.id === prevTop || n >= MAX_FLASHES_PER_UPDATE) break;
      n++;
      if (ev.kind === 'trade') a.flashCoin(ev.placeId, ev.side, flashLabel(ev.side, ev.sol));
    }
  }

  /* ================================================================ adapter → store */

  /** Open a place from a map click and apply the §4.5 viewport rule once the layout settles. */
  private select(place: Place): void {
    const before = useStore.getState();
    const prev = { panel: before.panel, collapsed: before.panelCollapsed, snap: before.sheetSnap, hero: before.heroDismissed };
    before.openPlace(place);
    const after = useStore.getState();
    const mobile = isMobileNow();
    const layoutChanges =
      prev.panel === 'none' || !prev.hero || (!mobile && prev.collapsed) || (mobile && prev.snap !== after.sheetSnap);
    this.focusOn(place.location, layoutChanges);
  }

  private onPlaceClick(e: PlaceClickEvent): void {
    const st = useStore.getState();
    if (e.source === 'google') {
      const coin = st.coins[e.id];
      this.select(coin ? placeFromCoin(coin) : googlePlaceStub(e.id, e.location));
      return;
    }
    if (e.source === 'osm') this.select(e.place ?? placeFromOsmFeature({}, e.location));
  }

  private onCoinClick(placeId: string): void {
    const coin = useStore.getState().coins[placeId];
    if (coin) this.select(placeFromCoin(coin));
  }

  private onResultClick(placeId: string): void {
    const st = useStore.getState();
    const coin = st.coins[placeId];
    if (coin) {
      this.select(placeFromCoin(coin));
      return;
    }
    const place = st.results.find((p) => p.id === placeId);
    if (place) this.select(place);
  }

  /** Selected balloon: launchable → scroll the panel to the top + pulse Launch (DESIGN §18.1). */
  private onSelectedClick(fromKeyboard: boolean): void {
    const st = useStore.getState();
    const place = st.selected.place;
    if (!place) return;
    const coin = st.coins[place.id];
    const showing = st.panel === 'place' && !st.panelCollapsed;
    if (!coin && isLaunchableSource(place.source)) {
      if (!showing) this.select(place);
      this.pulseLaunch(fromKeyboard, showing ? 0 : isMobileNow() ? 520 : 360);
      return;
    }
    if (!showing) {
      this.select(coin ? placeFromCoin(coin) : place);
      return;
    }
    if (isMobileNow() && st.sheetSnap === 'peek') st.setSheetSnap('half');
  }

  /**
   * The place panel owns the visual pulse (it listens for LAUNCH_PULSE_EVENT, scrolls to the top
   * and scales its Launch action once). The event is sent once the panel is on screen; keyboard
   * activation then also moves focus to Launch.
   */
  private pulseLaunch(fromKeyboard: boolean, delay: number): void {
    const st = useStore.getState();
    if (st.placeTab !== 'overview') st.setPlaceTab('overview');
    if (isMobileNow() && st.sheetSnap === 'peek') st.setSheetSnap('half');
    window.clearTimeout(this.pulseTimer);
    this.pulseTimer = window.setTimeout(() => {
      this.pulseTimer = 0;
      const detail: LaunchPulseDetail = { fromKeyboard };
      window.dispatchEvent(new CustomEvent(LAUNCH_PULSE_EVENT, { detail }));
      if (!fromKeyboard) return;
      const panel = document.querySelector('.panel');
      const target = panel ? firstVisible(panel, ['.act.primary', '.pills .btn-primary']) : null;
      target?.focus({ preventScroll: true });
    }, delay);
  }

  /** Desktop: nothing (selection stays). Mobile: a Full sheet collapses to Half (DESIGN §18.1). */
  private onEmptyMapClick(): void {
    const st = useStore.getState();
    if (isMobileNow() && st.panel !== 'none' && st.sheetSnap === 'full') st.setSheetSnap('half');
  }

  private onUserGesture(): void {
    const st = useStore.getState();
    if (st.locateStatus === 'located') st.setLocateStatus('idle');
    // The user took over the camera: drop pending automatic moves.
    this.recenter = null;
    this.cancelFocus();
  }

  /* ================================================================ §4.5 viewport rules */

  private cancelFocus(): void {
    window.clearTimeout(this.focusTimer);
    this.focusTimer = 0;
    this.pendingFocus = null;
  }

  private focusOn(loc: LatLng, waitForLayout: boolean): void {
    this.cancelFocus();
    this.recenter = null;
    this.pendingFocus = loc;
    // cs:layout normally arrives first (320ms desktop / 460ms mobile); the timer is the fallback.
    this.focusTimer = window.setTimeout(() => this.runFocus(), waitForLayout ? (isMobileNow() ? 560 : 400) : 0);
  }

  private runFocus(): void {
    const loc = this.pendingFocus;
    this.cancelFocus();
    const a = this.adapter;
    if (!a || !loc) return;
    const p = a.toContainerPoint(loc);
    const { width: w, height: h } = a.getSize();
    if (!p || w < 40 || h < 40) return;
    const animate = !prefersReducedMotion();
    if (isMobileNow()) {
      // Mobile: the pin sits at 40% of the *visible* map (DESIGN §4.5): below the floating search
      // pill, chips row and DEMO chip, above the sheet — and never so high that its 54px balloon
      // and label reach under that chrome (short phones).
      const top = Math.min(h * 0.6, this.topChromeInset());
      const y = Math.max(top + (h - top) * 0.4, top + BALLOON_CLEARANCE);
      const dx = p.x - w / 2;
      const dy = p.y - Math.min(y, h - 16);
      if (Math.hypot(dx, dy) > 4) a.panBy(dx, dy, animate);
    } else if (p.x < w * 0.1 || p.x > w * 0.9 || p.y < h * 0.1 || p.y > h * 0.9) {
      // Desktop: only when outside the inner 80% of the visible map area.
      a.panTo(loc, animate);
    }
  }

  /** Mobile: how far the floating top chrome (search pill, chips row, DEMO chip) reaches into the map (px). */
  private topChromeInset(): number {
    const mapTop = this.host.getBoundingClientRect().top;
    let bottom = 0;
    for (const el of document.querySelectorAll<HTMLElement>('.search .search-box, .chips, .m-chrome')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) bottom = Math.max(bottom, r.bottom - mapTop);
    }
    return Math.max(0, bottom);
  }

  /* ================================================================ DOM listeners */

  private readonly onLayout = (): void => {
    const a = this.adapter;
    if (!a) return;
    a.resize();
    const r = this.recenter;
    this.recenter = null;
    if (r && Date.now() < r.until) {
      if (r.bounds) a.fitBoundsPadded(r.bounds, fitPadding(), false);
      else if (r.center) a.flyTo(r.center, r.zoom, { animate: false });
    }
    if (this.pendingFocus) this.runFocus();
  };

  /** Arrow keys / +/- while the #map container itself has focus (e.g. after "Skip to map"). */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.target !== this.host || e.altKey || e.ctrlKey || e.metaKey) return;
    const a = this.adapter;
    if (!a) return;
    const animate = !prefersReducedMotion();
    switch (e.key) {
      case 'ArrowUp':
        a.panBy(0, -KEY_PAN_PX, animate);
        break;
      case 'ArrowDown':
        a.panBy(0, KEY_PAN_PX, animate);
        break;
      case 'ArrowLeft':
        a.panBy(-KEY_PAN_PX, 0, animate);
        break;
      case 'ArrowRight':
        a.panBy(KEY_PAN_PX, 0, animate);
        break;
      case '+':
      case '=':
        zoomBy(1);
        break;
      case '-':
      case '_':
        zoomBy(-1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  /**
   * Focusing a pin near the edge can make the browser scroll an overflow:hidden map ancestor,
   * which shifts every pane. Undo that (only for ancestors of our pin layers).
   */
  private readonly onScroll = (e: Event): void => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || (!t.scrollTop && !t.scrollLeft)) return;
    if (!t.querySelector('.cs-pins')) return;
    t.scrollTop = 0;
    t.scrollLeft = 0;
  };
}
