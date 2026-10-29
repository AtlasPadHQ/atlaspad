/**
 * MapLibre GL + OpenFreeMap "liberty" fallback (BRIEF; DESIGN §9.4, §13.5): used when there is
 * no Google key, Google fails to load / rejects the key, or `?map=demo`.
 *  - lazy chunk: `await import('maplibre-gl')` (its CSS is imported once in main.tsx);
 *  - the worker is resolved through Vite (`?url`) because MapLibre v6 looks for it next to the
 *    module, which does not exist in a bundled app;
 *  - a light recolour of the liberty style toward the CORNERSHOP/Google map tints;
 *  - OSM POIs (`poi_r1/r7/r20`) are clickable → onPlaceClick({source:'osm', place});
 *  - the same HTML pin layer as Google, in an overlay inside the canvas container (so dragging
 *    from a pin still pans the map).
 * Zoom is exposed in Google units everywhere (MapLibre's 512px tiles: ML zoom = Google zoom − 1),
 * so LOW_ZOOM / FOCUS_ZOOM / AREA_MIN_ZOOM mean the same on both providers.
 */
import type { MapEventType, MapGeoJSONFeature, Map as MlMap, TransformStyleFunction } from 'maplibre-gl';
import { OSM_STYLE_URL } from '../../config';
import { prefersReducedMotion } from '../../lib/media';
import { placeFromOsmFeature } from '../../places';
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

/** Google-unit zoom limits (ML = −1). */
const MIN_ZOOM = 3;
const MAX_ZOOM = 20;
const LOAD_TIMEOUT_MS = 20_000;
const POI_LAYERS = ['poi_r1', 'poi_r7', 'poi_r20'] as const;

const toMl = (z: number) => z - 1;
const fromMl = (z: number) => z + 1;

type MapLibreModule = typeof import('maplibre-gl');
let mlPromise: Promise<MapLibreModule> | null = null;

function loadMapLibre(): Promise<MapLibreModule> {
  mlPromise ??= Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl-worker.mjs?url')])
    .then(([ml, worker]) => {
      ml.setWorkerUrl(worker.default);
      return ml;
    })
    .catch((err: unknown) => {
      mlPromise = null; // allow a retry
      throw err;
    });
  return mlPromise;
}

type StyleSpec = Parameters<TransformStyleFunction>[1];
type LooseLayer = { id: string; paint?: Record<string, unknown>; filter?: unknown };

/**
 * Light recolour of OpenFreeMap liberty toward the Google-like look of the product
 * (buildings = --cs-map-bg, parks = --cs-green-container, white roads with grey casings).
 * Applied to the style JSON before it is committed, so the original colours never flash.
 */
const RECOLOUR: Record<string, Record<string, unknown>> = {
  background: { 'background-color': '#f4f2ee' },
  water: { 'fill-color': '#aad3f0' },
  waterway_river: { 'line-color': '#aad3f0' },
  waterway_other: { 'line-color': '#aad3f0' },
  waterway_tunnel: { 'line-color': '#aad3f0' },
  park: { 'fill-color': '#d7f5e1', 'fill-opacity': 0.85 },
  landcover_wood: { 'fill-color': '#cfe9d4' },
  landcover_grass: { 'fill-color': '#cfe9d4' },
  landuse_residential: { 'fill-color': 'rgba(232,230,225,0.45)' },
  building: { 'fill-color': '#e8e6e1' },
  'building-3d': { 'fill-extrusion-color': '#ebe9e4', 'fill-extrusion-opacity': 0.55 },
  road_trunk_primary: { 'line-color': '#ffffff' },
  road_secondary_tertiary: { 'line-color': '#ffffff' },
  road_link: { 'line-color': '#ffffff' },
  bridge_trunk_primary: { 'line-color': '#ffffff' },
  bridge_secondary_tertiary: { 'line-color': '#ffffff' },
  bridge_link: { 'line-color': '#ffffff' },
  road_trunk_primary_casing: { 'line-color': '#d6d3cd' },
  road_secondary_tertiary_casing: { 'line-color': '#d6d3cd' },
  road_link_casing: { 'line-color': '#d6d3cd' },
  bridge_trunk_primary_casing: { 'line-color': '#d6d3cd' },
  bridge_secondary_tertiary_casing: { 'line-color': '#d6d3cd' },
  bridge_link_casing: { 'line-color': '#d6d3cd' },
  road_motorway: { 'line-color': '#fde293' },
  road_motorway_link: { 'line-color': '#fde293' },
  bridge_motorway: { 'line-color': '#fde293' },
  bridge_motorway_link: { 'line-color': '#fde293' },
  road_motorway_casing: { 'line-color': '#f1c35a' },
  road_motorway_link_casing: { 'line-color': '#f1c35a' },
  bridge_motorway_casing: { 'line-color': '#f1c35a' },
  bridge_motorway_link_casing: { 'line-color': '#f1c35a' },
};

