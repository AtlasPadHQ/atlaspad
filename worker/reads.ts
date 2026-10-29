/**
 * Read endpoints (INTEGRATION §3.2): /api/coins, /api/coins/:mint, /api/market, /api/top, /api/feed, /api/place/:id
 * and /api/place/:id/eligibility. Everything comes from the D1 registry (built from chain) or live chain reads; hidden
 * coins and rows of another cluster are never returned.
 */
import { decodeBondingCurve, decodePumpPool } from '../src/chain/curve';
import { canonicalPubkey } from './bytes';
import { COIN_COLUMNS, COIN_FROM, coinDTO, initialPriceLamports, marketFromCurve, marketFromPool, tradeDTO, u64s, type CoinRow, type TradeRow } from './coins';
import { accountExists, tokenAccount } from './chainState';
import { cap, DAY, limit, type Ctx } from './ctx';
import { freshCoin } from './fresh';
import { assertPlaceAllowed } from './geo';
import { eligibility, spendGoogleLookup, validPlaceId } from './google';
import { change24h, priceHistory } from './history';
import { ApiErr, CACHE, json } from './http';
import { indexMint } from './indexer';
import { adoptFromChain } from './launch';
import { freshSolUsd, globalFrom, metaSnapshot } from './meta';
import { placeAddresses } from './addresses';
import { programIdOf } from './env';
import type { AccountRaw } from './solana';
import { placeOptedOut } from './takedown';
import type {
  CoinDetailDTO,
  CoinsResponse,
  EligibilityResponse,
  FeedEventDTO,
  FeedResponse,
  MarketDTO,
  MarketResponse,
  PlaceResponse,
  TopResponse,
} from './wire';

/* ------------------------------------------------------------------------------------------------ params */

export interface Bbox {
  w: number;
  s: number;
  e: number;
  n: number;
}

export function parseBbox(v: string | null): Bbox | null {
  if (!v) return null;
  const p = v.split(',').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isFinite(x))) throw new ApiErr('bad_request', 'bbox must be w,s,e,n');
  const [w, s, e, n] = p as [number, number, number, number];
  if (w < -180 || w > 180 || e < -180 || e > 180 || s < -90 || s > 90 || n < -90 || n > 90 || s > n) throw new ApiErr('bad_request', 'bbox out of range');
  return { w, s, e, n };
}

/** SQL fragment + params for a bbox (antimeridian-aware: west > east splits into two longitude ranges). */
function bboxSql(b: Bbox, now: number, firstParam: number): { sql: string; params: (number | string)[] } {
  const i = firstParam;
  const lng = b.w <= b.e ? `coins.lng BETWEEN ?${i + 2} AND ?${i + 3}` : `(coins.lng >= ?${i + 2} OR coins.lng <= ?${i + 3})`;
  return {
    sql: `coins.lat BETWEEN ?${i} AND ?${i + 1} AND ${lng} AND (coins.coords_expire_at IS NULL OR coins.coords_expire_at > ?${i + 4})`,
    params: [b.s, b.n, b.w, b.e, now],
  };
}

function parseLimit(v: string | null, def: number, max: number): number {
  if (v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ApiErr('bad_request', 'Invalid limit');
  return Math.min(n, max);
}

export function parseMints(v: string | null, max = 100): string[] {
  if (!v) return [];
  const parts = [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))];
  if (parts.length > max) throw new ApiErr('bad_request', `At most ${max} mints`);
  return parts.map((m) => {
    const c = canonicalPubkey(m);
    if (!c) throw new ApiErr('bad_request', 'Invalid mint');
    return c;
  });
}

function pubkeyParam(v: string | null, name: string): string {
  const c = canonicalPubkey(v);
  if (!c) throw new ApiErr('bad_request', `Invalid ${name}`);
  return c;
}

const placeholders = (n: number, from: number) => Array.from({ length: n }, (_, i) => `?${from + i}`).join(',');

/* ------------------------------------------------------------------------------------------------ /api/coins */

