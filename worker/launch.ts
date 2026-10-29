/**
 * Launch flow (INTEGRATION §3.4): prepare → (browser builds the v0 tx with the pump SDK) → cosign (SPEC §8.4 policy,
 * then the attestor signature) → (wallet signs, browser sends via /api/rpc) → confirm (verify on chain, register in
 * D1). Plus the cron reconciliation of co-signed reservations that never confirmed.
 *
 * Ordering choices (stronger than the listed order, same semantics): the policy and the reference check run BEFORE
 * the per-place lock is taken, so a malformed message never locks a place; the attestor signs only after both pass
 * AND the lock is held.
 */
import { launchAddresses, placeAddresses, type LaunchAddresses } from './addresses';
import { attestorPubkey, signApproved } from './attestor';
import { canonicalPubkey, fromB64, fromHex, isSignature, parseU64, toB64 } from './bytes';
import { CATEGORY_KEYS } from './categories';
import { accountExists, altFromAccount, cachedAlt, configFromAccount, decodeVaultState, loadAlt, type ConfigView } from './chainState';
import { COIN_COLUMNS, COIN_FROM, type CoinRow } from './coins';
import { CONFIG_PDA, LAUNCH_CU_LIMIT, POLICY_MAX_CU_LAUNCH, POLICY_MAX_CU_PRICE } from './consts';
import { cap, DAY, kvPutStmt, limit, uncap, type Ctx } from './ctx';
import { programIdOf } from './env';
import { freshCoin } from './fresh';
import { assertPlaceAllowed } from './geo';
import { eligibility, spendGoogleLookup, validPlaceId } from './google';
import { ApiErr, CACHE, ID_RE, json, randomId, readJsonObject } from './http';
import { ingestTransactions } from './indexer';
import { configView, globalLive, metaSnapshot } from './meta';
import { approveLaunch, type LaunchExpect } from './policy';
import { referenceLaunchViolations, warmReference } from './policyRef';
import { assertWalletAllowed } from './sanctions';
import { txAccountKeys, type AccountRaw, type Rpc, type RpcTransaction } from './solana';
import { placeOptedOut } from './takedown';
import { RESERVATION_TTL_MS, type LaunchConfirmResponse, type LaunchCosignResponse, type LaunchPrepareResponse } from './wire';

const LOCK_MS = 120_000;
const MAX_COSIGNS = 5;
/** Per day, per place: co-signed launch locks one IP (and one launcher wallet) may take (SPEC T8). */
const LOCKS_PER_PLACE_PER_DAY = 3;
const COORDS_TTL_MS = 30 * DAY;

export interface ReservationRow {
  id: string;
  place_id: string;
  place_hash: string;
  launcher: string;
  mint: string;
  metadata_id: string;
  category: string;
  emoji: string;
  bg: string;
  dev_buy_lamports: number;
  lat: number | null;
  lng: number | null;
  status: 'prepared' | 'cosigned' | 'confirmed' | 'expired' | 'failed';
  cosign_count: number;
  locked_until: number | null;
  signature: string | null;
  created_at: number;
  expires_at: number;
}

interface MetadataRow {
  id: string;
  name: string;
  symbol: string;
  description: string;
  image_id: string;
  place_id: string;
  used_by_mint: string | null;
}

function graphemes(s: string): number {
  try {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length;
  } catch {
    return [...s].length;
  }
}

async function takenError(ctx: Ctx, placeId: string): Promise<ApiErr | null> {
  const row = await ctx.db
    .prepare('SELECT place_id, mint, ticker, name FROM coins WHERE place_id = ?1 AND cluster = ?2')
    .bind(placeId, ctx.cluster)
    .first<{ place_id: string; mint: string; ticker: string; name: string }>();
  if (!row) return null;
  return new ApiErr('taken', 'Someone launched this shop first', { existing: { placeId: row.place_id, mint: row.mint, ticker: row.ticker, name: row.name } });
}

async function vaultStateExists(rpc: Rpc, vaultState: string): Promise<boolean> {
  const a = await rpc.getAccount(vaultState);
  return accountExists(a) && a.data.length > 0;
}

/**
 * A place is registered on-chain but has no D1 coin (e.g. the launch landed after its reservation lapsed, or the
 * browser never called confirm): find the reservation of the on-chain mint and register it from the launch tx, so the
 * registry never misses a coin. Runs in the background; returns quietly when nothing matches.
 */