/** `["get","ref_length"]` is null on many roads; the liberty shield filters then warn on every tile. */
function nullSafeRefLength(expr: unknown): unknown {
  if (!Array.isArray(expr)) return expr;
  if (expr.length === 2 && expr[0] === 'get' && expr[1] === 'ref_length') return ['coalesce', expr, 99];
  return expr.map(nullSafeRefLength);
}

const transformStyle: TransformStyleFunction = (_prev, next): StyleSpec => {
  try {
    const layers = (next.layers as unknown as LooseLayer[]).map((layer) => {
      let out = layer;
      const paint = RECOLOUR[layer.id];
      if (paint) out = { ...out, paint: { ...(layer.paint ?? {}), ...paint } };
      if (layer.id.includes('shield') && layer.filter) out = { ...out, filter: nullSafeRefLength(layer.filter) };
      return out;
    });
    return { ...next, layers: layers as unknown as StyleSpec['layers'] };
  } catch {
    return next; // never block the map on a cosmetic tweak
  }
};

/**
 * OpenMapTiles/planetiler POI feature ids encode the OSM element: id = osmId × 10 + type
 * (1 node, 2 way, 3 relation). Falls back to "node" when the id doesn't follow that scheme.
 */
function osmIdentity(featureId: unknown): { osm_id?: number; osm_type?: string } {
  const n = typeof featureId === 'number' ? featureId : typeof featureId === 'string' ? Number(featureId) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return {};
  const t = n % 10;
  if (t >= 1 && t <= 3) return { osm_id: Math.floor(n / 10), osm_type: t === 1 ? 'node' : t === 2 ? 'way' : 'relation' };
  return { osm_id: n, osm_type: 'node' };
}

function featureLocation(f: MapGeoJSONFeature, fallback: LatLng): LatLng {
  const g = f.geometry;
  if (g.type === 'Point') {
    const [lng, lat] = g.coordinates;
    if (typeof lat === 'number' && typeof lng === 'number') return { lat, lng };
  }
  return fallback;
}

export class MapLibreAdapter implements CsMapAdapter {
  readonly provider = 'demo' as const;

  private map: MlMap | null = null;
  private destroyed = false;
  private size = { width: 0, height: 0 };
  private readonly overlay = document.createElement('div');
  private readonly roots = {
    under: document.createElement('div'),
    pins: document.createElement('div'),
    float: document.createElement('div'),
  };
  private readonly pins: PinLayer;
  private poiHover = 0;
  private offs: Array<() => void> = [];
  private mapType: MapType = 'roadmap';

  private readonly placeClick = new Emitter<PlaceClickEvent>();
  private readonly coinClick = new Emitter<string>();
  private readonly resultClick = new Emitter<string>();
  private readonly selectedClick = new Emitter<boolean>();
  private readonly mapClick = new Emitter<LatLng>();
  private readonly moveEnd = new Emitter<Viewport>();
  private readonly gesture = new Emitter<void>();
  private readonly zoomChange = new Emitter<number>();

  constructor() {
    this.overlay.className = 'cs-ml-overlay';
    this.overlay.append(this.roots.under, this.roots.pins, this.roots.float);
    this.pins = new PinLayer(this.roots, {
      coin: (id) => this.coinClick.emit(id),
      result: (id) => this.resultClick.emit(id),
      selected: (kbd) => this.selectedClick.emit(kbd),
    });
  }

  /* -------------------------------------------------------------- lifecycle */