export async function handleCoins(ctx: Ctx, url: URL): Promise<Response> {
  await limit(ctx.env.RL_READ, `read:${ctx.ipHash}`);
  const now = ctx.deps.now();
  const q = url.searchParams;
  const base = `SELECT ${COIN_COLUMNS} FROM ${COIN_FROM} WHERE coins.status = 'live' AND coins.cluster = ?1`;
  let stmt: D1PreparedStatement;
  const bbox = parseBbox(q.get('bbox'));
  const mints = parseMints(q.get('mints'));
  if (bbox) {
    const lim = parseLimit(q.get('limit'), 300, 500);
    const b = bboxSql(bbox, now, 2);
    stmt = ctx.db.prepare(`${base} AND ${b.sql} ORDER BY COALESCE(coins.mcap_lamports, 0) DESC LIMIT ?7`).bind(ctx.cluster, ...b.params, lim);
  } else if (mints.length) {
    stmt = ctx.db.prepare(`${base} AND coins.mint IN (${placeholders(mints.length, 2)})`).bind(ctx.cluster, ...mints);
  } else if (q.get('launcher') || q.get('owner')) {
    const who = q.get('launcher') ? pubkeyParam(q.get('launcher'), 'launcher') : null;
    const own = q.get('owner') ? pubkeyParam(q.get('owner'), 'owner') : null;
    const cond = [who ? 'coins.launcher = ?2' : null, own ? `(coins.owner = ?${who ? 3 : 2} OR coins.pending_owner = ?${who ? 3 : 2})` : null].filter(Boolean).join(' OR ');
    stmt = ctx.db.prepare(`${base} AND (${cond}) ORDER BY coins.created_at DESC LIMIT 200`).bind(ctx.cluster, ...[who, own].filter((x): x is string => !!x));
  } else if (q.get('sort') === 'new') {
    const lim = parseLimit(q.get('limit'), 50, 200);
    stmt = ctx.db.prepare(`${base} ORDER BY coins.created_at DESC LIMIT ?2`).bind(ctx.cluster, lim);
  } else {
    throw new ApiErr('bad_request', 'Use bbox, mints, launcher, owner or sort=new');
  }
  const [rows, snap] = await Promise.all([stmt.all<CoinRow>(), metaSnapshot(ctx)]);
  const g = globalFrom(snap, ctx.cluster);
  const out: CoinsResponse = { coins: (rows.results ?? []).map((r) => coinDTO(r, ctx.origin, g, now)), solUsd: freshSolUsd(snap, now), at: now };
  return json(out, 200, CACHE.coins);
}

/* ------------------------------------------------------------------------------------------- /api/coins/:mint */

export async function loadCoinByMint(ctx: Ctx, mint: string): Promise<CoinRow | null> {
  return ctx.db.prepare(`SELECT ${COIN_COLUMNS} FROM ${COIN_FROM} WHERE coins.mint = ?1 AND coins.cluster = ?2`).bind(mint, ctx.cluster).first<CoinRow>();
}

export async function loadCoinByPlace(ctx: Ctx, placeId: string): Promise<CoinRow | null> {
  return ctx.db.prepare(`SELECT ${COIN_COLUMNS} FROM ${COIN_FROM} WHERE coins.place_id = ?1 AND coins.cluster = ?2`).bind(placeId, ctx.cluster).first<CoinRow>();
}

/** Last automatic chain read per mint (per isolate): see handleCoinDetail. */
const autoFreshAt = new Map<string, number>();
const AUTO_FRESH_MS = 5_000;

