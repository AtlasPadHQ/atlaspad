/**
 * One-shot fresh chain read of a coin (INTEGRATION §3.2 `fresh=1`, launch confirm): curve (or pool), vault, vault
 * state, pump creator vault, vault WSOL ATA (+ AMM creator WSOL vault) in ONE getMultipleAccounts, recomputing the
 * market, fees and owner exactly, plus the D1 write-back statements.
 */
import { decodePumpPool } from '../src/chain/curve';
import { coinDTO, curveUpdateStmt, feesDTO, marketFromCurve, marketFromPool, ownerFromState, parseVaultSweep, poolUpdateStmt, vaultSweepKeys, vaultUpdateStmt, type CoinRow } from './coins';
import { rentMins, tokenAccount, type PumpGlobalView } from './chainState';
import type { Ctx } from './ctx';
import type { Rpc } from './solana';
import type { CoinDTO, MarketDTO } from './wire';

export interface FreshResult {
  dto: CoinDTO;
  stmts: D1PreparedStatement[];
  slot: number;
}

export async function freshCoin(ctx: Ctx, rpc: Rpc, row: CoinRow, g: PumpGlobalView): Promise<FreshResult> {
  const now = ctx.deps.now();
  const keys = await vaultSweepKeys(row);
  const nSweep = keys.length;
  if (row.graduated && row.pool && row.pool_base_vault && row.pool_quote_vault) keys.push(row.pool, row.pool_base_vault, row.pool_quote_vault);
  const [{ slot, accounts }, rent] = await Promise.all([rpc.getMultipleAccounts(keys), rentMins(rpc)]);
  const sweep = parseVaultSweep(accounts.slice(0, nSweep), !!row.graduated, rent, row.vault);
  const stmts: D1PreparedStatement[] = [vaultUpdateStmt(ctx.db, row.mint, sweep, now)];
  let market: MarketDTO | undefined;
  if (row.graduated && row.pool) {
    const [poolAcc, baseAcc, quoteAcc] = accounts.slice(nSweep);
    const base = baseAcc ? tokenAccount(baseAcc.data)?.amount : undefined;
    const quote = quoteAcc ? tokenAccount(quoteAcc.data)?.amount : undefined;
    if (poolAcc && base !== undefined && quote !== undefined) {
      let vq = 0n;
      try {
        vq = decodePumpPool(poolAcc.data).virtualQuoteReserves;
      } catch {
        vq = 0n;
      }
      market = marketFromPool(base, quote, vq, BigInt(row.supply ?? Number(g.tokenTotalSupply)), slot, now, row);
      stmts.push(poolUpdateStmt(ctx.db, row.mint, market, now));
    }
  } else if (sweep.curve) {
    market = marketFromCurve(sweep.curve, g, slot, now, row);
    stmts.push(curveUpdateStmt(ctx.db, row.mint, sweep.curve, g, slot, now));
  }
  const dto = coinDTO(row, ctx.origin, g, now, {
    ...(market ? { market } : {}),
    fees: feesDTO(sweep.fees, now),
    ...(sweep.state ? { owner: ownerFromState(sweep.state) } : {}),
  });
  return { dto, stmts, slot };
}
