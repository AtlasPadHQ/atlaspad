import { describe, expect, it } from 'vitest';
import { createMockCoins } from '../data/mockCoins';
import type { Coin, Place, PlaceSuggestion } from '../types';
import { buildDropdown, MAX_ROWS, type DropdownInput } from './dropdownModel';

const SEEDS = new Set(['KEBAB', 'BEAN', 'FADE', 'PEPI', 'CROW', 'LATE', 'NOODL', 'SIMIT']);
const coins: Record<string, Coin> = Object.fromEntries(
  createMockCoins(150, Date.now())
    .filter((c) => SEEDS.has(c.ticker) && c.place.location.lat > 51.5 && c.place.location.lat < 51.6)
    .map((c) => [c.placeId, c]),
);
const kebab = Object.values(coins).find((c) => c.ticker === 'KEBAB')!;

const sugg = (id: string, main: string, source: PlaceSuggestion['source'] = 'google'): PlaceSuggestion => ({
  kind: 'place',
  id,
  source,
  main,
  secondary: 'Kingsland Rd, London',
  types: ['restaurant', 'establishment'],
});

const base = (over: Partial<DropdownInput> = {}): DropdownInput => ({
  open: true,
  q: '',
  isLink: false,
  tipFirst: false,
  recent: [],
  coins,
  places: { status: 'idle', q: '', items: [] },
  queryFilter: null,
  online: true,
  mobile: false,
  provider: 'google',
  viewportBounds: { north: 51.556, south: 51.538, east: -0.055, west: -0.088 },
  recentPlace: () => undefined,
  ...over,
});

const kinds = (out: ReturnType<typeof buildDropdown>) =>
  out.blocks.map((b) => (b.kind === 'row' ? `row:${b.row.kind}` : b.kind === 'header' ? `h:${b.label}` : b.kind));

describe('search dropdown model', () => {
  it('closed → nothing', () => {
    expect(buildDropdown(base({ open: false, q: 'kebab' })).blocks).toEqual([]);
  });

  it('empty input → Recent (coins + session places, max 5) then the link tip', () => {
    const place: Place = {
      id: 'ChIJabc1234567890',
      source: 'google',
      name: 'Kebab Junction',
      category: 'kebab',
      categoryLabel: 'Kebab shop',
      emoji: '🥙',
      location: { lat: 51.5, lng: -0.07 },
    };
    const out = buildDropdown(
      base({
        recent: [kebab.placeId, 'ChIJabc1234567890', 'ChIJunknownXXXXXX'],
        recentPlace: (id) => (id === place.id ? place : undefined),
      }),
    );
    expect(kinds(out)).toEqual(['h:Recent', 'row:coin', 'row:place', 'tip']);
    expect(out.rows).toHaveLength(2);
  });

  it('tip first when the rocket / an empty state asked for it', () => {
    expect(kinds(buildDropdown(base({ tipFirst: true })))).toEqual(['tip']);
  });

  it('a Google Maps link → only the link row', () => {
    expect(kinds(buildDropdown(base({ q: 'https://maps.app.goo.gl/x', isLink: true })))).toEqual(['row:link']);
  });

  it('Coins → Places (category row first) with 2 skeletons while loading', () => {
    const out = buildDropdown(base({ q: 'kebab', queryFilter: 'kebab', places: { status: 'loading', q: 'kebab', items: [] } }));
    expect(kinds(out)).toEqual(['h:Coins', 'row:coin', 'h:Places', 'row:query', 'skeleton', 'skeleton']);
    const query = out.rows.find((r) => r.kind === 'query');
    // no count until the shared category list is known (never a number that disagrees with it)
    expect(query).toMatchObject({ filter: 'kebab', count: null });
    const counted = buildDropdown(base({ q: 'kebab', queryFilter: 'kebab', queryCount: 22, places: { status: 'loading', q: 'kebab', items: [] } }));
    expect(counted.rows.find((r) => r.kind === 'query')).toMatchObject({ filter: 'kebab', count: 22 });
  });

  it('caps the dropdown at 8 rows and never repeats a coin as a place', () => {
    const items = [sugg(kebab.placeId, 'Bosphorus'), ...Array.from({ length: 10 }, (_, i) => sugg(`ChIJplace${i}XXXXXXXX`, `Kebab ${i}`))];
    const out = buildDropdown(base({ q: 'kebab', queryFilter: 'kebab', places: { status: 'ready', q: 'kebab', items } }));
    expect(out.rows.length).toBeLessThanOrEqual(MAX_ROWS);
    expect(out.rows.filter((r) => r.kind === 'place')).toHaveLength(5);
    expect(out.rows.some((r) => r.kind === 'place' && r.s.id === kebab.placeId)).toBe(false);
  });

  it('marks places that already have a coin', () => {
    const out = buildDropdown(base({ q: 'bospho', places: { status: 'ready', q: 'bospho', items: [sugg(kebab.placeId, 'Bosphorus Grill')] } }));
    // name match → shown in Coins, so the duplicate place row is dropped
    expect(out.rows.map((r) => r.kind)).toEqual(['coin']);
  });

  it('no results → the search_off row; offline → unavailable row (coins still work)', () => {
    expect(kinds(buildDropdown(base({ q: 'zzzz', places: { status: 'ready', q: 'zzzz', items: [] } })))).toEqual(['empty']);
    expect(kinds(buildDropdown(base({ q: 'pepi', online: false })))).toEqual(['h:Coins', 'row:coin', 'offline']);
    expect(kinds(buildDropdown(base({ q: 'zzzz', places: { status: 'error', q: 'zzzz', items: [] } })))).toEqual(['offline']);
  });

  it('mobile + Google rows → "Google Maps" credit row', () => {
    const p = { status: 'ready' as const, q: 'cafe', items: [sugg('ChIJcafeXXXXXXXXXX', 'Cafe Oto')] };
    expect(kinds(buildDropdown(base({ q: 'cafe', places: p, mobile: true }))).at(-1)).toBe('credit');
    expect(kinds(buildDropdown(base({ q: 'cafe', places: p, mobile: false }))).at(-1)).not.toBe('credit');
    expect(kinds(buildDropdown(base({ q: 'cafe', places: p, mobile: true, provider: 'demo' }))).at(-1)).not.toBe('credit');
  });

  it('one-letter query: coin prefix matches only, else the tip', () => {
    const k = buildDropdown(base({ q: 'k' }));
    expect(kinds(k)[0]).toBe('h:Coins');
    expect(k.rows.every((r) => r.kind === 'coin')).toBe(true);
    expect(k.rows[0]).toMatchObject({ coin: { ticker: 'KEBAB' } }); // ticker prefix beats name prefix
    expect(kinds(buildDropdown(base({ q: 'q' })))).toEqual(['tip']);
  });
});