export async function handleCoinDetail(ctx: Ctx, mintRaw: string, url: URL): Promise<Response> {
  const fresh = url.searchParams.get('fresh') === '1';
  await limit(fresh ? ctx.env.RL_FRESH : ctx.env.RL_READ, `${fresh ? 'fresh' : 'read'}:${ctx.ipHash}`);
  const mint = canonicalPubkey(mintRaw);
  if (!mint) throw new ApiErr('bad_request', 'Invalid mint');
  const row = await loadCoinByMint(ctx, mint);
  if (!row || row.status !== 'live') throw new ApiErr('not_found', 'Coin not found');
  // A claim whose public window is over can be finalized at any moment (by the Worker's crank, the owner or anyone),
  // and the D1 mirror only learns about it on a later pass. While a coin is in that state its detail is read from
  // chain (at most once per 5 s per isolate), so the panel moves to "You own this shop" as soon as it happened instead
  // of offering a Finalize that can only fail (QA: up to ~70 s of a stale "Claim pending").
  const now = ctx.deps.now();
  let auto = false;
  if (!fresh && row.pending_owner && row.unlock_ts != null && row.unlock_ts * 1000 <= now && now - (autoFreshAt.get(mint) ?? 0) >= AUTO_FRESH_MS) {
    autoFreshAt.set(mint, now);
    if (autoFreshAt.size > 500) for (const k of [...autoFreshAt.keys()].slice(0, 100)) autoFreshAt.delete(k);
    auto = true;
  }
  const out = await coinDetail(ctx, row, fresh || auto);
  return json(out, 200, fresh || auto ? CACHE.none : CACHE.coin);
}

export async function coinDetail(ctx: Ctx, row: CoinRow, fresh: boolean): Promise<CoinDetailDTO> {
  const now = ctx.deps.now();
  const snap = await metaSnapshot(ctx);
  const g = globalFrom(snap, ctx.cluster);
  const historyAt = Math.floor(now / 1_800_000) * 1_800_000;
  const winStart = historyAt - 47 * 1_800_000;
  const dayAgo = now - 86_400_000;
  const [recent, window, seed, vol, ago] = await ctx.db.batch([
    ctx.db.prepare('SELECT * FROM trades WHERE mint = ?1 ORDER BY ts DESC, sig DESC, ix DESC LIMIT 60').bind(row.mint),
    ctx.db.prepare('SELECT ts, price_lamports FROM trades WHERE mint = ?1 AND ts >= ?2 ORDER BY ts ASC, ix ASC LIMIT 5000').bind(row.mint, winStart),
    ctx.db.prepare('SELECT price_lamports FROM trades WHERE mint = ?1 AND ts < ?2 ORDER BY ts DESC LIMIT 1').bind(row.mint, winStart),
    ctx.db.prepare('SELECT COALESCE(SUM(sol_lamports), 0) AS v, MAX(ts) AS last FROM trades WHERE mint = ?1 AND ts >= ?2').bind(row.mint, dayAgo),
    ctx.db.prepare('SELECT price_lamports FROM trades WHERE mint = ?1 AND ts <= ?2 ORDER BY ts DESC LIMIT 1').bind(row.mint, dayAgo),
  ]);
  let base = coinDTO(row, ctx.origin, g, now);
  if (fresh) {
    const r = await freshCoin(ctx, ctx.rpc(8), row, g);
    base = r.dto;
    ctx.waitUntil(ctx.db.batch(r.stmts).catch(() => undefined));
  }
  const trades = (recent!.results as unknown as TradeRow[]) ?? [];
  const init = initialPriceLamports(g);
  const seedPrice = ((seed!.results?.[0] as { price_lamports?: number } | undefined)?.price_lamports ?? init) || init;
  const pts = ((window!.results ?? []) as { ts: number; price_lamports: number }[]).map((t) => ({ ts: t.ts, price: t.price_lamports }));
  const { history } = priceHistory(pts, seedPrice, base.market.priceLamports, now);
  const volRow = (vol!.results?.[0] ?? { v: 0, last: null }) as { v: number; last: number | null };
  // last trade at or before 24 h ago; otherwise the initial curve price (no trade that old: the price then was the
  // launch price, or the coin did not exist yet and the comparison is with its launch price)
  const agoPrice = (ago!.results?.[0] as { price_lamports?: number } | undefined)?.price_lamports ?? init;
  const market: MarketDTO = {
    ...base.market,
    vol24hLamports: u64s(volRow.v),
    change24hPct: change24h(base.market.priceLamports, agoPrice),
    lastTradeAt: trades[0]?.ts ?? row.last_trade_at,
  };
  const ticksSrc = trades.slice(0, 60).reverse();
  return {
    ...base,
    market,
    trades: trades.slice(0, 50).map((t) => tradeDTO(t, row.place_id)),
    history,
    historyAt,
    ticks: ticksSrc.map((t) => t.price_lamports),
    tickTimes: ticksSrc.map((t) => t.ts),
  };
}