export async function adoptFromChain(ctx: Ctx, placeId: string): Promise<void> {
  try {
    if (await takenError(ctx, placeId)) return;
    const rpc = ctx.rpc(6);
    const { vaultState } = await placeAddresses(placeId, programIdOf(ctx.env));
    const acc = await rpc.getAccount(vaultState);
    if (!acc || !acc.data.length) return;
    const st = decodeVaultState(acc.data);
    const r = await ctx.db.prepare('SELECT * FROM launch_reservations WHERE mint = ?1').bind(st.mint).first<ReservationRow>();
    if (!r || r.place_id !== placeId) {
      ctx.log.warn('launch.adopt_unknown', { placeHash: st.placeHash, mint: st.mint });
      return;
    }
    const sigs = await rpc.getSignaturesForAddress(vaultState, { limit: 25 });
    const first = sigs.filter((x) => !x.err).pop();
    if (first) await registerFromSignature(ctx, rpc, r, first.signature);
  } catch (e) {
    ctx.log.warn('launch.adopt_failed', { error: e instanceof Error ? e.message : 'error' });
  }
}

/** The attestor must be configured AND equal on-chain Config.attestor; launches must not be paused. */
async function launchGate(ctx: Ctx): Promise<string> {
  const [cfg, attestor] = await Promise.all([configView(ctx, { fresh: true }), attestorPubkey(ctx.env)]);
  return checkLaunchGate(ctx, cfg, attestor);
}

function checkLaunchGate(ctx: Ctx, cfg: ConfigView | null, attestor: string | null): string {
  if (!cfg) throw new ApiErr('unavailable', 'Launches are not available yet');
  if (cfg.paused) throw new ApiErr('launches_paused', 'Launches are paused right now. Trading and claims still work.');
  if (!attestor || attestor !== cfg.attestor) {
    ctx.log.error('launch.attestor_mismatch', { configured: !!attestor });
    throw new ApiErr('unavailable', 'Launches are not available right now');
  }
  return attestor;
}

/* ================================================================================================ prepare */

const OPTED_OUT_MESSAGE = 'This business asked us not to list coins for it.';

