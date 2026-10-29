/**
 * Indexer (INTEGRATION §3.7): `scheduled()` every minute plus on-demand entry points (/api/index/tx, launch confirm,
 * opportunistic /api/market). One run holds `kv_meta.indexer_lock` (50 s), spends ≤ 36 RPC fetches, ≤ 6 Google
 * fetches (Workers Free: 50 subrequests) and stops after 25 s wall time; leftover work carries over (cursors,
 * `vault_at` ordering, the rowid sweeps of `curves` and `vaults`).
 *
 * D1 budget (Workers Free: 100,000 rows written and 5,000,000 read a day for the whole account, devnet included): the
 * mirrors are written only when a value moved, never just to stamp a time, so an idle coin costs no writes; the sweeps
 * remember their place in `kv_meta.indexer_jobs` (written once per run anyway) instead of in every coin row.
 *
 * Accuracy: trades come from decoded pump / pump-amm events of confirmed transactions only (INSERT OR IGNORE, keyed
 * (sig, event index)); the market mirror is updated from the post-trade reserves in those events and from direct
 * account reads; fees from SPEC §8.5 account math. Nothing is estimated.
 */
import { decodeBondingCurve, decodePumpPool, type CurveState } from '../src/chain/curve';
import { canonicalPoolPda, placeAddressesFromHash } from './addresses';
import { CONFIG_PDA, PUMP_GLOBAL, PUMP_PROGRAM } from './consts';
import { accountExists, chainConfig, decodeVaultState, pumpGlobal, rentMins, type PumpGlobalView, type VaultStateView } from './chainState';
import { curveUpdateStmt, dbInt, initialPriceLamports, ownerUpdateStmt, parseVaultSweep, vaultSweepKeys, vaultUpdateStmt, type CoinRow } from './coins';
import { crankKey, sendFeeCrank, sendFinalizeClaim } from './crank';
import { alert, cronPeriodMs, DAY, HOUR, kvGet, kvPutIfChangedStmt, kvPutStmt, sleepFor, type Ctx } from './ctx';
import { programIdOf } from './env';
import { curveUserLamports, decodePumpEvents, decodeVaultLogEvents, evHex, evKey, evU64, evU8, priceOf, type CurveTrade } from './events';
import { lookupLocation } from './google';
import { errMsg } from './log';
import { alertSubject, deliverAlert } from './notify';
import { fetchSolUsd } from './price';
import { notifyOwnerFromChain } from './ownerAlerts';
import { reportRetentionStmts } from './takedown';
import { BudgetExceeded, RpcError, UpstreamError, type Rpc, type RpcTransaction, type SignatureInfo } from './solana';
import { reconcileReservations } from './launch';

/* ======================================================================================== trade ingestion */

interface CoinRef {
  mint: string;
  place_id: string;
  pool: string | null;
  vault: string;
  supply: number | null;
  market_slot: number | null;
}

/**
 * Stores the trade events of confirmed transactions for registered coins and refreshes the market mirror from the
 * post-trade reserves. ONE coin lookup + ONE D1 batch for the whole set (Workers Free: ≤ 50 D1 queries per
 * invocation); `extra` statements (cursor updates) ride in the same batch. Returns the number of trade rows written.
 */