/* ------------------------------------------------------------------------------------------------ /api/market */

const acctCache = new Map<string, { at: number; slot: number; v: AccountRaw | null }>();
/**
 * Curve / pool account cache per isolate, stale-while-revalidate (INTEGRATION §8 `/api/market` cache hit ≤ 60 ms, §9
 * price staleness 7 s). A viewer polls every 5 s and the next poll arrives ≈5.1-5.6 s later (fixed delay + RTT), so a
 * plain TTL either never hits (any TTL below the gap: 2 s and 4 s both measured ~1% hits) or must exceed the staleness
 * budget. Instead:
 *  - an entry younger than ACCT_FRESH_MS is served as is;
 *  - an entry between ACCT_FRESH_MS and ACCT_MAX_AGE_MS is served immediately AND refreshed in the background
 *    (`waitUntil`, one upstream call per isolate per batch of keys), so the viewer's next poll finds a fresh entry;
 *  - an entry older than ACCT_MAX_AGE_MS (or missing) is fetched before answering, together with any stale ones.
 * A served price is therefore at most 6 s old at read time (budget 7 s), and each quote's `at` is the time its
 * accounts were read from chain, not the time of the response.
 */
const ACCT_FRESH_MS = 2_500;
const ACCT_MAX_AGE_MS = 6_000;
const acctRefreshing = new Set<string>();

async function fetchAccountsInto(ctx: Ctx, keys: string[], now: number): Promise<number> {
  const res = await ctx.rpc(6).getMultipleAccounts(keys);
  keys.forEach((k, i) => acctCache.set(`${ctx.cluster}:${k}`, { at: now, slot: res.slot, v: res.accounts[i] ?? null }));
  if (acctCache.size > 5_000) for (const k of [...acctCache.keys()].slice(0, 1_000)) acctCache.delete(k);
  return res.slot;
}

/** Test helper. */
export function __resetMarketCache(): void {
  acctCache.clear();
  acctRefreshing.clear();
}
const lastIndexed = new Map<string, number>();

interface MarketRow {
  mint: string;
  bonding_curve: string;
  graduated: number;
  pool: string | null;
  pool_base_vault: string | null;
  pool_quote_vault: string | null;
  vol24h_lamports: number;
  change24h_pct: number | null;
  last_trade_at: number | null;
  real_sol: number | null;
  supply: number | null;
  status: string;
}

