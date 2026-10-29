/**
 * Compute budgets and priority fees for the vault operations: withdraw, request_claim, finalize_claim and the Worker's
 * fee crank. PURE + WORKER-SAFE: worker/crank.ts imports this file, so it imports nothing and touches no environment.
 *
 * Limits are sized per instruction from measurements, so a routine owner operation is not billed for 250k CU it never
 * uses. Each step is the most CU measured for it × ~1.5, rounded up (find_program_address bump searches make the same
 * instruction vary by a few thousand CU):
 *
 *   step                                    measured                                          budget
 *   ComputeBudget × 2                       150 each                                           300
 *   shop-vault request_claim                1,682 (devnet, every claim so far)                 6,000 (SPEC §9 cap 4k)
 *   shop-vault finalize_claim               849 (devnet)                                       3,000 (SPEC §9 cap 4k)
 *   pump sweep_creator_fee (curve bucket)   devnet 28,589–36,539 · mainnet sim 25,492–31,593   55,000
 *   pump-amm sweep_creator_fee (pool)       mainnet sim 26,459–29,459                          45,000
 *   pump-amm transfer_creator_fees_to_pump  mainnet sim 48,564–59,066                          90,000
 *   pump collect_creator_fee                13,149–17,650                                      27,000
 *   shop-vault unwrap_wsol                  not measured (SPEC §9 cap 10k)                     15,000
 *   shop-vault withdraw                     4,117 (devnet)                                     8,000 (SPEC §9 cap 8k)
 *
 * Devnet figures are the landed shop-vault transactions of 2026-10-08..25; mainnet figures are read-only simulations
 * (sigVerify off, nothing sent) against real pump coins on 2026-10-26.
 *
 * Priority: the cluster price from /api/config (on mainnet the p75 of recent pump-program fees, up to 2,000,000 µL/CU,
 * which is what a trade racing other traders needs). Vault operations race nobody, so their priority is capped at
 * VAULT_PRIORITY_MAX_LAMPORTS per transaction. On devnet (10,000 µL/CU) the cap never binds.
 */

export const CU_STEP = {
  computeBudget: 300,
  requestClaim: 6_000,
  finalizeClaim: 3_000,
  curveSweep: 55_000,
  poolSweep: 45_000,
  ammTransfer: 90_000,
  collect: 27_000,
  unwrapWsol: 15_000,
  withdraw: 8_000,
} as const;

/** Whole-transaction limits for the single-instruction vault operations. */
export const VAULT_CU = {
  requestClaim: CU_STEP.computeBudget + CU_STEP.requestClaim,
  finalizeClaim: CU_STEP.computeBudget + CU_STEP.finalizeClaim,
} as const;

/** The most a vault operation pays in priority fees: 0.00002 SOL (the 0.000005 SOL signature fee comes on top). */
export const VAULT_PRIORITY_MAX_LAMPORTS = 20_000;

/** Which optional steps an owner's collect + withdraw transaction carries (src/chain/vault.ts `withdrawPlan`). */
export interface WithdrawSteps {
  curveSweep: boolean;
  poolSweep: boolean;
  ammTransfer: boolean;
  collect: boolean;
  unwrap: boolean;
}

/** CU limit for a collect + withdraw transaction with exactly these steps (withdraw itself is always there). */
export function withdrawCuLimit(s: WithdrawSteps): number {
  return (
    CU_STEP.computeBudget +
    (s.curveSweep ? CU_STEP.curveSweep : 0) +
    (s.poolSweep ? CU_STEP.poolSweep : 0) +
    (s.ammTransfer ? CU_STEP.ammTransfer : 0) +
    (s.collect ? CU_STEP.collect : 0) +
    (s.unwrap ? CU_STEP.unwrapWsol : 0) +
    CU_STEP.withdraw
  );
}

/** CU limit for the Worker's fee crank: [sweep if the curve bucket > 0] [pump-amm transfer if graduated] collect. */
export function feeCrankCuLimit(s: { curveSweep: boolean; ammTransfer: boolean }): number {
  return CU_STEP.computeBudget + (s.curveSweep ? CU_STEP.curveSweep : 0) + (s.ammTransfer ? CU_STEP.ammTransfer : 0) + CU_STEP.collect;
}

/**
 * The compute-unit price (µL/CU) for a vault operation with this CU limit: the cluster price, capped so the priority
 * fee stays within VAULT_PRIORITY_MAX_LAMPORTS. Never negative; a missing or bad cluster price means no priority.
 */
export function vaultPriorityMicroLamports(cuLimit: number, clusterMicroLamports: number): number {
  const price = Number.isFinite(clusterMicroLamports) && clusterMicroLamports > 0 ? Math.floor(clusterMicroLamports) : 0;
  if (!(cuLimit > 0)) return price;
  return Math.min(price, Math.floor((VAULT_PRIORITY_MAX_LAMPORTS * 1_000_000) / cuLimit));
}

/** The priority fee Solana charges (lamports): ⌈limit × price / 10^6⌉, the same rounding as the runtime. */
export function priorityLamports(cuLimit: number, microLamports: number): bigint {
  return (BigInt(Math.max(0, Math.floor(cuLimit))) * BigInt(Math.max(0, Math.floor(microLamports))) + 999_999n) / 1_000_000n;
}
