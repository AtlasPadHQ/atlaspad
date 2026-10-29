/**
 * Google Maps adapter (DESIGN §7, research/google.md §1 + §3):
 *  - the real Google default basemap: raster, no `mapId`, no restyling, `clickableIcons:true`,
 *    `gestureHandling:'greedy'`, `disableDefaultUI:true` (Google's logo / attribution / terms stay);
 *  - ONE `OverlayView` holding every HTML pin: coin + result pins in `overlayMouseTarget`, the
 *    selected pin in `floatPane`, the user dot in `overlayLayer`; positioned in `draw()` with
 *    `fromLatLngToDivPixel`, culled outside the container;
 *  - POI click → `event.placeId` → `event.stop()` (no Google info window) → onPlaceClick.
 * Loaded through the shared bootstrap (`lib/google.importLibrary`), which rejects on no key,
 * script failure, auth failure (`gm_authFailure`) or timeout — MapView then falls back to MapLibre.
 */
import { importLibrary } from '../../lib/google';
import { prefersReducedMotion } from '../../lib/media';
import type {
  Bounds,
  Coin,
  LatLng,
  LayersState,
  MapType,
  Place,
  PlaceClickEvent,
  SelectedPin,
  TradeSide,
  Unsubscribe,
  UserLocation,
  Viewport,
} from '../../types';
import { markMapPainted } from '../mapBridge';
import { PinLayer, type Projector } from '../pins';
import { clamp, Emitter, withinOneViewport } from '../util';
import type { ContainerPoint, CsMapAdapter, MapPadding } from './types';

const MIN_ZOOM = 3;
const MAX_ZOOM = 21;
/** Colour shown before tiles load (= --cs-map-bg). */
const MAP_BG = '#e8e6e1';
/** Phone-sized maps get Google's first-view preview image (see mount). */
const PREVIEW_MAX_WIDTH = 800;
const PREVIEW_MAX_HEIGHT = 1_400;

interface OverlayHost {
  attach(panes: google.maps.MapPanes, ov: typeof google.maps.OverlayView): void;
  draw(projection: google.maps.MapCanvasProjection): void;
  detach(): void;
}

/** `google.maps.OverlayView` only exists after the library loads, so the subclass is made here. */
function createPinOverlay(OV: typeof google.maps.OverlayView, host: OverlayHost): google.maps.OverlayView {
  class PinOverlay extends OV {
    override onAdd(): void {
      const panes = this.getPanes();
      if (panes) host.attach(panes, OV);
    }
    override draw(): void {
      const projection = this.getProjection();
      if (projection) host.draw(projection);
    }
    override onRemove(): void {
      host.detach();
    }
  }
  return new PinOverlay();
}

function toBounds(b: google.maps.LatLngBounds | null | undefined): Bounds | null {
  if (!b) return null;
  const ne = b.getNorthEast();
  const sw = b.getSouthWest();
  return { north: ne.lat(), east: ne.lng(), south: sw.lat(), west: sw.lng() };
}

export class GoogleAdapter implements CsMapAdapter, OverlayHost {
  readonly provider = 'google' as const;

  private map: google.maps.Map | null = null;
  /** `core` library (event, Point): taken from importLibrary rather than the global namespace. */
  private core: google.maps.CoreLibrary | null = null;
  private overlay: google.maps.OverlayView | null = null;
  private projection: google.maps.MapCanvasProjection | null = null;
  private el: HTMLElement | null = null;
  private destroyed = false;
  private listeners: google.maps.MapsEventListener[] = [];
  private pendingZoom: google.maps.MapsEventListener | null = null;
  private size = { width: 0, height: 0 };

  private readonly roots = {
    under: document.createElement('div'),
    pins: document.createElement('div'),
    float: document.createElement('div'),
  };
  private readonly pins: PinLayer;

