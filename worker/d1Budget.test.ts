/**
 * The D1 budget on Workers Free: 100,000 rows written and 5,000,000 read a day for the whole account (devnet and mainnet
 * together), 500 MB stored. Devnet build, fake upstreams, node:sqlite D1 with the real migrations:
 *  - the mirrors (curve, pool, vault, 24 h figures) are written only when a value moved, so an idle cron run writes
 *    only its bookkeeping rows; the curve and vault sweeps still reach every coin, paging by rowid across runs;
 *  - the lock is released by expiring it; per-value kv rows and quiet cursors are not rewritten every run;
 *  - the `trade_amounts` backfill reads a partial index (migration 0004) and idles hourly once nothing is missing;
 *  - devnet's cron runs every 5 minutes: the freshness windows follow it;
 *  - unused uploads go after 6 hours (never one a reservation or coin points at); uploads have a global daily budget.
 */
import './test/globals';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { placeAddresses } from './addresses';
import { b58encode } from './bytes';
import { __resetChainCaches } from './chainState';
import { curveUpdateStmt, marketFromCurve, parseVaultSweep, poolUpdateStmt, vaultUpdateStmt } from './coins';
import { CONFIG_PDA, PUMP_GLOBAL, PUMP_PROGRAM, SHOP_VAULT_PROGRAM_ID } from './consts';
import { cronPeriodMs, DAY, HOUR, type Deps } from './ctx';
import type { Env } from './env';
import { ipHash } from './hmac';
import { aggregatesStmt, MISSING_TRADE_AMOUNTS_SQL, runIndexer, UPLOAD_KEEP_MS } from './indexer';
import { __resetMetaCache } from './meta';
import { META_GLOBAL_PER_DAY } from './metadata';
import { buildCtx, handlePhase2 } from './router';
import { configData, curveData, FakeWorld, pumpGlobalData, vaultStateData } from './test/fakeChain';
import { FakeD1 } from './test/fakeD1';
import { NodeBuffer, web3 } from './test/launchFixture';
import type { HealthResponse } from './wire';

const ORIGIN = 'https://cornershop-devnet.tiejiucai.workers.dev';
const SYSTEM = '11111111111111111111111111111111';
const b64 = (u: Uint8Array) => NodeBuffer.from(u).toString('base64');
const newKey = () => web3.Keypair.generate().publicKey.toBase58() as string;
const newSig = () => b58encode(crypto.getRandomValues(new Uint8Array(64)));

/** pump's initial curve on devnet (pumpGlobalData), and the same curve after a 0.1 SOL buy. */
const FRESH = { vTok: 1_073_000_000_000_000n, vSol: 1_000_000_000n, rTok: 793_100_000_000_000n, rSol: 0n };
const BOUGHT = { vTok: 975_454_545_454_546n, vSol: 1_100_000_000n, rTok: 695_554_545_454_546n, rSol: 100_000_000n };