export async function handleLaunchPrepare(ctx: Ctx, request: Request): Promise<Response> {
  await limit(ctx.env.RL_WRITE, `write:${ctx.ipHash}`);
  const body = await readJsonObject(request);
  const requested = body.placeId;
  if (!validPlaceId(requested, ctx.cluster)) throw new ApiErr('bad_request', 'Invalid placeId');
  const launcher = canonicalPubkey(body.launcher);
  const mint = canonicalPubkey(body.mint);
  if (!launcher || !mint || launcher === mint) throw new ApiErr('bad_request', 'Invalid launcher or mint');
  assertWalletAllowed(ctx, launcher, 'launch');
  const metadataId = typeof body.metadataId === 'string' && /^[0-9a-f]{32}$/.test(body.metadataId) ? body.metadataId : null;
  if (!metadataId) throw new ApiErr('bad_request', 'Invalid metadataId');
  const category = body.category;
  if (typeof category !== 'string' || !(CATEGORY_KEYS as readonly string[]).includes(category)) throw new ApiErr('bad_request', 'Invalid category');
  const emoji = typeof body.emoji === 'string' ? body.emoji : '';
  if (!emoji || emoji.length > 16 || graphemes(emoji) > 2) throw new ApiErr('bad_request', 'Invalid emoji');
  const bg = typeof body.bg === 'string' && /^#[0-9a-f]{6}$/.test(body.bg) ? body.bg : null;
  if (!bg) throw new ApiErr('bad_request', 'Invalid background colour');
  const devBuy = parseU64(body.devBuyLamports);
  const maxDevBuy = parseU64(ctx.env.MAX_DEV_BUY_LAMPORTS ?? '') ?? 1_000_000_000n;
  if (devBuy === null || devBuy > maxDevBuy) throw new ApiErr('bad_request', 'Invalid first buy amount');

  const now = ctx.deps.now();
  await cap(ctx.db, `prepare:ip:${ctx.ipHash}`, 100, DAY, now, 'rate_limited', 'Too many launches today. Try again tomorrow.');
  // a business that opted out gets no coin, also before one exists (checked before the paid Google lookup)
  if (await placeOptedOut(ctx.db, requested)) throw new ApiErr('place_opted_out', OPTED_OUT_MESSAGE);

  const meta = await ctx.db.prepare('SELECT * FROM metadata WHERE id = ?1').bind(metadataId).first<MetadataRow>();
  if (!meta) throw new ApiErr('bad_request', 'Upload the coin art first');
  if (meta.used_by_mint) throw new ApiErr('bad_request', 'This metadata was already used. Upload it again.');

  const attestor = await launchGate(ctx);
  if (launcher === attestor) throw new ApiErr('bad_request', 'Invalid launcher');

  // Google lookup: key the coin on the id Google returns (a real Google call spends the global daily budget)
  const elig = await eligibility(ctx.env, ctx.deps, ctx.cluster, requested, () => spendGoogleLookup(ctx));
  if (elig.reason !== 'ok') throw new ApiErr('not_launchable', "This place can't have a coin", { reason: elig.reason });
  assertPlaceAllowed(ctx.env, elig.region, 'launch'); // no coins for businesses in blocked regions (worker/geo.ts)
  const placeId = elig.placeId;
  if (placeId !== requested && (await placeOptedOut(ctx.db, placeId))) throw new ApiErr('place_opted_out', OPTED_OUT_MESSAGE);
  if (meta.place_id !== requested && meta.place_id !== placeId) throw new ApiErr('bad_request', 'The art was uploaded for another place');

  const taken = await takenError(ctx, placeId);
  if (taken) throw taken;
  const programId = programIdOf(ctx.env);
  const addrs = await placeAddresses(placeId, programId);
  const rpc = ctx.rpc(4);
  if (await vaultStateExists(rpc, addrs.vaultState)) {
    ctx.waitUntil(adoptFromChain(ctx, placeId));
    throw new ApiErr('taken', 'Someone launched this shop first');
  }

  const busy = await ctx.db
    .prepare("SELECT launcher, locked_until FROM launch_reservations WHERE place_id = ?1 AND status = 'cosigned' AND locked_until > ?2")
    .bind(placeId, now)
    .first<{ launcher: string; locked_until: number }>();
  if (busy && busy.launcher !== launcher) {
    throw new ApiErr('reserved', 'Someone else is launching this shop right now. Try again in a minute.', { retryAfterSec: Math.ceil((busy.locked_until - now) / 1000) });
  }

  const [{ blockhash, lastValidBlockHeight }, snap] = await Promise.all([rpc.getLatestBlockhash(), metaSnapshot(ctx)]);
  const id = randomId();
  const loc = elig.location;
  try {
    await ctx.db
      .prepare(
        `INSERT INTO launch_reservations(id, place_id, place_hash, launcher, mint, metadata_id, category, emoji, bg, dev_buy_lamports, lat, lng, status, created_at, expires_at, ip_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'prepared', ?13, ?14, ?15)`,
      )
      .bind(id, placeId, addrs.placeHashHex, launcher, mint, metadataId, category, emoji, bg, Number(devBuy), loc?.lat ?? null, loc?.lng ?? null, now, now + RESERVATION_TTL_MS, ctx.ipHash)
      .run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) throw new ApiErr('bad_request', 'Use a fresh mint for every launch');
    throw e;
  }
  const out: LaunchPrepareResponse = {
    reservationId: id,
    placeId,
    placeHash: addrs.placeHashHex,
    vault: addrs.vault,
    vaultState: addrs.vaultState,
    name: meta.name,
    symbol: meta.symbol,
    uri: `${ctx.origin}/meta/${meta.id}.json`,
    attestor,
    alt: ctx.env.ALT_ADDRESS ?? '',
    programId,
    configPda: CONFIG_PDA,
    maxDevBuyLamports: maxDevBuy.toString(),
    computeUnitLimit: LAUNCH_CU_LIMIT,
    priorityFeeMicroLamports: snap.priorityFee ?? (Number(ctx.env.PRIORITY_FEE_DEFAULT ?? '10000') || 10_000),
    blockhash,
    lastValidBlockHeight,
    expiresAt: now + RESERVATION_TTL_MS,
  };
  ctx.log.info('launch.prepared', { reservation: id, placeHash: addrs.placeHashHex, devBuy: devBuy.toString() });
  // the co-sign follows in seconds (usually on this isolate): pay web3.js's one-off evaluation and the ALT read now,
  // after the response, instead of on the co-sign's critical path (INTEGRATION §8: cosign ≤ 400 ms)
  if (ctx.env.POLICY_REFERENCE !== '0') ctx.waitUntil(warmReference());
  ctx.waitUntil(loadAlt(rpc, ctx.env.ALT_ADDRESS?.trim() ?? '').catch(() => undefined));
  return json(out, 200);
}

/* ================================================================================================= cosign */

