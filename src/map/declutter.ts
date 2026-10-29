/**
 * Pin label declutter (DESIGN §7.2): pure geometry, no DOM.
 *
 *  - Label right (default): `left:21px; top:-17px` from the anchor.
 *  - Label left (`.pin.left`): when the right label would collide with a higher-priority pin's
 *    label/marker or leave the visible map.
 *  - Label hidden (`.pin.nolabel`): still colliding after flipping. Marker only; the label shows on
 *    hover/focus.
 *  - Priority: selected (passed as `reserved`) > higher market cap (the order of `items`).
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LabelSide = 'right' | 'left' | 'hidden';

export interface DeclutterItem {
  id: string;
  /** Anchor in container px. */
  x: number;
  y: number;
  /** Measured label width (px). */
  labelW: number;
}

/** Geometry of the default (unselected) pin, from DESIGN §7.1. */
export const PIN_BOX = {
  /** Marker radius incl. the 2px white ring + 2px green outer ring (30px circle, ring inset −4px). */
  markerR: 19,
  /** Label offset from the anchor (left:21px / right:21px). */
  labelGap: 21,
  /** Label top (top:-17px). */
  labelTop: -17,
  /** Label height: 17px ticker line + 14px meta line. */
  labelH: 31,
} as const;

/** Selected balloon geometry (§7.1 `.pin.sel`). */
export const SEL_BOX = {
  balloon: { x: -20, y: -54, w: 40, h: 54 },
  labelLeft: 24,
  labelTop: -46,
  /** 19px ticker line + 16px meta line. */
  labelH: 35,
} as const;

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function hitsAny(r: Rect, placed: readonly Rect[]): boolean {
  for (const p of placed) if (intersects(r, p)) return true;
  return false;
}

function inside(r: Rect, width: number, height: number): boolean {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= width && r.y + r.h <= height;
}

export function labelRect(item: DeclutterItem, side: 'right' | 'left'): Rect {
  const { labelGap, labelTop, labelH } = PIN_BOX;
  return side === 'right'
    ? { x: item.x + labelGap, y: item.y + labelTop, w: item.labelW, h: labelH }
    : { x: item.x - labelGap - item.labelW, y: item.y + labelTop, w: item.labelW, h: labelH };
}

export function markerRect(item: Pick<DeclutterItem, 'x' | 'y'>): Rect {
  const r = PIN_BOX.markerR;
  return { x: item.x - r, y: item.y - r, w: r * 2, h: r * 2 };
}

/** Rects the selected balloon occupies (balloon + its label). */
export function selectedRects(x: number, y: number, labelW: number): Rect[] {
  const b = SEL_BOX.balloon;
  return [
    { x: x + b.x, y: y + b.y, w: b.w, h: b.h },
    { x: x + SEL_BOX.labelLeft, y: y + SEL_BOX.labelTop, w: labelW, h: SEL_BOX.labelH },
  ];
}

/**
 * Decide a label side for each item. `items` must be in priority order (market cap, descending)
 * and contain only pins that are rendered in (or near) the viewport.
 */
export function declutterLabels(
  items: readonly DeclutterItem[],
  opts: { width: number; height: number; reserved?: readonly Rect[] },
): Map<string, LabelSide> {
  const placed: Rect[] = [...(opts.reserved ?? [])];
  const out = new Map<string, LabelSide>();
  for (const item of items) {
    const right = labelRect(item, 'right');
    const left = labelRect(item, 'left');
    const rHit = hitsAny(right, placed);
    const lHit = hitsAny(left, placed);
    let side: LabelSide;
    if (!rHit && inside(right, opts.width, opts.height)) side = 'right';
    else if (!lHit && inside(left, opts.width, opts.height)) side = 'left';
    else if (!rHit) side = 'right';
    else if (!lHit) side = 'left';
    else side = 'hidden';
    placed.push(markerRect(item));
    if (side !== 'hidden') placed.push(side === 'right' ? right : left);
    out.set(item.id, side);
  }
  return out;
}
