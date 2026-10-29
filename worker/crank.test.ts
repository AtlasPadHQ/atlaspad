/**
 * The crank's transactions are sized like the owners' vault transactions (src/chain/budget): per-step CU limits and a
 * priority capped at 0.00002 SOL, even when the pump-program p75 sits at the 2,000,000 µL/CU ceiling. Fake RPC: the
 * signed tx is decoded, nothing leaves the process.
 */
import './test/globals';
import { describe, expect, it } from 'vitest';
import { feeCrankCuLimit, priorityLamports, VAULT_CU, VAULT_PRIORITY_MAX_LAMPORTS } from '../src/chain/budget';
import { sendFeeCrank, sendFinalizeClaim } from './crank';
import { SHOP_VAULT_PROGRAM_ID } from './consts';
import type { Rpc } from './solana';
import { BLOCKHASH, NodeBuffer, web3 } from './test/launchFixture';
import { decodeTransaction } from './txcodec';

const CRANK = web3.Keypair.generate();
const ctx = { env: { CRANK_SECRET: NodeBuffer.from(CRANK.secretKey).toString('base64') } } as never;
const pk = () => web3.Keypair.generate().publicKey.toBase58();

/** Records what the crank simulated and sent; the simulation always passes. */
function fakeRpc() {
  const sent: string[] = [];
  const rpc = {
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 }),
    simulate: async () => ({ err: null, logs: [], unitsConsumed: 20_000 }),
    sendTransaction: async (b64: string) => {
      sent.push(b64);
      return '';
    },
  } as unknown as Rpc;
  return { rpc, sent };
}

/** [CU limit, CU price] of a sent crank tx. */
function budgetOf(b64: string): { limit: number; price: bigint; ixs: number } {
  const { message } = decodeTransaction(new Uint8Array(NodeBuffer.from(b64, 'base64')));
  const [lim, price] = message.instructions;
  expect(lim!.data[0]).toBe(2);
  expect(price!.data[0]).toBe(3);
  const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
  return { limit: view(lim!.data).getUint32(1, true), price: view(price!.data).getBigUint64(1, true), ixs: message.instructions.length };
}

describe('crank compute budgets', () => {
  it('fee crank: collect only / sweep + collect / sweep + pump-amm transfer + collect', async () => {
    const cases = [
      { curveBucket: 0n, graduated: false, limit: feeCrankCuLimit({ curveSweep: false, ammTransfer: false }), ixs: 3 },
      { curveBucket: 5_000n, graduated: false, limit: feeCrankCuLimit({ curveSweep: true, ammTransfer: false }), ixs: 4 },
      { curveBucket: 5_000n, graduated: true, limit: feeCrankCuLimit({ curveSweep: true, ammTransfer: true }), ixs: 5 },
    ];
    for (const c of cases) {
      const { rpc, sent } = fakeRpc();
      const r = await sendFeeCrank(ctx, rpc, { mint: pk(), vault: pk(), curveBucket: c.curveBucket, graduated: c.graduated }, 10_000);
      expect(r.ok).toBe(true);
      const b = budgetOf(sent[0]!);
      expect(b.ixs).toBe(c.ixs);
      expect(b.limit).toBe(c.limit);
      expect(b.limit).toBeLessThan(200_000); // the old blanket limit
      expect(b.price).toBe(10_000n); // devnet price: under the cap
    }
  });

  it('a sniper-level cluster price is capped: ≤ 0.00002 SOL of priority per crank tx', async () => {
    for (const graduated of [false, true]) {
      const { rpc, sent } = fakeRpc();
      await sendFeeCrank(ctx, rpc, { mint: pk(), vault: pk(), curveBucket: 1n, graduated }, 2_000_000);
      const b = budgetOf(sent[0]!);
      expect(b.price).toBeLessThan(2_000_000n);
      expect(priorityLamports(b.limit, Number(b.price))).toBeLessThanOrEqual(BigInt(VAULT_PRIORITY_MAX_LAMPORTS));
    }
  });

  it('finalize_claim: its own small limit', async () => {
    const { rpc, sent } = fakeRpc();
    const r = await sendFinalizeClaim(ctx, rpc, SHOP_VAULT_PROGRAM_ID, pk(), 2_000_000);
    expect(r.ok).toBe(true);
    const b = budgetOf(sent[0]!);
    expect(b.limit).toBe(VAULT_CU.finalizeClaim);
    expect(priorityLamports(b.limit, Number(b.price))).toBeLessThanOrEqual(BigInt(VAULT_PRIORITY_MAX_LAMPORTS));
  });

  it('a failed simulation sends nothing', async () => {
    const { rpc, sent } = fakeRpc();
    (rpc as unknown as { simulate: () => Promise<unknown> }).simulate = async () => ({ err: { InstructionError: [2, 'ComputationalBudgetExceeded'] }, logs: [] });
    const r = await sendFeeCrank(ctx, rpc, { mint: pk(), vault: pk(), curveBucket: 1n, graduated: true }, 10_000);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/simulation failed/);
    expect(sent).toHaveLength(0);
  });
});