export async function launchExpectFor(
  ctx: Ctx,
  r: ReservationRow,
  meta: MetadataRow,
  attestor: string,
  alt: { address: string; keys: readonly string[] } | null,
  addrs?: LaunchAddresses,
): Promise<LaunchExpect> {
  const programId = programIdOf(ctx.env);
  const a = addrs ?? (await launchAddresses(fromHex(r.place_hash), r.launcher, r.mint, programId));
  return {
    programId,
    attestor,
    launcher: r.launcher,
    mint: r.mint,
    placeHash: a.placeHash,
    vault: a.vault,
    vaultState: a.vaultState,
    config: a.config,
    bondingCurve: a.bondingCurve,
    curveBaseAta: a.curveBaseAta,
    curveQuoteAta: a.curveQuoteAta,
    mayhemState: a.mayhemState,
    mayhemTokenVault: a.mayhemTokenVault,
    launcherAta: a.launcherAta,
    launcherWsolAta: a.launcherWsolAta,
    userVolumeAccumulator: a.userVolumeAccumulator,
    name: meta.name,
    symbol: meta.symbol,
    uri: `${ctx.origin}/meta/${meta.id}.json`,
    devBuyLamports: BigInt(r.dev_buy_lamports),
    maxDevBuyLamports: parseU64(ctx.env.MAX_DEV_BUY_LAMPORTS ?? '') ?? 1_000_000_000n,
    alt,
    maxComputeUnitLimit: POLICY_MAX_CU_LAUNCH,
    maxComputeUnitPriceMicroLamports: POLICY_MAX_CU_PRICE,
  };
}

