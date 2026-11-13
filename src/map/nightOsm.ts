/**
 * Night palette for the OpenStreetMap (OpenFreeMap liberty) fallback: a lazy chunk, loaded by the MapLibre adapter
 * only when Night is on (see src/map/night.ts). Every colour keeps its hue and moves to a dark palette by role;
 * NIGHT_RECOLOUR sets the main layers outright. Pure functions, unit-tested directly.
 */
import { NIGHT_BG } from './night';

const ROAD = '#3a4458';
const CASING = '#141925';
const MOTORWAY = '#58513f';
const MOTORWAY_CASING = '#272419';

/** Set colours for the layers the day style recolours too (same layer ids as maplibre.ts RECOLOUR). */
export const NIGHT_RECOLOUR: Record<string, Record<string, unknown>> = {
  background: { 'background-color': NIGHT_BG },
  // the Natural Earth shaded-relief raster drawn at low zoom: dimmed so it doesn't wash the dark map out
  natural_earth: { 'raster-brightness-max': 0.3, 'raster-saturation': -0.5 },
  water: { 'fill-color': '#0e1a2b' },
  waterway_river: { 'line-color': '#1a3150' },
  waterway_other: { 'line-color': '#1a3150' },
  waterway_tunnel: { 'line-color': '#1a3150' },
  park: { 'fill-color': '#173226', 'fill-opacity': 0.85 },
  landcover_wood: { 'fill-color': '#182d24' },
  landcover_grass: { 'fill-color': '#182d24' },
  landuse_residential: { 'fill-color': 'rgba(38,46,62,0.45)' },
  building: { 'fill-color': '#232b3b' },
  'building-3d': { 'fill-extrusion-color': '#252e3e', 'fill-extrusion-opacity': 0.55 },
  road_trunk_primary: { 'line-color': ROAD },
  road_secondary_tertiary: { 'line-color': ROAD },
  road_link: { 'line-color': ROAD },
  bridge_trunk_primary: { 'line-color': ROAD },
  bridge_secondary_tertiary: { 'line-color': ROAD },
  bridge_link: { 'line-color': ROAD },
  road_trunk_primary_casing: { 'line-color': CASING },
  road_secondary_tertiary_casing: { 'line-color': CASING },
  road_link_casing: { 'line-color': CASING },
  bridge_trunk_primary_casing: { 'line-color': CASING },
  bridge_secondary_tertiary_casing: { 'line-color': CASING },
  bridge_link_casing: { 'line-color': CASING },
  road_motorway: { 'line-color': MOTORWAY },
  road_motorway_link: { 'line-color': MOTORWAY },
  bridge_motorway: { 'line-color': MOTORWAY },
  bridge_motorway_link: { 'line-color': MOTORWAY },
  road_motorway_casing: { 'line-color': MOTORWAY_CASING },
  road_motorway_link_casing: { 'line-color': MOTORWAY_CASING },
  bridge_motorway_casing: { 'line-color': MOTORWAY_CASING },
  bridge_motorway_link_casing: { 'line-color': MOTORWAY_CASING },
};

type Rgba = { r: number; g: number; b: number; a: number };
/** fill = areas, line = lines and outlines, text = labels and icons, halo = the outline around labels. */
export type ColourRole = 'fill' | 'line' | 'text' | 'halo';

const NAMED: Record<string, Rgba> = {
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Parses the CSS colours MapLibre styles use: #rgb[a], #rrggbb[aa], rgb[a](), hsl[a](), white, black. */
export function parseColour(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  const named = NAMED[s];
  if (named) return { ...named };
  if (s.startsWith('#')) {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = [...h].map((c) => parseInt(c + c, 16));
      return { r: r ?? 0, g: g ?? 0, b: b ?? 0, a: a === undefined ? 1 : a / 255 };
    }
    if (h.length === 6 || h.length === 8) {
      const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
    }
    return null;
  }
  const m = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(s);
  if (!m) return null;
  const parts = (m[2] ?? '').split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (p: string, scale: number) => (p.endsWith('%') ? (parseFloat(p) / 100) * scale : parseFloat(p));
  const alpha = parts[3] === undefined ? 1 : clamp01(num(parts[3], 1));
  if (m[1]?.startsWith('rgb')) {
    const [r, g, b] = parts.slice(0, 3).map((p) => num(p, 255));
    if ([r, g, b].some((v) => v === undefined || !Number.isFinite(v))) return null;
    return { r: r as number, g: g as number, b: b as number, a: alpha };
  }
  const hue = parseFloat(parts[0] ?? '');
  const sat = parseFloat(parts[1] ?? '') / 100;
  const light = parseFloat(parts[2] ?? '') / 100;
  if (![hue, sat, light].every(Number.isFinite)) return null;
  return { ...hslToRgb(hue, clamp01(sat), clamp01(light)), a: alpha };
}

function rgbToHsl({ r, g, b }: Rgba): { h: number; s: number; l: number } {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: h * 60, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
}

/** Lightness (0-1) of a colour, for tests and checks. */
export function lightness(input: string): number | null {
  const c = parseColour(input);
  return c ? rgbToHsl(c).l : null;
}

/**
 * The night version of one colour, keeping its hue: areas go dark, lines a little lighter than the land,
 * labels light, label halos near-black. Colours it can't read come back unchanged.
 */
export function nightColour(input: string, role: ColourRole): string {
  const c = parseColour(input);
  if (!c) return input;
  const { h, s, l } = rgbToHsl(c);
  let L: number;
  let S: number;
  switch (role) {
    case 'fill':
      L = Math.min(0.3, Math.max(0.07, 0.1 + (1 - l) * 0.3));
      S = s * 0.5;
      break;
    case 'line':
      L = 0.14 + l * 0.14;
      S = s * 0.55;
      break;
    case 'text':
      L = Math.min(0.9, Math.max(0.55, 0.94 - l * 0.6));
      S = s * 0.6;
      break;
    case 'halo':
      L = 0.09;
      S = s * 0.3;
      break;
  }
  const { r, g, b } = hslToRgb(h, clamp01(S), clamp01(L));
  const a = Math.round(c.a * 1000) / 1000;
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

/** Which role a paint property's colour plays (null: not a colour property). */
export function colourRole(prop: string): ColourRole | null {
  if (!prop.endsWith('-color')) return null;
  if (prop === 'text-halo-color' || prop === 'icon-halo-color') return 'halo';
  if (prop === 'text-color' || prop === 'icon-color') return 'text';
  if (prop === 'line-color' || prop === 'fill-outline-color') return 'line';
  return 'fill';
}

/** Every colour string inside a paint value (plain, expression or legacy `{stops}` function) → night. */
function nightValue(v: unknown, role: ColourRole): unknown {
  if (typeof v === 'string') return nightColour(v, role);
  if (Array.isArray(v)) return v.map((x) => nightValue(x, role));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.stops)) return { ...o, stops: o.stops.map((st) => (Array.isArray(st) ? [st[0], nightValue(st[1], role)] : st)) };
  }
  return v;
}

/** One layer's paint at night: every colour property moved to the dark palette. */
export function nightPaint(paint: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!paint) return paint;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(paint)) {
    const role = colourRole(k);
    out[k] = role ? nightValue(v, role) : v;
  }
  return out;
}
