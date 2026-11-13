import { describe, expect, it } from 'vitest';
import {
  colourRole,
  isMapType,
  lightness,
  MAP_TYPE_LIST,
  NIGHT_BG,
  NIGHT_GOOGLE_STYLES,
  NIGHT_RECOLOUR,
  nightColour,
  nightPaint,
  parseColour,
} from './night';

const L = (c: string) => {
  const l = lightness(c);
  if (l === null) throw new Error(`unreadable colour ${c}`);
  return l;
};

describe('map types', () => {
  it('knows the three map types and nothing else', () => {
    expect(MAP_TYPE_LIST).toEqual(['roadmap', 'hybrid', 'night']);
    for (const t of MAP_TYPE_LIST) expect(isMapType(t)).toBe(true);
    for (const v of ['satellite', 'terrain', '', null, undefined, 3, {}]) expect(isMapType(v)).toBe(false);
  });
});

describe('parseColour', () => {
  it('reads the colour forms map styles use', () => {
    expect(parseColour('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColour('#f4f2ee')).toEqual({ r: 244, g: 242, b: 238, a: 1 });
    expect(parseColour('#00000080')?.a).toBeCloseTo(0.502, 2);
    expect(parseColour('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColour('rgba(232,230,225,0.45)')).toEqual({ r: 232, g: 230, b: 225, a: 0.45 });
    expect(parseColour('hsl(0, 0%, 100%)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColour('hsla(205, 56%, 73%, 0.5)')?.a).toBe(0.5);
    expect(parseColour('White')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it('leaves anything else alone', () => {
    for (const s of ['zoom', 'linear', 'get', '#ggg', '#12345', 'rgb(1,2)', 'transparentish', '']) expect(parseColour(s)).toBeNull();
    expect(nightColour('linear', 'fill')).toBe('linear');
  });
});

describe('nightColour', () => {
  it('turns light land dark and keeps lines just above it', () => {
    const land = nightColour('#f4f2ee', 'fill');
    const road = nightColour('#ffffff', 'line');
    expect(L(land)).toBeLessThan(0.15);
    expect(L(road)).toBeGreaterThan(L(land));
    expect(L(road)).toBeLessThan(0.35);
  });

  it('makes dark labels light and their white halos near-black', () => {
    expect(L(nightColour('#333333', 'text'))).toBeGreaterThan(0.7);
    expect(L(nightColour('hsl(0,0%,40%)', 'text'))).toBeGreaterThan(0.55);
    expect(L(nightColour('#ffffff', 'halo'))).toBeLessThan(0.12);
  });

  it('keeps transparency', () => {
    expect(nightColour('rgba(232,230,225,0.45)', 'fill')).toMatch(/^rgba\(\d+,\d+,\d+,0\.45\)$/);
    expect(nightColour('#aad3f0', 'fill')).toMatch(/^rgb\(/);
  });
});

describe('nightPaint', () => {
  it('maps colours inside expressions and legacy stop functions, nothing else', () => {
    const out = nightPaint({
      'line-color': ['interpolate', ['linear'], ['zoom'], 5, '#ffffff', 10, 'hsl(0,0%,80%)'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 10, 4],
      'text-color': { stops: [[6, '#333'], [12, '#555']] },
      'text-halo-color': 'rgba(255,255,255,0.8)',
      'fill-opacity': 0.5,
    });
    const line = out?.['line-color'] as unknown[];
    expect(line.slice(0, 3)).toEqual(['interpolate', ['linear'], ['zoom']]);
    expect(L(line[4] as string)).toBeLessThan(0.35);
    expect(L(line[6] as string)).toBeLessThan(0.35);
    expect(out?.['line-width']).toEqual(['interpolate', ['linear'], ['zoom'], 5, 1, 10, 4]);
    const stops = (out?.['text-color'] as { stops: [number, string][] }).stops;
    expect(stops.map((s) => s[0])).toEqual([6, 12]);
    for (const [, c] of stops) expect(L(c)).toBeGreaterThan(0.6);
    expect(out?.['text-halo-color']).toMatch(/^rgba\(\d+,\d+,\d+,0\.8\)$/);
    expect(out?.['fill-opacity']).toBe(0.5);
    expect(nightPaint(undefined)).toBeUndefined();
  });

  it('knows which role each colour property plays', () => {
    expect(colourRole('background-color')).toBe('fill');
    expect(colourRole('fill-extrusion-color')).toBe('fill');
    expect(colourRole('line-color')).toBe('line');
    expect(colourRole('fill-outline-color')).toBe('line');
    expect(colourRole('text-color')).toBe('text');
    expect(colourRole('text-halo-color')).toBe('halo');
    expect(colourRole('line-width')).toBeNull();
  });
});

describe('night palettes', () => {
  it('Google: every colour reads, areas are dark, labels stand out from the land', () => {
    expect(NIGHT_GOOGLE_STYLES.length).toBeGreaterThan(10);
    for (const rule of NIGHT_GOOGLE_STYLES) {
      for (const st of rule.stylers ?? []) {
        const c = (st as { color?: string }).color;
        if (!c) continue;
        const l = L(c);
        if (rule.elementType?.startsWith('labels.text.fill')) expect(l).toBeGreaterThan(L(NIGHT_BG) + 0.15);
        else expect(l).toBeLessThan(0.35);
      }
    }
  });

  it('OpenStreetMap: set colours all read and stay dark', () => {
    for (const [layer, paint] of Object.entries(NIGHT_RECOLOUR)) {
      for (const [prop, v] of Object.entries(paint)) {
        if (!prop.endsWith('-color')) continue;
        expect(typeof v, layer).toBe('string');
        expect(L(v as string), layer).toBeLessThan(0.35);
      }
    }
  });
});
