/**
 * Smoke-render the RAIL+FEED components (server render, no DOM) against seeded demo data:
 * they must render without throwing and show the DESIGN copy.
 */
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockActivity, createMockCoins } from '../data/mockCoins';
import Hero from '../landing/Hero';
import { loadDemoData } from '../lib/demoBridge';
import Rail from '../rail/Rail';
import ThisAreaCard from '../rail/ThisAreaCard';
import { useStore } from '../store';
import LaunchedPanel from './LaunchedPanel';
import LivePanel from './LivePanel';
import MyCoinsPanel from './MyCoinsPanel';
import TopShopsPanel from './TopShopsPanel';

// other builders' modules may be mid-edit: stub the ones the hero / My coins import
vi.mock('../search/resolveLink', () => ({ resolveMapsLink: async () => ({ status: 'error', error: 'unsupported' }) }));
vi.mock('../search/parseMapsLink', () => ({ looksLikeMapsLink: () => false, parseMapsLink: () => null }));
vi.mock('../places', () => ({ getPlaceDetails: async () => null, placeFromParsedLink: () => null }));

const DALSTON = { north: 51.558, south: 51.536, east: -0.043, west: -0.099 };

/** Strip tags and decode the few entities React emits, for text assertions. */
function text(html: string): string {
  return html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/**
 * Server rendering reads zustand's *initial* state (useSyncExternalStore getServerSnapshot), so
 * copy the live state into that object before each render.
 */
function render(c: Parameters<typeof h>[0]): string {
  Object.assign(useStore.getInitialState(), useStore.getState());
  return renderToString(h(c as never));
}

// demo shops reach the panels through the demo-data bridge (loaded lazily in the app)
beforeAll(async () => {
  await loadDemoData();
});

beforeEach(() => {
  const coins = createMockCoins(150, Date.now());
  useStore.setState({
    coins: {},
    trades: {},
    feed: [],
    online: true,
    simLastTickAt: Date.now(),
    panel: 'none',
    panelCollapsed: false,
    heroDismissed: true,
    category: null,
    topShops: { sort: 'mcap', scope: 'everywhere' },
    wallet: { address: null, kind: null },
    holdings: {},
    watch: [],
    viewport: { center: { lat: 51.5469, lng: -0.0712 }, zoom: 15, bounds: DALSTON },
    selected: { place: null, status: 'idle' },
  });
  useStore.getState().seedCoins(coins);
  useStore.getState().seedActivity(createMockActivity(coins));
});

describe('rail', () => {
  it('renders the desktop rail with items, live dot and Launched badge', () => {
    const t = text(render(Rail));
    for (const s of ['Live', 'Top shops', 'Launched', 'My coins', 'Help']) expect(t).toContain(s);
    expect(t).toContain('2 new'); // two seeded launches inside the first-visit hour
  });

  it('shows the selected place entry', () => {
    const coin = useStore.getState().coins['demo-kebab']!;
    useStore.setState({ panel: 'place', selected: { place: { id: coin.placeId, source: 'demo', name: coin.name, category: 'kebab', categoryLabel: 'Kebab shop', emoji: '🥙', location: coin.place.location }, status: 'ready' } });
    expect(text(render(Rail))).toContain('$KEBAB');
  });
});

describe('This area card', () => {
  it('counts the Dalston coins and their fees', () => {
    const t = text(render(ThisAreaCard));
    expect(t).toContain('This area');
    expect(t).toMatch(/\d+ shops have coins/);
    expect(t).toContain('waiting for owners');
  });

  it('respects the chip filter and hides behind panels / the hero', () => {
    useStore.setState({ category: 'kebab' });
    expect(text(render(ThisAreaCard))).toContain('1 shop has a coin');
    useStore.setState({ panel: 'live' });
    expect(render(ThisAreaCard)).toBe('');
    useStore.setState({ panel: 'none', heroDismissed: false });
    expect(render(ThisAreaCard)).toBe('');
  });

  it('says zoom in when zoomed out', () => {
    useStore.setState({ viewport: { center: { lat: 51.5, lng: 0 }, zoom: 8, bounds: { north: 53, south: 50, east: 2, west: -2 } } });
    expect(text(render(ThisAreaCard))).toContain('Zoom in to see shops');
  });
});

describe('rail panels', () => {
  it('Live: header, filters, rows and the Top shops preview', () => {
    const t = text(render(LivePanel));
    for (const s of ['Live', 'simulated · updating', 'All', 'Trades', 'Launches', 'Claims', 'Top shops', 'Market cap', 'Fees earned', 'See all top shops'])
      expect(t).toContain(s);
    expect(t).toMatch(/(bought|sold)/);
    expect(t).toContain('$BODEGA'); // #1 by market cap
  });

  it('Top shops: rank, ticker, fees line; fees sort swaps the metrics', () => {
    let t = text(render(TopShopsPanel));
    expect(t).toContain('Everywhere');
    expect(t).toContain('This area');
    expect(t).toMatch(/ 1 \S+ \$BODEGA verified , owner verified · Marigold Bodega/);
    expect(t).toContain('fees');
    useStore.setState({ topShops: { sort: 'fees', scope: 'area' } });
    t = text(render(TopShopsPanel));
    expect(t).toContain('mcap');
    expect(t).toContain('≈');
    expect(t).not.toContain('$BODEGA'); // not in Dalston
  });

  it('Launched: newest first with launcher addresses', () => {
    const t = text(render(LaunchedPanel));
    expect(t).toContain('Newest first');
    expect(t).toContain('launched by');
    expect(t.indexOf('$OFFY')).toBeLessThan(t.indexOf('$KEBAB'));
  });

  it('Launched: no scope chips; `by you` only for the connected wallet', () => {
    const A = 'HfyCwalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZTY2';
    const B = 'GJRewalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const kebab = useStore.getState().coins['demo-kebab']!;
    // launched in this browser, but by wallet A
    useStore.setState({ coins: { ...useStore.getState().coins, 'demo-kebab': { ...kebab, launcher: A, isUserLaunched: true } } });
    let t = text(render(LaunchedPanel));
    expect(t).not.toContain('Everywhere');
    expect(t).not.toContain('This area');
    expect(t).not.toContain('launched by you');
    useStore.setState({ wallet: { address: B, kind: 'email' } });
    expect(text(render(LaunchedPanel))).not.toContain('launched by you');
    expect(text(render(MyCoinsPanel))).not.toContain('Launched by you');
    useStore.setState({ wallet: { address: A, kind: 'email' } });
    t = text(render(LaunchedPanel));
    expect(t).toContain('launched by you');
    expect(text(render(MyCoinsPanel))).toContain('Launched by you');
  });

  it('My coins: connect prompt, then holdings / launched / watching', () => {
    expect(text(render(MyCoinsPanel))).toContain('Connect a wallet to see your coins');
    useStore.setState({ wallet: { address: 'So1anaWa11etAddressXXXXXXXXXXXXXXXXXXXXXXX', kind: 'email' }, solBalance: 2.41 });
    expect(text(render(MyCoinsPanel))).toContain('No coins yet');
    useStore.setState({ holdings: { 'demo-kebab': 2_000_000 }, watch: ['demo-crumb'] });
    const t = text(render(MyCoinsPanel));
    expect(t).toContain('Holding');
    expect(t).toContain('2.41 SOL');
    expect(t).toContain('Watching');
    expect(t).toContain('Crumb & Co. Bakery');
    // nothing sends a notification when a watched shop launches: never promise one
    expect(t).toContain('No coin yet');
    expect(t).not.toMatch(/let you know/i);
  });
});

describe('hero', () => {
  it('renders the verbatim pitch and live stats on a first visit', () => {
    useStore.setState({ heroDismissed: false });
    const t = text(render(Hero));
    expect(t).toContain('your cafe. your barber. your kebab shop.');
    expect(t).toContain("launch a coin for any business on earth. 100% of creator fees are held for the shop's verified owner.");
    expect(t).toContain('paste a google maps link. launch. done.');
    expect(t).toContain('try now');
    expect(t).toContain('or tap any shop on the map');
    expect(t).toContain('shops launched');
    expect(t).toContain('platform cut of fees');
    useStore.setState({ heroDismissed: true });
    expect(render(Hero)).toBe('');
  });
});
