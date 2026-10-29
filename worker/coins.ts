/**
 * Coin registry rows (D1 `coins`) → wire DTOs, plus the exact market / fee math shared by /api/market, /api/coins,
 * `fresh=1`, the launch confirm path and the indexer. Prices and market caps use src/chain/curve.ts — the same
 * functions the browser uses (INTEGRATION §4.3); fees use SPEC §8.5 and always round DOWN (whole lamports).
 */
import { curvePrice, decodeBondingCurve, decodePumpPool, lamportsPerToken, poolPrice, type CurveState } from '../src/chain/curve';
import { pumpCreatorVaultPda, vaultWsolAta, ammCreatorVaultAta } from './addresses';
import { type PumpGlobalView, decodeVaultState, tokenAccount, type RentMins, type VaultStateView } from './chainState';
import type { AccountRaw } from './solana';
import type { CategoryKey, CoinDTO, Cluster, FeesDTO, MarketDTO, OwnerDTO, TradeDTO } from './wire';

export interface CoinRow {
  place_id: string;
  place_hash: string;
  mint: string;
  vault: string;
  vault_state: string;
  bonding_curve: string;
  ticker: string;
  name: string;
  description: string;
  category: string;
  emoji: string;
  bg: string;
  image_id: string | null;
  image_type?: string | null;
  metadata_id: string;
  launcher: string;
  created_at: number;
  launch_sig: string;
  launch_slot: number;
  cluster: string;
  lat: number | null;
  lng: number | null;
  coords_expire_at: number | null;
  status: string;
  graduated: number;
  pool: string | null;
  pool_base_vault: string | null;
  pool_quote_vault: string | null;
  v_sol: number | null;
  v_tok: number | null;
  real_sol: number | null;
  real_tok: number | null;
  supply: number | null;
  complete: number;
  price_lamports: number | null;
  mcap_lamports: number | null;
  progress_pct: number | null;
  vol24h_lamports: number;
  change24h_pct: number | null;
  last_trade_at: number | null;
  holders: number | null;
  holders_at: number | null;
  fees_earned_lamports: number;
  fees_waiting_lamports: number;
  fees_withdrawable_lamports: number;
  fees_collectable_lamports: number;
  fees_withdrawn_lamports: number;
  owner: string | null;
  pending_owner: string | null;
  unlock_ts: number | null;
  in_probation: number;
  owner_since: number | null;
  claim_nonce: number;
  market_slot: number | null;
  market_at: number | null;
  vault_at: number | null;
  updated_at: number;
}

/** SELECT list for coin rows (with the image content type for the image URL; never the image bytes). */
export const COIN_COLUMNS = 'coins.*, assets.content_type AS image_type';
export const COIN_FROM = 'coins LEFT JOIN assets ON assets.id = coins.image_id';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** Numbers from D1 → decimal u64 strings (all stored values are < 2^53, so exact). */
export const u64s = (n: number | bigint | null | undefined): string => {
  if (n === null || n === undefined) return '0';
  if (typeof n === 'bigint') return (n < 0n ? 0n : n).toString();
  if (!Number.isFinite(n) || n <= 0) return '0';
  return BigInt(Math.floor(n)).toString();
};

/** bigint → number for D1 (throws above 2^53, which no real lamport / token value reaches). */
export function dbInt(v: bigint): number {
  if (v < 0n) return 0;
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('value exceeds 2^53');
  return Number(v);
}

export function initialPriceLamports(g: PumpGlobalView): number {
  return lamportsPerToken(g.initialVirtualQuoteReserves, g.initialVirtualTokenReserves);
}

export function marketFromCurve(c: CurveState, g: PumpGlobalView, slot: number, at: number, row?: Pick<CoinRow, 'vol24h_lamports' | 'change24h_pct' | 'last_trade_at'>): MarketDTO {
  const p = curvePrice(c, g.initialRealTokenReserves);
  return {
    venue: 'curve',
    priceLamports: p.lamportsPerToken,
    mcapLamports: p.mcapLamports.toString(),
    vSol: c.virtualQuoteReserves.toString(),
    vTok: c.virtualTokenReserves.toString(),
    realSol: c.realQuoteReserves.toString(),
    realTok: c.realTokenReserves.toString(),
    supply: c.tokenTotalSupply.toString(),
    progressPct: p.progressPct,
    complete: c.complete,
    vol24hLamports: u64s(row?.vol24h_lamports ?? 0),
    change24hPct: row?.change24h_pct ?? null,
    lastTradeAt: row?.last_trade_at ?? null,
    slot,
    at,
  };
}

