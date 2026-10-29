/**
 * Live market simulator (prototype — nothing touches a chain, nothing is signed or sent).
 * OWNED BY RAIL+FEED. Contract: startSimulator(): () => void (returns the cleanup).
 *
 * Every ~0.9–1.6s (jittered) one tick applies a weighted batch of 1–3 simulated trades through
 * store.applyTickBatch (one store update per tick):
 *  - coin weight ∝ √market cap, ×3 when the coin is in the current map view (so pins flash where
 *    the user is looking), ×3 for coins launched in the last 15 minutes;
 *  - trade size 0.05–25 SOL with a fat tail (mockCoins.tradeSizeSol), capped by the coin's
 *    virtual pool so a whale can't 10× a small coin in one trade;
 *  - side is mean-reverting around a slowly drifting per-coin anchor, so prices wander but
 *    don't run away over a long session;
 *  - the selected coin trades at least every 3–8s (DESIGN §8.10 "price ticks every 3–8s").
 * Also: a pump every ~40–80s (3–6 buys in one tick + a 'pump' feed event, then a cool-off),
 * a new FICTIONAL launch every ~35–60s (store.addCoin, then a dev buy and early buyers), an
 * owner claim at a fictional shop every ~5–9 min (store.claimFees with a simulated owner). SOL/USD
 * stays at the constant DEMO_SOL_USD (DESIGN §3.4), so fixed USD amounts always show the same SOL
 * figure. The DESIGN §19.2 Dalston shops are never auto-claimed.
 *
 * Pauses while the tab is hidden or the app is offline. On return after ≥ 5s it applies one
 * catch-up batch (so the Live panel can show "<n> new events · Show"). Cleanup clears every
 * timer and listener.
 */
import { boundsContains, distanceM } from '../lib/geo';
import { buildCoin } from '../lib/market';
import { demoPlaceId } from '../lib/place';
import { liveRng, type Rng } from '../lib/rand';
import { fakeWallet, randomWallet } from '../lib/fakeSolana';
import { isTickerTaken } from '../lib/ticker';
import { COIN_SWATCHES } from '../lib/categories';
import { feesWaiting, useStore, type SimTrade } from '../store';
import type { Coin, FeedEvent, LatLng } from '../types';
import { CITIES, cityDef, fictionalPlaceInfo, generateCandidate, jitter, LAUNCH_POOL, nearestCity, type LaunchCandidate } from './fictional';
import { createMockActivity, maxTradeSol, MOCK_PARITY_IDS, roundSol, tradeSizeSol } from './mockCoins';

const SEC = 1000;
const MIN = 60 * SEC;
/** The unlaunched demo place used by the `?state=unlaunched` QA state: never auto-launched. */
const RESERVED_IDS = new Set([demoPlaceId('crumb')]);

interface PendingTrade extends SimTrade {
  at: number;
}