export async function ingestTransactions(
  ctx: Ctx,
  items: { sig: string; tx: RpcTransaction }[],
  g: PumpGlobalView,
  extra: D1PreparedStatement[] = [],
): Promise<number> {
  const decoded = items
    .filter((it) => it.tx.meta && !it.tx.meta.err)
    .map((it) => ({ ...it, events: decodePumpEvents(it.tx) }))
    .filter((it) => it.events.length);
  const mints = [...new Set(decoded.flatMap((d) => d.events.flatMap((e) => (e.kind === 'curve' || e.kind === 'complete' ? [e.mint] : e.kind === 'creator_change' && e.mintGuess ? [e.mintGuess] : []))))];
  const pools = [...new Set(decoded.flatMap((d) => d.events.flatMap((e) => (e.kind === 'amm' ? [e.pool] : []))))];
  if (!mints.length && !pools.length) {
    if (extra.length) await ctx.db.batch(extra);
    return 0;
  }
  const ph = (n: number, from: number) => Array.from({ length: n }, (_, i) => `?${from + i}`).join(',');
  const refs = (
    await ctx.db
      .prepare(
        `SELECT mint, place_id, pool, vault, supply, market_slot FROM coins WHERE cluster = ?1 AND (mint IN (${mints.length ? ph(mints.length, 2) : "''"})
         OR pool IN (${pools.length ? ph(pools.length, 2 + mints.length) : "''"}))`,
      )
      .bind(ctx.cluster, ...mints, ...pools)
      .all<CoinRef>()
  ).results;
  const byMint = new Map(refs.map((r) => [r.mint, r]));
  const byPool = new Map(refs.filter((r) => r.pool).map((r) => [r.pool!, r]));
  const now = ctx.deps.now();
  const stmts: D1PreparedStatement[] = [];
  const insert = ctx.db.prepare(
    `INSERT OR IGNORE INTO trades(sig, ix, mint, side, sol_lamports, tokens, trader, price_lamports, creator_fee_lamports, venue, slot, ts, user_lamports)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  );
  const lastCurve = new Map<string, { ev: CurveTrade; slot: number }>();
  const touched = new Map<string, number>();
  let written = 0;
  for (const { sig, tx, events } of decoded) {
    const slot = tx.slot;
    const blockMs = (tx.blockTime ?? 0) * 1000;
    for (const e of events) {
      if (e.kind === 'curve') {
        const ref = byMint.get(e.mint);
        if (!ref) continue;
        const ts = e.timestamp > 0 ? e.timestamp * 1000 : blockMs || now;
        stmts.push(
          insert.bind(
            sig,
            e.index,
            e.mint,
            e.isBuy ? 'buy' : 'sell',
            dbInt(e.solAmount),
            dbInt(e.tokenAmount),
            e.user,
            priceOf(e.virtualSol, e.virtualToken),
            dbInt(e.creatorFee),
            'curve',
            slot,
            ts,
            dbInt(curveUserLamports(e)),
          ),
        );
        written++;
        const prev = lastCurve.get(e.mint);
        if (!prev || prev.slot <= slot) lastCurve.set(e.mint, { ev: e, slot });
        touched.set(e.mint, Math.max(touched.get(e.mint) ?? 0, ts));
        if (e.creator !== ref.vault) {
          ctx.waitUntil(alert(ctx, 'critical', 'creator_changed', `pump TradeEvent creator ${e.creator} is not the vault for ${e.mint} (admin_cto?)`, e.mint));
        }
      } else if (e.kind === 'amm') {
        const ref = byPool.get(e.pool);
        if (!ref) continue;
        const ts = e.timestamp > 0 ? e.timestamp * 1000 : blockMs || now;
        stmts.push(
          insert.bind(sig, e.index, ref.mint, e.isBuy ? 'buy' : 'sell', dbInt(e.quoteAmount), dbInt(e.baseAmount), e.user, priceOf(e.quoteAmount, e.baseAmount), dbInt(e.coinCreatorFee), 'amm', slot, ts, dbInt(e.quoteAmount)),
        );
        written++;
        touched.set(ref.mint, Math.max(touched.get(ref.mint) ?? 0, ts));
        // pump-amm's admin can move a graduated coin's creator fees (admin_cto_pool since the 2026-10-19 upgrade),
        // as pump's admin_cto does on the curve (SPEC T13); every pool trade event names the pool's coin_creator.
        if (e.coinCreator !== ref.vault) {
          ctx.waitUntil(alert(ctx, 'critical', 'creator_changed', `pump-amm coin_creator ${e.coinCreator} is not the vault for ${ref.mint} (admin_cto_pool?)`, ref.mint));
        }
      } else if (e.kind === 'complete') {
        if (byMint.has(e.mint)) stmts.push(ctx.db.prepare('UPDATE coins SET complete = 1, updated_at = ?2 WHERE mint = ?1 AND complete = 0').bind(e.mint, now));
      } else if (e.kind === 'creator_change' && e.mintGuess && byMint.has(e.mintGuess)) {
        ctx.waitUntil(alert(ctx, 'critical', 'creator_changed', `pump ${e.name} on registered coin ${e.mintGuess} (SPEC T13)`, e.mintGuess));
      }
    }
  }
  for (const [mint, { ev, slot }] of lastCurve) {
    const ref = byMint.get(mint)!;
    const c: CurveState = {
      virtualTokenReserves: ev.virtualToken,
      virtualQuoteReserves: ev.virtualSol,
      realTokenReserves: ev.realToken,
      realQuoteReserves: ev.realSol,
      tokenTotalSupply: ref.supply !== null ? BigInt(ref.supply) : g.tokenTotalSupply,
      complete: ev.realToken === 0n,
      creator: ev.creator,
      isMayhemMode: false,
      isCashbackCoin: false,
      quoteMint: '11111111111111111111111111111111',
      isHolderReward: false,
      creatorFeeBucket: 0n,
    };
    stmts.push(curveUpdateStmt(ctx.db, mint, c, g, slot, now));
  }
  for (const [mint, ts] of touched) {
    // re-walked (already known) trades change nothing, so they write nothing
    stmts.push(ctx.db.prepare('UPDATE coins SET last_trade_at = ?2 WHERE mint = ?1 AND COALESCE(last_trade_at, 0) < ?2').bind(mint, ts));
  }
  // Refresh the 24 h aggregates of the coins these trades touched right away (same maths as the cron job), so
  // /api/coins and /api/market agree with /api/coins/:mint?fresh=1 straight after a launch or trade (INTEGRATION §9).
  if (touched.size) stmts.push(aggregatesStmt(ctx.db, ctx.cluster, now, initialPriceLamports(g), [...touched.keys()]));
  stmts.push(...extra);
  if (stmts.length) await ctx.db.batch(stmts);
  return written;
}

export function ingestTransaction(ctx: Ctx, sig: string, tx: RpcTransaction, g: PumpGlobalView): Promise<number> {
  return ingestTransactions(ctx, [{ sig, tx }], g);
}

/** On-demand: index one signature (the caller's own trade, or an owner's withdrawal). */
export async function indexTx(ctx: Ctx, sig: string, rpc: Rpc = ctx.rpc(3)): Promise<number> {
  const tx = await rpc.getTransaction(sig);
  if (!tx) return 0;
  const g = await globalFor(ctx, rpc);
  const n = await ingestTransaction(ctx, sig, tx, g);
  await ingestWithdrawals(ctx, sig, tx);
  return n;
}

/** `Withdrawn` event fields (SPEC §7: place_hash, owner, amount u64, total_withdrawn u64) for chain_events.data_json. */
export function withdrawnData(f: Uint8Array[]): Record<string, unknown> {
  return { owner: evKey(f[1]), amount: evU64(f[2])?.toString() ?? null, total: evU64(f[3])?.toString() ?? null };
}

/**
 * Records the shop-vault `Withdrawn` events of one confirmed transaction in chain_events right away (the Live feed shows
 * payouts from there), instead of waiting for the program monitor's next run. Same (sig, ix) key as the monitor, so the
 * monitor's later INSERT OR IGNORE is a no-op; only Withdrawn is recorded here (no alerts are raised from this path).
 */
async function ingestWithdrawals(ctx: Ctx, sig: string, tx: RpcTransaction): Promise<void> {
  if (!tx.meta || tx.meta.err) return;
  const programId = programIdOf(ctx.env);
  const stmts = decodeVaultLogEvents(tx.meta.logMessages, programId)
    .filter((ev) => ev.name === 'Withdrawn')
    .map((ev) =>
      ctx.db
        .prepare('INSERT OR IGNORE INTO chain_events(sig, ix, kind, place_hash, data_json, slot, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
        .bind(sig, ev.index, ev.name, evHex(ev.fields[0]), JSON.stringify({ name: ev.name, ...withdrawnData(ev.fields) }), tx.slot, (tx.blockTime ?? 0) * 1000 || ctx.deps.now()),
    );
  if (stmts.length) await ctx.db.batch(stmts);
}

async function globalFor(ctx: Ctx, rpc: Rpc): Promise<PumpGlobalView> {
  const kv = await kvGet<Record<string, string>>(ctx.db, 'pump_global');
  if (kv?.value?.initialVirtualTokenReserves) {
    return {
      initialVirtualTokenReserves: BigInt(kv.value.initialVirtualTokenReserves),
      initialVirtualQuoteReserves: BigInt(kv.value.initialVirtualQuoteReserves!),
      initialRealTokenReserves: BigInt(kv.value.initialRealTokenReserves!),
      tokenTotalSupply: BigInt(kv.value.tokenTotalSupply!),
    };
  }
  return pumpGlobal(rpc, PUMP_GLOBAL, ctx.deps.now());
}

/* ============================================================================================ cursors */

interface Cursor {
  account: string;
  last_sig: string | null;
  last_slot: number | null;
  pending_before: string | null;
  pending_top: string | null;
  pending_top_slot: number | null;
}

const PAGE = 25;
/** A quiet hot coin's account is walked again once its cursor is this old (trades job). */
const CURSOR_STALE_MS = 10 * 60_000;

/**
 * Walks an account's signatures newest → oldest down to the cursor (`last_sig`), in pages of 25, across runs when
 * needed (`pending_*`). Trades are idempotent, so a re-walk is harmless; the cursor only advances over a contiguous
 * prefix of the page that was fully processed (failed txs carry no events). 2 D1 calls per account (cursor prefetch
 * is the caller's). Returns the number of transactions fetched.
 */
export async function backfillAccount(ctx: Ctx, rpc: Rpc, account: string, maxTx: number, g: PumpGlobalView, cursor?: Cursor | null): Promise<number> {
  return walkAccount(ctx, rpc, account, maxTx, (items, extra) => ingestTransactions(ctx, items, g, extra).then(() => undefined), cursor);
}

/** `page`: the signatures this walk read this run, failed ones included (they are never fetched). */
export type TxHandler = (items: { sig: string; tx: RpcTransaction }[], extra: D1PreparedStatement[], page: SignatureInfo[]) => Promise<void>;

/**
 * Generic cursor walk (trades backfill, program monitor). `startAtHead`: an account without a cursor starts at its
 * newest signature instead of walking its whole history (the monitor only cares about new events).
 */
export async function walkAccount(
  ctx: Ctx,
  rpc: Rpc,
  account: string,
  maxTx: number,
  handle: TxHandler,
  cursor?: Cursor | null,
  opts: { startAtHead?: boolean } = {},
): Promise<number> {
  if (maxTx <= 0 || rpc.remaining < 2) return 0;
  const now = ctx.deps.now();
  const existing = cursor === undefined ? await ctx.db.prepare('SELECT * FROM indexer_cursors WHERE account = ?1').bind(account).first<Cursor>() : cursor;
  if (!existing && opts.startAtHead) {
    const head = await rpc.getSignaturesForAddress(account, { limit: 1 });
    await ctx.db
      .prepare('INSERT INTO indexer_cursors(account, last_sig, last_slot, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(account) DO NOTHING')
      .bind(account, head[0]?.signature ?? null, head[0]?.slot ?? null, now)
      .run();
    return 0;
  }
  const cur = existing ?? ({ account, last_sig: null, last_slot: null, pending_before: null, pending_top: null, pending_top_slot: null } as Cursor);
  const page = await rpc.getSignaturesForAddress(account, {
    limit: PAGE,
    ...(cur.last_sig ? { until: cur.last_sig } : {}),
    ...(cur.pending_before ? { before: cur.pending_before } : {}),
  });
  let top = cur.pending_top;
  let topSlot = cur.pending_top_slot;
  if (!cur.pending_before) {
    if (!page.length) {
      // nothing new: the cursor's "checked at" only matters once it is CURSOR_STALE_MS old (the trades job then walks
      // the account again), so it is not rewritten on every run (the program monitor walks its account every run)
      await ctx.db
        .prepare('INSERT INTO indexer_cursors(account, updated_at) VALUES (?1, ?2) ON CONFLICT(account) DO UPDATE SET updated_at = ?2 WHERE indexer_cursors.updated_at < ?3')
        .bind(account, now, now - CURSOR_STALE_MS)
        .run();
      return 0;
    }
    top = page[0]!.signature;
    topSlot = page[0]!.slot;
  }
  const todo: { i: number; sig: string }[] = [];
  for (let i = 0; i < page.length && todo.length < maxTx; i++) if (!page[i]!.err) todo.push({ i, sig: page[i]!.signature });
  const items: { sig: string; tx: RpcTransaction }[] = [];
  const done = new Set<number>();
  let fetched = 0;
  if (todo.length) {
    const txs = await fetchTransactions(rpc, todo.map((t) => t.sig));
    for (let k = 0; k < todo.length; k++) {
      const tx = txs[k];
      if (tx === undefined) break; // budget ran out
      fetched++;
      if (!tx) break; // not visible yet at 'confirmed': retry next run
      items.push({ sig: todo[k]!.sig, tx });
      done.add(todo[k]!.i);
    }
  }
  let processedUpTo = -1;
  for (let i = 0; i < page.length; i++) {
    if (page[i]!.err || done.has(i)) processedUpTo = i;
    else break;
  }
  const extra: D1PreparedStatement[] = [];
  if (processedUpTo === page.length - 1 && page.length < PAGE) {
    extra.push(
      ctx.db
        .prepare(
          `INSERT INTO indexer_cursors(account, last_sig, last_slot, updated_at, pending_before, pending_top, pending_top_slot)
           VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL)
           ON CONFLICT(account) DO UPDATE SET last_sig = ?2, last_slot = ?3, updated_at = ?4, pending_before = NULL, pending_top = NULL, pending_top_slot = NULL`,
        )
        .bind(account, top, topSlot, now),
    );
  } else if (processedUpTo >= 0) {
    extra.push(
      ctx.db
        .prepare(
          `INSERT INTO indexer_cursors(account, last_sig, last_slot, updated_at, pending_before, pending_top, pending_top_slot)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
           ON CONFLICT(account) DO UPDATE SET updated_at = ?4, pending_before = ?5, pending_top = ?6, pending_top_slot = ?7`,
        )
        .bind(account, cur.last_sig, cur.last_slot, now, page[processedUpTo]!.signature, top, topSlot),
    );
  }
  await handle(items, extra, page);
  return fetched;
}

/** getTransaction for several signatures: JSON-RPC batches of 10, sequential fallback; `undefined` = not fetched. */
async function fetchTransactions(rpc: Rpc, sigs: string[]): Promise<(RpcTransaction | null | undefined)[]> {
  const out: (RpcTransaction | null | undefined)[] = sigs.map(() => undefined);
  for (let i = 0; i < sigs.length; i += 10) {
    if (rpc.remaining < 1) break;
    const chunk = sigs.slice(i, i + 10);
    try {
      const res = await rpc.getTransactions(chunk);
      res.forEach((r, j) => (out[i + j] = r));
    } catch (e) {
      if (e instanceof BudgetExceeded) break;
      // batch unsupported or failed: sequential within the remaining budget
      for (let j = 0; j < chunk.length && rpc.remaining > 0; j++) {
        try {
          out[i + j] = await rpc.getTransaction(chunk[j]!);
        } catch {
          out[i + j] = null;
        }
      }
    }
  }
  return out;
}

/** Opportunistic / on-demand: catch up one coin's trades (curve or pool account). */
export async function indexMint(ctx: Ctx, mint: string, budget = 10): Promise<number> {
  const row = await ctx.db
    .prepare('SELECT bonding_curve, graduated, pool FROM coins WHERE mint = ?1 AND cluster = ?2')
    .bind(mint, ctx.cluster)
    .first<{ bonding_curve: string; graduated: number; pool: string | null }>();
  if (!row) return 0;
  const rpc = ctx.rpc(budget);
  const g = await globalFor(ctx, rpc);
  const account = row.graduated && row.pool ? row.pool : row.bonding_curve;
  return backfillAccount(ctx, rpc, account, Math.max(1, budget - 3), g);
}

/* ============================================================================================ cron */

export interface CronReport {
  ok: boolean;
  skipped?: 'locked';
  jobs: Record<string, string>;
  fetches: number;
  ms: number;
}

const LOCK_MS = 50_000;
const WALL_MS = 25_000;
const CURVES_PER_RUN = 300;
/** Unused uploads (metadata + art no reservation or coin points at) are deleted after this (anyone can upload). */
export const UPLOAD_KEEP_MS = 6 * HOUR;

export async function runIndexer(ctx: Ctx, opts: { budget?: number; googleBudget?: number; reason?: string } = {}): Promise<CronReport> {
  const t0 = ctx.deps.now();
  const holder = `${t0}-${Math.random().toString(36).slice(2, 10)}`;
  // a released lock (updated_at 0, see the end of the run) or one older than LOCK_MS is taken over
  const got = await ctx.db
    .prepare(
      `INSERT INTO kv_meta(key, value, updated_at) VALUES ('indexer_lock', ?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2 WHERE kv_meta.updated_at < ?3
       RETURNING value`,
    )
    .bind(JSON.stringify(holder), t0, t0 - LOCK_MS)
    .first<{ value: string }>();
  if (!got || got.value !== JSON.stringify(holder)) return { ok: true, skipped: 'locked', jobs: {}, fetches: 0, ms: 0 };
  // Workers Free allows 50 subrequests per invocation: ≤ 36 RPC + ≤ 6 Google + 2 price APIs + 1 alert webhook
  const rpc = ctx.rpc(opts.budget ?? 36);
  const jobs: Record<string, string> = {};
  let googleLeft = opts.googleBudget ?? 6;
  const timeLeft = () => WALL_MS - (ctx.deps.now() - t0);
  const run = async (name: string, f: () => Promise<string | void>, minFetches = 1) => {
    if (timeLeft() <= 0) return void (jobs[name] = 'skipped: time');
    if (rpc.remaining < minFetches) return void (jobs[name] = 'skipped: budget');
    try {
      jobs[name] = (await f()) ?? 'ok';
    } catch (e) {
      jobs[name] = e instanceof BudgetExceeded ? 'partial: budget' : `error: ${errMsg(e)}`;
      if (!(e instanceof BudgetExceeded)) ctx.log.warn('indexer.job_failed', { job: name, error: errMsg(e) });
    }
  };
  const now = t0;
  const last = await kvGet<Record<string, number>>(ctx.db, 'indexer_jobs');
  const lastRun: Record<string, number> = last?.value ?? {};
  const due = (job: string, everyMs: number) => (lastRun[job] ?? 0) <= now - everyMs + 5_000;
  const mark = (job: string) => (lastRun[job] = now);

  let g: PumpGlobalView | null = null;
  const programId = programIdOf(ctx.env);

  await run('price', async () => {
    const p = await fetchSolUsd(ctx.env, ctx.deps);
    if (!p) return 'no source answered';
    await kvPutStmt(ctx.db, 'sol_usd', { usd: p.usd, at: p.at, src: p.src }, now).run();
    if (p.spread !== null && p.spread > 0.02) await alert(ctx, 'warn', 'price_spread', `Jupiter and Pyth differ by ${(p.spread * 100).toFixed(2)}%`);
    return `${p.src} ${p.usd}`;
  }, 0);

  await run('config', async () => {
    const c = await chainConfig(rpc, CONFIG_PDA, now, true);
    if (!c) return 'config account missing';
    await kvPutStmt(ctx.db, 'chain_config', c, now).run();
    if (c.flavor !== ctx.cluster) await alert(ctx, 'critical', 'config_flavor', `on-chain Config flavor ${c.flavor} on ${ctx.cluster}`);
    return c.paused ? 'paused' : 'ok';
  });

  await run('global', async () => {
    const kv = await kvGet<Record<string, string>>(ctx.db, 'pump_global');
    if (kv && now - kv.updatedAt < 10 * 60_000) {
      g = await globalFor(ctx, rpc);
      return 'cached';
    }
    g = await pumpGlobal(rpc, PUMP_GLOBAL, now);
    await kvPutStmt(ctx.db, 'pump_global', g, now).run();
    return 'refreshed';
  });
  const G = (): PumpGlobalView => g ?? { initialVirtualTokenReserves: 1_073_000_000_000_000n, initialVirtualQuoteReserves: ctx.cluster === 'devnet' ? 1_000_000_000n : 30_000_000_000n, initialRealTokenReserves: 793_100_000_000_000n, tokenTotalSupply: 1_000_000_000_000_000n };

  await run('priority_fee', async () => {
    const def = Number(ctx.env.PRIORITY_FEE_DEFAULT ?? '10000') || 10_000;
    // read by value only (never by age): written only when it changes
    if (ctx.cluster === 'devnet') {
      await kvPutIfChangedStmt(ctx.db, 'priority_fee', def, now).run();
      return String(def);
    }
    const fees = await rpc.call<{ slot: number; prioritizationFee: number }[]>('getRecentPrioritizationFees', [[PUMP_PROGRAM]]);
    const nz = fees.map((f) => f.prioritizationFee).filter((x) => x > 0).sort((a, b) => a - b);
    const p75 = nz.length ? nz[Math.min(nz.length - 1, Math.floor(nz.length * 0.75))]! : def;
    const v = Math.min(2_000_000, Math.max(1_000, p75));
    await kvPutIfChangedStmt(ctx.db, 'priority_fee', v, now).run();
    return String(v);
  });

  await run('reservations', async () => reconcileReservations(ctx, rpc));
  await run('claims', async () => claimsJob(ctx, rpc, programId));

  // hot curves → dirty set. ≤ CURVES_PER_RUN coins a run in rowid order, continuing where the last run of the same kind
  // stopped (`curves_from` / `curves_full_from`): an unchanged curve is not written (curveUpdateStmt), so its
  // market_at cannot order the sweep
  const dirty = new Set<string>();
  await run('curves', async () => {
    const full = due('curves_full', 10 * 60_000);
    const at = full ? 'curves_full_from' : 'curves_from';
    const rows = (
      await ctx.db
        .prepare(
          `SELECT rowid AS rid, mint, bonding_curve, real_sol, complete, market_slot FROM coins WHERE cluster = ?1 AND graduated = 0 AND rowid > ?2
           ${full ? '' : 'AND (COALESCE(last_trade_at, 0) > ?3 OR created_at > ?4)'} ORDER BY rowid ASC LIMIT ${CURVES_PER_RUN}`,
        )
        .bind(ctx.cluster, lastRun[at] ?? 0, ...(full ? [] : [now - 6 * HOUR, now - DAY]))
        .all<{ rid: number; mint: string; bonding_curve: string; real_sol: number | null; complete: number; market_slot: number | null }>()
    ).results;
    const next = rows.length < CURVES_PER_RUN ? 0 : rows[rows.length - 1]!.rid;
    if (!rows.length) {
      lastRun[at] = next;
      if (full) mark('curves_full');
      return '0 coins';
    }
    const { slot, accounts } = await rpc.getMultipleAccounts(rows.map((r) => r.bonding_curve));
    const stmts: D1PreparedStatement[] = [];
    rows.forEach((r, i) => {
      const a = accounts[i];
      if (!a || !accountExists(a)) return;
      let c: CurveState;
      try {
        c = decodeBondingCurve(a.data);
      } catch {
        return;
      }
      const changed = r.real_sol === null || BigInt(Math.round(r.real_sol)) !== c.realQuoteReserves || !!r.complete !== c.complete;
      if (changed) dirty.add(r.mint);
      stmts.push(curveUpdateStmt(ctx.db, r.mint, c, G(), slot, now));
    });
    for (let i = 0; i < stmts.length; i += 50) await ctx.db.batch(stmts.slice(i, i + 50));
    lastRun[at] = next;
    if (full) mark('curves_full');
    return `${rows.length} read, ${dirty.size} moved`;
  });

  await run('trades', async () => {
    // dirty coins first, then hot coins whose cursor is ≥ 10 min old (CURSOR_STALE_MS)
    const stale = (
      await ctx.db
        .prepare(
          `SELECT c.mint, CASE WHEN c.graduated = 1 AND c.pool IS NOT NULL THEN c.pool ELSE c.bonding_curve END AS account
           FROM coins c LEFT JOIN indexer_cursors k ON k.account = CASE WHEN c.graduated = 1 AND c.pool IS NOT NULL THEN c.pool ELSE c.bonding_curve END
           WHERE c.cluster = ?1 AND (k.pending_before IS NOT NULL OR COALESCE(k.updated_at, 0) < ?2) AND (COALESCE(c.last_trade_at, 0) > ?3 OR c.created_at > ?4)
           ORDER BY COALESCE(k.updated_at, 0) ASC LIMIT 20`,
        )
        .bind(ctx.cluster, now - CURSOR_STALE_MS, now - DAY, now - DAY)
        .all<{ mint: string; account: string }>()
    ).results;
    const dirtyRows = dirty.size
      ? (
          await ctx.db
            .prepare(`SELECT mint, CASE WHEN graduated = 1 AND pool IS NOT NULL THEN pool ELSE bonding_curve END AS account FROM coins WHERE mint IN (${[...dirty].map((_, i) => `?${i + 1}`).join(',')})`)
            .bind(...dirty)
            .all<{ mint: string; account: string }>()
        ).results
      : [];
    const accounts = [...new Set([...dirtyRows, ...stale].map((r) => r.account))].slice(0, 8);
    const cursors = accounts.length
      ? (
          await ctx.db
            .prepare(`SELECT * FROM indexer_cursors WHERE account IN (${accounts.map((_, i) => `?${i + 1}`).join(',')})`)
            .bind(...accounts)
            .all<Cursor>()
        ).results
      : [];
    const byAccount = new Map(cursors.map((c) => [c.account, c]));
    const seen = new Set<string>();
    let txLeft = 30;
    let n = 0;
    for (const account of accounts) {
      if (txLeft <= 0 || rpc.remaining < 3 || timeLeft() < 3_000) break;
      seen.add(account);
      const f = await backfillAccount(ctx, rpc, account, Math.min(txLeft, 10), G(), byAccount.get(account) ?? null);
      txLeft -= f;
      n += f;
    }
    return `${seen.size} accounts, ${n} txs`;
  }, 3);

  await run('vaults', async () => vaultJob(ctx, rpc, now, lastRun, due('vaults_sweep', VAULT_SWEEP_MS)), 2);
  await run('graduation', async () => graduationJob(ctx, rpc, now), 1);
  await run('aggregates', async () => {
    if (!due('aggregates', 60_000)) return 'not due';
    await aggregatesStmt(ctx.db, ctx.cluster, now, initialPriceLamports(G())).run();
    mark('aggregates');
    return 'ok';
  }, 0);
  await run('monitor', async () => monitorJob(ctx, rpc, programId, now), 2);
  await run('coords', async () => {
    if (!due('coords', 10 * 60_000)) return 'not due';
    mark('coords');
    const rows = (
      await ctx.db
        .prepare("SELECT place_id FROM coins WHERE cluster = ?1 AND place_id NOT LIKE 'cornershop-test:%' AND (coords_expire_at IS NULL OR coords_expire_at < ?2) LIMIT 20")
        .bind(ctx.cluster, now + 3 * DAY)
        .all<{ place_id: string }>()
    ).results;
    let n = 0;
    for (const r of rows) {
      if (googleLeft-- <= 0 || timeLeft() < 2_000) break;
      try {
        const l = await lookupLocation(ctx.env, ctx.deps, r.place_id);
        if (l) {
          await ctx.db.prepare('UPDATE coins SET lat = ?2, lng = ?3, coords_expire_at = ?4 WHERE place_id = ?1').bind(r.place_id, l.lat, l.lng, now + 30 * DAY).run();
          n++;
        } else {
          await ctx.db.prepare('UPDATE coins SET lat = NULL, lng = NULL, coords_expire_at = NULL WHERE place_id = ?1').bind(r.place_id).run();
        }
      } catch {
        break;
      }
    }
    return `${n} refreshed`;
  }, 0);
  await run('holders', async () => holdersJob(ctx, rpc, now, due('holders', HOUR) ? () => mark('holders') : null), 1);
  // backfills of rows stored before their columns existed (new rows never miss them): once nothing is missing, they
  // look again only hourly
  await run('trade_amounts', async () => (due('trade_amounts', HOUR) ? tradeAmountsJob(ctx, rpc, () => mark('trade_amounts')) : 'not due'), 1);
  await run('withdraw_amounts', async () => (due('withdraw_amounts', HOUR) ? withdrawAmountsJob(ctx, rpc, programId, () => mark('withdraw_amounts')) : 'not due'), 1);
  await run('fee_crank', async () => feeCrankJob(ctx, rpc, now), 3);
  if (ctx.cluster === 'devnet') {
    if (__CS_DEV_ENDPOINTS__) {
      await run('faucet', async () => {
        if (!due('faucet', 5 * 60_000)) return 'not due';
        mark('faucet');
        const m = await import('./dev/airdrop');
        const bal = await m.faucetBalance(ctx, rpc);
        if (bal === null) return 'no faucet key';
        await kvPutIfChangedStmt(ctx.db, 'faucet_balance', Number(bal), now).run();
        return `${Number(bal) / 1e9} SOL`;
      });
    }
  }
  await run('retention', async () => {
    if (!due('retention', HOUR)) return 'not due';
    mark('retention');
    await ctx.db.batch([
      ctx.db.prepare("DELETE FROM claims WHERE status IN ('expired','failed') AND updated_at < ?1").bind(now - 90 * DAY),
      ctx.db.prepare('DELETE FROM phone_verifications WHERE ts < ?1').bind(now - 30 * DAY),
      ctx.db.prepare('DELETE FROM rate_counters WHERE window_start < ?1').bind(now - 2 * DAY),
      // expired reservations can no longer land (blockhash + lock long gone); failed ones are kept for audits
      ctx.db.prepare("DELETE FROM launch_reservations WHERE status = 'expired' AND created_at < ?1").bind(now - 30 * DAY),
      // uploads that never got as far as a reservation (never on-chain): metadata, then unreferenced art, after
      // UPLOAD_KEEP_MS. Anything a reservation (any status) or a coin points at is never deleted here.
      ctx.db
        .prepare('DELETE FROM metadata WHERE used_by_mint IS NULL AND created_at < ?1 AND id NOT IN (SELECT metadata_id FROM launch_reservations) AND id NOT IN (SELECT metadata_id FROM coins)')
        .bind(now - UPLOAD_KEEP_MS),
      ctx.db
        .prepare('DELETE FROM assets WHERE created_at < ?1 AND id NOT IN (SELECT image_id FROM metadata) AND id NOT IN (SELECT image_id FROM coins WHERE image_id IS NOT NULL)')
        .bind(now - UPLOAD_KEEP_MS),
      // reports and opt-outs: names, emails, free text and IP hashes go after 180 days (worker/takedown.ts)
      ...reportRetentionStmts(ctx.db, now),
    ]);
    return 'ok';
  }, 0);

  const ms = ctx.deps.now() - t0;
  await ctx.db.batch([
    kvPutStmt(ctx.db, 'indexer_jobs', lastRun, now),
    kvPutStmt(ctx.db, 'indexer_last_run', ctx.deps.now(), ctx.deps.now()),
    // released by expiring it, not deleting it: the next run then rewrites one row instead of inserting the row and its
    // key index entry again (D1 bills both)
    ctx.db.prepare("UPDATE kv_meta SET updated_at = 0 WHERE key = 'indexer_lock' AND value = ?1").bind(JSON.stringify(holder)),
  ]);
  ctx.log.info('indexer.run', { reason: opts.reason ?? 'cron', fetches: rpc.fetches, ms, ...Object.fromEntries(Object.entries(jobs).map(([k, v]) => [`job_${k}`, v])) });
  return { ok: true, jobs, fetches: rpc.fetches, ms };
}

/* ------------------------------------------------------------------------------------------------ jobs */

export function aggregatesStmt(db: D1Database, cluster: string, now: number, initPrice: number, mints?: string[]): D1PreparedStatement {
  // vol = Σ sol over 24 h; change = price now vs last price ≤ 24 h ago (initial price when none), 1 dp, SOL terms.
  // `mints` limits the update to those coins (trade ingestion); without it every recently active coin is refreshed.
  // Only coins whose figures moved are written (the cron recomputes every active coin on every run). Each figure is
  // computed once in a materialized CTE: a correlated subquery repeated in SET and WHERE would scan the trades twice.
  const only = mints?.length ? ` AND c.mint IN (${mints.map((_, i) => `?${5 + i}`).join(',')})` : '';
  const change = `CASE WHEN COALESCE(coins.price_lamports, 0) > 0 THEN ROUND((coins.price_lamports - COALESCE(a.ref, ?3)) * 100.0 / COALESCE(a.ref, ?3), 1) ELSE NULL END`;
  return db
    .prepare(
      `WITH a AS MATERIALIZED (
         SELECT c.mint AS mint,
           (SELECT COALESCE(SUM(t.sol_lamports), 0) FROM trades t WHERE t.mint = c.mint AND t.ts > ?2) AS vol,
           (SELECT t.price_lamports FROM trades t WHERE t.mint = c.mint AND t.ts <= ?2 ORDER BY t.ts DESC LIMIT 1) AS ref
         FROM coins c WHERE c.cluster = ?1 AND (COALESCE(c.last_trade_at, 0) > ?4 OR c.created_at > ?4)${only})
       UPDATE coins SET vol24h_lamports = a.vol, change24h_pct = ${change}
       FROM a WHERE coins.mint = a.mint AND (coins.vol24h_lamports IS NOT a.vol OR coins.change24h_pct IS NOT ${change})`,
    )
    .bind(cluster, now - DAY, initPrice > 0 ? initPrice : 1, now - DAY - 2 * HOUR, ...(mints ?? []));
}

const VAULTS_PER_RUN = 32;
const VAULT_SWEEP_RESERVE = 8;
const VAULT_SWEEP_MS = 10 * 60_000;

/**
 * Vault mirror (fees, owner). Coins never read and coins traded since their last read (each at most once a minute) come
 * first; then the sweep of every coin, a new pass at most every VAULT_SWEEP_MS, walks the registry in rowid order
 * across runs (`vaults_from`). vaultUpdateStmt writes a coin only when something moved (or it traded since), so an
 * idle coin costs no D1 write and its vault_at cannot order the sweep.
 */
async function vaultJob(ctx: Ctx, rpc: Rpc, now: number, lastRun: Record<string, number>, sweepDue: boolean): Promise<string> {
  type Row = Pick<CoinRow, 'place_id' | 'mint' | 'vault' | 'vault_state' | 'bonding_curve' | 'graduated' | 'pool' | 'owner' | 'pending_owner'>;
  const cols = 'place_id, mint, vault, vault_state, bonding_curve, graduated, pool, owner, pending_owner';
  const from = lastRun.vaults_from ?? 0;
  // while a sweep is in progress or due, keep slots for it so a run full of busy coins cannot starve the idle ones
  const sweeping = from > 0 || sweepDue;
  const urgentMax = sweeping ? VAULTS_PER_RUN - VAULT_SWEEP_RESERVE : VAULTS_PER_RUN;
  const rows = (
    await ctx.db
      .prepare(
        `SELECT ${cols} FROM coins WHERE cluster = ?1 AND (vault_at IS NULL OR (last_trade_at > vault_at AND vault_at < ?2))
         ORDER BY COALESCE(vault_at, 0) ASC LIMIT ${urgentMax}`,
      )
      .bind(ctx.cluster, now - 60_000)
      .all<Row>()
  ).results;
  let next: number | null = null;
  if (rows.length < VAULTS_PER_RUN && sweeping) {
    const room = VAULTS_PER_RUN - rows.length;
    const page = (
      await ctx.db
        .prepare(`SELECT rowid AS rid, ${cols} FROM coins WHERE cluster = ?1 AND rowid > ?2 ORDER BY rowid ASC LIMIT ?3`)
        .bind(ctx.cluster, from, room)
        .all<Row & { rid: number }>()
    ).results;
    const have = new Set(rows.map((r) => r.mint));
    for (const r of page) if (!have.has(r.mint)) rows.push(r);
    next = page.length < room ? 0 : page[page.length - 1]!.rid;
  }
  // the sweep's place moves on only once its coins were read and written
  const advance = () => {
    if (next === null) return;
    if (from === 0) lastRun.vaults_sweep = now; // a new pass started
    lastRun.vaults_from = next;
  };
  if (!rows.length) {
    advance();
    return '0 coins';
  }
  const rent = await rentMins(rpc);
  const keySets = await Promise.all(rows.map((r) => vaultSweepKeys(r)));
  const flat = keySets.flat();
  const { accounts } = await rpc.getMultipleAccounts(flat);
  const stmts: D1PreparedStatement[] = [];
  const pending: PendingClaim[] = [];
  let o = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const n = keySets[i]!.length;
    const sweep = parseVaultSweep(accounts.slice(o, o + n), !!r.graduated, rent, r.vault);
    o += n;
    if (!sweep.state) continue;
    stmts.push(vaultUpdateStmt(ctx.db, r.mint, sweep, now));
    if (sweep.state.pendingOwner) pending.push({ r, st: sweep.state });
    if (sweep.curve && sweep.curve.creator !== r.vault && sweep.curve.creator !== '11111111111111111111111111111111') {
      ctx.waitUntil(alert(ctx, 'critical', 'creator_changed', `curve.creator ${sweep.curve.creator} != vault ${r.vault} for ${r.mint} (pump admin_cto, SPEC §8.5)`, r.mint));
    }
  }
  const written = stmts.length ? (await ctx.db.batch(stmts)).filter((res) => (res.meta?.changes ?? 0) > 0).length : 0;
  advance();
  // after the mirror is written: an alert-only check must never cost the run its vault writes or the sweep its place
  try {
    await unrecordedClaims(ctx, pending, now);
  } catch (e) {
    ctx.log.error('indexer.unrecorded_claims', { coins: pending.length, error: errMsg(e) });
  }
  return `${stmts.length} vaults, ${written} changed`;
}

/** A co-signed claim's browser polls /api/claim/confirm until its transaction lands: this long is left for it. */
export const CONFIRM_GRACE_MS = 10 * 60_000;
/** claim_pending_onchain is sent once per claim (ref = vault state + nonce + pending owner): longer than any window. */
const UNRECORDED_DEDUPE_MS = 30 * DAY;
/** Claims listed in one claim_pending_onchain message (each ~300 characters; the webhook keeps 1900). */
const UNRECORDED_LINES = 4;

interface PendingClaim {
  r: Pick<CoinRow, 'place_id' | 'mint' | 'vault_state'>;
  st: VaultStateView;
}

/**
 * Alerts about a claim pending on chain that the claims table does not have as pending (claim_pending_onchain): its
 * request_claim was sent through another RPC and /api/claim/confirm never called, so the program monitor is the only
 * other witness, and a flood of transactions can bury that. Judged on the claims rows, never on the coins mirror, which
 * public reads write too (`?fresh=1`). A co-sign younger than CONFIRM_GRACE_MS is left to its browser (a later sweep
 * reads the coin again); a request the attestor never co-signed is critical.
 *
 * D1: at most three batches for the whole run, whatever the number of pending coins or claims found (Workers Free: ≤ 50
 * D1 queries per invocation, a batch counting as one). The first holds the three indexed checks per coin, so a coin that
 * trades all through its window costs little; the second (claims has no index for it) runs only for the coins left,
 * once per claim (its stored alert then answers the first batch); the third stores the alerts, and the claims it stored
 * go out as one message.
 */
async function unrecordedClaims(ctx: Ctx, pending: PendingClaim[], now: number): Promise<void> {
  if (!pending.length) return;
  const claim = 'place_id = ?1 AND new_owner = ?2 AND nonce = ?3';
  const claimArgs = (p: PendingClaim) => [p.r.place_id, p.st.pendingOwner, Number(p.st.claimNonce)] as const;
  const refOf = (p: PendingClaim) => `${p.r.vault_state}:${Number(p.st.claimNonce)}:${p.st.pendingOwner}`;
  const checks = await ctx.db.batch<{ recorded: number; sent: number; young: number }>(
    pending.map((p) =>
      ctx.db
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM claims WHERE status = 'pending_onchain' AND unlock_ts IS ?4 AND ${claim}) AS recorded,
             EXISTS (SELECT 1 FROM alerts WHERE kind = 'claim_pending_onchain' AND ref = ?5 AND created_at > ?6) AS sent,
             EXISTS (SELECT 1 FROM claims WHERE status = 'cosigned' AND updated_at > ?7 AND ${claim}) AS young`,
        )
        .bind(...claimArgs(p), p.st.unlockTs, refOf(p), now - UNRECORDED_DEDUPE_MS, now - CONFIRM_GRACE_MS),
    ),
  );
  const left = pending.filter((_, i) => {
    const c = checks[i]?.results[0];
    return !!c && !c.recorded && !c.sent && !c.young;
  });
  if (!left.length) return;
  const cosigns = await ctx.db.batch<{ x: number }>(left.map((p) => ctx.db.prepare(`SELECT 1 AS x FROM claims WHERE ${claim} LIMIT 1`).bind(...claimArgs(p))));
  const check = `node scripts/claims-admin.mjs --env ${ctx.cluster} list`;
  const found = left
    .map((p, i) => {
      const { r, st } = p;
      const cosigned = !!cosigns[i]?.results.length;
      const unlock = st.unlockTs ? new Date(st.unlockTs * 1000).toISOString() : '?';
      const what = cosigned ? 'that the site co-signed but nobody confirmed (no /api/claim/confirm)' : 'that the site never co-signed (possible attestor misuse)';
      const severity: 'warn' | 'critical' = cosigned ? 'warn' : 'critical';
      const claim = `place ${r.place_id} (mint ${r.mint}) ${what}: pending owner ${st.pendingOwner}, nonce ${Number(st.claimNonce)}, unlocks ${unlock}`;
      return { severity, claim, message: `Claim pending on chain for ${claim}. Check it before then: ${check}`, ref: refOf(p) };
    })
    // never co-signed first: a long message is cut by the webhook, so the most urgent claims lead
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
  // the de-dup rows in one batch (not alert(), whose two queries per claim would grow with the claims), one message
  const stored = await ctx.db.batch<{ id: number }>(
    found.map((a) =>
      ctx.db
        .prepare(
          `INSERT INTO alerts(severity, kind, message, ref, created_at) SELECT ?1, 'claim_pending_onchain', ?2, ?3, ?4
           WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE kind = 'claim_pending_onchain' AND ref = ?3 AND created_at > ?5) RETURNING id`,
        )
        .bind(a.severity, a.message.slice(0, 1000), a.ref, now, now - UNRECORDED_DEDUPE_MS),
    ),
  );
  const fresh = found.filter((_, i) => !!stored[i]?.results.length);
  if (!fresh.length) return;
  const critical = fresh.filter((a) => a.severity === 'critical').length;
  const severity = critical ? 'critical' : 'warn';
  for (const a of fresh) ctx.log[a.severity === 'critical' ? 'error' : 'warn']('alert', { severity: a.severity, kind: 'claim_pending_onchain', message: a.message.slice(0, 300), ref: a.ref });
  const head = `[AtlasPad ${ctx.cluster}] ${severity.toUpperCase()} claim_pending_onchain: `;
  let text: string;
  let summary: string;
  if (fresh.length === 1) {
    text = head + fresh[0]!.message;
    summary = fresh[0]!.message;
  } else {
    // within the webhook's 1900 characters: a count, at most UNRECORDED_LINES claims, then where to read the rest
    summary = `${fresh.length} claims pending on chain that no confirm recorded (${critical} never co-signed)`;
    const lines = fresh.slice(0, UNRECORDED_LINES).map((a) => `• ${a.claim}`);
    const more = fresh.length > UNRECORDED_LINES ? `\n… and ${fresh.length - UNRECORDED_LINES} more: node scripts/watchdog.mjs --cluster ${ctx.cluster}` : '';
    text = `${head}${summary}. Check them before they unlock: ${check}\n${lines.join('\n')}${more}`;
  }
  ctx.waitUntil(deliverAlert(ctx.env, ctx.deps, alertSubject(ctx.cluster, severity, 'claim_pending_onchain', summary), text, ctx.log).then(() => undefined));
}

