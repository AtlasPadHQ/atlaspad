import { describe, expect, it } from 'vitest';
import { declutterLabels, selectedRects } from './declutter';
import { isUsableLocation, safeBg, withinOneViewport } from './util';

describe('declutterLabels', () => {
  const view = { width: 800, height: 600 };

  it('keeps labels on the right when there is room', () => {
    const out = declutterLabels(
      [
        { id: 'a', x: 100, y: 100, labelW: 80 },
        { id: 'b', x: 400, y: 400, labelW: 80 },
      ],
      view,
    );
    expect(out.get('a')).toBe('right');
    expect(out.get('b')).toBe('right');
  });

  it('flips a lower-mcap label left when it would collide on the right', () => {
    const out = declutterLabels(
      [
        { id: 'a', x: 300, y: 200, labelW: 90 },
        { id: 'b', x: 230, y: 205, labelW: 90 },
      ],
      view,
    );
    expect(out.get('a')).toBe('right');
    expect(out.get('b')).toBe('left');
  });

  it('flips left when the right label would leave the visible map', () => {
    const out = declutterLabels([{ id: 'edge', x: 780, y: 300, labelW: 90 }], view);
    expect(out.get('edge')).toBe('left');
  });

  it('hides a label that collides on both sides', () => {
    const out = declutterLabels(
      [
        { id: 'a', x: 300, y: 200, labelW: 90 },
        { id: 'c', x: 160, y: 200, labelW: 90 },
        { id: 'b', x: 250, y: 200, labelW: 90 },
      ],
      view,
    );
    expect(out.get('b')).toBe('hidden');
  });

  it('gives the selected balloon priority over other labels', () => {
    const reserved = selectedRects(300, 300, 100);
    const out = declutterLabels([{ id: 'x', x: 290, y: 270, labelW: 80 }], { ...view, reserved });
    expect(out.get('x')).not.toBe('right');
  });
});

describe('map utils', () => {
  const b = { north: 51.56, south: 51.54, east: -0.06, west: -0.08 };

  it('withinOneViewport accepts near targets and rejects far ones', () => {
    expect(withinOneViewport(b, { lat: 51.55, lng: -0.07 })).toBe(true);
    expect(withinOneViewport(b, { lat: 51.575, lng: -0.05 })).toBe(true);
    expect(withinOneViewport(b, { lat: 48.85, lng: 2.35 })).toBe(false);
  });

  it('safeBg only lets hex colours through', () => {
    expect(safeBg('#ffe4cc')).toBe('#ffe4cc');
    expect(safeBg('red;background:url(x)')).toBe('#ffffff');
    expect(safeBg(undefined)).toBe('#ffffff');
  });

  it('isUsableLocation rejects null island and invalid values', () => {
    expect(isUsableLocation({ lat: 0, lng: 0 })).toBe(false);
    expect(isUsableLocation({ lat: 91, lng: 0 })).toBe(false);
    expect(isUsableLocation({ lat: 51.5, lng: -0.07 })).toBe(true);
  });
});
