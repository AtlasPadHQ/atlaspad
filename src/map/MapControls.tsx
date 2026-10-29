/**
 * Desktop/tablet map controls `.mapctl` (DESIGN §6.6): Locate ("Near me") + Zoom in / Zoom out.
 * The map is created with `disableDefaultUI:true`, so these are the only controls; there is no
 * compass (no tilt/rotation on the raster map, and rotation is disabled on MapLibre).
 * Mobile (<768) hides this group: pinch to zoom, and the mobile locate FAB is SEARCH's NearMe.
 * Contract: default export, no props.
 */
import { nearMe } from '../search/actions';
import { useStore } from '../store';
import { Icon } from '../ui';
import { useMapCamera, zoomBy } from './mapBridge';
import './map.css';

export default function MapControls() {
  const status = useStore((s) => s.locateStatus);
  const cam = useMapCamera();
  const locating = status === 'locating';
  const located = status === 'located';
  const canZoomIn = cam.ready && cam.zoom < cam.maxZoom - 1e-3;
  const canZoomOut = cam.ready && cam.zoom > cam.minZoom + 1e-3;

  return (
    <div className="mapctl" role="group" aria-label="Map controls">
      <button
        type="button"
        className={['ctl', 'locate', located ? 'located' : ''].filter(Boolean).join(' ')}
        aria-label="Near me"
        data-tip="Near me"
        aria-busy={locating || undefined}
        onClick={() => {
          void nearMe();
        }}
      >
        {locating ? <Icon name="progress_activity" spin /> : <Icon name="my_location" fill={located} />}
      </button>
      <div className="zoom">
        <button type="button" className="ctl" aria-label="Zoom in" data-tip="Zoom in" disabled={!canZoomIn} onClick={() => zoomBy(1)}>
          <Icon name="add" />
        </button>
        <hr aria-hidden="true" />
        <button type="button" className="ctl" aria-label="Zoom out" data-tip="Zoom out" disabled={!canZoomOut} onClick={() => zoomBy(-1)}>
          <Icon name="remove" />
        </button>
      </div>
    </div>
  );
}