function fixture() {
  __resetMetaCache();
  __resetChainCaches();
  const world = new FakeWorld();
  const db = new FakeD1();
  const t = { now: Date.UTC(2026, 9, 27, 12, 0, 30) };
  const env: Env = {
    ASSETS: { fetch: async () => new Response('x') } as unknown as Fetcher,
    DB: db.asD1(),
    CLUSTER: 'devnet',
    PUBLIC_ORIGIN: ORIGIN,
    PROGRAM_ID: SHOP_VAULT_PROGRAM_ID,
    MAX_DEV_BUY_LAMPORTS: '1000000000',
    PRIORITY_FEE_DEFAULT: '10000',
    GOOGLE_SERVER_KEY: 'google-server-key-test-d1',
    ALCHEMY_API_KEY: 'alchemy-secret-key-d1-budget',
    ATTESTOR_SECRET: b64(web3.Keypair.generate().secretKey),
    CRANK_SECRET: b64(web3.Keypair.generate().secretKey),
    HMAC_KEY: b64(crypto.getRandomValues(new Uint8Array(32))),
  };
  const deps: Deps = { fetch: world.fetch, now: () => t.now, sleep: async () => {} };
  const pending: Promise<unknown>[] = [];
  const exec = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const flush = async () => {
    while (pending.length) await Promise.allSettled(pending.splice(0));
  };
  world.chain.set(CONFIG_PDA, { lamports: 2_000_000n, owner: SHOP_VAULT_PROGRAM_ID, data: configData({ attestor: newKey(), guardian: newKey(), governance: newKey(), window: 60 }) });
  world.chain.set(PUMP_GLOBAL, { lamports: 1n, owner: PUMP_PROGRAM, data: pumpGlobalData() });
  // the art + metadata the test coins point at (foreign keys are enforced, as on D1)
  db.raw.prepare("INSERT INTO assets(id, content_type, bytes, width, height, created_at) VALUES ('a', 'image/png', x'00', 1, 1, ?)").run(t.now);
  db.raw.prepare("INSERT INTO metadata(id, json, name, symbol, description, image_id, place_id, created_at) VALUES ('m', '{}', 'Test', 'TEST', '', 'a', 'x', ?)").run(t.now);
  const cron = async () => {
    db.writeLog = [];
    const r = await runIndexer((await buildCtx(env, exec, deps, 'cron'))!);
    await flush();
    return r;
  };
  const request = async (path: string, init: RequestInit = {}) => {
    __resetMetaCache();
    const res = (await handlePhase2(new Request(`${ORIGIN}${path}`, init), env, exec, deps))!;
    await flush();
    return res;
  };
  /** kv_meta.indexer_jobs: the jobs' last runs and the sweeps' places. */
  const jobs = () => JSON.parse(db.get<{ value: string }>("SELECT value FROM kv_meta WHERE key = 'indexer_jobs'")!.value) as Record<string, number>;
  const coinWrites = () => db.writeLog.filter((w) => /^UPDATE coins\b/.test(w.sql));
  const rowsWritten = () => db.writeLog.reduce((n, w) => n + w.changes, 0);
  let n = 0;
  /** A registered coin (D1 row; VaultState, vault and optionally its curve on the fake chain). */
  const addCoin = async (o: { createdAt?: number; vaultAt?: number | null; curve?: boolean; pdas?: boolean } = {}) => {
    const placeId = `cornershop-test:d1-${++n}`;
    const a = o.pdas === false ? { placeHashHex: NodeBuffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'), vault: newKey(), vaultState: newKey() } : await placeAddresses(placeId, SHOP_VAULT_PROGRAM_ID);
    const mint = newKey();
    const launcher = newKey();
    const curve = newKey();
    db.raw
      .prepare(
        `INSERT INTO coins(place_id, place_hash, mint, vault, vault_state, bonding_curve, ticker, name, category, emoji, bg, metadata_id, launcher,
           created_at, launch_sig, launch_slot, cluster, vault_at, holders, holders_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'TEST', 'Test', 'cafe', '☕', '#000000', 'm', ?, ?, ?, 1, 'devnet', ?, 0, ?, ?)`,
      )
      .run(placeId, a.placeHashHex, mint, a.vault, a.vaultState, curve, launcher, o.createdAt ?? t.now - HOUR, newSig(), o.vaultAt === undefined ? null : o.vaultAt, t.now, t.now);
    if (o.pdas !== false) {
      world.chain.set(a.vaultState, { lamports: 2_338_000n, owner: SHOP_VAULT_PROGRAM_ID, data: vaultStateData({ placeHashHex: a.placeHashHex, mint, launcher }) });
      world.chain.set(a.vault, { lamports: 890_880n, owner: SYSTEM, data: new Uint8Array(0) });
    }
    if (o.curve) world.chain.set(curve, { lamports: 1_500_000n, owner: PUMP_PROGRAM, data: curveData({ ...FRESH, creator: a.vault }) });
    return { placeId, mint, curve, vault: a.vault };
  };
  return { world, db, env, deps, t, cron, request, jobs, coinWrites, rowsWritten, addCoin };
}

const coinRow = (db: FakeD1, mint: string) =>
  db.get<{ real_sol: number | null; market_at: number | null; market_slot: number | null; vault_at: number | null; updated_at: number; fees_withdrawable_lamports: number; change24h_pct: number | null }>(
    'SELECT real_sol, market_at, market_slot, vault_at, updated_at, fees_withdrawable_lamports, change24h_pct FROM coins WHERE mint = ?',
    mint,
  )!;

/* ======================================================================================== the indexer cron */

describe('indexer cron: an idle coin costs no D1 write', () => {
  it('only moved values are written; a quiet run writes its 6 bookkeeping rows and nothing else', async () => {
    const fx = fixture();
    const c = await fx.addCoin({ curve: true });

    // run 1: everything is new (market, vault, 24 h figures, cursors, kv)
    let r = await fx.cron();
    expect(r.jobs.curves).toBe('1 read, 1 moved');
    expect(r.jobs.vaults).toBe('1 vaults, 1 changed');
    const first = coinRow(fx.db, c.mint);
    expect(first).toMatchObject({ real_sol: 0, vault_at: fx.t.now });
    expect(first.change24h_pct).toBe(0);

    // run 2, a minute later, nothing moved on chain
    fx.t.now += 61_000;
    r = await fx.cron();
    expect(r.jobs).toMatchObject({ curves: '1 read, 0 moved', vaults: '0 coins', priority_fee: '10000', trade_amounts: 'not due', withdraw_amounts: 'not due' });
    expect(fx.coinWrites()).toEqual([]);
    expect(coinRow(fx.db, c.mint)).toEqual(first);
    // the lock taken + released (1 + 1), sol_usd + chain_config (the read routes' freshness), indexer_jobs +
    // indexer_last_run: 6 rows, all kv_meta
    expect(fx.db.writeLog.every((w) => /^(INSERT INTO|UPDATE) kv_meta\b/.test(w.sql))).toBe(true);
    expect(fx.rowsWritten()).toBe(6);
    expect(fx.db.all<{ key: string }>('SELECT key FROM kv_meta WHERE updated_at = ? ORDER BY key', fx.t.now).map((k) => k.key)).toEqual([
      'chain_config',
      'indexer_jobs',
      'indexer_last_run',
      'sol_usd',
    ]);
    const priority = fx.db.get<{ updated_at: number }>("SELECT updated_at FROM kv_meta WHERE key = 'priority_fee'")!.updated_at;
    expect(priority).toBe(fx.t.now - 61_000); // unchanged value: not rewritten

    // 10 min on: the full curve sweep and the vault sweep re-read the coin, still no coin write; the quiet cursors (the
    // coin's curve and the program monitor's) get their 10-minute "checked" stamp
    const monitorAt = () => fx.db.get<{ updated_at: number }>('SELECT updated_at FROM indexer_cursors WHERE account = ?', SHOP_VAULT_PROGRAM_ID)!.updated_at;
    const monitorBefore = monitorAt();
    fx.t.now += 10 * 60_000;
    r = await fx.cron();
    expect(r.jobs).toMatchObject({ curves: '1 read, 0 moved', vaults: '1 vaults, 0 changed' });
    expect(fx.coinWrites()).toEqual([]);
    expect(monitorAt()).toBe(fx.t.now);
    expect(monitorAt()).not.toBe(monitorBefore);
    expect(fx.rowsWritten()).toBe(6 + 2 + 1); // + the two cursors + pump Global's own 10-minute refresh

    // a buy moves the curve, fees reach the vault: the market is written on the next run, the vault on its sweep
    fx.world.chain.set(c.curve, { lamports: 1_500_000n, owner: PUMP_PROGRAM, data: curveData({ ...BOUGHT, creator: c.vault }) });
    fx.world.chain.set(c.vault, { lamports: 890_880n + 500_000n, owner: SYSTEM, data: new Uint8Array(0) });
    fx.t.now += 61_000;
    r = await fx.cron();
    expect(r.jobs.curves).toBe('1 read, 1 moved');
    expect(coinRow(fx.db, c.mint)).toMatchObject({ real_sol: 100_000_000, market_at: fx.t.now, fees_withdrawable_lamports: 0 });
    fx.t.now += 10 * 60_000;
    r = await fx.cron();
    expect(r.jobs.vaults).toBe('1 vaults, 1 changed');
    expect(coinRow(fx.db, c.mint)).toMatchObject({ fees_withdrawable_lamports: 500_000, vault_at: fx.t.now });

    // a trade since the last vault read brings the coin back within a minute; unchanged fees still stamp vault_at
    // once, so it does not come back every run
    fx.db.raw.prepare('UPDATE coins SET last_trade_at = ? WHERE mint = ?').run(fx.t.now + 1, c.mint);
    fx.t.now += 61_000;
    r = await fx.cron();
    expect(r.jobs.vaults).toBe('1 vaults, 1 changed');
    fx.t.now += 61_000;
    r = await fx.cron();
    expect(r.jobs.vaults).toBe('0 coins');
  });

  it('the vault sweep reaches every coin, 32 a run, at least every 10 min, without writing unchanged ones', async () => {
    const fx = fixture();
    for (let i = 0; i < 40; i++) await fx.addCoin({ createdAt: fx.t.now - 3 * DAY, vaultAt: fx.t.now - HOUR });
    const rid = (k: number) => fx.db.get<{ rid: number }>('SELECT rowid AS rid FROM coins ORDER BY rowid LIMIT 1 OFFSET ?', k - 1)!.rid;
    let r = await fx.cron();
    expect(r.jobs.vaults).toBe('32 vaults, 0 changed');
    expect(fx.jobs().vaults_from).toBe(rid(32));
    expect(fx.coinWrites()).toEqual([]);
    fx.t.now += 61_000;
    r = await fx.cron();
    expect(r.jobs.vaults).toBe('8 vaults, 0 changed');
    expect(fx.jobs().vaults_from).toBe(0);
    fx.t.now += 61_000;
    expect((await fx.cron()).jobs.vaults).toBe('0 coins'); // pass done; the next starts 10 min after this one did
    fx.t.now += 8 * 60_000;
    expect((await fx.cron()).jobs.vaults).toBe('32 vaults, 0 changed');
    expect(fx.coinWrites()).toEqual([]);
  });

  it('the curve sweeps page through more than 300 coins by rowid, each kind from where it stopped', async () => {
    const fx = fixture();
    for (let i = 0; i < 301; i++) await fx.addCoin({ vaultAt: fx.t.now, pdas: false });
    const rid300 = fx.db.get<{ rid: number }>('SELECT rowid AS rid FROM coins ORDER BY rowid LIMIT 1 OFFSET 299')!.rid;
    let r = await fx.cron(); // the first run is a full sweep
    expect(r.jobs.curves).toBe('300 read, 0 moved');
    expect(fx.jobs()).toMatchObject({ curves_full_from: rid300 });
    fx.t.now += 61_000;
    r = await fx.cron(); // hot coins (all of them: created an hour ago)
    expect(r.jobs.curves).toBe('300 read, 0 moved');
    expect(fx.jobs()).toMatchObject({ curves_from: rid300, curves_full_from: rid300 });
    fx.t.now += 61_000;
    r = await fx.cron();
    expect(r.jobs.curves).toBe('1 read, 0 moved');
    expect(fx.jobs()).toMatchObject({ curves_from: 0 });
    fx.t.now += 10 * 60_000;
    r = await fx.cron(); // the next full sweep carries on with coin 301
    expect(r.jobs.curves).toBe('1 read, 0 moved');
    expect(fx.jobs()).toMatchObject({ curves_full_from: 0 });
  }, 60_000);

  it('the indexer lock: released by expiring it, refused while fresh, taken over once stale', async () => {
    const fx = fixture();
    await fx.cron();
    expect(fx.db.get<{ updated_at: number }>("SELECT updated_at FROM kv_meta WHERE key = 'indexer_lock'")!.updated_at).toBe(0);
    fx.db.raw.prepare("UPDATE kv_meta SET value = '\"other\"', updated_at = ? WHERE key = 'indexer_lock'").run(fx.t.now);
    fx.t.now += 30_000;
    expect((await fx.cron()).skipped).toBe('locked');
    expect(fx.db.writeLog).toEqual([]);
    fx.t.now += 30_000; // 60 s old: past LOCK_MS (50 s)
    const r = await fx.cron();
    expect(r.skipped).toBeUndefined();
    expect(fx.db.get<{ value: string; updated_at: number }>("SELECT value, updated_at FROM kv_meta WHERE key = 'indexer_lock'")!.updated_at).toBe(0);
  });
});

describe('mirror statements write only what moved', () => {
  const g = { initialVirtualTokenReserves: FRESH.vTok, initialVirtualQuoteReserves: FRESH.vSol, initialRealTokenReserves: FRESH.rTok, tokenTotalSupply: 1_000_000_000_000_000n };
  const curve = (f: typeof FRESH) => ({
    virtualTokenReserves: f.vTok,
    virtualQuoteReserves: f.vSol,
    realTokenReserves: f.rTok,
    realQuoteReserves: f.rSol,
    tokenTotalSupply: g.tokenTotalSupply,
    complete: false,
    creator: SYSTEM,
    isMayhemMode: false,
    isCashbackCoin: false,
    quoteMint: SYSTEM,
    isHolderReward: false,
    creatorFeeBucket: 0n,
  });

  it('curve / pool: same market → no write (market_at keeps the time it last changed); an older slot never wins', async () => {
    const fx = fixture();
    const c = await fx.addCoin();
    const db = fx.db.asD1();
    const changes = async (s: D1PreparedStatement) => (await s.run()).meta.changes;
    expect(await changes(curveUpdateStmt(db, c.mint, curve(FRESH), g, 10, 1_000))).toBe(1);
    expect(await changes(curveUpdateStmt(db, c.mint, curve(FRESH), g, 11, 2_000))).toBe(0);
    expect(coinRow(fx.db, c.mint)).toMatchObject({ market_at: 1_000, market_slot: 10 });
    expect(await changes(curveUpdateStmt(db, c.mint, curve(BOUGHT), g, 12, 3_000))).toBe(1);
    expect(await changes(curveUpdateStmt(db, c.mint, curve(FRESH), g, 11, 4_000))).toBe(0); // older slot
    expect(coinRow(fx.db, c.mint)).toMatchObject({ real_sol: 100_000_000, market_at: 3_000, market_slot: 12 });
    const pool = marketFromCurve(curve(BOUGHT), g, 13, 5_000);
    expect(await changes(poolUpdateStmt(db, c.mint, pool, 5_000))).toBe(1); // complete / progress 100 are new
    expect(await changes(poolUpdateStmt(db, c.mint, { ...pool, slot: 14 }, 6_000))).toBe(0);
    expect(await changes(poolUpdateStmt(db, c.mint, { ...pool, slot: 15, realSol: '100000001' }, 7_000))).toBe(1);
  });

  it('vault: same fees and owner → no write, unless never read or traded since the last read', async () => {
    const fx = fixture();
    const c = await fx.addCoin();
    const db = fx.db.asD1();
    const rent = { r0: 890_880n, rState: 2_338_560n, rToken: 2_039_280n };
    const vs = fx.world.chain.accounts.get(fx.db.get<{ vault_state: string }>('SELECT vault_state FROM coins WHERE mint = ?', c.mint)!.vault_state)!;
    const vaultState = { lamports: vs.lamports, owner: vs.owner, data: vs.data, executable: false };
    const sweep = (vaultLamports: bigint) =>
      parseVaultSweep([{ lamports: vaultLamports, owner: SYSTEM, data: new Uint8Array(0), executable: false }, vaultState, null, null, null], false, rent, c.vault);
    const changes = async (s: D1PreparedStatement) => (await s.run()).meta.changes;
    expect(await changes(vaultUpdateStmt(db, c.mint, sweep(890_880n), 1_000))).toBe(1); // vault_at was NULL
    expect(await changes(vaultUpdateStmt(db, c.mint, sweep(890_880n), 2_000))).toBe(0);
    expect(await changes(vaultUpdateStmt(db, c.mint, sweep(990_880n), 3_000))).toBe(1);
    expect(coinRow(fx.db, c.mint)).toMatchObject({ fees_withdrawable_lamports: 100_000, vault_at: 3_000 });
    fx.db.raw.prepare('UPDATE coins SET last_trade_at = 3_500 WHERE mint = ?').run(c.mint);
    expect(await changes(vaultUpdateStmt(db, c.mint, sweep(990_880n), 4_000))).toBe(1); // traded since: stamped
    expect(await changes(vaultUpdateStmt(db, c.mint, sweep(990_880n), 5_000))).toBe(0);
  });

  it('24 h figures: the cron recomputes every active coin, but writes only those whose volume or change moved', async () => {
    const fx = fixture();
    const c = await fx.addCoin({ createdAt: fx.t.now - 3 * DAY });
    const db = fx.db.asD1();
    const now = fx.t.now;
    fx.db.raw.prepare('UPDATE coins SET price_lamports = 0.002, last_trade_at = ? WHERE mint = ?').run(now - HOUR, c.mint);
    const trade = fx.db.raw.prepare("INSERT INTO trades(sig, ix, mint, side, sol_lamports, tokens, trader, price_lamports, venue, slot, ts) VALUES (?, 0, ?, 'buy', ?, 1, 'x', ?, 'curve', 1, ?)");
    trade.run(newSig(), c.mint, 50_000_000, 0.001, now - 2 * DAY);
    trade.run(newSig(), c.mint, 70_000_000, 0.002, now - HOUR);
    const changes = async (at: number) => (await aggregatesStmt(db, 'devnet', at, 1, undefined).run()).meta.changes;
    expect(await changes(now)).toBe(1);
    expect(fx.db.get('SELECT vol24h_lamports, change24h_pct FROM coins WHERE mint = ?', c.mint)).toEqual({ vol24h_lamports: 70_000_000, change24h_pct: 100 });
    expect(await changes(now + 60_000)).toBe(0);
    expect(await changes(now + 120_000)).toBe(0);
    trade.run(newSig(), c.mint, 30_000_000, 0.002, now + 150_000);
    expect(await changes(now + 180_000)).toBe(1);
    expect(fx.db.get<{ vol24h_lamports: number }>('SELECT vol24h_lamports FROM coins WHERE mint = ?', c.mint)!.vol24h_lamports).toBe(100_000_000);
    // the hour-old trade leaves the 24 h window a day later
    expect(await changes(now + DAY - HOUR + 60_000)).toBe(1);
    expect(fx.db.get<{ vol24h_lamports: number }>('SELECT vol24h_lamports FROM coins WHERE mint = ?', c.mint)!.vol24h_lamports).toBe(30_000_000);
  });
});

/* ======================================================================================== reads */

describe('trade_amounts backfill (migration 0004)', () => {
  it('reads only the partial index of rows still missing user_lamports, not the whole trades table', () => {
    const db = new FakeD1();
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'trades_user_lamports_missing'")!.n).toBe(1);
    const plan = db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${MISSING_TRADE_AMOUNTS_SQL}`).map((p) => p.detail);
    expect(plan.join(' | ')).toMatch(/SCAN trades USING (COVERING )?INDEX trades_user_lamports_missing/);
  });

  it('once nothing is missing it looks again only hourly', async () => {
    const fx = fixture();
    expect((await fx.cron()).jobs.trade_amounts).toBe('none missing');
    fx.t.now += 61_000;
    expect((await fx.cron()).jobs.trade_amounts).toBe('not due');
    fx.t.now += HOUR;
    expect((await fx.cron()).jobs.trade_amounts).toBe('none missing');
  });
});

/* ======================================================================================== devnet cron period */

describe('devnet cron every 5 minutes', () => {
  it('wrangler.jsonc: devnet */5, mainnet every minute, as cronPeriodMs says', () => {
    const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url).pathname, 'utf8');
    const crons = [...text.matchAll(/"crons":\s*\[\s*"([^"]+)"\s*\]/g)].map((m) => m[1]!);
    expect(crons).toEqual(['*/5 * * * *', '* * * * *']); // env.devnet, env.mainnet (file order)
    const everyMin = (c: string) => (c.startsWith('*/') ? Number(c.slice(2, c.indexOf(' '))) : 1);
    expect(everyMin(crons[0]!) * 60_000).toBe(cronPeriodMs('devnet'));
    expect(everyMin(crons[1]!) * 60_000).toBe(cronPeriodMs('mainnet'));
    // mainnet keeps its windows: request fallback after 90 s, health "stale" after 3 min, kv Config 2 min
    expect([1.5, 3, 2].map((k) => k * cronPeriodMs('mainnet'))).toEqual([90_000, 180_000, 120_000]);
  });

  it('a working 5-minute cron is neither doubled by the request fallback nor reported stale', async () => {
    const fx = fixture();
    await fx.cron();
    const lastRun = () => fx.db.get<{ value: string }>("SELECT value FROM kv_meta WHERE key = 'indexer_last_run'")!.value;
    const at = Number(lastRun());
    fx.t.now = at + 4 * 60_000 + 50_000; // just before the next cron
    expect((await fx.request('/api/feed')).status).toBe(200);
    expect(Number(lastRun())).toBe(at); // no fallback run
    const h = (await (await fx.request('/api/health')).json()) as HealthResponse;
    expect(h.checks.indexer).toBe('ok');
    expect(h.indexerLagSec).toBe(290);
    // the cron missed a run: requests drive the indexer after 1.5 periods (7.5 min)
    fx.t.now = at + 7 * 60_000 + 40_000;
    await fx.request('/api/feed');
    expect(Number(lastRun())).toBe(fx.t.now);
    // stale after 3 missed periods
    fx.db.raw.prepare("UPDATE kv_meta SET value = ? WHERE key = 'indexer_last_run'").run(String(fx.t.now - 15 * 60_000 - 1_000));
    fx.db.raw.prepare("UPDATE kv_meta SET updated_at = ? WHERE key = 'indexer_lock'").run(fx.t.now); // keep the fallback out
    expect(((await (await fx.request('/api/health')).json()) as HealthResponse).checks.indexer).toBe('stale');
  });
});

/* ======================================================================================== storage */

describe('uploads: 6-hour retention for unused ones, and a global daily budget', () => {
  it('the cron deletes unused uploads after UPLOAD_KEEP_MS, never one a reservation or a coin points at', async () => {
    expect(UPLOAD_KEEP_MS).toBe(6 * HOUR);
    const fx = fixture();
    const now = fx.t.now;
    const old = now - UPLOAD_KEEP_MS - 60_000;
    const recent = now - UPLOAD_KEEP_MS + 60_000;
    const asset = fx.db.raw.prepare("INSERT INTO assets(id, content_type, bytes, width, height, created_at) VALUES (?, 'image/png', x'00', 1, 1, ?)");
    const meta = fx.db.raw.prepare("INSERT INTO metadata(id, json, name, symbol, description, image_id, place_id, used_by_mint, created_at) VALUES (?, '{}', 'N', 'S', '', ?, 'p', ?, ?)");
    asset.run('a-unused', old);
    meta.run('m-unused', 'a-unused', null, old);
    asset.run('a-of-recent', old);
    meta.run('m-recent', 'a-of-recent', null, recent);
    asset.run('a-reserved', old);
    meta.run('m-reserved', 'a-reserved', null, old);
    fx.db.raw
      .prepare(
        `INSERT INTO launch_reservations(id, place_id, place_hash, launcher, mint, metadata_id, category, emoji, bg, dev_buy_lamports, status, created_at, expires_at)
         VALUES ('r1', 'p', 'h', 'l', ?, 'm-reserved', 'cafe', '☕', '#000000', 0, 'expired', ?, ?)`,
      )
      .run(newKey(), old, old);
    const coin = await fx.addCoin();
    asset.run('a-coin', old);
    meta.run('m-coin', 'a-coin', null, old);
    asset.run('a-coin-only', old);
    fx.db.raw.prepare("UPDATE coins SET metadata_id = 'm-coin', image_id = 'a-coin-only' WHERE mint = ?").run(coin.mint);
    asset.run('a-used', old);
    meta.run('m-used', 'a-used', newKey(), old);
    asset.run('a-orphan-old', old);
    asset.run('a-orphan-recent', recent);
    const r = await fx.cron();
    expect(r.jobs.retention).toBe('ok');
    // ('m' / 'a': the fixture's own, uploaded just now)
    expect(fx.db.all<{ id: string }>('SELECT id FROM metadata ORDER BY id').map((x) => x.id)).toEqual(['m', 'm-coin', 'm-recent', 'm-reserved', 'm-used']);
    expect(fx.db.all<{ id: string }>('SELECT id FROM assets ORDER BY id').map((x) => x.id)).toEqual(['a', 'a-coin', 'a-coin-only', 'a-of-recent', 'a-orphan-recent', 'a-reserved', 'a-used']);
  });

  const png = (w: number, h: number) => {
    const d = new Uint8Array(64);
    d.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(d.buffer).setUint32(16, w);
    new DataView(d.buffer).setUint32(20, h);
    return d;
  };
  const upload = (fx: ReturnType<typeof fixture>, ip: string, image = png(512, 512)) => {
    const f = new FormData();
    f.set('name', 'Corner Cafe');
    f.set('symbol', 'CAFE');
    f.set('description', `Upload ${Math.random()}`);
    f.set('placeId', 'cornershop-test:d1-upload');
    f.set('image', new Blob([image], { type: 'image/png' }), 'art.png');
    return fx.request('/api/metadata', { method: 'POST', body: f, headers: { origin: ORIGIN, 'cf-connecting-ip': ip } });
  };

  it(`POST /api/metadata: ${META_GLOBAL_PER_DAY} uploads a day for everyone, counted after the per-IP cap, fail closed`, async () => {
    expect(META_GLOBAL_PER_DAY).toBe(400);
    const fx = fixture();
    const day = Math.floor(fx.t.now / DAY) * DAY;
    const global = () => fx.db.get<{ count: number }>("SELECT count FROM rate_counters WHERE key = 'meta:global'")?.count ?? 0;
    expect((await upload(fx, '203.0.113.50')).status).toBe(200);
    expect(global()).toBe(1);
    // a refused image does not burn the budget
    expect((await upload(fx, '203.0.113.50', png(512, 300))).status).toBe(400);
    expect(global()).toBe(1);
    // an IP over its own cap is refused before it touches the shared budget
    fx.db.raw.prepare('INSERT INTO rate_counters(key, window_start, count) VALUES (?, ?, 60)').run(`meta:ip:${await ipHash(fx.env, '203.0.113.51')}`, day);
    const capped = await upload(fx, '203.0.113.51');
    expect(capped.status).toBe(429);
    expect(((await capped.json()) as { message: string }).message).toBe('Too many uploads today. Try again tomorrow.');
    expect(global()).toBe(1);
    // the shared budget used up: everyone is refused until the next UTC day
    fx.db.raw.prepare("UPDATE rate_counters SET count = ? WHERE key = 'meta:global'").run(META_GLOBAL_PER_DAY);
    const busy = await upload(fx, '203.0.113.52');
    expect(busy.status).toBe(429);
    expect((await busy.json()) as { error: string; message: string }).toMatchObject({ error: 'rate_limited', message: 'Uploads are busy today. Try again tomorrow.' });
    expect(fx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM metadata WHERE description LIKE 'Upload %'")!.n).toBe(1);
    fx.t.now = day + DAY + 60_000;
    expect((await upload(fx, '203.0.113.52')).status).toBe(200);
    expect(global()).toBe(1);
  });
});