export async function handleMarket(ctx: Ctx, url: URL): Promise<Response> {
  await limit(ctx.env.RL_READ, `read:${ctx.ipHash}`);
  const mints = parseMints(url.searchParams.get('mints'));
  const now = ctx.deps.now();
  const snap = await metaSnapshot(ctx);
  const g = globalFrom(snap, ctx.cluster);
  if (!mints.length) return json({ quotes: {}, solUsd: freshSolUsd(snap, now), slot: 0, at: now } satisfies MarketResponse, 200, CACHE.market);
  const rows = (
    await ctx.db
      .prepare(
        `SELECT mint, bonding_curve, graduated, pool, pool_base_vault, pool_quote_vault, vol24h_lamports, change24h_pct, last_trade_at,
                real_sol, supply, status FROM coins WHERE cluster = ?1 AND mint IN (${placeholders(mints.length, 2)})`,
      )
      .bind(ctx.cluster, ...mints)
      .all<MarketRow>()
  ).results.filter((r) => r.status === 'live');

  const want: string[] = [];
  for (const r of rows) {
    if (r.graduated && r.pool && r.pool_base_vault && r.pool_quote_vault) want.push(r.pool, r.pool_base_vault, r.pool_quote_vault);
    else want.push(r.bonding_curve);
  }
  const miss: string[] = [];
  const stale: string[] = [];
  for (const k of new Set(want)) {
    const h = acctCache.get(`${ctx.cluster}:${k}`);
    if (!h || now - h.at >= ACCT_MAX_AGE_MS) miss.push(k);
    else if (now - h.at >= ACCT_FRESH_MS) stale.push(k);
  }
  let slot = 0;
  if (miss.length) {
    // going upstream anyway: refresh the stale entries in the same call
    slot = await fetchAccountsInto(ctx, [...miss, ...stale], now);
  } else if (stale.length) {
    const todo = stale.filter((k) => !acctRefreshing.has(`${ctx.cluster}:${k}`));
    if (todo.length) {
      for (const k of todo) acctRefreshing.add(`${ctx.cluster}:${k}`);
      ctx.waitUntil(
        fetchAccountsInto(ctx, todo, now)
          .catch((e) => ctx.log.warn('market.refresh_failed', { error: String(e).slice(0, 200) }))
          .finally(() => {
            for (const k of todo) acctRefreshing.delete(`${ctx.cluster}:${k}`);
          }),
      );
    }
  }
  const get = (k: string) => acctCache.get(`${ctx.cluster}:${k}`);
  const quotes: Record<string, MarketDTO> = {};
  for (const r of rows) {
    try {
      if (r.graduated && r.pool && r.pool_base_vault && r.pool_quote_vault) {
        const pool = get(r.pool);
        const b = get(r.pool_base_vault);
        const qv = get(r.pool_quote_vault);
        const base = b?.v ? tokenAccount(b.v.data)?.amount : undefined;
        const quote = qv?.v ? tokenAccount(qv.v.data)?.amount : undefined;
        if (base === undefined || quote === undefined || !pool?.v) continue;
        const vq = decodePumpPool(pool.v.data).virtualQuoteReserves;
        quotes[r.mint] = marketFromPool(base, quote, vq, BigInt(r.supply ?? Number(g.tokenTotalSupply)), b!.slot, Math.min(pool.at, b!.at, qv!.at), r);
        slot = Math.max(slot, b!.slot);
      } else {
        const c = get(r.bonding_curve);
        if (!c?.v || !accountExists(c.v)) continue;
        const curve = decodeBondingCurve(c.v.data);
        quotes[r.mint] = marketFromCurve(curve, g, c.slot, c.at, r);
        slot = Math.max(slot, c.slot);
        // opportunistic indexing: the curve moved since the indexer last saw it
        if (r.real_sol === null || BigInt(Math.round(r.real_sol)) !== curve.realQuoteReserves) {
          const last = lastIndexed.get(r.mint) ?? 0;
          if (now - last > 10_000) {
            lastIndexed.set(r.mint, now);
            ctx.waitUntil(indexMint(ctx, r.mint, 10).catch((e) => ctx.log.warn('index.opportunistic_failed', { mint: r.mint, error: String(e).slice(0, 200) })));
          }
        }
      }
    } catch {
      /* skip undecodable accounts */
    }
  }
  const out: MarketResponse = { quotes, solUsd: freshSolUsd(snap, now), slot, at: now };
  return json(out, 200, CACHE.market);
}

/* ------------------------------------------------------------------------------------------------ /api/top */

