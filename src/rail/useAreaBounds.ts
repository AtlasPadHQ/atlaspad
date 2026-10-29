/**
 * "This area" bounds (DESIGN §6.5): the map's current bounds, recomputed on map idle with a
 * 300ms debounce. Before the map has published a viewport, `ready` is false; after 600ms the
 * bounds fall back to an estimate from the initial camera and the window size so the card never
 * hangs in its skeleton state. OWNED BY RAIL+FEED (used by the This area card, Top shops and
 * Launched "This area" scopes).
 */
import { useEffect, useRef, useState } from 'react';
import { AREA_MIN_ZOOM } from '../config';
import { metersPerPixel } from '../lib/geo';
import { initialCamera, useStore } from '../store';
import type { Bounds, LatLng, Viewport } from '../types';

export interface AreaBounds {
  bounds: Bounds | null;
  zoom: number;
  /** True once the map published a viewport, or the 600ms fallback kicked in. */
  ready: boolean;
  /** Zoomed out below AREA_MIN_ZOOM ("Zoom in to see shops"). */
  zoomedOut: boolean;
}

/** Approximate bounds of a `w`×`h` px map at `center`/`zoom` (Web Mercator). */
export function approxBounds(center: LatLng, zoom: number, w: number, h: number): Bounds {
  const mpp = metersPerPixel(zoom, center.lat);
  const dLat = (h / 2) * mpp / 111_320;
  const dLng = ((w / 2) * mpp) / (111_320 * Math.max(0.2, Math.cos((center.lat * Math.PI) / 180)));
  return { north: Math.min(90, center.lat + dLat), south: Math.max(-90, center.lat - dLat), east: center.lng + dLng, west: center.lng - dLng };
}

function windowBounds(center: LatLng, zoom: number): Bounds {
  const w = typeof window === 'undefined' ? 1200 : Math.max(320, window.innerWidth - 72);
  const h = typeof window === 'undefined' ? 800 : Math.max(320, window.innerHeight);
  return approxBounds(center, zoom, w, h);
}

function fallback(): { bounds: Bounds; zoom: number } {
  const cam = initialCamera(!useStore.getState().heroDismissed);
  return { bounds: windowBounds(cam.center, cam.zoom), zoom: cam.zoom };
}

function fromViewport(v: Viewport): { bounds: Bounds; zoom: number; ready: true } {
  return { bounds: v.bounds ?? windowBounds(v.center, v.zoom), zoom: v.zoom, ready: true };
}

export function useAreaBounds(): AreaBounds {
  const viewport = useStore((s) => s.viewport);
  const [state, setState] = useState<{ bounds: Bounds | null; zoom: number; ready: boolean }>(() =>
    viewport ? fromViewport(viewport) : { bounds: null, zoom: 15, ready: false },
  );

  // follow the map (debounced 300ms; the first real viewport applies immediately)
  const applied = useRef(viewport != null);
  useEffect(() => {
    if (!viewport) return;
    const next = fromViewport(viewport);
    if (!applied.current) {
      applied.current = true;
      setState(next);
      return;
    }
    const t = setTimeout(() => setState(next), 300);
    return () => clearTimeout(t);
  }, [viewport]);

  // no map yet after 600ms → estimate from the initial camera
  useEffect(() => {
    if (state.ready) return;
    const t = setTimeout(() => {
      if (useStore.getState().viewport) return;
      const f = fallback();
      setState({ bounds: f.bounds, zoom: f.zoom, ready: true });
    }, 600);
    return () => clearTimeout(t);
  }, [state.ready]);

  return { ...state, zoomedOut: state.ready && state.zoom < AREA_MIN_ZOOM };
}
