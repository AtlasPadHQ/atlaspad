/**
 * Geo helpers + geolocation wrapper. SHARED (src/lib).
 * Location privacy: user location is never stored and never sent to our server (DESIGN §7.3).
 */
import type { Bounds, LatLng, UserLocation } from '../types';

const R = 6_371_000; // earth radius, m

const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True when `p` is inside `b` (handles antimeridian-crossing boxes). */
export function boundsContains(b: Bounds, p: LatLng): boolean {
  if (p.lat < b.south || p.lat > b.north) return false;
  return b.west <= b.east ? p.lng >= b.west && p.lng <= b.east : p.lng >= b.west || p.lng <= b.east;
}

/** Smallest bounds containing all points (null for an empty list). */
export function boundsFromPoints(points: readonly LatLng[]): Bounds | null {
  if (points.length === 0) return null;
  let north = -90;
  let south = 90;
  let east = -180;
  let west = 180;
  for (const p of points) {
    north = Math.max(north, p.lat);
    south = Math.min(south, p.lat);
    east = Math.max(east, p.lng);
    west = Math.min(west, p.lng);
  }
  return { north, south, east, west };
}

/** Grow bounds by a fraction of their size on each side (0.1 = 10%). Single points get a ~250m box. */
export function padBounds(b: Bounds, frac = 0.1): Bounds {
  const dLat = Math.max(b.north - b.south, 0.0045) * frac + (b.north === b.south ? 0.00225 : 0);
  const dLng = Math.max(b.east - b.west, 0.007) * frac + (b.east === b.west ? 0.0035 : 0);
  return {
    north: Math.min(90, b.north + dLat),
    south: Math.max(-90, b.south - dLat),
    east: b.east + dLng,
    west: b.west - dLng,
  };
}

export function boundsCenter(b: Bounds): LatLng {
  const lng = b.west <= b.east ? (b.west + b.east) / 2 : ((b.west + b.east + 360) / 2) % 360;
  return { lat: (b.north + b.south) / 2, lng: lng > 180 ? lng - 360 : lng };
}

/** Metres per CSS pixel at a Web-Mercator zoom and latitude. */
export function metersPerPixel(zoom: number, lat: number): number {
  return (156_543.03392 * Math.cos(rad(lat))) / 2 ** zoom;
}

/** True when two points are within `m` metres. */
export function near(a: LatLng, b: LatLng, m: number): boolean {
  return distanceM(a, b) <= m;
}

export function sameLatLng(a: LatLng | null | undefined, b: LatLng | null | undefined, eps = 1e-7): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.lat - b.lat) < eps && Math.abs(a.lng - b.lng) < eps;
}

export function isLatLng(v: unknown): v is LatLng {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.lat === 'number' &&
    typeof o.lng === 'number' &&
    Number.isFinite(o.lat) &&
    Number.isFinite(o.lng) &&
    Math.abs(o.lat) <= 90 &&
    Math.abs(o.lng) <= 180
  );
}

export type GeoErrorCode = 'denied' | 'unavailable' | 'timeout' | 'unsupported';

export class GeoError extends Error {
  constructor(public readonly code: GeoErrorCode) {
    super(code);
    this.name = 'GeoError';
  }
}

/**
 * One-shot geolocation (only ever on an explicit user tap — never automatically).
 * `enableHighAccuracy:false`, timeout 10s (DESIGN §7.3). Rejects with GeoError.
 */
export function requestPosition(timeoutMs = 10_000): Promise<UserLocation> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      reject(new GeoError('unsupported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          location: { lat: pos.coords.latitude, lng: pos.coords.longitude },
          accuracy: pos.coords.accuracy,
          ts: pos.timestamp || Date.now(),
        }),
      (err) => {
        const code: GeoErrorCode =
          err.code === err.PERMISSION_DENIED ? 'denied' : err.code === err.TIMEOUT ? 'timeout' : 'unavailable';
        reject(new GeoError(code));
      },
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}
