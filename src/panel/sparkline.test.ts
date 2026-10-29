// The sparkline never stretches float noise or a dust move to the full height (a fake crash or spike at "now").
import { describe, expect, it } from 'vitest';
import { sparkPoints } from './Sparkline';

const H = 32;
const MID = (H + 2) / 2; // middle of the drawing band (6 … H - 4)
const ys = (prices: number[]) => sparkPoints(prices, 200, H, true).map((p) => p.y);

describe('sparkPoints', () => {
  it('a real move fills the band, as before', () => {
    const [a, b] = ys([1, 2]);
    expect(a).toBeCloseTo(H - 4, 9);
    expect(b).toBeCloseTo(6, 9);
  });

  it('float noise from re-expressing USD (label 0.0%) is drawn flat at mid-height', () => {
    const p = 0.000_003_172;
    for (const y of ys([p, p, p * (1 + 1e-12), p * (1 - 3e-13), p])) expect(y).toBeCloseTo(MID, 6);
    for (const y of ys([5, 5, 5])) expect(y).toBe(MID);
    for (const y of ys([0, 0])) expect(y).toBe(MID);
  });

  it('a small move stays small (the scale covers at least 0.5% of the price)', () => {
    const [a, b] = ys([1, 1.001]); // +0.1%
    expect(a).toBeGreaterThan(b);
    expect(a - b).toBeLessThan((H - 10) / 4);
    expect((a + b) / 2).toBeCloseTo(MID, 9);
    // just over the floor: the whole band again
    const [c, d] = ys([1, 1.01]);
    expect(c).toBeCloseTo(H - 4, 9);
    expect(d).toBeCloseTo(6, 9);
  });

  it('nothing to draw without points or width', () => {
    expect(sparkPoints([], 200, H, true)).toEqual([]);
    expect(sparkPoints([1, 2], 0, H, true)).toEqual([]);
  });
});