export async function handleTop(ctx: Ctx, url: URL): Promise<Response> {
  await limit(ctx.env.RL_READ, `read:${ctx.ipHash}`);
  const by = url.searchParams.get('by') === 'fees' ? 'fees' : 'mcap';
  const lim = parseLimit(url.searchParams.get('limit'), 20, by === 'mcap' ? 300 : 100);
  const now = ctx.deps.now();
  const bbox = parseBbox(url.searchParams.get('bbox'));
  const order = by === 'fees' ? 'COALESCE(coins.fees_earned_lamports, 0) DESC' : 'COALESCE(coins.mcap_lamports, 0) DESC';
  let stmt: D1PreparedStatement;
  const base = `SELECT ${COIN_COLUMNS} FROM ${COIN_FROM} WHERE coins.status = 'live' AND coins.cluster = ?1`;
  if (bbox) {
    const b = bboxSql(bbox, now, 2);
    stmt = ctx.db.prepare(`${base} AND ${b.sql} ORDER BY ${order} LIMIT ?7`).bind(ctx.cluster, ...b.params, lim);
  } else {
    stmt = ctx.db.prepare(`${base} ORDER BY ${order} LIMIT ?2`).bind(ctx.cluster, lim);
  }
  const [rows, snap] = await Promise.all([stmt.all<CoinRow>(), metaSnapshot(ctx)]);
  const g = globalFrom(snap, ctx.cluster);
  const out: TopResponse = { by, coins: rows.results.map((r) => coinDTO(r, ctx.origin, g, now)), solUsd: freshSolUsd(snap, now), at: now };
  return json(out, 200, CACHE.top);
}

/* ------------------------------------------------------------------------------------------------ /api/feed */

const DUST_LAMPORTS = 1_000_000; // trades under 0.001 SOL are dropped from the feed