export async function handleLaunchCosign(ctx: Ctx, request: Request): Promise<Response> {
  const t0 = Date.now();
  await limit(ctx.env.RL_WRITE, `write:${ctx.ipHash}`);
  const body = await readJsonObject(request);
  const rid = typeof body.reservationId === 'string' && ID_RE.test(body.reservationId) ? body.reservationId : null;
  if (!rid) throw new ApiErr('bad_request', 'Invalid reservationId');
  let bytes: Uint8Array;
  try {
    if (typeof body.messageBase64 !== 'string' || body.messageBase64.length > 2_000) throw new Error('bad');
    bytes = fromB64(body.messageBase64);
  } catch {
    throw new ApiErr('bad_request', 'Invalid messageBase64');
  }
  // web3.js + the shop-vault client evaluate while this request waits on D1 / RPC (usually already warm from prepare)
  const useReference = ctx.env.POLICY_REFERENCE !== '0';
  if (useReference) void warmReference();
  const now = ctx.deps.now();
  const r = await ctx.db.prepare('SELECT * FROM launch_reservations WHERE id = ?1').bind(rid).first<ReservationRow>();
  if (!r) throw new ApiErr('not_found', 'Reservation not found');
  const live = (r.status === 'prepared' && r.expires_at > now) || (r.status === 'cosigned' && (r.locked_until ?? 0) > now);
  if (!live) throw new ApiErr('reservation_expired', 'This launch timed out. Start again.');
  if (r.cosign_count >= MAX_COSIGNS) throw new ApiErr('too_many_attempts', 'Too many attempts for this launch. Start again.', { retryAfterSec: 60 });
  const tRes = Date.now();

  // The independent gates run in parallel (cosign ≤ 400 ms p95, INTEGRATION §8). Chain state is ONE getMultipleAccounts:
  // Config (fresh: paused / attestor), the place's VaultState (on-chain "taken") and, until this isolate has verified
  // it once, the frozen ALT. D1: taken + stored metadata. Address derivation (CPU) overlaps the I/O.
  const programId = programIdOf(ctx.env);
  const rpc = ctx.rpc(4);
  const altAddr = ctx.env.ALT_ADDRESS?.trim() ?? '';
  const altHit = cachedAlt(rpc.cluster, altAddr);
  const [chain, attestorKey, taken, meta, addrs] = await Promise.all([
    placeAddresses(r.place_id, programId).then(async (pa) => {
      const keys = [CONFIG_PDA, pa.vaultState, ...(altHit || !altAddr ? [] : [altAddr])];
      const { accounts } = await rpc.getMultipleAccounts(keys);
      return { config: accounts[0] ?? null, vaultState: accounts[1] ?? null, alt: altHit ? null : (accounts[2] ?? null) };
    }),
    attestorPubkey(ctx.env),
    takenError(ctx, r.place_id),
    ctx.db.prepare('SELECT * FROM metadata WHERE id = ?1').bind(r.metadata_id).first<MetadataRow>(),
    launchAddresses(fromHex(r.place_hash), r.launcher, r.mint, programId),
  ]);
  const cfg = configFromAccount(rpc.cluster, chain.config, now);
  ctx.waitUntil(cfg ? kvPutStmt(ctx.db, 'chain_config', cfg, now).run() : Promise.resolve());
  const attestor = checkLaunchGate(ctx, cfg, attestorKey);
  if (taken) throw taken;
  if (accountExists(chain.vaultState) && (chain.vaultState?.data.length ?? 0) > 0) {
    ctx.waitUntil(adoptFromChain(ctx, r.place_id));
    throw new ApiErr('taken', 'Someone launched this shop first');
  }
  if (!meta || (meta.used_by_mint && meta.used_by_mint !== r.mint)) throw new ApiErr('bad_request', 'This metadata was already used. Start again.');
  const { alt, problems } = altHit ? { alt: altHit, problems: [] as string[] } : altFromAccount(rpc.cluster, altAddr, chain.alt);
  if (problems.length || !alt) {
    ctx.log.error('launch.alt_unavailable', { problems });
    throw new ApiErr('unavailable', 'Launches are not available right now');
  }
  const expect = await launchExpectFor(ctx, r, meta, attestor, { address: altAddr, keys: alt.addresses }, addrs);
  const tGates = Date.now();

  // 1) both policy gates on the exact submitted bytes (nothing is locked or signed yet)
  const reference = (b: Uint8Array) =>
    referenceLaunchViolations(b, {
      attestor,
      launcher: r.launcher,
      mint: r.mint,
      placeId: r.place_id,
      name: meta.name,
      symbol: meta.symbol,
      uri: expect.uri,
      maxDevBuyLamports: expect.maxDevBuyLamports,
      alt: expect.alt,
      maxComputeUnitLimit: expect.maxComputeUnitLimit,
      maxComputeUnitPriceMicroLamports: expect.maxComputeUnitPriceMicroLamports,
      programId: expect.programId,
    });
  const approval = await approveLaunch(bytes, expect, useReference ? reference : undefined);
  if (!approval.ok) {
    await ctx.db.prepare('UPDATE launch_reservations SET cosign_count = cosign_count + 1 WHERE id = ?1').bind(rid).run();
    ctx.log.warn('launch.policy_violation', { reservation: rid, count: approval.violations.length, first: approval.violations[0] ?? '' });
    throw new ApiErr('policy_violation', "We couldn't approve this transaction. Please try again.", { violations: approval.violations.slice(0, 20) });
  }
  const tPolicy = Date.now();

  // 2) the per-place lock (one co-signed launch per place; partial unique index), in ONE D1 batch (a transaction).
  //    SPEC T8 griefing bounds:
  //    - the lock deadline is fixed at the FIRST co-sign (re-co-signing with a fresh blockhash never extends it);
  //    - each (place, IP) and (place, launcher) may take at most LOCKS_PER_PLACE_PER_DAY locks a day: on a first lock
  //      both day counters are incremented in the same batch, and the lock is taken only while both stay ≤ the cap;
  //    - a launcher who starts over replaces their own earlier lock instead of stacking a second one.
  //    A UNIQUE violation rolls the whole batch back (counters included); a refused cap gives its counts back.
  const firstLock = r.status === 'prepared';
  const dayStart = Math.floor(now / DAY) * DAY;
  const capKeys = [`lock:ip:${r.place_id}:${ctx.ipHash}`, `lock:wallet:${r.place_id}:${r.launcher}`];
  const capStmt = (key: string) =>
    ctx.db
      .prepare(
        `INSERT INTO rate_counters(key, window_start, count) VALUES (?1, ?2, 1)
         ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END, window_start = ?2
         RETURNING count`,
      )
      .bind(key, dayStart);
  // SQL: true when this is not a first lock, or both day counters are within the cap after the increments above
  const capsOk = (first: number, ipKey: number, walletKey: number, max: number) =>
    `(?${first} = 0 OR ((SELECT count FROM rate_counters WHERE key = ?${ipKey}) <= ?${max} AND (SELECT count FROM rate_counters WHERE key = ?${walletKey}) <= ?${max}))`;
  let lockedUntil = now + LOCK_MS;
  try {
    const res = await ctx.db.batch([
      ...(firstLock ? capKeys.map(capStmt) : []),
      ctx.db
        .prepare(
          `UPDATE launch_reservations SET status = 'expired', locked_until = NULL WHERE place_id = ?1 AND status = 'cosigned'
             AND (locked_until < ?2 OR (launcher = ?3 AND id != ?4)) AND ${capsOk(5, 6, 7, 8)}`,
        )
        .bind(r.place_id, now, r.launcher, rid, firstLock ? 1 : 0, capKeys[0], capKeys[1], LOCKS_PER_PLACE_PER_DAY),
      ctx.db
        .prepare(
          `UPDATE launch_reservations SET locked_until = CASE WHEN status = 'cosigned' AND locked_until IS NOT NULL THEN locked_until ELSE ?2 END,
             status = 'cosigned', cosign_count = cosign_count + 1
           WHERE id = ?1 AND status IN ('prepared','cosigned') AND cosign_count < ?3 AND ${capsOk(4, 5, 6, 7)}
           RETURNING locked_until`,
        )
        .bind(rid, lockedUntil, MAX_COSIGNS, firstLock ? 1 : 0, capKeys[0], capKeys[1], LOCKS_PER_PLACE_PER_DAY),
    ]);
    const counts = firstLock ? res.slice(0, 2).map((x) => Number((x?.results?.[0] as { count?: number } | undefined)?.count ?? 1)) : [];
    const lockRes = res[res.length - 1];
    if (counts.some((n) => n > LOCKS_PER_PLACE_PER_DAY)) {
      throw new ApiErr('too_many_attempts', 'Too many launch attempts for this shop today. Try again tomorrow.', {
        retryAfterSec: Math.max(1, Math.ceil((dayStart + DAY - now) / 1000)),
      });
    }
    if (!lockRes?.results?.length && !lockRes?.meta?.changes) throw new ApiErr('reservation_expired', 'This launch timed out. Start again.');
    const lu = (lockRes?.results?.[0] as { locked_until?: number } | undefined)?.locked_until;
    if (typeof lu === 'number') lockedUntil = lu;
  } catch (e) {
    // counters were incremented only when the batch committed (cap refused, or the reservation went stale meanwhile)
    if (firstLock && e instanceof ApiErr) await Promise.all(capKeys.map((k) => uncap(ctx.db, k, DAY, now).catch(() => undefined)));
    if (e instanceof ApiErr) throw e;
    if (/UNIQUE/i.test(String(e))) {
      const other = await ctx.db
        .prepare("SELECT locked_until FROM launch_reservations WHERE place_id = ?1 AND status = 'cosigned'")
        .bind(r.place_id)
        .first<{ locked_until: number }>();
      throw new ApiErr('reserved', 'Someone else is launching this shop right now. Try again in a minute.', {
        retryAfterSec: Math.max(1, Math.ceil(((other?.locked_until ?? now + 60_000) - now) / 1000)),
      });
    }
    throw e;
  }
  if (lockedUntil <= now) throw new ApiErr('reservation_expired', 'This launch timed out. Start again.');
  const tLock = Date.now();

  // 3) sign exactly the approved bytes
  const { signature, attestor: signer } = await signApproved(ctx.env, approval.approved);
  const tSign = Date.now();
  ctx.log.info('launch.cosigned', {
    reservation: rid,
    placeHash: r.place_hash,
    bytes: bytes.length,
    // phase timings (ms): reservation read, gates (chain + D1 + addresses), policy, lock, sign
    msRes: tRes - t0,
    msGates: tGates - tRes,
    msPolicy: tPolicy - tGates,
    msLock: tLock - tPolicy,
    msSign: tSign - tLock,
    msTotal: tSign - t0,
  });
  const out: LaunchCosignResponse = { attestor: signer, attestorSignature: toB64(signature), lockedUntil };
  return json(out, 200);
}