export function marketFromPool(
  base: bigint,
  quote: bigint,
  virtualQuote: bigint,
  supply: bigint,
  slot: number,
  at: number,
  row?: Pick<CoinRow, 'vol24h_lamports' | 'change24h_pct' | 'last_trade_at'>,
): MarketDTO {
  const p = poolPrice(base, quote, virtualQuote, supply);
  return {
    venue: 'amm',
    priceLamports: p.lamportsPerToken,
    mcapLamports: p.mcapLamports.toString(),
    vSol: (quote + (virtualQuote > 0n ? virtualQuote : 0n)).toString(),
    vTok: base.toString(),
    realSol: quote.toString(),
    realTok: base.toString(),
    supply: supply.toString(),
    progressPct: 100,
    complete: true,
    vol24hLamports: u64s(row?.vol24h_lamports ?? 0),
    change24hPct: row?.change24h_pct ?? null,
    lastTradeAt: row?.last_trade_at ?? null,
    slot,
    at,
  };
}

/** Market view from the D1 mirror (falls back to the initial curve when the indexer has not read the coin yet). */
export function marketFromRow(r: CoinRow, g: PumpGlobalView, now: number): MarketDTO {
  if (r.v_sol === null || r.v_tok === null) {
    const c: CurveState = {
      virtualTokenReserves: g.initialVirtualTokenReserves,
      virtualQuoteReserves: g.initialVirtualQuoteReserves,
      realTokenReserves: g.initialRealTokenReserves,
      realQuoteReserves: 0n,
      tokenTotalSupply: g.tokenTotalSupply,
      complete: false,
      creator: r.vault,
      isMayhemMode: false,
      isCashbackCoin: false,
      quoteMint: '11111111111111111111111111111111',
      isHolderReward: false,
      creatorFeeBucket: 0n,
    };
    return marketFromCurve(c, g, r.market_slot ?? 0, r.market_at ?? now, r);
  }
  return {
    venue: r.graduated ? 'amm' : 'curve',
    priceLamports: r.price_lamports ?? 0,
    mcapLamports: u64s(r.mcap_lamports),
    vSol: u64s(r.v_sol),
    vTok: u64s(r.v_tok),
    realSol: u64s(r.real_sol),
    realTok: u64s(r.real_tok),
    supply: u64s(r.supply ?? Number(g.tokenTotalSupply)),
    progressPct: r.graduated ? 100 : (r.progress_pct ?? 0),
    complete: !!r.complete || !!r.graduated,
    vol24hLamports: u64s(r.vol24h_lamports),
    change24hPct: r.change24h_pct,
    lastTradeAt: r.last_trade_at,
    slot: r.market_slot ?? 0,
    at: r.market_at ?? now,
  };
}

export function feesFromRow(r: CoinRow): FeesDTO {
  return {
    earnedLamports: u64s(r.fees_earned_lamports),
    waitingLamports: u64s(r.fees_waiting_lamports),
    withdrawableNowLamports: u64s(r.fees_withdrawable_lamports),
    collectableLamports: u64s(r.fees_collectable_lamports),
    withdrawnLamports: u64s(r.fees_withdrawn_lamports),
    at: r.vault_at ?? r.created_at,
  };
}

export function ownerFromRow(r: CoinRow): OwnerDTO {
  return {
    status: r.owner ? 'claimed' : r.pending_owner ? 'pending' : 'unclaimed',
    owner: r.owner,
    pendingOwner: r.pending_owner,
    unlockTs: r.pending_owner ? r.unlock_ts : null,
    inProbation: !!r.in_probation && !!r.pending_owner,
    ownerSince: r.owner_since,
  };
}

export function ownerFromState(s: VaultStateView): OwnerDTO {
  return {
    status: s.owner ? 'claimed' : s.pendingOwner ? 'pending' : 'unclaimed',
    owner: s.owner,
    pendingOwner: s.pendingOwner,
    unlockTs: s.unlockTs,
    inProbation: s.inProbation,
    ownerSince: s.ownerSince,
  };
}