  private readonly placeClick = new Emitter<PlaceClickEvent>();
  private readonly coinClick = new Emitter<string>();
  private readonly resultClick = new Emitter<string>();
  private readonly selectedClick = new Emitter<boolean>();
  private readonly mapClick = new Emitter<LatLng>();
  private readonly moveEnd = new Emitter<Viewport>();
  private readonly gesture = new Emitter<void>();
  private readonly zoomChange = new Emitter<number>();

  constructor() {
    this.pins = new PinLayer(this.roots, {
      coin: (id) => this.coinClick.emit(id),
      result: (id) => this.resultClick.emit(id),
      selected: (kbd) => this.selectedClick.emit(kbd),
    });
  }

  /* -------------------------------------------------------------- lifecycle */

  async mount(el: HTMLElement, opts: { center: LatLng; zoom: number; mapType: MapType }): Promise<void> {
    this.el = el;
    const [{ Map, OverlayView }, core] = await Promise.all([importLibrary('maps'), importLibrary('core')]);
    if (this.destroyed) return;
    this.core = core;
    const options: google.maps.MapOptions & { useStaticMap?: boolean } = {
      center: opts.center,
      zoom: clamp(Math.round(opts.zoom), MIN_ZOOM, MAX_ZOOM),
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      mapTypeId: opts.mapType,
      disableDefaultUI: true,
      clickableIcons: true,
      gestureHandling: 'greedy',
      keyboardShortcuts: true,
      backgroundColor: MAP_BG,
    };
    // LCP on phones (INTEGRATION §8): Maps JS paints a one-image preview of the first view (its own static map
    // service, part of the map load) while the raster tiles download, but only when the map is ≤ 800 × 800 and
    // ≤ 384k px. A full-height phone map (375 × 812, 412 × 915, …) just misses that, so on a slow connection the map
    // stayed blank until ~15 tiles at 2-3× DPR had arrived (7+ s on slow 4G). Ask for the preview on phone-sized
    // maps; desktop keeps Google's default (tiles arrive fast there and a large preview would only add bytes).
    if (el.clientWidth > 0 && el.clientWidth <= PREVIEW_MAX_WIDTH && el.clientHeight <= PREVIEW_MAX_HEIGHT) options.useStaticMap = true;
    const map = new Map(el, options);
    this.map = map;
    this.measure();

    this.listeners.push(
      map.addListener('click', (e: google.maps.MapMouseEvent) => this.handleClick(e)),
      map.addListener('idle', () => this.onIdle()),
      map.addListener('dragstart', () => this.gesture.emit()),
      map.addListener('zoom_changed', () => {
        const z = map.getZoom();
        if (typeof z === 'number') this.zoomChange.emit(z);
        this.pins.scheduleDeclutter();
      }),
    );
    const firstTiles = map.addListener('tilesloaded', () => {
      firstTiles.remove();
      markMapPainted();
    });
    this.listeners.push(firstTiles);

    this.overlay = createPinOverlay(OverlayView, this);
    this.overlay.setMap(map);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const l of this.listeners) l.remove();
    this.listeners = [];
    this.pendingZoom?.remove();
    this.pendingZoom = null;
    this.overlay?.setMap(null);
    this.overlay = null;
    this.pins.destroy();
    if (this.map && this.core) {
      try {
        this.core.event.clearInstanceListeners(this.map);
      } catch {
        /* library gone */
      }
    }
    this.map = null;
    this.core = null;
    this.projection = null;
    for (const e of [
      this.placeClick,
      this.coinClick,
      this.resultClick,
      this.selectedClick,
      this.mapClick,
      this.moveEnd,
      this.gesture,
      this.zoomChange,
    ]) {
      e.clear();
    }
    this.el = null;
  }

  /* -------------------------------------------------------------- OverlayHost */

  attach(panes: google.maps.MapPanes, OV: typeof google.maps.OverlayView): void {
    panes.overlayLayer.append(this.roots.under);
    panes.overlayMouseTarget.append(this.roots.pins);
    panes.floatPane.append(this.roots.float);
    // A pin click must never also fire a map / POI click (DESIGN §7). Clicks only: dragging and
    // wheel-zooming the map still work when the gesture starts over a pin.
    OV.preventMapHitsFrom(this.roots.pins);
    OV.preventMapHitsFrom(this.roots.float);
  }

  draw(projection: google.maps.MapCanvasProjection): void {
    this.projection = projection;
    const map = this.map;
    if (!map || this.destroyed) return;
    const c = map.getCenter();
    if (!c) return;
    const dc = projection.fromLatLngToDivPixel(c);
    const cc = projection.fromLatLngToContainerPixel(c);
    if (!dc || !cc) return;
    const ox = dc.x - cc.x;
    const oy = dc.y - cc.y;
    const project: Projector = (ll) => {
      const p = projection.fromLatLngToDivPixel(ll);
      return p ? { px: p.x, py: p.y, cx: p.x - ox, cy: p.y - oy } : null;
    };
    this.pins.layout(project, this.size.width, this.size.height, map.getZoom() ?? 0);
  }

  detach(): void {
    this.roots.under.remove();
    this.roots.pins.remove();
    this.roots.float.remove();
  }

  /* -------------------------------------------------------------- map events */

  private handleClick(e: google.maps.MapMouseEvent): void {
    const placeId = (e as google.maps.IconMouseEvent).placeId;
    const ll = e.latLng;
    if (placeId) {
      e.stop(); // suppress Google's default info window
      if (!ll) return;
      this.placeClick.emit({ id: placeId, source: 'google', location: { lat: ll.lat(), lng: ll.lng() } });
      return;
    }
    if (ll) this.mapClick.emit({ lat: ll.lat(), lng: ll.lng() });
  }

  private onIdle(): void {
    const map = this.map;
    if (!map) return;
    this.measure();
    const c = map.getCenter();
    const z = map.getZoom();
    if (c && typeof z === 'number') {
      this.moveEnd.emit({ center: { lat: c.lat(), lng: c.lng() }, zoom: z, bounds: toBounds(map.getBounds()) });
    }
    this.pins.declutter();
  }

  private measure(): void {
    const el = this.el;
    if (!el) return;
    this.size = { width: el.clientWidth, height: el.clientHeight };
  }

  /* -------------------------------------------------------------- camera */

  private cancelPendingZoom(): void {
    this.pendingZoom?.remove();
    this.pendingZoom = null;
  }

  flyTo(center: LatLng, zoom?: number, opts: { animate?: boolean } = {}): void {
    const map = this.map;
    if (!map) return;
    this.cancelPendingZoom();
    const z = zoom == null ? undefined : clamp(Math.round(zoom), MIN_ZOOM, MAX_ZOOM);
    const animate = opts.animate ?? !prefersReducedMotion();
    const bounds = toBounds(map.getBounds());
    if (!animate || !bounds || !withinOneViewport(bounds, center)) {
      // Long hops jump (no long pans, DESIGN §14); reduced motion never animates.
      map.setCenter(center);
      if (z != null) map.setZoom(z);
      return;
    }
    map.panTo(center);
    if (z != null && z !== map.getZoom()) {
      this.pendingZoom = this.core?.event.addListenerOnce(map, 'idle', () => {
        this.pendingZoom = null;
        if (this.map === map) map.setZoom(z);
      }) ?? null;
    }
  }

  fitBounds(bounds: Bounds, paddingPx = 64): void {
    this.fitBoundsPadded(bounds, { top: paddingPx, right: paddingPx, bottom: paddingPx, left: paddingPx }, true);
  }

  fitBoundsPadded(bounds: Bounds, padding: MapPadding, _animate: boolean): void {
    const map = this.map;
    if (!map) return;
    this.cancelPendingZoom();
    map.fitBounds(bounds, padding);
    // Never zoom closer than street level for a single coin.
    this.core?.event.addListenerOnce(map, 'idle', () => {
      const z = map.getZoom();
      if (this.map === map && typeof z === 'number' && z > 17) map.setZoom(17);
    });
  }

  setZoom(zoom: number): void {
    this.cancelPendingZoom();
    this.map?.setZoom(clamp(Math.round(zoom), MIN_ZOOM, MAX_ZOOM));
  }

  getZoomLimits(): { min: number; max: number } {
    return { min: MIN_ZOOM, max: MAX_ZOOM };
  }

  panBy(dx: number, dy: number, animate: boolean): void {
    const map = this.map;
    if (!map) return;
    if (animate) {
      map.panBy(Math.round(dx), Math.round(dy));
      return;
    }
    const proj = this.projection;
    const c = map.getCenter();
    if (!proj || !c) return;
    const cc = proj.fromLatLngToContainerPixel(c);
    if (!cc) return;
    const core = this.core;
    if (!core) return;
    const ll = proj.fromContainerPixelToLatLng(new core.Point(cc.x + dx, cc.y + dy));
    if (ll) map.setCenter(ll);
  }

  panTo(ll: LatLng, animate: boolean): void {
    const map = this.map;
    if (!map) return;
    if (animate) map.panTo(ll);
    else map.setCenter(ll);
  }

  setMapType(type: MapType): void {
    const map = this.map;
    if (map && map.getMapTypeId() !== type) map.setMapTypeId(type);
  }

  setLayers(layers: LayersState): void {
    this.pins.setLayers(layers);
  }

  resize(): void {
    this.measure();
    if (this.projection) this.draw(this.projection);
    this.pins.scheduleDeclutter();
  }

  getCenter(): LatLng {
    const c = this.map?.getCenter();
    return c ? { lat: c.lat(), lng: c.lng() } : { lat: 0, lng: 0 };
  }

  getZoom(): number {
    return this.map?.getZoom() ?? 0;
  }

  getBounds(): Bounds | null {
    return toBounds(this.map?.getBounds());
  }

  getSize(): { width: number; height: number } {
    this.measure();
    return this.size;
  }

  toContainerPoint(ll: LatLng): ContainerPoint | null {
    const p = this.projection?.fromLatLngToContainerPixel(ll);
    return p ? { x: p.x, y: p.y } : null;
  }

  /* -------------------------------------------------------------- pins */

  setCoinPins(coins: Coin[]): void {
    this.pins.setCoins(coins);
  }

  setSelectedPlace(sel: SelectedPin | null): void {
    this.pins.setSelected(sel);
  }

  setResultPins(places: Place[]): void {
    this.pins.setResults(places);
  }

  setUserLocation(loc: UserLocation | null): void {
    this.pins.setUser(loc);
  }

  flashCoin(placeId: string, side: TradeSide, label: string): void {
    this.pins.flash(placeId, side, label);
  }

  /* -------------------------------------------------------------- subscriptions */

  onPlaceClick(cb: (e: PlaceClickEvent) => void): Unsubscribe {
    return this.placeClick.on(cb);
  }
  onCoinClick(cb: (placeId: string) => void): Unsubscribe {
    return this.coinClick.on(cb);
  }
  onResultClick(cb: (placeId: string) => void): Unsubscribe {
    return this.resultClick.on(cb);
  }
  onSelectedClick(cb: (fromKeyboard: boolean) => void): Unsubscribe {
    return this.selectedClick.on(cb);
  }
  onMapClick(cb: (location: LatLng) => void): Unsubscribe {
    return this.mapClick.on(cb);
  }
  onMoveEnd(cb: (v: Viewport) => void): Unsubscribe {
    return this.moveEnd.on(cb);
  }
  onUserGesture(cb: () => void): Unsubscribe {
    return this.gesture.on(cb);
  }
  onZoomChange(cb: (zoom: number) => void): Unsubscribe {
    return this.zoomChange.on(cb);
  }
}