export async function handleFeed(ctx: Ctx, url: URL): Promise<Response> {
  await limit(ctx.env.RL_READ, `read:${ctx.ipHash}`);
  const q = url.searchParams;
  const now = ctx.deps.now();
  const lim = parseLimit(q.get('limit'), 50, 100);
  const since = q.get('since') ? Number(q.get('since')) : 0;
  const before = q.get('before') ? Number(q.get('before')) : now + 60_000;
  if (!Number.isFinite(since) || !Number.isFinite(before)) throw new ApiErr('bad_request', 'Invalid since/before');
  const kindsRaw = q.get('kinds');
  const kinds = new Set((kindsRaw ? kindsRaw.split(',') : ['trade', 'launch', 'claim']).map((k) => k.trim()));
  for (const k of kinds) if (!['trade', 'launch', 'claim'].includes(k)) throw new ApiErr('bad_request', 'Invalid kinds');
  const bbox = parseBbox(q.get('bbox'));
  const bb = bbox ? bboxSql(bbox, now, 5) : null;
  const geo = bb ? ` AND ${bb.sql}` : '';
  const geoParams = bb ? bb.params : [];
  const stmts: D1PreparedStatement[] = [];
  const order: string[] = [];
  if (kinds.has('trade')) {
    order.push('trade');
    stmts.push(
      ctx.db
        .prepare(
          `SELECT t.sig, t.ix, t.mint, t.side, t.sol_lamports, t.user_lamports, t.tokens, t.trader, t.ts, coins.place_id, coins.ticker, coins.name, coins.emoji, coins.bg
           FROM trades t JOIN coins ON coins.mint = t.mint
           WHERE coins.status = 'live' AND coins.cluster = ?1 AND t.ts > ?2 AND t.ts < ?3 AND t.sol_lamports >= ?4${geo}
           ORDER BY t.ts DESC, t.sig DESC, t.ix DESC LIMIT ${lim}`,
        )
        .bind(ctx.cluster, since, before, DUST_LAMPORTS, ...geoParams),
    );
  }
  if (kinds.has('launch')) {
    order.push('launch');
    stmts.push(
      ctx.db
        .prepare(
          `SELECT coins.mint, coins.place_id, coins.ticker, coins.name, coins.emoji, coins.bg, coins.launcher, coins.launch_sig, coins.created_at
           FROM coins WHERE coins.status = 'live' AND coins.cluster = ?1 AND coins.created_at > ?2 AND coins.created_at < ?3 AND ?4 >= 0${geo}
           ORDER BY coins.created_at DESC LIMIT ${lim}`,
        )
        .bind(ctx.cluster, since, before, 0, ...geoParams),
    );
  }
  if (kinds.has('claim')) {
    order.push('claim');
    stmts.push(
      ctx.db
        .prepare(
          `SELECT cl.id, cl.status, cl.new_owner, cl.request_sig, cl.finalize_sig, cl.onchain_at, cl.finalized_at,
                  coins.mint, coins.place_id, coins.ticker, coins.name, coins.emoji, coins.bg
           FROM claims cl JOIN coins ON coins.place_id = cl.place_id
           WHERE coins.status = 'live' AND coins.cluster = ?1 AND cl.status IN ('pending_onchain','finalized')
             AND COALESCE(cl.finalized_at, cl.onchain_at) > ?2 AND cl.onchain_at < ?3 AND ?4 >= 0${geo}
           ORDER BY COALESCE(cl.finalized_at, cl.onchain_at) DESC LIMIT ${lim}`,
        )
        .bind(ctx.cluster, since, before, 0, ...geoParams),
    );
    // payouts: the shop-vault `Withdrawn` events (exact amount of each withdrawal, from the chain)
    order.push('withdraw');
    stmts.push(
      ctx.db
        .prepare(
          `SELECT ev.sig, ev.ix, ev.ts, ev.data_json, coins.mint, coins.place_id, coins.ticker, coins.name, coins.emoji, coins.bg
           FROM chain_events ev JOIN coins ON coins.place_hash = ev.place_hash
           WHERE ev.kind = 'Withdrawn' AND coins.status = 'live' AND coins.cluster = ?1 AND ev.ts > ?2 AND ev.ts < ?3 AND ?4 >= 0${geo}
           ORDER BY ev.ts DESC LIMIT ${lim}`,
        )
        .bind(ctx.cluster, since, before, 0, ...geoParams),
    );
  }
  const results = stmts.length ? await ctx.db.batch(stmts) : [];
  const events: FeedEventDTO[] = [];
  results.forEach((res, i) => {
    const kind = order[i];
    for (const r of (res.results ?? []) as Record<string, unknown>[]) {
      const baseEv = {
        mint: r.mint as string,
        placeId: r.place_id as string,
        ticker: r.ticker as string,
        name: r.name as string,
        emoji: r.emoji as string,
        bg: r.bg as string,
      };
      if (kind === 'trade') {
        events.push({
          ...baseEv,
          kind: 'trade',
          id: `${r.sig}:${r.ix}`,
          ts: r.ts as number,
          side: r.side as 'buy' | 'sell',
          solLamports: u64s(r.sol_lamports as number),
          userLamports: r.user_lamports === null || r.user_lamports === undefined ? null : u64s(r.user_lamports as number),
          tokens: u64s(r.tokens as number),
          wallet: r.trader as string,
          sig: r.sig as string,
        });
      } else if (kind === 'launch') {
        events.push({ ...baseEv, kind: 'launch', id: `launch:${r.mint}`, ts: r.created_at as number, wallet: r.launcher as string, sig: r.launch_sig as string });
      } else if (kind === 'withdraw') {
        // amount + owner come from the event itself; rows recorded before amounts were stored are skipped
        let d: { owner?: string | null; amount?: string | null } = {};
        try {
          d = JSON.parse(String(r.data_json ?? '{}')) as typeof d;
        } catch {
          d = {};
        }
        if (!d.owner || !d.amount || !/^\d{1,20}$/.test(d.amount)) continue;
        events.push({ ...baseEv, kind: 'claim', stage: 'withdrawn', id: `withdraw:${r.sig}:${r.ix}`, ts: r.ts as number, wallet: d.owner, feesLamports: d.amount, sig: r.sig as string });
      } else {
        // ownership events move no money: no amount (the payout is its own `withdrawn` event)
        if (r.onchain_at && (r.onchain_at as number) > since && (r.onchain_at as number) < before) {
          events.push({ ...baseEv, kind: 'claim', stage: 'requested', id: `claim:${r.id}:requested`, ts: r.onchain_at as number, wallet: r.new_owner as string, feesLamports: null, sig: (r.request_sig as string) ?? null });
        }
        if (r.status === 'finalized' && r.finalized_at && (r.finalized_at as number) > since && (r.finalized_at as number) < before) {
          events.push({ ...baseEv, kind: 'claim', stage: 'finalized', id: `claim:${r.id}:finalized`, ts: r.finalized_at as number, wallet: r.new_owner as string, feesLamports: null, sig: (r.finalize_sig as string) ?? null });
        }
      }
    }
  });
  // newest first; within one timestamp a launch is older than its own dev buy, claims are newest
  const rank = { launch: 0, trade: 1, claim: 2 } as const;
  events.sort((a, b) => b.ts - a.ts || rank[b.kind] - rank[a.kind] || (a.id < b.id ? 1 : -1));
  const out: FeedResponse = { events: events.slice(0, lim), now };
  return json(out, 200, CACHE.feed);
}