  async mount(el: HTMLElement, opts: { center: LatLng; zoom: number; mapType: MapType }): Promise<void> {
    const ml = await loadMapLibre();
    if (this.destroyed) return;
    this.mapType = opts.mapType;
    const map = new ml.Map({
      container: el,
      center: [opts.center.lng, opts.center.lat],
      zoom: toMl(clamp(opts.zoom, MIN_ZOOM, MAX_ZOOM)),
      minZoom: toMl(MIN_ZOOM),
      maxZoom: toMl(MAX_ZOOM),
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
    });
    this.map = map;
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.getCanvasContainer().append(this.overlay);
    // Liberty references a few icons its sprite doesn't ship: use a transparent placeholder
    // instead of letting MapLibre warn for each one.
    map.setMissingStyleImageResolver((id) => {
      if (!map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
    map.setStyle(OSM_STYLE_URL, { transformStyle });

    // MapLibre logs unhandled 'error' events to the console; tile hiccups are not fatal here.
    let loaded = false;
    const onError = () => {
      /* swallowed: transient tile/glyph errors; a dead style is caught by the load timeout */
    };
    map.on('error', onError);

    // 'style.load' only needs the network; 'load' also needs a rendered frame, which never comes
    // while the tab is in the background (rAF is paused). Waiting on 'load' alone made a map
    // opened in a background tab fail after the timeout, so either event counts as loaded.
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Map style did not load')), LOAD_TIMEOUT_MS);
      const done = () => {
        if (loaded) return;
        window.clearTimeout(timer);
        loaded = true;
        resolve();
      };
      map.once('style.load', done);
      map.once('load', done);
      map.once('load', () => markMapPainted());
      this.offs.push(() => window.clearTimeout(timer));
    });
    if (this.destroyed || !loaded) return;

    this.measure();
    this.wire(map);
    this.layoutNow();
    this.emitMoveEnd();
    this.zoomChange.emit(fromMl(map.getZoom()));
  }

  private wire(map: MlMap): void {
    const subs = [
      map.on('move', () => this.layoutNow()),
      map.on('resize', () => {
        this.measure();
        this.layoutNow();
      }),
      map.on('moveend', () => {
        this.layoutNow();
        this.emitMoveEnd();
        this.pins.declutter();
      }),
      map.on('zoomend', () => this.zoomChange.emit(fromMl(map.getZoom()))),
      map.on('dragstart', () => this.gesture.emit()),
      map.on('click', (e) => this.onClick(e)),
    ];
    for (const id of POI_LAYERS) {
      if (!map.getLayer(id)) continue;
      subs.push(
        map.on('mouseenter', id, () => {
          this.poiHover++;
          map.getCanvas().style.cursor = 'pointer';
        }),
        map.on('mouseleave', id, () => {
          this.poiHover = Math.max(0, this.poiHover - 1);
          if (!this.poiHover) map.getCanvas().style.cursor = '';
        }),
      );
    }
    for (const sub of subs) this.offs.push(() => sub.unsubscribe());
  }

  private onClick(e: MapEventType['click']): void {
    const map = this.map;
    if (!map) return;
    const target = e.originalEvent?.target;
    if (target instanceof Element && target.closest('.pin')) return; // pin clicks are handled by the pin layer
    const ll = { lat: e.lngLat.lat, lng: e.lngLat.lng };
    const layers = POI_LAYERS.filter((id) => !!map.getLayer(id));
    let features: MapGeoJSONFeature[] = [];
    if (layers.length) {
      try {
        features = map.queryRenderedFeatures(e.point, { layers });
      } catch {
        features = [];
      }
    }
    const f = features.find((x) => typeof x.properties?.name === 'string' && x.properties.name) ?? features[0];
    if (f) {
      const location = featureLocation(f, ll);
      const props: Record<string, unknown> = { ...(f.properties ?? {}), ...osmIdentity(f.id) };
      let place: Place | undefined;
      try {
        place = placeFromOsmFeature(props, location);
      } catch {
        place = undefined;
      }
      if (place) {
        this.placeClick.emit({ id: place.id, source: 'osm', location, place });
        return;
      }
    }
    this.mapClick.emit(ll);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.offs) off();
    this.offs = [];
    this.pins.destroy();
    this.overlay.remove();
    try {
      this.map?.remove();
    } catch {
      /* already torn down */
    }
    this.map = null;
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
  }