async function graduationJob(ctx: Ctx, rpc: Rpc, now: number): Promise<string> {
  const rows = (
    await ctx.db.prepare('SELECT mint FROM coins WHERE cluster = ?1 AND complete = 1 AND graduated = 0 LIMIT 50').bind(ctx.cluster).all<{ mint: string }>()
  ).results;
  if (!rows.length) return '0 pending';
  const pools = await Promise.all(rows.map((r) => canonicalPoolPda(r.mint)));
  const { accounts } = await rpc.getMultipleAccounts(pools);
  const stmts: D1PreparedStatement[] = [];
  rows.forEach((r, i) => {
    const a = accounts[i];
    if (!a || !accountExists(a)) return;
    try {
      const p = decodePumpPool(a.data);
      if (p.baseMint !== r.mint) return;
      stmts.push(
        ctx.db
          .prepare('UPDATE coins SET graduated = 1, complete = 1, pool = ?2, pool_base_vault = ?3, pool_quote_vault = ?4, progress_pct = 100, updated_at = ?5 WHERE mint = ?1')
          .bind(r.mint, pools[i]!, p.baseVault, p.quoteVault, now),
      );
    } catch {
      /* not a pool yet */
    }
  });
  if (stmts.length) await ctx.db.batch(stmts);
  return `${stmts.length} graduated`;
}

