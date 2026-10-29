/**
 * Tiny MAP-internal bridge between MapView (owns the adapter) and the map chrome
 * (MapControls zoom buttons, LayersTile). Not part of the app store on purpose: zoom ticks would
 * otherwise re-render every store subscriber.
 */
import { useSyncExternalStore } from 'react';
import type { MapProvider, TradeSide } from '../types';
import type { CsMapAdapter } from './adapters/types';

export interface MapCameraState {
  /** An adapter is mounted and interactive. */
  ready: boolean;
  provider: MapProvider | null;
  /** Current zoom (Google units). */
  zoom: number;
  minZoom: number;
  maxZoom: number;
}

let adapter: CsMapAdapter | null = null;
let camera: MapCameraState = { ready: false, provider: null, zoom: 0, minZoom: 0, maxZoom: 22 };
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

export function setActiveAdapter(a: CsMapAdapter | null): void {
  adapter = a;
  if (a) {
    const { min, max } = a.getZoomLimits();
    camera = { ready: true, provider: a.provider, zoom: a.getZoom(), minZoom: min, maxZoom: max };
  } else {
    camera = { ...camera, ready: false, provider: null };
  }
  notify();
}

export function getActiveAdapter(): CsMapAdapter | null {
  return adapter;
}

export function publishZoom(zoom: number): void {
  if (!Number.isFinite(zoom) || Math.abs(zoom - camera.zoom) < 1e-3) return;
  camera = { ...camera, zoom };
  notify();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const getSnapshot = () => camera;

/** Reactive camera state for the map chrome. */
export function useMapCamera(): MapCameraState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Zoom in/out by one level from the current zoom (DESIGN §18.1 "Zoom in / out"). */
export function zoomBy(delta: 1 | -1): void {
  const a = adapter;
  if (!a) return;
  const { min, max } = a.getZoomLimits();
  const next = Math.min(max, Math.max(min, Math.round(a.getZoom()) + delta));
  a.setZoom(next);
}

/**
 * Real mode: buy/sell flash on a pin from a market delta (INTEGRATION.md §5.2 — pin flashes come
 * from `/api/market` reserve changes, not feed rows). Honours the Layers "Flashes" toggle and
 * skips hidden tabs. `label` like "+1.2 SOL".
 */
export function flashPin(placeId: string, side: TradeSide, label: string, enabled: boolean): void {
  if (!enabled || !adapter || (typeof document !== 'undefined' && document.hidden)) return;
  adapter.flashCoin(placeId, side, label);
}

/* ------------------------------------------------------------------ first view painted */

let painted = false;
const paintedWaiters = new Set<() => void>();

/** The map's first view has its imagery (Google `tilesloaded`, MapLibre `load`). Idempotent. */
export function markMapPainted(): void {
  if (painted) return;
  painted = true;
  for (const w of [...paintedWaiters]) w();
  paintedWaiters.clear();
}

/**
 * Resolves once the first map view has painted, or after `timeoutMs` (a hidden tab or a failed map must not hold
 * anything back for ever). Non-urgent downloads (modal chunks) wait for this, so on a slow connection they do not
 * compete with the map tiles for bandwidth (INTEGRATION §8, LCP).
 */
export function whenMapPainted(timeoutMs = 12_000): Promise<void> {
  if (painted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      paintedWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    paintedWaiters.add(done);
  });
}
