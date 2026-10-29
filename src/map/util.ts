/**
 * Small MAP-internal helpers: a typed emitter, bounds conversion, "within one viewport" test,
 * safe colour values for pins.
 */
import type { Bounds, LatLng, Unsubscribe } from '../types';

export class Emitter<T> {
  private readonly subs = new Set<(v: T) => void>();

  on(cb: (v: T) => void): Unsubscribe {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }

  emit(v: T): void {
    for (const cb of [...this.subs]) {
      try {
        cb(v);
      } catch (err) {
        // A listener error must not break the map; surface it without throwing.
        console.warn('[map] listener failed', err);
      }
    }
  }

  clear(): void {
    this.subs.clear();
  }
}

/**
 * True when `p` is inside `b` grown by one viewport on every side (DESIGN §14: pan only when
 * the target is within ~1 viewport, otherwise jump).
 */
export function withinOneViewport(b: Bounds, p: LatLng): boolean {
  const h = b.north - b.south;
  const w = b.west <= b.east ? b.east - b.west : b.east + 360 - b.west;
  if (p.lat < b.south - h || p.lat > b.north + h) return false;
  let lng = p.lng;
  if (b.west > b.east && lng < b.west) lng += 360;
  return lng >= b.west - w && lng <= b.west + 2 * w;
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Coin `--bg` from launcher input: only plain hex colours reach CSS. */
export function safeBg(bg: string | undefined): string {
  return bg && HEX_RE.test(bg) ? bg : '#ffffff';
}

/** Valid, non-null-island coordinates (unresolved links use {0,0}). */
export function isUsableLocation(ll: LatLng | null | undefined): ll is LatLng {
  return (
    !!ll &&
    Number.isFinite(ll.lat) &&
    Number.isFinite(ll.lng) &&
    Math.abs(ll.lat) <= 90 &&
    Math.abs(ll.lng) <= 180 &&
    !(ll.lat === 0 && ll.lng === 0)
  );
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