export function coinDTO(r: CoinRow, origin: string, g: PumpGlobalView, now: number, over: { market?: MarketDTO; fees?: FeesDTO; owner?: OwnerDTO } = {}): CoinDTO {
  const ext = r.image_type ? EXT[r.image_type] : undefined;
  const coordsValid = r.lat !== null && r.lng !== null && (r.coords_expire_at === null || r.coords_expire_at > now);
  return {
    placeId: r.place_id,
    placeHash: r.place_hash,
    mint: r.mint,
    vault: r.vault,
    vaultState: r.vault_state,
    bondingCurve: r.bonding_curve,
    ticker: r.ticker,
    name: r.name,
    description: r.description,
    category: r.category as CategoryKey,
    emoji: r.emoji,
    bg: r.bg,
    imageUrl: r.image_id && ext ? `${origin}/img/${r.image_id}.${ext}` : null,
    metadataUri: `${origin}/meta/${r.metadata_id}.json`,
    launcher: r.launcher,
    createdAt: r.created_at,
    launchSig: r.launch_sig,
    location: coordsValid ? { lat: r.lat!, lng: r.lng! } : null,
    graduated: !!r.graduated,
    pool: r.pool,
    market: over.market ?? marketFromRow(r, g, now),
    fees: over.fees ?? feesFromRow(r),
    owner: over.owner ?? ownerFromRow(r),
    holders: r.holders,
    holdersAt: r.holders_at,
  };
}

export interface TradeRow {
  sig: string;
  ix: number;
  mint: string;
  side: 'buy' | 'sell';
  sol_lamports: number;
  tokens: number;
  trader: string;
  price_lamports: number;
  creator_fee_lamports: number;
  venue: 'curve' | 'amm';
  slot: number;
  ts: number;
  /** Trader's paid / received lamports, fees included (NULL until backfilled on old rows). */
  user_lamports?: number | null;
}

export function tradeDTO(t: TradeRow, placeId: string): TradeDTO {
  return {
    id: `${t.sig}:${t.ix}`,
    sig: t.sig,
    mint: t.mint,
    placeId,
    side: t.side,
    solLamports: u64s(t.sol_lamports),
    userLamports: t.user_lamports === null || t.user_lamports === undefined ? null : u64s(t.user_lamports),
    tokens: u64s(t.tokens),
    trader: t.trader,
    priceLamports: t.price_lamports,
    venue: t.venue,
    ts: t.ts,
  };
}

/* ------------------------------------------------------------------------------------------------- fees */

export interface FeeInputs {
  vault: AccountRaw | null;
  vaultState: AccountRaw | null;
  pumpCreatorVault: AccountRaw | null;
  curveBucket: bigint;
  vaultWsol: AccountRaw | null;
  ammCreatorVault: AccountRaw | null;
  /** Graduated coins: pump-amm `Pool.creator_fees` (v2 pool trades) when `Pool.coin_creator` is the vault. */
  poolCreatorFees?: bigint;
}

export interface FeesExact {
  withdrawableNow: bigint;
  collectable: bigint;
  waiting: bigint;
  withdrawn: bigint;
  earned: bigint;
}

/**
 * SPEC §8.5 fees waiting, exact lamports: vault − rent_min(0) + state surplus (withdrawable now) + pump creator vault
 * − rent_min(0) + curve bucket + the vault's WSOL account (all its lamports land in the vault on unwrap) + the AMM
 * coin-creator WSOL vault amount (graduated). Never negative; whole lamports only (round down by construction).
 */
export function computeFees(i: FeeInputs, rent: RentMins, totalWithdrawn: bigint): FeesExact {
  const pos = (x: bigint) => (x > 0n ? x : 0n);
  const withdrawableNow = pos((i.vault?.lamports ?? 0n) - rent.r0) + pos((i.vaultState?.lamports ?? 0n) - rent.rState);
  const ammAmt = i.ammCreatorVault ? (tokenAccount(i.ammCreatorVault.data)?.amount ?? 0n) : 0n;
  const pumpVault = i.pumpCreatorVault?.lamports ?? 0n;
  const collectable = pos(pumpVault - rent.r0) + pos(i.curveBucket) + (i.vaultWsol?.lamports ?? 0n) + ammAmt + pos(i.poolCreatorFees ?? 0n);
  const waiting = withdrawableNow + collectable;
  return { withdrawableNow, collectable, waiting, withdrawn: totalWithdrawn, earned: totalWithdrawn + waiting };
}