/* ------------------------------------------------------------------------------------------------ /api/place */

export async function handlePlace(ctx: Ctx, placeId: string): Promise<Response> {
  await limit(ctx.env.RL_READ, `read:${ctx.ipHash}`);
  if (!validPlaceId(placeId, ctx.cluster)) throw new ApiErr('bad_request', 'Invalid placeId');
  const now = ctx.deps.now();
  const [row, lock, snap, optedOut] = await Promise.all([
    loadCoinByPlace(ctx, placeId),
    ctx.db.prepare("SELECT 1 AS x FROM launch_reservations WHERE place_id = ?1 AND status = 'cosigned' AND locked_until > ?2 LIMIT 1").bind(placeId, now).first(),
    metaSnapshot(ctx),
    placeOptedOut(ctx.db, placeId),
  ]);
  const g = globalFrom(snap, ctx.cluster);
  const out: PlaceResponse = { placeId, coin: row && row.status === 'live' ? coinDTO(row, ctx.origin, g, now) : null, launchInProgress: !!lock && !row };
  // hidden coins stay out of discovery; the flags only let the panel say why there is no Launch (and offer the claim)
  if (optedOut) out.optedOut = true;
  if (row && row.status !== 'live') out.hidden = true;
  return json(out, 200, CACHE.coin);
}

export async function handleEligibility(ctx: Ctx, placeId: string): Promise<Response> {
  await limit(ctx.env.RL_GOOGLE, `google:${ctx.ipHash}`);
  if (!validPlaceId(placeId, ctx.cluster)) throw new ApiErr('bad_request', 'Invalid placeId');
  await cap(ctx.db, `elig:ip:${ctx.ipHash}`, 200, DAY, ctx.deps.now(), 'rate_limited', 'Too many lookups today. Try again tomorrow.');
  // an opted-out business (worker/takedown.ts) is answered without the paid Google lookup
  if (await placeOptedOut(ctx.db, placeId)) return json({ placeId, launchable: false, reason: 'opted_out', category: null } satisfies EligibilityResponse, 200, CACHE.none);
  const e = await eligibility(ctx.env, ctx.deps, ctx.cluster, placeId, () => spendGoogleLookup(ctx));
  if (e.reason === 'ok') assertPlaceAllowed(ctx.env, e.region, 'launch'); // the launch flow says so before the art step
  let reason = e.reason;
  if (reason === 'ok' && e.placeId !== placeId && (await placeOptedOut(ctx.db, e.placeId))) reason = 'opted_out';
  if (reason === 'ok') {
    const taken = await ctx.db.prepare('SELECT mint FROM coins WHERE place_id = ?1 OR place_id = ?2 LIMIT 1').bind(placeId, e.placeId).first();
    if (taken) reason = 'taken';
    else {
      const { vaultState } = await placeAddresses(e.placeId, programIdOf(ctx.env));
      const acc = await ctx.rpc(3).getAccount(vaultState);
      if (accountExists(acc) && acc.data.length > 0) {
        reason = 'taken';
        ctx.waitUntil(adoptFromChain(ctx, e.placeId)); // registered on-chain but missing from the registry
      }
    }
  }
  const out: EligibilityResponse = { placeId: e.placeId, launchable: reason === 'ok', reason, category: reason === 'ok' ? e.category : null };
  return json(out, 200, CACHE.none);
}
