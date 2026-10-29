/**
 * Claims persist per COIN (mint), not per place: a new coin on a place that had an earlier,
 * claimed coin must start `Unclaimed · not affiliated` (DESIGN §17), and a claim keeps the amount
 * actually paid out for the Live feed after a reload. Uses an in-memory localStorage.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  clear() {
    this.m.clear();
  }
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
}

const local = new MemoryStorage();
const noop = () => {};

beforeAll(() => {
  vi.stubGlobal('window', { localStorage: local, sessionStorage: new MemoryStorage(), addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) });
  vi.stubGlobal('document', { addEventListener: noop, removeEventListener: noop, visibilityState: 'visible', hidden: false });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

async function load() {
  const store = await import('./store');
  const config = await import('./config');
  const mock = await import('./data/mockCoins');
  return { ...store, ...config, ...mock };
}

const PLACE = 'ChIJxYs1ArocdkgR-G13PLmofec';
const A = 'HfyCwalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZTY2';
const B = 'GJRewalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function googlePlace() {
  return {
    id: PLACE,
    source: 'google' as const,
    name: 'Test place',
    category: 'restaurant' as const,
    categoryLabel: 'Restaurant',
    emoji: '🍛',
    location: { lat: 51.52, lng: -0.077 },
  };
}

beforeEach(async () => {
  local.clear();
  const { useStore } = await load();
  useStore.setState({ coins: {}, trades: {}, feed: [], wallet: { address: null, kind: null }, holdings: {}, watch: [], solBalance: 2.41 });
});

describe('claims are tied to the coin (mint)', () => {
  it('a new coin on a place with an old claim record stays unclaimed after a reload', async () => {
    const { useStore, STORAGE_KEYS } = await load();
    // a claim left behind by an earlier coin on the same place (older build: no mint)
    local.setItem(STORAGE_KEYS.claims, JSON.stringify({ [PLACE]: { owner: B, payoutWallet: B, claimedAt: Date.now() - 86_400_000 } }));
    useStore.setState({ wallet: { address: A, kind: 'email' } });
    const r = useStore.getState().launchCoin({ place: googlePlace() as never, name: 'Dishoom', ticker: 'DSHVF', description: '', category: 'restaurant' as never, logo: { emoji: '🍛', bg: '#ffedd0' } as never, devBuySol: 0 });
    expect(r.ok).toBe(true);
    // launching clears the stale record
    expect(JSON.parse(local.getItem(STORAGE_KEYS.claims) ?? '{}')[PLACE]).toBeUndefined();
    // "reload": the stored coin is hydrated again, even if an old record (another mint) is back
    local.setItem(STORAGE_KEYS.userCoins, JSON.stringify([useStore.getState().coins[PLACE]]));
    local.setItem(STORAGE_KEYS.claims, JSON.stringify({ [PLACE]: { mint: 'OLDmint111111111111111111111111111111111pump', owner: B, payoutWallet: B, claimedAt: Date.now() - 1000 } }));
    useStore.setState({ coins: {} });
    useStore.getState().hydrateUserCoins();
    const c = useStore.getState().coins[PLACE]!;
    expect(c.claimed).toBe(false);
    expect(c.owner).toBeUndefined();
  });

  it('repairs a stored coin that borrowed an earlier claim (claimedAt before its launch)', async () => {
    const { useStore, STORAGE_KEYS } = await load();
    useStore.setState({ wallet: { address: A, kind: 'email' } });
    const r = useStore.getState().launchCoin({ place: googlePlace() as never, name: 'Dishoom', ticker: 'DSHVF', description: '', category: 'restaurant' as never, logo: { emoji: '🍛', bg: '#ffedd0' } as never, devBuySol: 0 });
    if (!r.ok) throw new Error('launch failed');
    const polluted = { ...r.coin, claimed: true, ownerVerified: true, owner: B, payoutWallet: B, claimedAt: r.coin.launchedAt - 60_000, feesClaimedUsd: r.coin.feesEarnedUsd };
    local.setItem(STORAGE_KEYS.userCoins, JSON.stringify([polluted]));
    useStore.setState({ coins: {} });
    useStore.getState().hydrateUserCoins();
    const c = useStore.getState().coins[PLACE]!;
    expect(c.claimed).toBe(false);
    expect(c.ownerVerified).toBe(false);
    expect(c.payoutWallet).toBeUndefined();
  });

  it('a claim on a seeded coin keeps its real amount for the Live feed after a reload', async () => {
    const { useStore, createMockCoins, createMockActivity } = await load();
    const seeds = createMockCoins(150, Date.now());
    useStore.getState().seedCoins(seeds);
    const bean = Object.values(useStore.getState().coins).find((c) => c.ticker === 'BEAN')!;
    expect(bean.claimed).toBe(false);
    useStore.setState({ wallet: { address: A, kind: 'email' } });
    const res = useStore.getState().claimFees(bean.placeId, A);
    if (!res.ok) throw new Error('claim failed');
    // reload: fresh seeds + stored claims
    useStore.setState({ coins: {}, feed: [] });
    useStore.getState().seedCoins(createMockCoins(150, Date.now()));
    const again = useStore.getState().coins[bean.placeId]!;
    expect(again.claimed).toBe(true);
    expect(again.claimedUsd).toBe(res.amountUsd);
    const ev = createMockActivity([again]).feed.find((e) => e.kind === 'claim');
    expect(ev && ev.kind === 'claim' ? ev.usd : null).toBe(res.amountUsd);
  });

  it('rebuilds the launch and claim rows of restored user coins', async () => {
    const { useStore, STORAGE_KEYS } = await load();
    useStore.setState({ wallet: { address: A, kind: 'email' } });
    const r = useStore.getState().launchCoin({ place: googlePlace() as never, name: 'Dishoom', ticker: 'DSHVF', description: '', category: 'restaurant' as never, logo: { emoji: '🍛', bg: '#ffedd0' } as never, devBuySol: 0 });
    if (!r.ok) throw new Error('launch failed');
    const claim = useStore.getState().claimFees(PLACE, A);
    if (!claim.ok) throw new Error('claim failed');
    local.setItem(STORAGE_KEYS.userCoins, JSON.stringify([useStore.getState().coins[PLACE]]));
    useStore.setState({ coins: {}, feed: [] });
    useStore.getState().hydrateUserCoins();
    const feed = useStore.getState().feed.filter((e) => e.placeId === PLACE);
    expect(feed.map((e) => e.kind).sort()).toEqual(['claim', 'launch']);
    const row = feed.find((e) => e.kind === 'claim');
    expect(row && row.kind === 'claim' ? row.usd : null).toBe(claim.amountUsd);
  });
});