export function feesDTO(f: FeesExact, at: number): FeesDTO {
  return {
    earnedLamports: f.earned.toString(),
    waitingLamports: f.waiting.toString(),
    withdrawableNowLamports: f.withdrawableNow.toString(),
    collectableLamports: f.collectable.toString(),
    withdrawnLamports: f.withdrawn.toString(),
    at,
  };
}

/** The accounts a vault sweep reads per coin (order matters: see `parseVaultSweep`). */
export async function vaultSweepKeys(r: Pick<CoinRow, 'vault' | 'vault_state' | 'bonding_curve' | 'graduated'> & { pool?: string | null }): Promise<string[]> {
  const keys = [r.vault, r.vault_state, await pumpCreatorVaultPda(r.vault), r.bonding_curve, await vaultWsolAta(r.vault)];
  if (r.graduated) {
    keys.push(await ammCreatorVaultAta(r.vault));
    // pump-amm Pool: its `creator_fees` bucket (v2 pool trades) is also owed to the shop until swept
    if (r.pool) keys.push(r.pool);
  }
  return keys;
}

export interface VaultSweep {
  state: VaultStateView | null;
  curve: CurveState | null;
  fees: FeesExact;
}

export function parseVaultSweep(accts: (AccountRaw | null)[], graduated: boolean, rent: RentMins, vaultAddress?: string): VaultSweep {
  const [vault, vs, pcv, curveAcc, wsol, amm, poolAcc] = accts;
  let poolCreatorFees = 0n;
  if (graduated && poolAcc && vaultAddress) {
    try {
      const pool = decodePumpPool(poolAcc.data);
      if (pool.coinCreator === vaultAddress) poolCreatorFees = pool.creatorFees;
    } catch {
      poolCreatorFees = 0n;
    }
  }
  let state: VaultStateView | null = null;
  try {
    state = vs ? decodeVaultState(vs.data) : null;
  } catch {
    state = null;
  }
  let curve: CurveState | null = null;
  try {
    curve = curveAcc ? decodeBondingCurve(curveAcc.data) : null;
  } catch {
    curve = null;
  }
  const fees = computeFees(
    {
      vault: vault ?? null,
      vaultState: vs ?? null,
      pumpCreatorVault: pcv ?? null,
      curveBucket: curve?.creatorFeeBucket ?? 0n,
      vaultWsol: wsol ?? null,
      ammCreatorVault: graduated ? (amm ?? null) : null,
      poolCreatorFees,
    },
    rent,
    state?.totalWithdrawn ?? 0n,
  );
  return { state, curve, fees };
}

/*
 * The mirror UPDATEs below write only when a mirrored value moved: D1 bills a rewrite of identical values as rows
 * written (plus one per index on a written column), and the cron reads every hot coin each run (Workers Free: 100,000
 * rows written a day for the whole account). `market_at` / `vault_at` are therefore "last changed", not "last read".
 */

/** UPDATE statement for the vault mirror columns (no write when nothing moved, unless the coin traded since). */
export function vaultUpdateStmt(db: D1Database, mint: string, s: VaultSweep, now: number): D1PreparedStatement {
  const st = s.state;
  return db
    .prepare(
      `UPDATE coins SET fees_earned_lamports = ?2, fees_waiting_lamports = ?3, fees_withdrawable_lamports = ?4,
         fees_collectable_lamports = ?5, fees_withdrawn_lamports = ?6, owner = ?7, pending_owner = ?8, unlock_ts = ?9,
         in_probation = ?10, owner_since = ?11, claim_nonce = ?12, vault_at = ?13, updated_at = ?13
       WHERE mint = ?1 AND (fees_earned_lamports IS NOT ?2 OR fees_waiting_lamports IS NOT ?3 OR fees_withdrawable_lamports IS NOT ?4
         OR fees_collectable_lamports IS NOT ?5 OR fees_withdrawn_lamports IS NOT ?6 OR owner IS NOT ?7 OR pending_owner IS NOT ?8
         OR unlock_ts IS NOT ?9 OR in_probation IS NOT ?10 OR owner_since IS NOT ?11 OR claim_nonce IS NOT ?12
         OR vault_at IS NULL OR last_trade_at > vault_at)`,
    )
    .bind(
      mint,
      dbInt(s.fees.earned),
      dbInt(s.fees.waiting),
      dbInt(s.fees.withdrawableNow),
      dbInt(s.fees.collectable),
      dbInt(s.fees.withdrawn),
      st?.owner ?? null,
      st?.pendingOwner ?? null,
      st?.unlockTs ?? null,
      st?.inProbation ? 1 : 0,
      st?.ownerSince ?? null,
      st ? dbInt(st.claimNonce) : 0,
      now,
    );
}