export function startSimulator(): () => void {
  const rng = liveRng();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hiddenAt: number | null = null;
  let launchSeq = 0;

  /* ---------------------------------------------------------------- backfill */
  const st0 = useStore.getState();
  st0.seedActivity(createMockActivity(Object.values(st0.coins).filter((c) => c.isDemoSeed)));

  /* ---------------------------------------------------------------- schedule state */
  const t0 = Date.now();
  let nextLaunchAt = t0 + rng.int(18, 30) * SEC; // first one soon, so new visitors see a launch
  let nextPumpAt = t0 + rng.int(15, 30) * SEC;
  let nextClaimAt = t0 + rng.int(120, 240) * SEC;
  let focusDueMs = rng.int(3, 8) * SEC;
  const pending: PendingTrade[] = [];
  const usedPool = new Set<number>();

  /**
   * Mean-reversion anchor per coin: a long-run `origin`, a `base` that wanders a little around
   * it (±~10%), and a `boost` (log) from pumps / fresh launches that decays with a 150s half-life
   * — so a pump is followed by a cool-off instead of ratcheting prices up forever.
   */
  interface Anchor {
    origin: number;
    base: number;
    boost: number;
    at: number;
  }
  const anchors = new Map<string, Anchor>();

  function anchorRec(c: Coin, now: number): Anchor {
    let a = anchors.get(c.placeId);
    if (!a) {
      // A coin first seen within minutes of its launch (e.g. one the user just launched) gets the
      // same treatment as the simulator's own launches: early demand, so it tends to run, not dump.
      const fresh = now - c.launchedAt < 10 * MIN;
      const level = fresh ? c.priceUsd * Math.exp(rng.range(0.3, 1)) : c.priceUsd;
      a = { origin: level, base: level, boost: 0, at: now };
      anchors.set(c.placeId, a);
    }
    a.boost *= 0.5 ** (Math.max(0, now - a.at) / 150_000);
    a.at = now;
    return a;
  }

  function anchorPrice(c: Coin, now: number): number {
    const a = anchorRec(c, now);
    a.base = a.origin * Math.exp(Math.log(a.base / a.origin) * 0.98 + rng.normal() * 0.02);
    return a.base * Math.exp(a.boost);
  }

  /* ---------------------------------------------------------------- trade building */
  function sizeFor(c: Coin, solUsd: number, r: Rng): number {
    return roundSol(Math.max(0.05, Math.min(tradeSizeSol(r), maxTradeSol(c, solUsd))));
  }

  function sideFor(c: Coin, now: number): 'buy' | 'sell' {
    const dev = Math.log(c.priceUsd / anchorPrice(c, now));
    const pBuy = Math.min(0.85, Math.max(0.15, 0.52 - 0.9 * dev));
    return rng.chance(pBuy) ? 'buy' : 'sell';
  }

  function pickCoins(coins: Coin[], n: number, now: number): Coin[] {
    const s = useStore.getState();
    const bounds = s.viewport?.bounds ?? null;
    const weights = coins.map((c) => {
      let w = Math.sqrt(Math.max(1000, c.marketCapUsd) / 1000);
      if (bounds && boundsContains(bounds, c.place.location)) w *= 3;
      if (now - c.launchedAt < 15 * MIN) w *= 3;
      return w;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    const out: Coin[] = [];
    for (let k = 0; k < n && total > 0; k++) {
      let x = rng.next() * total;
      for (let i = 0; i < coins.length; i++) {
        x -= weights[i] as number;
        if (x <= 0) {
          out.push(coins[i] as Coin);
          break;
        }
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- launches */
  function placeTaken(coins: Record<string, Coin>, p: LatLng): boolean {
    return Object.values(coins).some((c) => distanceM(c.place.location, p) < 45);
  }

  function launch(now: number): void {
    const s = useStore.getState();
    const all = Object.values(s.coins);
    const taken = (t: string) => isTickerTaken(t, all);
    const v = s.viewport;
    const inView = v?.bounds && v.zoom >= 12 ? all.filter((c) => boundsContains(v.bounds!, c.place.location)) : [];

    let cand: LaunchCandidate | null = null;
    let location: LatLng | null = null;

    // ~45%: launch close to what the user is looking at (next to an existing coin in view),
    // unless that part of the map is already busy
    if (inView.length > 0 && inView.length < 20 && rng.chance(0.45)) {
      const near = rng.pick(inView);
      const city = nearestCity(near.place.location);
      const cityKey = city?.key ?? 'london';
      const idx = LAUNCH_POOL.findIndex((c, i) => !usedPool.has(i) && c.cityKey === cityKey && !taken(c.ticker));
      if (idx >= 0) {
        usedPool.add(idx);
        cand = LAUNCH_POOL[idx] as LaunchCandidate;
      } else {
        cand = generateCandidate(rng, cityKey, taken);
      }
      for (let i = 0; i < 6 && (!location || placeTaken(s.coins, location)); i++) location = jitter(near.place.location, rng, 140, 480);
    }
    if (!cand) {
      const free = LAUNCH_POOL.map((_c, i) => i).filter((i) => !usedPool.has(i) && !taken((LAUNCH_POOL[i] as LaunchCandidate).ticker));
      if (free.length > 0) {
        const idx = rng.pick(free);
        usedPool.add(idx);
        cand = LAUNCH_POOL[idx] as LaunchCandidate;
      } else {
        cand = generateCandidate(rng, rng.pick(CITIES).key, taken);
      }
    }
    const city = cityDef(cand.cityKey);
    const spot = rng.pick(city.spots);
    if (!location) {
      for (let i = 0; i < 6 && (!location || placeTaken(s.coins, location)); i++) location = jitter(spot.at, rng, 120, 650);
    }
    if (!location || placeTaken(s.coins, location)) return; // try again next time

    const slug = `sim-${cand.ticker.toLowerCase()}-${(++launchSeq).toString(36)}${now.toString(36).slice(-3)}`;
    const placeId = demoPlaceId(slug);
    if (RESERVED_IDS.has(placeId) || s.coins[placeId]) return;
    const n = Math.floor(rng.next() * 1000);
    const coin = buildCoin(
      {
        placeId,
        place: {
          id: placeId,
          source: 'demo',
          location,
          category: cand.category,
          emoji: cand.emoji,
          city: city.city,
          demo: fictionalPlaceInfo({ name: cand.name, category: cand.category, cityKey: city.key, spot: { ...spot, at: location }, n, rating: 4.2 + (n % 8) / 10, reviews: 6 + (n % 140) }),
        },
        ticker: cand.ticker,
        name: cand.name,
        logo: { kind: 'sticker', emoji: cand.emoji, bg: rng.pick(COIN_SWATCHES) },
        launchedAt: now,
        historyAt: now,
        launcher: randomWallet(),
        holders: 1,
      },
      s.solUsd,
    );
    if (!s.addCoin(coin)) return;
    // fresh launches tend to run: raise the anchor, then a dev buy and a couple of early buyers
    const level = coin.priceUsd * Math.exp(rng.range(0.3, 1.5));
    anchors.set(placeId, { origin: level, base: level, boost: 0, at: now });
    pending.push({ placeId, side: 'buy', sol: roundSol(rng.range(0.5, 3)), wallet: coin.launcher, at: now + rng.int(2, 5) * SEC });
    const early = rng.int(1, 3);
    for (let i = 0; i < early; i++) pending.push({ placeId, side: 'buy', sol: roundSol(rng.range(0.1, 1.5)), at: now + rng.int(6, 25) * SEC });
  }

  /* ---------------------------------------------------------------- claims */
  function claim(): void {
    const s = useStore.getState();
    const all = Object.values(s.coins).filter((c) => c.place.source === 'demo' && !c.isUserLaunched);
    const claimedShare = all.filter((c) => c.claimed).length / Math.max(1, all.length);
    if (claimedShare >= 0.3) return;
    const now = Date.now();
    const candidates = all.filter(
      (c) => !c.claimed && !c.claimPending && !MOCK_PARITY_IDS.has(c.placeId) && now - c.launchedAt > 10 * MIN && feesWaiting(c) >= 25,
    );
    if (candidates.length === 0) return;
    const c = rng.pick(candidates);
    const owner = fakeWallet(`sim-owner:${c.placeId}:${Date.now()}`);
    s.claimFees(c.placeId, owner, { owner });
  }

  /* ---------------------------------------------------------------- one tick */
  function step(now: number, catchUp = 0): void {
    const s = useStore.getState();
    const coins = Object.values(s.coins).filter((c) => c.priceUsd > 0);
    if (coins.length === 0) return;

    if (catchUp === 0 && now >= nextLaunchAt) {
      launch(now);
      nextLaunchAt = now + rng.int(35, 60) * SEC;
    }

    const batch: SimTrade[] = [];
    const add = (c: Coin, side: 'buy' | 'sell', sol?: number, wallet?: string) =>
      batch.push({ placeId: c.placeId, side, sol: sol ?? sizeFor(c, s.solUsd, rng), ...(wallet ? { wallet } : {}) });

    // due dev buys / early buyers
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i] as PendingTrade;
      if (p.at > now) continue;
      pending.splice(i, 1);
      const c = s.coins[p.placeId];
      if (c) add(c, p.side, Math.min(p.sol, roundSol(maxTradeSol(c, s.solUsd))), p.wallet);
    }

    // the selected coin ticks every 3–8s
    const selId = s.selected.place?.id;
    const sel = selId ? s.coins[selId] : undefined;
    if (sel && now - (sel.lastTradeAt ?? 0) >= focusDueMs) {
      add(sel, sideFor(sel, now));
      focusDueMs = rng.int(3, 8) * SEC;
    }

    // a pump: several buys on one (smaller) coin in a single tick
    let pump: { coin: Coin; before: number } | null = null;
    if (catchUp === 0 && now >= nextPumpAt) {
      nextPumpAt = now + rng.int(40, 80) * SEC;
      const small = coins.filter((c) => c.marketCapUsd < 400_000);
      const pick = pickCoins(small.length ? small : coins, 1, now)[0];
      if (pick) {
        pump = { coin: pick, before: pick.priceUsd };
        anchorRec(pick, now).boost += rng.range(0.15, 0.45);
        const burst = rng.int(3, 6);
        for (let i = 0; i < burst; i++) add(pick, 'buy', roundSol(Math.min(maxTradeSol(pick, s.solUsd) * 0.6, rng.range(0.2, 2))));
      }
    }

    // regular flow
    const n = catchUp > 0 ? catchUp : 1 + (rng.chance(0.45) ? 1 : 0) + (rng.chance(0.15) ? 1 : 0);
    for (const c of pickCoins(coins, n, now)) add(c, sideFor(c, now));

    if (batch.length > 0) s.applyTickBatch(batch);

    if (pump) {
      const after = useStore.getState().coins[pump.coin.placeId];
      const changePct = after ? (after.priceUsd / pump.before - 1) * 100 : 0;
      if (after && changePct >= 5) {
        const ev: FeedEvent = {
          id: `ev_pump_${after.placeId}_${now.toString(36)}`,
          ts: now + batch.length,
          kind: 'pump',
          placeId: after.placeId,
          ticker: after.ticker,
          name: after.name,
          emoji: after.logo.emoji,
          bg: after.logo.bg,
          changePct,
        };
        useStore.getState().pushFeed(ev);
      }
    }

    if (catchUp === 0 && now >= nextClaimAt) {
      claim();
      nextClaimAt = now + rng.int(300, 540) * SEC;
    }
  }

  /* ---------------------------------------------------------------- loop & lifecycle */
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

  function schedule(delay: number): void {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(tick, delay);
  }

  function tick(): void {
    timer = undefined;
    if (stopped || hidden()) return; // visibilitychange restarts the loop
    try {
      if (useStore.getState().online) step(Date.now());
    } catch (err) {
      // never let one bad tick kill the simulation
      if (import.meta.env.DEV) console.warn('[simulator] tick failed', err);
    }
    schedule(rng.int(900, 1600));
  }

  const onVisibility = () => {
    if (stopped) return;
    if (hidden()) {
      hiddenAt = Date.now();
      clearTimeout(timer);
      timer = undefined;
      return;
    }
    const away = hiddenAt == null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (away >= 5 * SEC && useStore.getState().online) {
      // the market kept moving while you were away: one catch-up batch
      try {
        step(Date.now(), Math.min(14, Math.max(3, Math.round(away / (2.5 * SEC)))));
      } catch {
        /* ignore */
      }
    }
    schedule(rng.int(400, 900));
  };

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  if (!hidden()) schedule(rng.int(600, 1200));
  else hiddenAt = Date.now();

  return () => {
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
    pending.length = 0;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  };
}