async function claimsJob(ctx: Ctx, rpc: Rpc, programId: string): Promise<string> {
  const now = ctx.deps.now();
  const nowSec = Math.floor(now / 1000);
  await ctx.db.batch([
    ctx.db.prepare("UPDATE claims SET status = 'expired', updated_at = ?1 WHERE status = 'calling' AND expires_at < ?1").bind(now),
    ctx.db.prepare("UPDATE claims SET status = 'expired', updated_at = ?1 WHERE status IN ('verified','cosigned') AND token_expires_at < ?1").bind(now),
  ]);
  const due = (
    await ctx.db
      .prepare("SELECT c.id, c.place_id, c.new_owner, c.unlock_ts, c.finalize_sig, k.place_hash FROM claims c JOIN coins k ON k.place_id = c.place_id WHERE c.status = 'pending_onchain' AND c.unlock_ts <= ?1 ORDER BY c.unlock_ts ASC LIMIT 5")
      .bind(nowSec)
      .all<{ id: string; place_id: string; new_owner: string; unlock_ts: number; finalize_sig: string | null; place_hash: string }>()
  ).results;
  if (!due.length) return 'nothing due';
  const prio = Number((await kvGet<number>(ctx.db, 'priority_fee'))?.value ?? ctx.env.PRIORITY_FEE_DEFAULT ?? 10_000);
  let finalized = 0;
  let sent = 0;
  for (const c of due) {
    if (rpc.remaining < 4) break;
    const { vaultState } = await placeAddressesFromHash(c.place_hash, programId);
    const acc = await rpc.getAccount(vaultState);
    if (!acc) continue;
    const st = decodeVaultState(acc.data);
    if (st.owner === c.new_owner && st.pendingOwner === null) {
      // finalized on chain (by us, the owner or anyone): the claim row AND the coin's owner mirror
      await ctx.db.batch([
        ctx.db.prepare("UPDATE claims SET status = 'finalized', finalized_at = COALESCE(finalized_at, ?2), updated_at = ?2 WHERE id = ?1").bind(c.id, now),
        ownerUpdateStmt(ctx.db, c.place_id, st, now),
      ]);
      finalized++;
      continue;
    }
    if (st.pendingOwner !== c.new_owner) {
      await ctx.db.prepare("UPDATE claims SET status = 'cancelled', updated_at = ?2 WHERE id = ?1").bind(c.id, now).run();
      await alert(ctx, 'warn', 'claim_cancelled', `pending claim ${c.id} for ${c.place_id} is no longer on-chain (cancelled or replaced)`, c.id);
      continue;
    }
    if (st.unlockTs !== null && st.unlockTs > nowSec) continue;
    if (!(await crankKey(ctx))) return 'crank key missing';
    const r = await sendFinalizeClaim(ctx, rpc, programId, vaultState, prio);
    if (r.ok) {
      sent++;
      await ctx.db.prepare('UPDATE claims SET finalize_sig = ?2, updated_at = ?3 WHERE id = ?1').bind(c.id, r.signature ?? null, now).run();
      // Wait (briefly, within this run's budget) for the finalize to land, then mirror the new owner at once: until the
      // mirror says so, the app would keep offering a Finalize that can only fail with "no claim waiting".
      if (r.signature && (await landed(ctx, rpc, r.signature))) {
        const after = await rpc.getAccount(vaultState).catch(() => null);
        const st2 = after ? decodeVaultState(after.data) : null;
        if (st2 && st2.owner === c.new_owner && st2.pendingOwner === null) {
          const t = ctx.deps.now();
          await ctx.db.batch([
            ctx.db.prepare("UPDATE claims SET status = 'finalized', finalized_at = COALESCE(finalized_at, ?2), updated_at = ?2 WHERE id = ?1").bind(c.id, t),
            ownerUpdateStmt(ctx.db, c.place_id, st2, t),
          ]);
          finalized++;
        }
      }
    } else {
      ctx.log.warn('claims.finalize_failed', { claim: c.id, error: r.error ?? 'unknown' });
    }
  }
  return `${finalized} finalized, ${sent} sent`;
}