  /* -------------------------------------------------------------- layout */

  private measure(): void {
    const c = this.map?.getContainer();
    if (c) this.size = { width: c.clientWidth, height: c.clientHeight };
  }

  private layoutNow(): void {
    const map = this.map;
    if (!map || this.destroyed) return;
    const project: Projector = (ll) => {
      const p = map.project([ll.lng, ll.lat]);
      return { cx: p.x, cy: p.y, px: p.x, py: p.y };
    };
    this.pins.layout(project, this.size.width, this.size.height, fromMl(map.getZoom()));
  }

  private emitMoveEnd(): void {
    const map = this.map;
    if (!map) return;
    const c = map.getCenter();
    this.moveEnd.emit({ center: { lat: c.lat, lng: c.lng }, zoom: fromMl(map.getZoom()), bounds: this.getBounds() });
  }

  /* -------------------------------------------------------------- camera */

  flyTo(center: LatLng, zoom?: number, opts: { animate?: boolean } = {}): void {
    const map = this.map;
    if (!map) return;
    const z = zoom == null ? undefined : toMl(clamp(zoom, MIN_ZOOM, MAX_ZOOM));
    const animate = opts.animate ?? !prefersReducedMotion();
    const bounds = this.getBounds();
    const target = { center: [center.lng, center.lat] as [number, number], ...(z != null ? { zoom: z } : {}) };
    if (!animate || !bounds || !withinOneViewport(bounds, center)) map.jumpTo(target);
    else map.easeTo({ ...target, duration: 600 });
  }

  fitBounds(bounds: Bounds, paddingPx = 64): void {
    this.fitBoundsPadded(bounds, { top: paddingPx, right: paddingPx, bottom: paddingPx, left: paddingPx }, true);
  }

  fitBoundsPadded(bounds: Bounds, padding: MapPadding, animate: boolean): void {
    const map = this.map;
    if (!map) return;
    try {
      map.fitBounds(
        [
          [bounds.west, bounds.south],
          [bounds.east, bounds.north],
        ],
        { padding, maxZoom: toMl(17), animate: animate && !prefersReducedMotion(), duration: 600 },
      );
    } catch {
      /* padding larger than the container: ignore */
    }
  }

  setZoom(zoom: number): void {
    this.map?.zoomTo(toMl(clamp(zoom, MIN_ZOOM, MAX_ZOOM)), { duration: prefersReducedMotion() ? 0 : 250 });
  }

  getZoomLimits(): { min: number; max: number } {
    return { min: MIN_ZOOM, max: MAX_ZOOM };
  }

  panBy(dx: number, dy: number, animate: boolean): void {
    this.map?.panBy([dx, dy], { animate, duration: 300 });
  }

  panTo(ll: LatLng, animate: boolean): void {
    this.map?.panTo([ll.lng, ll.lat], { animate, duration: 400 });
  }

  /** OpenFreeMap has no imagery; the Layers UI disables Satellite on this provider. */
  setMapType(type: MapType): void {
    this.mapType = type;
  }

  setLayers(layers: LayersState): void {
    this.pins.setLayers(layers);
  }

  resize(): void {
    const map = this.map;
    if (!map) return;
    map.resize();
    this.measure();
    this.layoutNow();
    this.pins.scheduleDeclutter();
  }

  getCenter(): LatLng {
    const c = this.map?.getCenter();
    return c ? { lat: c.lat, lng: c.lng } : { lat: 0, lng: 0 };
  }

  getZoom(): number {
    return this.map ? fromMl(this.map.getZoom()) : 0;
  }

  getBounds(): Bounds | null {
    const b = this.map?.getBounds();
    if (!b) return null;
    return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
  }

  getSize(): { width: number; height: number } {
    this.measure();
    return this.size;
  }

  toContainerPoint(ll: LatLng): ContainerPoint | null {
    const map = this.map;
    if (!map) return null;
    const p = map.project([ll.lng, ll.lat]);
    return { x: p.x, y: p.y };
  }

  /** Current (provider-supported) map type. */
  getMapType(): MapType {
    return this.mapType === 'hybrid' ? 'roadmap' : this.mapType;
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