/* ================================================================================================ confirm */

export async function handleLaunchConfirm(ctx: Ctx, request: Request): Promise<Response> {
  await limit(ctx.env.RL_READ, `read:${ctx.ipHash}`);
  const body = await readJsonObject(request);
  const rid = typeof body.reservationId === 'string' && ID_RE.test(body.reservationId) ? body.reservationId : null;
  const sig = isSignature(body.signature) ? (body.signature as string) : null;
  if (!rid || !sig) throw new ApiErr('bad_request', 'Invalid reservationId or signature');
  const r = await ctx.db.prepare('SELECT * FROM launch_reservations WHERE id = ?1').bind(rid).first<ReservationRow>();
  if (!r) throw new ApiErr('not_found', 'Reservation not found');
  const rpc = ctx.rpc(8);
  if (r.status === 'confirmed') {
    const row = await ctx.db.prepare(`SELECT ${COIN_COLUMNS} FROM ${COIN_FROM} WHERE coins.mint = ?1`).bind(r.mint).first<CoinRow>();
    if (row) return json({ status: 'registered', coin: (await freshCoin(ctx, rpc, row, await globalLive(ctx))).dto } satisfies LaunchConfirmResponse, 200);
  }
  // Speed (INTEGRATION §8, confirm ≤ 1.5 s): a `confirmed` getTransaction already proves the landing, so read it and
  // the VaultState in parallel; the signature status is only consulted while the tx is not visible yet.
  const { vaultState } = await placeAddresses(r.place_id, programIdOf(ctx.env));
  const [tx, vs] = await Promise.all([rpc.getTransaction(sig), rpc.getAccount(vaultState)]);
  if (!tx || !tx.meta) {
    const st = await rpc.getSignatureStatus(sig);
    if (st?.err) return failed(ctx, r, st.err);
    return json({ status: 'pending' } satisfies LaunchConfirmResponse, 202);
  }
  if (tx.meta.err) return failed(ctx, r, tx.meta.err);
  const out = await registerFromSignature(ctx, rpc, r, sig, { tx, vaultState: vs });
  if (out === 'pending') return json({ status: 'pending' } satisfies LaunchConfirmResponse, 202);
  return json({ status: 'registered', coin: out } satisfies LaunchConfirmResponse, 200, CACHE.none);
}

