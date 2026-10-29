/**
 * MAP-internal adapter contract: the shared `MapAdapter` (src/types.ts) plus the few extra
 * hooks MapView needs for §4.5 viewport rules, zoom controls and pin events.
 * Only src/map talks to adapters.
 */
import type { Bounds, LatLng, MapAdapter, Unsubscribe } from '../../types';

export interface ContainerPoint {
  x: number;
  y: number;
}

/** Padding (CSS px) for fitBounds. */
export interface MapPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CsMapAdapter extends MapAdapter {
  /** Size of the map container in CSS px (0×0 before mount). */
  getSize(): { width: number; height: number };
  /** Container pixel of a lat/lng (null before the projection is ready). */
  toContainerPoint(ll: LatLng): ContainerPoint | null;
  /** Pan by a pixel offset (positive = content moves up/left, i.e. the camera moves right/down). */
  panBy(dx: number, dy: number, animate: boolean): void;
  panTo(ll: LatLng, animate: boolean): void;
  /** fitBounds with per-side padding (MapAdapter.fitBounds takes a single number). */
  fitBoundsPadded(bounds: Bounds, padding: MapPadding, animate: boolean): void;
  /** Zoom changed (Google zoom units, integers on Google, fractional on MapLibre). */
  onZoomChange(cb: (zoom: number) => void): Unsubscribe;
  /** A search-result pin was clicked. */
  onResultClick(cb: (placeId: string) => void): Unsubscribe;
  /** The selected balloon was clicked (`fromKeyboard` = activated with Enter/Space). */
  onSelectedClick(cb: (fromKeyboard: boolean) => void): Unsubscribe;
}
