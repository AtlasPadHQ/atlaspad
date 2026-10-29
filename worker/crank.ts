/**
 * The crank key (INTEGRATION §1.6): fee payer for `finalize_claim` and the fee-collect crank only. The only reader of
 * CRANK_SECRET. Every crank transaction is simulated first and never retried blindly (the next cron run re-checks
 * chain state). The crank can never move shop funds anywhere but INTO the vault (SPEC I1/I8): finalize_claim and the
 * pump/pump-amm collection instructions are permissionless. Compute limits and the (capped) priority come from
 * src/chain/budget, the same sizing as the owners' own vault transactions: the crank races nobody.
 */
import { feeCrankCuLimit, VAULT_CU, vaultPriorityMicroLamports } from '../src/chain/budget';
import { b58encode } from './bytes';
import type { Ctx } from './ctx';
import { KeyError, loadSigningKey, type SigningKey } from './keys';
import { collectCreatorFeeIx, finalizeClaimIx, sweepCreatorFeeIx, transferCreatorFeesToPumpIx } from './pumpIx';
import type { Rpc } from './solana';
import { buildSignedTx, setComputeUnitLimit, setComputeUnitPrice, type Instruction } from './txbuild';

export async function crankKey(ctx: Pick<Ctx, 'env'>): Promise<SigningKey | null> {
  try {
    return await loadSigningKey(ctx.env.CRANK_SECRET, 'CRANK_SECRET');
  } catch (e) {
    if (e instanceof KeyError) return null;
    throw e;
  }
}

export interface CrankResult {
  ok: boolean;
  signature?: string;
  error?: string;
}

async function simulateAndSend(rpc: Rpc, key: SigningKey, ixs: Instruction[]): Promise<CrankResult> {
  const { blockhash } = await rpc.getLatestBlockhash();
  const tx = await buildSignedTx(key, ixs, blockhash);
  const sim = await rpc.simulate(tx.base64);
  if (sim.err) return { ok: false, error: `simulation failed: ${JSON.stringify(sim.err).slice(0, 200)}` };
  const signature = await rpc.sendTransaction(tx.base64);
  return { ok: true, signature: signature || b58encode(tx.signature) };
}

/** finalize_claim(place) with the crank as fee payer. */
export async function sendFinalizeClaim(ctx: Pick<Ctx, 'env'>, rpc: Rpc, programId: string, vaultState: string, priorityMicroLamports: number): Promise<CrankResult> {
  const key = await crankKey(ctx);
  if (!key) return { ok: false, error: 'crank key not configured' };
  const limit = VAULT_CU.finalizeClaim;
  return simulateAndSend(rpc, key, [setComputeUnitLimit(limit), setComputeUnitPrice(BigInt(vaultPriorityMicroLamports(limit, priorityMicroLamports))), finalizeClaimIx(programId, vaultState)]);
}

/**
 * Fee crank (SPEC §8.3 without withdraw): [sweep_creator_fee if the curve bucket > 0] [pump-amm
 * transfer_creator_fees_to_pump if graduated] collect_creator_fee(creator = vault). Keeps fees out of pump's reach.
 */
export async function sendFeeCrank(
  ctx: Pick<Ctx, 'env'>,
  rpc: Rpc,
  p: { mint: string; vault: string; curveBucket: bigint; graduated: boolean },
  priorityMicroLamports: number,
): Promise<CrankResult> {
  const key = await crankKey(ctx);
  if (!key) return { ok: false, error: 'crank key not configured' };
  const limit = feeCrankCuLimit({ curveSweep: p.curveBucket > 0n, ammTransfer: p.graduated });
  const ixs: Instruction[] = [setComputeUnitLimit(limit), setComputeUnitPrice(BigInt(vaultPriorityMicroLamports(limit, priorityMicroLamports)))];
  if (p.curveBucket > 0n) ixs.push(await sweepCreatorFeeIx(key.publicKey, p.mint, p.vault));
  if (p.graduated) ixs.push(await transferCreatorFeesToPumpIx(p.vault));
  ixs.push(await collectCreatorFeeIx(p.vault));
  return simulateAndSend(rpc, key, ixs);
}
