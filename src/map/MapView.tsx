/**
 * Full-screen map (DESIGN §4, §7, §9.4, §13.5). Contract: default export, no props; renders
 * `<div id="mapwrap"><div id="map" tabIndex={0} aria-label="Map" /></div>` (positioned by App.css).
 *
 * Mounts one MapController per provider: Google (raster default basemap + one OverlayView of
 * HTML pins) when `store.provider === 'google'`, MapLibre + OpenFreeMap otherwise. If Google
 * fails (no key, script/network error, `gm_authFailure`, timeout) the store switches to the
 * MapLibre provider and a toast explains it; the "Basic map" chip (shared) stays visible.
 * The adapters render into a child of #map, so React never fights Google/MapLibre over the DOM.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { Button, Icon } from '../ui';
import { MapController } from './controller';
import './map.css';

const FALLBACK_TOAST = 'Google Maps is unavailable. Showing OpenStreetMap; launching is paused.';

export default function MapView() {
  const provider = useStore((s) => s.provider);
  const hostRef = useRef<HTMLDivElement>(null);
  const [fatal, setFatal] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // A layout effect, not a passive one: the map (and Google's first-view preview request) starts in the same task as the
  // first commit instead of after the first paint, which is ~0.1-0.3 s later on a slow phone (LCP, INTEGRATION §8).
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ctrl = new MapController(host, provider, {
      onGoogleFailed: () => {
        const st = useStore.getState();
        if (st.provider !== 'google') return;
        st.setProvider('demo', 'load-failed');
        st.toast(FALLBACK_TOAST, 'info', undefined, 'info');
      },
      onFatal: () => setFatal(true),
    });
    void ctrl.start();
    return () => ctrl.dispose();
  }, [provider, attempt]);

  return (
    <div id="mapwrap">
      <div id="map" ref={hostRef} tabIndex={0} role="region" aria-label="Map" />
      {fatal ? (
        <div className="map-fail" role="alert">
          <div className="map-fail-card">
            <Icon name="wifi_off" className="map-fail-ic" />
            <p className="map-fail-t">The map couldn't load</p>
            <p className="map-fail-s">Check your connection and try again. Search and the coin lists still work.</p>
            <Button
              variant="text"
              icon="refresh"
              onClick={() => {
                setFatal(false);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