/** Polls a just-sent crank tx until `confirmed` (≤ 4 polls over ~6 s; leaves 2 calls of the budget). */
async function landed(ctx: Ctx, rpc: Rpc, sig: string): Promise<boolean> {
  for (let i = 0; i < 4 && rpc.remaining > 2; i++) {
    await sleepFor(ctx.deps, i === 0 ? 1_200 : 1_500);
    try {
      const st = await rpc.getSignatureStatus(sig);
      if (st?.err) return false;
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return true;
    } catch {
      /* next poll */
    }
  }
  return false;
}

/**
 * The program monitor reads at most 10 transactions a run, newest first down to its cursor, so a burst of transactions
 * that name the program (anyone can add it as a read-only account) delays the events behind it. When it is reading
 * transactions older than this, it says so (pending claims are still caught by the vault sweep: claim_pending_onchain).
 * Judged on the signature page's block times, failed transactions included: they are never fetched, so a flood of
 * them moves the cursor without a single transaction to date it.
 */
export function monitorLagAlertMs(cluster: Ctx['cluster']): number {
  return Math.max(10 * 60_000, 3 * cronPeriodMs(cluster));
}

async function monitorJob(ctx: Ctx, rpc: Rpc, programId: string, now: number): Promise<string> {
  let n = 0;
  let oldestMs = Infinity;
  const fetched = await walkAccount(
    ctx,
    rpc,
    programId,
    10,
    async (items, extra, page) => {
      for (const s of page) if (s.blockTime) oldestMs = Math.min(oldestMs, s.blockTime * 1000);
      const stmts: D1PreparedStatement[] = [];
      // oldest first, so alerts read in chain order
      for (const { sig, tx } of [...items].reverse()) {
        if (tx.blockTime) oldestMs = Math.min(oldestMs, tx.blockTime * 1000);
        if (!tx.meta || tx.meta.err) continue;
        for (const ev of decodeVaultLogEvents(tx.meta.logMessages, programId)) {
          const f = ev.fields;
          const placeHash = ['Registered', 'ClaimRequested', 'ClaimCancelled', 'ClaimFinalized', 'Withdrawn', 'Unwrapped'].includes(ev.name) ? evHex(f[0]) : null;
          const data: Record<string, unknown> = { name: ev.name };
          if (ev.name === 'Registered') Object.assign(data, { mint: evKey(f[1]), launcher: evKey(f[2]) });
          if (ev.name === 'ClaimRequested') Object.assign(data, { newOwner: evKey(f[1]), nonce: evU64(f[2])?.toString(), unlockTs: evU64(f[3])?.toString() });
          if (ev.name === 'ClaimCancelled') Object.assign(data, { by: evKey(f[1]), role: evU8(f[2]) });
          if (ev.name === 'Withdrawn') Object.assign(data, withdrawnData(f));
          if (ev.name === 'AdminChanged') Object.assign(data, { kind: evU8(f[0]), key: evKey(f[1]) });
          stmts.push(
            ctx.db
              .prepare('INSERT OR IGNORE INTO chain_events(sig, ix, kind, place_hash, data_json, slot, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
              .bind(sig, ev.index, ev.name, placeHash, JSON.stringify(data), tx.slot, (tx.blockTime ?? 0) * 1000 || now),
          );
          n++;
          await checkEvent(ctx, ev.name, data, placeHash, sig);
        }
      }
      const all = [...stmts, ...extra];
      if (all.length) await ctx.db.batch(all);
    },
    undefined,
    { startAtHead: true },
  );
  const lagMs = now - oldestMs;
  if (lagMs > monitorLagAlertMs(ctx.cluster)) {
    ctx.waitUntil(
      alert(
        ctx,
        'warn',
        'monitor_backlog',
        `The program monitor is reading transactions ${Math.round(lagMs / 60_000)} min late (a burst of transactions naming the program, or missed runs): new claims and admin changes are seen late. Pending claims: node scripts/claims-admin.mjs --env ${ctx.cluster} list`,
        programId,
      ),
    );
  }
  return `${n} events from ${fetched} txs`;
}

async function checkEvent(ctx: Ctx, name: string, data: Record<string, unknown>, placeHash: string | null, sig: string): Promise<void> {
  if (name === 'Registered') {
    const mint = data.mint as string | null;
    const known = mint
      ? await ctx.db
          .prepare('SELECT 1 AS x FROM coins WHERE mint = ?1 UNION ALL SELECT 1 FROM launch_reservations WHERE mint = ?1 LIMIT 1')
          .bind(mint)
          .first()
      : null;
    if (!known) await alert(ctx, 'critical', 'registered_unknown', `Registered ${mint ?? '?'} (place ${placeHash}) without a coin or reservation: possible attestor misuse (tx ${sig})`, sig);
  } else if (name === 'ClaimRequested') {
    const known = await ctx.db
      .prepare("SELECT 1 AS x FROM claims c JOIN coins k ON k.place_id = c.place_id WHERE k.place_hash = ?1 AND c.new_owner = ?2 LIMIT 1")
      .bind(placeHash ?? '', (data.newOwner as string) ?? '')
      .first();
    if (!known) await alert(ctx, 'critical', 'claim_unknown', `ClaimRequested for place ${placeHash} by ${String(data.newOwner)} without a claims row (tx ${sig})`, sig);
    // the site owner's alert, also for a claim whose browser never confirmed it (de-duplicated with claim confirm)
    else ctx.waitUntil(notifyOwnerFromChain(ctx, placeHash, data, sig));
  } else if (name === 'ClaimCancelled') {
    await alert(ctx, 'warn', 'claim_cancelled', `ClaimCancelled at place ${placeHash} by role ${String(data.role)} (tx ${sig})`, sig);
  } else if (name === 'AdminChanged') {
    const kind = Number(data.kind);
    const key = data.key as string | null;
    const expected = key ? await ctx.db.prepare('SELECT 1 AS x FROM admin_expectations WHERE kind = ?1 AND key = ?2 LIMIT 1').bind(kind, key).first() : null;
    if (!expected) await alert(ctx, 'critical', 'admin_changed', `AdminChanged kind ${kind} key ${key ?? '-'} not pre-registered in admin_expectations (tx ${sig})`, sig);
  }
}

/**
 * Holders (INTEGRATION §9): Token-2022 accounts with amount > 0, excluding the curve's token account and the pool's
 * base vault. Source: `getTokenLargestAccounts` (standard RPC, on every Alchemy plan; `getProgramAccounts` is not):
 * EXACT while a coin has fewer than 20 token accounts. From 20 on, the count also takes the trade-derived holders
 * from D1 (net tokens bought − sold per trader > 0; exact while nobody transfers tokens), never below what the chain
 * shows. Runs every cron for coins that traded since their last count (≤ 4 per run), plus the hourly sweep.
 */
async function holdersJob(ctx: Ctx, rpc: Rpc, now: number, markDue: (() => void) | null): Promise<string> {
  const hourly = !!markDue;
  markDue?.();
  const rows = (
    await ctx.db
      .prepare(
        `SELECT mint, bonding_curve, pool_base_vault FROM coins WHERE cluster = ?1 AND (holders IS NULL
           OR (COALESCE(last_trade_at, 0) > COALESCE(holders_at, 0) AND COALESCE(holders_at, 0) < ?3)
           OR (?4 = 1 AND COALESCE(last_trade_at, 0) > ?2))
         ORDER BY COALESCE(holders_at, 0) ASC LIMIT ?5`,
      )
      .bind(ctx.cluster, now - DAY, now - 120_000, hourly ? 1 : 0, hourly ? 10 : 4)
      .all<{ mint: string; bonding_curve: string; pool_base_vault: string | null }>()
  ).results;
  if (!rows.length) return '0 coins';
  const { curveBaseAta } = await import('./addresses');
  const stmts: D1PreparedStatement[] = [];
  let n = 0;
  for (const r of rows) {
    if (rpc.remaining < 1) break;
    let largest: { address: string; amount: string }[];
    try {
      largest = (await rpc.call<{ value: { address: string; amount: string }[] }>('getTokenLargestAccounts', [r.mint, { commitment: 'confirmed' }])).value ?? [];
    } catch (e) {
      if (e instanceof RpcError || e instanceof UpstreamError) continue; // try again next run
      throw e;
    }
    const curveAta = await curveBaseAta(r.bonding_curve, r.mint);
    const held = largest.filter((a) => a.address !== curveAta && a.address !== r.pool_base_vault && /^\d+$/.test(a.amount) && BigInt(a.amount) > 0n).length;
    let count = held;
    if (largest.length >= 20) {
      const fromTrades = await ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM (SELECT trader, SUM(CASE WHEN side = 'buy' THEN tokens ELSE -tokens END) AS net FROM trades WHERE mint = ?1 GROUP BY trader) WHERE net > 0`,
        )
        .bind(r.mint)
        .first<{ n: number }>();
      count = Math.max(held, fromTrades?.n ?? 0);
    }
    stmts.push(ctx.db.prepare('UPDATE coins SET holders = ?2, holders_at = ?3 WHERE mint = ?1').bind(r.mint, count, now));
    n++;
  }
  if (stmts.length) await ctx.db.batch(stmts);
  return `${n} coins`;
}

export const MISSING_TRADE_AMOUNTS_SQL = 'SELECT sig, MAX(ts) AS t FROM trades WHERE user_lamports IS NULL GROUP BY sig ORDER BY t DESC LIMIT 10';

/**
 * Backfills `trades.user_lamports` (what the trader paid / received, fees included) for rows indexed before the column
 * existed: ≤ 10 transactions per run, newest first, decoded with the same event decoder (same (sig, ix) keys). The
 * lookup reads only the partial index `trades_user_lamports_missing` (migration 0004); `idle()` once nothing is missing.
 */
async function tradeAmountsJob(ctx: Ctx, rpc: Rpc, idle: () => void): Promise<string> {
  const sigs = (await ctx.db.prepare(MISSING_TRADE_AMOUNTS_SQL).all<{ sig: string }>()).results.map((r) => r.sig);
  if (!sigs.length) {
    idle();
    return 'none missing';
  }
  const txs = await fetchTransactions(rpc, sigs);
  const stmts: D1PreparedStatement[] = [];
  sigs.forEach((sig, i) => {
    const tx = txs[i];
    if (!tx) return;
    for (const e of decodePumpEvents(tx)) {
      const v = e.kind === 'curve' ? curveUserLamports(e) : e.kind === 'amm' ? e.quoteAmount : null;
      if (v === null) continue;
      stmts.push(ctx.db.prepare('UPDATE trades SET user_lamports = ?3 WHERE sig = ?1 AND ix = ?2 AND user_lamports IS NULL').bind(sig, e.index, dbInt(v)));
    }
  });
  if (stmts.length) await ctx.db.batch(stmts);
  return `${stmts.length} rows`;
}

/**
 * Backfills owner + amount on `Withdrawn` chain_events recorded before they were stored (the Live feed shows payouts
 * from them): ≤ 5 transactions per run, re-decoded from their logs. `idle()` once nothing is missing (the lookup reads
 * every Withdrawn row).
 */
async function withdrawAmountsJob(ctx: Ctx, rpc: Rpc, programId: string, idle: () => void): Promise<string> {
  const rows = (
    await ctx.db
      .prepare(`SELECT sig, ix FROM chain_events WHERE kind = 'Withdrawn' AND data_json NOT LIKE '%"amount"%' ORDER BY ts DESC LIMIT 5`)
      .all<{ sig: string; ix: number }>()
  ).results;
  if (!rows.length) {
    idle();
    return 'none missing';
  }
  const sigs = [...new Set(rows.map((r) => r.sig))];
  const txs = await fetchTransactions(rpc, sigs);
  const stmts: D1PreparedStatement[] = [];
  sigs.forEach((sig, i) => {
    const tx = txs[i];
    if (!tx?.meta) return;
    for (const ev of decodeVaultLogEvents(tx.meta.logMessages, programId)) {
      if (ev.name !== 'Withdrawn') continue;
      stmts.push(
        ctx.db
          .prepare(`UPDATE chain_events SET data_json = ?3 WHERE sig = ?1 AND ix = ?2 AND kind = 'Withdrawn' AND data_json NOT LIKE '%"amount"%'`)
          .bind(sig, ev.index, JSON.stringify({ name: ev.name, ...withdrawnData(ev.fields) })),
      );
    }
  });
  if (stmts.length) await ctx.db.batch(stmts);
  return `${stmts.length} rows`;
}

const FEE_CRANK_MIN = 10_000_000; // 0.01 SOL

async function feeCrankJob(ctx: Ctx, rpc: Rpc, now: number): Promise<string> {
  const rows = (
    await ctx.db
      .prepare(
        `SELECT mint, vault, vault_state, bonding_curve, graduated FROM coins WHERE cluster = ?1 AND fees_collectable_lamports >= ?2
         AND (fee_crank_at IS NULL OR fee_crank_at < ?3) ORDER BY fees_collectable_lamports DESC LIMIT 2`,
      )
      .bind(ctx.cluster, FEE_CRANK_MIN, now - 6 * HOUR)
      .all<{ mint: string; vault: string; vault_state: string; bonding_curve: string; graduated: number }>()
  ).results;
  if (!rows.length) return 'nothing due';
  if (!(await crankKey(ctx))) return 'crank key missing';
  const prio = Number((await kvGet<number>(ctx.db, 'priority_fee'))?.value ?? ctx.env.PRIORITY_FEE_DEFAULT ?? 10_000);
  let sent = 0;
  for (const r of rows) {
    if (rpc.remaining < 4) break;
    await ctx.db.prepare('UPDATE coins SET fee_crank_at = ?2 WHERE mint = ?1').bind(r.mint, now).run();
    const curve = await rpc.getAccount(r.bonding_curve);
    let bucket = 0n;
    try {
      bucket = curve ? decodeBondingCurve(curve.data).creatorFeeBucket : 0n;
    } catch {
      bucket = 0n;
    }
    const res = await sendFeeCrank(ctx, rpc, { mint: r.mint, vault: r.vault, curveBucket: bucket, graduated: !!r.graduated }, prio);
    if (res.ok) sent++;
    else ctx.log.warn('fee_crank.failed', { mint: r.mint, error: res.error ?? 'unknown' });
  }
  return `${sent} sent`;
}
