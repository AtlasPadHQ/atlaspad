/**
 * Mobile "Near me" locate FAB `.m-fab.locate-fab` (DESIGN §4.4, §6.6, §18.1). OWNED BY SEARCH.
 * (Desktop/tablet locate lives in src/map/MapControls.) Shown < 768px only; hidden while the hero
 * sheet or the full-screen search is up. Sits 40px above the sheet (24px with no sheet).
 *
 * Tap → geolocation (explicit tap only; store.locate: 10 s timeout, user dot, fly to zoom 16,
 * friendly error toasts) → toast with the coins within 2 km. States: idle `my_location` · locating
 * spinner · located `my_location` FILL in --cs-loc (back to idle when the map is dragged away).
 * Contract: default export, no props.
 */
import { useStore } from '../store';
import { Icon } from '../ui';
import { nearMe } from './actions';
import './search.css';

export default function NearMe() {
  const status = useStore((s) => s.locateStatus);
  const locating = status === 'locating';
  return (
    <button
      type="button"
      className={`m-fab locate-fab hit${status === 'located' ? ' located' : ''}`}
      aria-label="Near me"
      aria-busy={locating || undefined}
      onClick={() => void nearMe()}
    >
      <Icon name={locating ? 'progress_activity' : 'my_location'} spin={locating} fill={status === 'located'} />
      {locating ? <span className="sr">Finding your location…</span> : null}
    </button>
  );
}
