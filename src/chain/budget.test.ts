import { describe, expect, test } from 'vitest';
import { CU_STEP, feeCrankCuLimit, priorityLamports, VAULT_CU, VAULT_PRIORITY_MAX_LAMPORTS, vaultPriorityMicroLamports, withdrawCuLimit } from './budget';

const none = { curveSweep: false, poolSweep: false, ammTransfer: false, collect: false, unwrap: false };

describe('vault compute budgets', () => {
  test('every step keeps ≥ 1.4× headroom over the most CU measured for it', () => {
    const measuredMax = { requestClaim: 1_682, finalizeClaim: 849, curveSweep: 36_539, poolSweep: 29_459, ammTransfer: 59_066, collect: 17_650, withdraw: 4_117 };
    for (const [step, max] of Object.entries(measuredMax)) expect(CU_STEP[step as keyof typeof CU_STEP] / max, step).toBeGreaterThanOrEqual(1.4);
    // whole txs (2 compute-budget ixs at 150 CU each): devnet request_claim 1,982 · finalize_claim 1,149
    expect(VAULT_CU.requestClaim).toBe(6_300);
    expect(VAULT_CU.finalizeClaim).toBe(3_300);
    expect(VAULT_CU.requestClaim).toBeLessThanOrEqual(50_000); // Worker claim policy cap
  });

  test('withdraw limit = the steps it carries', () => {
    expect(withdrawCuLimit(none)).toBe(8_300); // withdraw only (fees already in the vault)
    // the usual one: sweep + collect + withdraw (devnet measured 46,156–54,106 CU in total; it used to get 250k)
    expect(withdrawCuLimit({ ...none, curveSweep: true, collect: true })).toBe(90_300);
    // graduated, pool fees: pool sweep + transfer + collect + withdraw (mainnet simulations ≈ 97k–106k in total)
    expect(withdrawCuLimit({ ...none, poolSweep: true, ammTransfer: true, collect: true })).toBe(170_300);
    // everything at once still fits well under the 1.4M runtime ceiling
    expect(withdrawCuLimit({ curveSweep: true, poolSweep: true, ammTransfer: true, collect: true, unwrap: true })).toBe(240_300);
  });

  test('fee crank limit = its steps + collect', () => {
    expect(feeCrankCuLimit({ curveSweep: false, ammTransfer: false })).toBe(27_300);
    expect(feeCrankCuLimit({ curveSweep: true, ammTransfer: false })).toBe(82_300);
    expect(feeCrankCuLimit({ curveSweep: true, ammTransfer: true })).toBe(172_300);
  });
});

describe('vault priority fee', () => {
  test('devnet price (10,000 µL/CU) is never capped', () => {
    for (const cu of [VAULT_CU.finalizeClaim, VAULT_CU.requestClaim, 90_300, 240_300]) expect(vaultPriorityMicroLamports(cu, 10_000)).toBe(10_000);
  });

  test('a sniper-level mainnet price is capped to ≤ 0.00002 SOL of priority per vault tx', () => {
    // pump-program p75 hits the Worker's 2,000,000 µL/CU ceiling on busy days
    for (const cu of [VAULT_CU.finalizeClaim, VAULT_CU.requestClaim, 90_300, 170_300, 240_300]) {
      const price = vaultPriorityMicroLamports(cu, 2_000_000);
      expect(price).toBeLessThanOrEqual(2_000_000);
      expect(priorityLamports(cu, price)).toBeLessThanOrEqual(BigInt(VAULT_PRIORITY_MAX_LAMPORTS));
    }
    expect(vaultPriorityMicroLamports(90_300, 2_000_000)).toBe(221_483);
    // small txs keep the full cluster price: their priority is tiny anyway
    expect(vaultPriorityMicroLamports(VAULT_CU.finalizeClaim, 2_000_000)).toBe(2_000_000);
    expect(priorityLamports(VAULT_CU.finalizeClaim, 2_000_000)).toBe(6_600n);
  });

  test('old vs new cost of a routine withdraw at a 2M µL/CU mainnet price', () => {
    const before = 5_000n + priorityLamports(250_000, 2_000_000); // 250k CU × 2M µL = 0.0005 SOL priority
    const after = 5_000n + priorityLamports(90_300, vaultPriorityMicroLamports(90_300, 2_000_000));
    expect(before).toBe(505_000n);
    expect(after).toBeLessThanOrEqual(25_000n); // ≤ 0.000025 SOL: a fraction of a cent
  });

  test('bad inputs: no priority, never negative', () => {
    expect(vaultPriorityMicroLamports(90_300, Number.NaN)).toBe(0);
    expect(vaultPriorityMicroLamports(90_300, -5)).toBe(0);
    expect(vaultPriorityMicroLamports(0, 10_000)).toBe(10_000);
    expect(priorityLamports(1, 1)).toBe(1n); // rounded up like the runtime
    expect(priorityLamports(30_000, 10_000)).toBe(300n); // the devnet claim fee 10,300 = 2 × 5,000 + 300
  });
});
