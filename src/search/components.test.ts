// Server-render smoke tests for the SEARCH components (no DOM in this repo's test setup):
// they must render every state without throwing and with the DESIGN copy / ARIA in place.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// No DOM here, and zustand's server snapshot is the store's *initial* state — so for these SSR
// smoke tests the hooks read the live state synchronously (same getState/setState underneath).
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  const hook = ((sel: (s: ReturnType<typeof actual.useStore.getState>) => unknown) => sel(actual.useStore.getState())) as unknown as typeof actual.useStore;
  Object.assign(hook, actual.useStore);
  return { ...actual, useStore: hook, useShallow: <T,>(f: T) => f };
});
vi.mock('./searchState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./searchState')>();
  const hook = ((sel: (s: ReturnType<typeof actual.useSearchUi.getState>) => unknown) => sel(actual.useSearchUi.getState())) as unknown as typeof actual.useSearchUi;
  Object.assign(hook, actual.useSearchUi);
  return { ...actual, useSearchUi: hook };
});
import { createMockCoins } from '../data/mockCoins';
import { useStore } from '../store';
import type { Place } from '../types';
import CategoryChips from './CategoryChips';
import NearMe from './NearMe';
import ResultsList from './ResultsList';
import SearchBar from './SearchBar';
import { useSearchUi } from './searchState';

const coins = Object.fromEntries(createMockCoins(150, Date.now()).map((c) => [c.placeId, c]));
const kebab = Object.values(coins).find((c) => c.ticker === 'KEBAB')!;
const googlePlace: Place = {
  id: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
  source: 'google',
  name: 'Kebab Junction',
  category: 'kebab',
  categoryLabel: 'Kebab shop',
  emoji: '🥙',
  address: 'Kingsland Rd, London',
  location: { lat: 51.548, lng: -0.075 },
};
const osmPlace: Place = { ...googlePlace, id: 'osm:node/1', source: 'osm', name: 'Cafe Oto' };

const html = (c: () => unknown) => renderToStaticMarkup(createElement(c as () => null));

beforeEach(() => {
  useStore.setState({ coins, provider: 'google', category: null, results: [], resultsStatus: 'idle', resultsQuery: '' });
  useSearchUi.setState({ text: '', origin: null });
});

describe('SearchBar', () => {
  it('renders the pill as an ARIA combobox inside role=search', () => {
    const out = html(SearchBar);
    expect(out).toContain('role="search"');
    expect(out).toContain('role="combobox"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('placeholder="Search shops or paste a Google Maps link"');
    expect(out).toContain('aria-label="Launch a coin"');
    expect(out).toContain('aria-label="Search"');
    expect(out).not.toContain('Clear search');
  });
  it('shows the clear button once there is text', () => {
    useSearchUi.setState({ text: 'kebab' });
    expect(html(SearchBar)).toContain('aria-label="Clear search"');
  });
});

describe('CategoryChips', () => {
  it('renders the 9 chips in DESIGN order as a toolbar with aria-pressed + roving tabindex', () => {
    const out = html(CategoryChips);
    expect(out).toContain('role="toolbar"');
    expect(out).toContain('aria-label="Filters"');
    const labels = [...out.matchAll(/<button[^>]*class="chip(?: [^"]*)?"[^>]*>(.*?)<\/button>/g)].map((m) =>
      (m[1] ?? '')
        .replace(/<span class="(?:ms|em|n)[^"]*"[^>]*>.*?<\/span>/g, '')
        .replace(/<[^>]+>/g, ''),
    );
    expect(labels).toEqual([
      'Live coins',
      'Cafés',
      'Barbers',
      'Kebab',
      'Pizza',
      'Bakeries',
      'Pubs',
      'Corner shops',
      'Fees waiting',
    ]);
    expect((out.match(/tabindex="0"/g) ?? []).length).toBe(1);
    expect(out).toContain('aria-label="More filters"');
  });
  it('active chip is pressed and shows the clear icon', () => {
    useStore.setState({ category: 'kebab' });
    const out = html(CategoryChips);
    expect(out).toMatch(/class="chip on hit"[^>]*aria-pressed="true"/);
    expect(out).toContain('chip-x');
  });
  it('Fees waiting shows the unclaimed fees in view', () => {
    expect(html(CategoryChips)).toMatch(/class="n num"[^>]*>\$[\d.]+k?</);
  });
});

describe('ResultsList', () => {
  it('loading → skeleton rows', () => {
    useStore.setState({ resultsStatus: 'loading', resultsQuery: 'kebab' });
    const out = html(ResultsList);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('Searching…');
  });
  it('error → unavailable + Try again', () => {
    useStore.setState({ resultsStatus: 'error', resultsQuery: 'kebab' });
    const out = html(ResultsList);
    expect(out).toContain('Search is unavailable right now');
    expect(out).toContain('Try again');
  });
  it('empty → no-match copy + paste-a-link action', () => {
    useStore.setState({ resultsStatus: 'ready', resultsQuery: 'zzz', results: [] });
    const out = html(ResultsList);
    expect(out).toContain('No shops match &quot;zzz&quot;');
    expect(out).toContain('Paste a link');
  });
  it('rows: coins show our data; launchable places get Launch; Google credit shown', () => {
    useStore.setState({
      resultsStatus: 'ready',
      resultsQuery: 'kebab',
      results: [{ ...googlePlace, id: kebab.placeId, source: 'demo' }, googlePlace],
    });
    const out = html(ResultsList);
    expect(out).toContain('$KEBAB');
    expect(out).toContain(kebab.name);
    expect(out).toContain('Kebab Junction');
    expect(out).toContain('aria-label="Launch a coin for Kebab Junction"');
    expect(out).toContain('>Google Maps<');
  });
  it('OSM places on the fallback map: no Launch, OSM credit', () => {
    useStore.setState({ provider: 'demo', resultsStatus: 'ready', resultsQuery: 'cafe', results: [osmPlace] });
    const out = html(ResultsList);
    expect(out).toContain('Cafe Oto');
    expect(out).not.toContain('Launch a coin for');
    expect(out).toContain('© OpenStreetMap contributors');
  });
  it('chip results are titled by the chip with a distance caption', () => {
    useSearchUi.setState({ origin: { kind: 'chip', filter: 'kebab', label: 'Kebab', center: { lat: 51.5469, lng: -0.0712 }, radiusM: 900 } });
    useStore.setState({ resultsStatus: 'ready', resultsQuery: 'Kebab', results: [googlePlace] });
    const out = html(ResultsList);
    expect(out).toContain('<h1>Kebab</h1>');
    expect(out).toContain('1 place near the map centre');
    expect(out).toMatch(/\d+ m</);
  });
});

describe('NearMe', () => {
  it('idle / locating / located', () => {
    useStore.setState({ locateStatus: 'idle' });
    expect(html(NearMe)).toContain('aria-label="Near me"');
    useStore.setState({ locateStatus: 'locating' });
    expect(html(NearMe)).toContain('aria-busy="true"');
    useStore.setState({ locateStatus: 'located' });
    expect(html(NearMe)).toContain('locate-fab hit located');
  });
});