async function failed(ctx: Ctx, r: ReservationRow, err: unknown): Promise<Response> {
  await ctx.db.prepare("UPDATE launch_reservations SET status = 'failed', locked_until = NULL WHERE id = ?1 AND status IN ('prepared','cosigned')").bind(r.id).run();
  const m = /"Custom":\s*(\d+)/.exec(JSON.stringify(err));
  const code = m ? Number(m[1]) : null;
  if (code === 110) {
    const taken = await takenError(ctx, r.place_id);
    if (taken) throw taken;
    ctx.waitUntil(adoptFromChain(ctx, r.place_id));
    throw new ApiErr('taken', 'Someone launched this shop first');
  }
  throw new ApiErr('not_confirmed', `The launch transaction failed on Solana${code !== null ? ` (error ${code})` : ''}.`);
}

/**
 * Verifies a landed launch against the reservation and registers it (idempotent). 'pending' when the transaction or
 * the VaultState is not visible yet. Throws not_confirmed when the transaction does not match the reservation.
 */
export async function registerFromSignature(
  ctx: Ctx,
  rpc: Rpc,
  r: ReservationRow,
  sig: string,
  pre?: { tx: RpcTransaction | null; vaultState: AccountRaw | null },
): Promise<import('./wire').CoinDTO | 'pending'> {
  const tx: RpcTransaction | null = pre ? pre.tx : await rpc.getTransaction(sig);
  if (!tx || !tx.meta) return 'pending';
  if (tx.meta.err) throw new ApiErr('not_confirmed', 'The launch transaction failed on Solana.');
  const programId = programIdOf(ctx.env);
  const addrs = await launchAddresses(fromHex(r.place_hash), r.launcher, r.mint, programId);
  const keys = txAccountKeys(tx);
  const signers = tx.transaction.message.accountKeys.slice(0, tx.transaction.message.header.numRequiredSignatures);
  const attestor = await attestorPubkey(ctx.env);
  if (!keys.includes(r.mint) || !keys.includes(addrs.vaultState) || signers[0] !== r.launcher || !attestor || !signers.includes(attestor)) {
    throw new ApiErr('not_confirmed', 'That transaction is not this launch.');
  }
  // the prefetched VaultState may predate the tx's visibility by a slot: read again only when it is missing
  const vs = pre?.vaultState && pre.vaultState.data.length ? pre.vaultState : await rpc.getAccount(addrs.vaultState);
  if (!vs || !vs.data.length) return 'pending';
  const state = decodeVaultState(vs.data);
  if (state.mint !== r.mint || state.launcher !== r.launcher || state.placeHash !== r.place_hash) {
    throw new ApiErr('not_confirmed', 'The registered coin does not match this launch.');
  }
  const meta = await ctx.db.prepare('SELECT * FROM metadata WHERE id = ?1').bind(r.metadata_id).first<MetadataRow>();
  if (!meta) throw new ApiErr('unavailable', 'Metadata missing');
  const now = ctx.deps.now();
  const createdAt = (tx.blockTime ?? Math.floor(now / 1000)) * 1000;
  const hasCoords = r.lat !== null && r.lng !== null;
  const g = await globalLive(ctx);
  const stmts: D1PreparedStatement[] = [
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO coins(place_id, place_hash, mint, vault, vault_state, bonding_curve, ticker, name, description, category, emoji, bg,
           image_id, metadata_id, launcher, created_at, launch_sig, launch_slot, cluster, lat, lng, coords_expire_at, status, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, 'live', ?23)`,
      )
      .bind(
        r.place_id,
        r.place_hash,
        r.mint,
        addrs.vault,
        addrs.vaultState,
        addrs.bondingCurve,
        meta.symbol,
        meta.name,
        meta.description,
        r.category,
        r.emoji,
        r.bg,
        meta.image_id,
        meta.id,
        r.launcher,
        createdAt,
        sig,
        tx.slot,
        ctx.cluster,
        hasCoords ? r.lat : null,
        hasCoords ? r.lng : null,
        hasCoords ? now + COORDS_TTL_MS : null,
        now,
      ),
    ctx.db.prepare('UPDATE metadata SET used_by_mint = ?2 WHERE id = ?1 AND used_by_mint IS NULL').bind(meta.id, r.mint),
    ctx.db.prepare("UPDATE launch_reservations SET status = 'confirmed', signature = ?2, locked_until = NULL WHERE id = ?1").bind(r.id, sig),
    // the launch tx is the curve's first signature: start the trade cursor there
    ctx.db
      .prepare('INSERT INTO indexer_cursors(account, last_sig, last_slot, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(account) DO NOTHING')
      .bind(addrs.bondingCurve, sig, tx.slot, now),
  ];
  // coin row first, then the dev-buy trade events of this very tx (same batch, after the insert)
  await ctx.db.batch(stmts);
  await ingestTransactions(ctx, [{ sig, tx }], g);
  const row = await ctx.db.prepare(`SELECT ${COIN_COLUMNS} FROM ${COIN_FROM} WHERE coins.mint = ?1`).bind(r.mint).first<CoinRow>();
  if (!row) throw new ApiErr('unavailable', 'Registration failed');
  if (row.place_id !== r.place_id) throw new ApiErr('taken', 'Someone launched this shop first');
  const fresh = await freshCoin(ctx, rpc, row, g);
  ctx.waitUntil(ctx.db.batch(fresh.stmts).catch(() => undefined));
  ctx.log.info('launch.registered', { mint: r.mint, placeHash: r.place_hash });
  return fresh.dto;
}

/* ========================================================================================= reconciliation */

/** Cron: co-signed reservations stuck > 30 s are checked against chain; stale ones expire (§3.4). */
export async function reconcileReservations(ctx: Ctx, rpc: Rpc): Promise<string> {
  const now = ctx.deps.now();
  await ctx.db
    .prepare("UPDATE launch_reservations SET status = 'expired' WHERE status = 'prepared' AND expires_at < ?1")
    .bind(now)
    .run();
  const rows = (
    await ctx.db
      .prepare("SELECT * FROM launch_reservations WHERE status = 'cosigned' AND locked_until < ?1 ORDER BY locked_until ASC LIMIT 5")
      .bind(now + LOCK_MS - 30_000)
      .all<ReservationRow>()
  ).results;
  let registered = 0;
  let expired = 0;
  for (const r of rows) {
    if (rpc.remaining < 4) break;
    const { vaultState } = await placeAddresses(r.place_id, programIdOf(ctx.env));
    const acc = await rpc.getAccount(vaultState);
    if (acc && acc.data.length) {
      const st = decodeVaultState(acc.data);
      if (st.mint === r.mint) {
        const sigs = await rpc.getSignaturesForAddress(vaultState, { limit: 25 });
        const first = sigs.filter((s) => !s.err).pop();
        if (first) {
          try {
            const out = await registerFromSignature(ctx, rpc, r, first.signature);
            if (out !== 'pending') registered++;
          } catch (e) {
            ctx.log.warn('reconcile.failed', { reservation: r.id, error: e instanceof Error ? e.message : 'error' });
          }
        }
        continue;
      }
      await ctx.db.prepare("UPDATE launch_reservations SET status = 'failed', locked_until = NULL WHERE id = ?1").bind(r.id).run();
      continue;
    }
    if ((r.locked_until ?? 0) < now) {
      await ctx.db.prepare("UPDATE launch_reservations SET status = 'expired', locked_until = NULL WHERE id = ?1 AND status = 'cosigned'").bind(r.id).run();
      expired++;
    }
  }
  return `${registered} registered, ${expired} expired`;
}
