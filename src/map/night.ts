/**
 * Night map (DESIGN §6.7): the dark basemap behind the `night` map type.
 *  - Google: a `styles` array on the raster roadmap (there is no `mapId`, so JSON styling applies) and a dark
 *    `backgroundColor` until the tiles arrive.
 *  - OpenStreetMap fallback: every colour in the liberty style moves to a dark palette as the style JSON is
 *    committed, with set colours for land, water, parks, buildings and the main roads (src/map/nightOsm.ts, loaded
 *    only when the fallback map turns Night on, so it stays off the initial bundle).
 * Pins keep their own colours; map.css gives them a dark halo and a soft glow while `body.map-night` is set.
 * Pure data (no DOM, no map SDK at runtime); small because it ships on the initial path.
 */
import type { MapType } from '../types';

export const MAP_TYPE_LIST: readonly MapType[] = ['roadmap', 'hybrid', 'night'];

export function isMapType(v: unknown): v is MapType {
  return typeof v === 'string' && (MAP_TYPE_LIST as readonly string[]).includes(v);
}

/** Night land colour; also the colour shown before night tiles load. */
export const NIGHT_BG = '#1b2130';

/** Google raster roadmap at night. Colours only: what the map shows is unchanged. */
export const NIGHT_GOOGLE_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: NIGHT_BG }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8a94a6' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: NIGHT_BG }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#3b4558' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#c8d0dc' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#202838' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#9aa5b5' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#173226' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#5fae86' }] },
  { featureType: 'road', elementType: 'geometry.fill', stylers: [{ color: '#333c4d' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#151a24' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#a4adbb' }] },
  { featureType: 'road', elementType: 'labels.text.stroke', stylers: [{ color: '#151a24' }] },
  { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: '#58513f' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#272419' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#e6cf98' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#29313f' }] },
  { featureType: 'transit.station', elementType: 'labels.text.fill', stylers: [{ color: '#9aa5b5' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1a2b' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4e6684' }] },
  { featureType: 'water', elementType: 'labels.text.stroke', stylers: [{ color: '#0e1a2b' }] },
];
