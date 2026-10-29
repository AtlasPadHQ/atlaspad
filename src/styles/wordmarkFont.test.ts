/**
 * The "CS Wordmark" @font-face (src/styles/global.css) must claim exactly the glyphs of its ATLASPAD-only subset
 * (src/styles/fonts/README.md): a letter outside the unicode-range silently falls back to the body font, which has no
 * wdth axis, so the stretched wordmark and map watermark would mix two fonts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./global.css', import.meta.url), 'utf8');

function wordmarkRange(): Set<number> {
  const face = /@font-face\{[^}]*font-family:"CS Wordmark"[^}]*\}/.exec(css)?.[0] ?? '';
  const range = /unicode-range:([^;}]+)/.exec(face)?.[1] ?? '';
  const out = new Set<number>();
  for (const part of range.split(',')) {
    const [a, b] = part.trim().replace(/^U\+/i, '').split('-');
    const lo = parseInt(a!, 16);
    const hi = b ? parseInt(b, 16) : lo;
    for (let c = lo; c <= hi; c++) out.add(c);
  }
  return out;
}

describe('wordmark font subset', () => {
  it('covers every character of the ATLASPAD wordmark and nothing else', () => {
    const want = new Set([...' ATLASPAD'].map((c) => c.codePointAt(0)!));
    expect([...wordmarkRange()].sort((x, y) => x - y)).toEqual([...want].sort((x, y) => x - y));
  });

  it('the wordmark and watermark render ATLASPAD', () => {
    const tsx = readFileSync(new URL('../ui/Wordmark.tsx', import.meta.url), 'utf8');
    expect(tsx.match(/>\s*ATLASPAD\s*</g)?.length).toBe(2);
  });
});
