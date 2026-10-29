/**
 * The real-mode data layer against a fake Worker (INTEGRATION.md §5): boot order, cluster check,
 * registry → store mapping, market polling scope (visible + selected only), feed merge, pin
 * flashes from market deltas, and "no /api/rpc without a wallet".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConfigResponse, FeedResponse, MarketResponse } from '../../worker/wire';
import { coinDto, market } from './testFixtures';

const CONFIG: ConfigResponse = {
  cluster: 'devnet',
  genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  publicOrigin: 'https://cornershop-devnet.tiejiucai.workers.dev',
  programId: '6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x',
  configPda: 'FbgtYWxSdefazpfMBXMJMZZbYRodxcJCQid8K2Fd7kMY',
  alt: 'Alt1111111111111111111111111111111111111111',
  attestor: 'AR4W7wJSk76qpqXGJu5herEmFja8EGrzvjZLxiaF6Wty',
  claimWindowSecs: 60,
  launchesPaused: false,
  probationUntil: 0,
  maxDevBuyLamports: '1000000000',
  priorityFeeMicroLamports: 10_000,
  curve: { initialVirtualTokenReserves: '1073000000000000', initialVirtualQuoteReserves: '30000000000', initialRealTokenReserves: '793100000000000', tokenTotalSupply: '1000000000000000' },
  solUsd: 150,
  solUsdAt: Date.now(),
  features: { testWallet: false, faucet: false, privy: false, phoneVerification: 'screen', turnstileSiteKey: null, jupiter: false, websiteVerification: true },
  explorer: { tx: 'https://solscan.io/tx/{sig}?cluster=devnet', address: 'https://solscan.io/account/{address}?cluster=devnet', token: 'https://solscan.io/token/{mint}?cluster=devnet' },
  buildId: 'test',
};

const VISIBLE = coinDto({ placeId: 'ChIJvisible000001', mint: 'MintVisib1e111111111111111111111111111111', location: { lat: 51.546, lng: -0.07 } });
const FAR = coinDto({ placeId: 'ChIJfaraway000001', mint: 'MintFar111111111111111111111111111111111', location: { lat: 40.7, lng: -74 } });

const calls: string[] = [];
let marketRealSol = '0';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  calls.push(url);
  const u = new URL(url, 'https://cornershop-devnet.tiejiucai.workers.dev');
  switch (u.pathname) {
    case '/api/config':
      return json(CONFIG);
    case '/api/feed': {
      const body: FeedResponse = {
        events: [
          { id: 'sigA:0', ts: Date.now() - 1000, mint: VISIBLE.mint, placeId: VISIBLE.placeId, ticker: 'KEBAB', name: 'Kebab King', emoji: '🥙', bg: '#ffe4cc', kind: 'trade', side: 'buy', solLamports: '100000000', userLamports: null, tokens: '3000000000000', wallet: 'Trader1111111111111111111111111111111111', sig: 'sigA' },
          { id: `launch:${FAR.mint}`, ts: Date.now() - 5000, mint: FAR.mint, placeId: FAR.placeId, ticker: 'KEBAB', name: 'Far', emoji: '🥙', bg: '#ffe4cc', kind: 'launch', wallet: 'L', sig: 'sigL' },
        ],
        now: Date.now(),
      };
      return json(body);
    }
    case '/api/coins':
      if (u.searchParams.get('mints')) return json({ coins: [FAR], solUsd: 150, at: Date.now() });
      return json({ coins: [VISIBLE, FAR], solUsd: 150, at: Date.now() });
    case '/api/market': {
      const mints = (u.searchParams.get('mints') ?? '').split(',');
      const body: MarketResponse = { quotes: {}, solUsd: 150, slot: 2, at: Date.now() };
      for (const m of mints) body.quotes[m] = market({ realSol: marketRealSol, priceLamports: marketRealSol === '0' ? 28 : 30, at: Date.now() });
      return json(body);
    }
    case '/api/top':
      return json({ by: 'mcap', coins: [VISIBLE], solUsd: 150, at: Date.now() });
    default:
      return json({ error: 'not_found' }, 404);
  }
});

type Mods = {
  store: typeof import('../store');
  realdata: typeof import('./index');
  bridge: typeof import('../map/mapBridge');
};
let mods: Mods;
let stop: () => void = () => {};

beforeAll(async () => {
  vi.stubEnv('VITE_CLUSTER', 'devnet');
  vi.stubGlobal('fetch', fakeFetch);
  const target = new EventTarget();
  vi.stubGlobal('document', Object.assign(target, { visibilityState: 'visible', hidden: false, querySelector: () => null }));
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout, requestIdleCallback: undefined }));
  vi.resetModules();
  mods = {
    store: await import('../store'),
    realdata: await import('./index'),
    bridge: await import('../map/mapBridge'),
  };
});

afterAll(() => {
  stop();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await tick(10);
  }
}

describe('startRealData (real mode on devnet)', () => {
  it('runs in real mode only when the build is a cluster build', async () => {
    const mode = await import('../mode');
    expect(mode.IS_REAL).toBe(true);
    expect(mode.CLUSTER).toBe('devnet');
  });

  it('boots: config (cluster check) → feed + registry → store', async () => {
    const { useStore } = mods.store;
    useStore.setState({ viewport: { center: { lat: 51.546, lng: -0.07 }, zoom: 15, bounds: { north: 51.56, south: 51.53, east: -0.04, west: -0.1 } }, heroDismissed: true });
    stop = mods.realdata.startRealData();
    await until(() => useStore.getState().chain.status === 'ready');
    expect(useStore.getState().chain.config?.cluster).toBe('devnet');
    await until(() => !!useStore.getState().coins[VISIBLE.placeId] && useStore.getState().dataReady);
    const c = useStore.getState().coins[VISIBLE.placeId];
    expect(c?.real?.vault).toBe(VISIBLE.vault);
    expect(useStore.getState().solUsd).toBe(150);
    // the feed merged, and its trade became a Recent-trades row of the coin (real signature)
    expect(useStore.getState().feed.some((e) => e.id === 'sigA:0')).toBe(true);
    expect(useStore.getState().trades[VISIBLE.placeId]?.[0]?.signature).toBe('sigA');
  });

  it('polls /api/market only for coins in view (not the far-away one) and never /api/rpc without a wallet', async () => {
    await until(() => calls.some((u) => u.startsWith('/api/market')));
    const m = calls.filter((u) => u.startsWith('/api/market'));
    expect(m.every((u) => u.includes(VISIBLE.mint) && !u.includes(FAR.mint))).toBe(true);
    expect(calls.some((u) => u.includes('/api/rpc'))).toBe(false);
  });

  it('flashes a pin when real SOL reserves grow between polls (buy)', async () => {
    const flashes: string[] = [];
    vi.spyOn(mods.bridge, 'flashPin').mockImplementation((placeId, side, label) => {
      flashes.push(`${placeId}:${side}:${label}`);
    });
    marketRealSol = '250000000';
    mods.realdata.pokeMarket();
    await until(() => flashes.length > 0, 3000);
    expect(flashes[0]).toBe(`${VISIBLE.placeId}:buy:+0.25 SOL`);
    const c = mods.store.useStore.getState().coins[VISIBLE.placeId];
    expect(c?.real?.realSolLamports).toBe('250000000');
    expect(c?.priceSol).toBeCloseTo(30e-9, 15);
  });

  it('ensurePlace marks the place checked and upserts a found coin', async () => {
    const r = await mods.realdata.findCoinByMint(VISIBLE.mint);
    expect(r?.placeId).toBe(VISIBLE.placeId);
  });
});