/**
 * UPDATE statement for the owner mirror columns only, from a VaultState just read from chain (claims: the moment a claim
 * is finalized, so `/api/coins/:mint` never reports a finalized claim as pending until the next vault sweep).
 */
export function ownerUpdateStmt(db: D1Database, placeId: string, st: VaultStateView, now: number): D1PreparedStatement {
  return db
    .prepare(
      'UPDATE coins SET owner = ?2, pending_owner = ?3, unlock_ts = ?4, in_probation = ?5, owner_since = ?6, claim_nonce = ?7, updated_at = ?8 WHERE place_id = ?1',
    )
    .bind(placeId, st.owner ?? null, st.pendingOwner ?? null, st.unlockTs ?? null, st.inProbation ? 1 : 0, st.ownerSince ?? null, dbInt(st.claimNonce), now);
}

/** UPDATE statement for the market mirror columns from a curve read (no write when the market did not move). */
export function curveUpdateStmt(db: D1Database, mint: string, c: CurveState, g: PumpGlobalView, slot: number, now: number): D1PreparedStatement {
  const p = curvePrice(c, g.initialRealTokenReserves);
  return db
    .prepare(
      `UPDATE coins SET v_sol = ?2, v_tok = ?3, real_sol = ?4, real_tok = ?5, supply = ?6, complete = ?7, price_lamports = ?8,
         mcap_lamports = ?9, progress_pct = ?10, market_slot = ?11, market_at = ?12, updated_at = ?12
       WHERE mint = ?1 AND (market_slot IS NULL OR market_slot <= ?11)
         AND (v_sol IS NOT ?2 OR v_tok IS NOT ?3 OR real_sol IS NOT ?4 OR real_tok IS NOT ?5 OR supply IS NOT ?6 OR complete IS NOT ?7
           OR price_lamports IS NOT ?8 OR mcap_lamports IS NOT ?9 OR progress_pct IS NOT ?10)`,
    )
    .bind(
      mint,
      dbInt(c.virtualQuoteReserves),
      dbInt(c.virtualTokenReserves),
      dbInt(c.realQuoteReserves),
      dbInt(c.realTokenReserves),
      dbInt(c.tokenTotalSupply),
      c.complete ? 1 : 0,
      p.lamportsPerToken,
      dbInt(p.mcapLamports),
      p.progressPct,
      slot,
      now,
    );
}

/** UPDATE statement for the market mirror columns from a pool read (no write when the market did not move). */
export function poolUpdateStmt(db: D1Database, mint: string, m: MarketDTO, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE coins SET v_sol = ?2, v_tok = ?3, real_sol = ?4, real_tok = ?5, supply = ?6, complete = 1, price_lamports = ?7,
         mcap_lamports = ?8, progress_pct = 100, market_slot = ?9, market_at = ?10, updated_at = ?10
       WHERE mint = ?1 AND (market_slot IS NULL OR market_slot <= ?9)
         AND (v_sol IS NOT ?2 OR v_tok IS NOT ?3 OR real_sol IS NOT ?4 OR real_tok IS NOT ?5 OR supply IS NOT ?6 OR complete IS NOT 1
           OR price_lamports IS NOT ?7 OR mcap_lamports IS NOT ?8 OR progress_pct IS NOT 100)`,
    )
    .bind(mint, Number(m.vSol), Number(m.vTok), Number(m.realSol), Number(m.realTok), Number(m.supply), m.priceLamports, Number(m.mcapLamports), m.slot, now);
}

export function coinsClusterOk(r: Pick<CoinRow, 'cluster'>, cluster: Cluster): boolean {
  return r.cluster === cluster;
}
