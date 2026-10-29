import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import * as sv from '@cornershop/shop-vault-client';
import type { ConfigResponse } from '../../worker/wire';
import fixture from './__fixtures__/devnet.json';
import { withdrawCuLimit } from './budget';
import { PUMP_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from './constants';
import { initChain } from './context';
import type { TxJson } from './events';
import type { WalletSigner } from './types';
import { ammCreatorVaultAta, canonicalPoolPda, collectAndWithdraw, collectCreatorFeeIx, getVault, readVault, withdrawInstructions, withdrawOutcome, withdrawPlan } from './vault';
import { installFakeRpc, wireAccount } from './__e2e__/fakeRpc';
import type { PumpSdkModule } from './pumpOps';

vi.mock('../mode', () => ({ BUILD_CLUSTER: 'devnet', TEST_WALLET_BUILD: false, APP_MODE: 'real', IS_REAL: true, CLUSTER: 'devnet', assertRealMode: () => {} }));

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-require-imports */
const pumpSdk = require('@pump-fun/pump-sdk') as PumpSdkModule;
const amm = require('@pump-fun/pump-swap-sdk');
/* eslint-enable @typescript-eslint/no-require-imports */
const RENT_PER_BYTE = BigInt(fixture.rent0) / 128n;
const rent = (size: number) => (BigInt(size) + 128n) * RENT_PER_BYTE;

initChain({ cluster: 'devnet', priorityFeeMicroLamports: 10_000, explorer: {} } as unknown as ConfigResponse, { rpcUrl: 'http://fake-rpc.test/', pumpSdk });

function vaultStateBytes(p: { placeHash: Uint8Array; mint: PublicKey; launcher: PublicKey; owner?: PublicKey; pending?: { owner: PublicKey; unlockTs: bigint }; nonce: bigint; withdrawn: bigint }) {
  const d = new Uint8Array(sv.VAULT_STATE_LEN);
  const v = new DataView(d.buffer);
  d[0] = sv.TAG_VAULT_STATE;
  d[1] = sv.LAYOUT_VERSION;
  d[4] = p.owner ? 1 : 0;
  d[5] = p.pending ? 1 : 0;
  d.set(p.placeHash, 8);
  d.set(p.mint.toBytes(), 40);
  d.set(p.launcher.toBytes(), 72);
  if (p.owner) d.set(p.owner.toBytes(), 104);
  if (p.pending) {
    d.set(p.pending.owner.toBytes(), 136);
    v.setBigInt64(168, p.pending.unlockTs, true);
  }
  v.setBigUint64(176, p.nonce, true);
  v.setBigUint64(184, p.withdrawn, true);
  return d;
}
function curveWithBucket(bucket: bigint, creator: PublicKey): Uint8Array {
  const d = new Uint8Array(166);
  d.set([0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60], 0);
  d.set(creator.toBytes(), 49);
  new DataView(d.buffer).setBigUint64(125, bucket, true);
  return d;
}
function splTokenAccount(mint: string, owner: PublicKey, amount: bigint): Uint8Array {
  const d = new Uint8Array(165);
  d.set(new PublicKey(mint).toBytes(), 0);
  d.set(owner.toBytes(), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = 1;
  d[109] = 1;
  return d;
}

describe('vault reads', () => {
  test('ammCreatorVaultAta == pump-swap-sdk coinCreatorVaultAtaPda(coinCreatorVaultAuthorityPda(creator))', () => {
    for (let i = 0; i < 5; i++) {
      const creator = Keypair.generate().publicKey;
      const sdk = amm.coinCreatorVaultAtaPda(amm.coinCreatorVaultAuthorityPda(creator), new PublicKey(WSOL_MINT), new PublicKey(TOKEN_PROGRAM));
      expect(ammCreatorVaultAta(creator).toBase58()).toBe(sdk.toBase58());
    }
  });

  test('canonicalPoolPda == pump-sdk canonicalPumpPoolPda', () => {
    for (let i = 0; i < 3; i++) {
      const mint = Keypair.generate().publicKey;
      expect(canonicalPoolPda(mint).toBase58()).toBe(pumpSdk.canonicalPumpPoolPda(mint).toBase58());
    }
    expect(canonicalPoolPda(new PublicKey(fixture.amm!.baseMint.address)).toBase58()).toBe(fixture.amm!.pool);
  });

  test('graduated coin: pool creatorFees count as waiting; withdraw = pool sweep → transfer to pump → collect → withdraw', async () => {
    const placeId = 'cornershop-test:vault-graduated';
    const { placeHash, vault, vaultState } = sv.placeAddresses(placeId);
    const mint = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const curve = curveWithBucket(0n, vault);
    curve[48] = 1; // complete
    const pool = new Uint8Array(301);
    pool.set(vault.toBytes(), 211);
    new DataView(pool.buffer).setBigUint64(279, 77_000n, true);
    const accounts: Record<string, ReturnType<typeof wireAccount> | null> = {
      [vaultState.toBase58()]: wireAccount(vaultStateBytes({ placeHash, mint, launcher: mint, owner, nonce: 1n, withdrawn: 0n }), sv.SHOP_VAULT_PROGRAM_ID.toBase58(), rent(208)),
      [vault.toBase58()]: wireAccount(new Uint8Array(0), SYSTEM_PROGRAM, rent(0)),
      [sv.pumpCreatorVaultPda(vault).toBase58()]: wireAccount(new Uint8Array(0), SYSTEM_PROGRAM, rent(0)),
      [sv.bondingCurvePda(mint).toBase58()]: wireAccount(curve, PUMP_PROGRAM),
      [canonicalPoolPda(mint).toBase58()]: wireAccount(pool, 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'),
      [ammCreatorVaultAta(vault).toBase58()]: wireAccount(splTokenAccount(WSOL_MINT, Keypair.generate().publicKey, 3_000n), TOKEN_PROGRAM, rent(165) + 3_000n),
    };
    installFakeRpc((method, params) => {
      if (method === 'getMinimumBalanceForRentExemption') return Number(rent(params[0] as number));
      if (method === 'getMultipleAccounts') return { context: { slot: 1 }, value: (params[0] as string[]).map((k) => accounts[k] ?? null) };
      throw new Error(method);
    });
    const r = await readVault(placeId, mint.toBase58());
    expect(r.graduated).toBe(true);
    expect(r.poolCreatorFees).toBe(77_000n);
    expect(r.view.fees.total).toBe(77_000n + 3_000n);
    expect(r.plan).toEqual({ curveSweep: false, poolSweep: true, ammTransfer: true, collect: true, unwrap: false });
    // 300 + pool sweep 45k + transfer 90k + collect 27k + withdraw 8k = 170,300 CU × 10,000 µL → 1,703 lamports
    expect(r.view.withdrawCostLamports).toBe(5_000n + 1_703n);
    const ixs = await withdrawInstructions(owner, r);
    expect(ixs.map((i) => i.programId.toBase58())).toEqual([
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // sweep_creator_fee (pool bucket → coin creator vault)
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // transfer_creator_fees_to_pump_v2
      PUMP_PROGRAM, // collect_creator_fee → shop vault
      sv.SHOP_VAULT_PROGRAM_ID.toBase58(), // withdraw
    ]);
  });

  test('withdrawPlan: only the steps that move something', () => {
    const r0 = rent(0);
    const base = { curveBucket: 0n, pumpCreatorVaultLamports: 0n, wsolAccount: null, ammVaultAmount: 0n, poolCreatorFees: 0n, graduated: false, mint: Keypair.generate().publicKey };
    expect(withdrawPlan(base, r0)).toEqual({ curveSweep: false, poolSweep: false, ammTransfer: false, collect: false, unwrap: false });
    expect(withdrawPlan({ ...base, pumpCreatorVaultLamports: r0 }, r0).collect).toBe(false);
    expect(withdrawPlan({ ...base, pumpCreatorVaultLamports: r0 + 1n }, r0).collect).toBe(true);
    expect(withdrawPlan({ ...base, curveBucket: 1n }, r0)).toMatchObject({ curveSweep: true, collect: true });
    expect(withdrawPlan({ ...base, curveBucket: 1n, mint: null }, r0)).toMatchObject({ curveSweep: false, collect: false });
    expect(withdrawPlan({ ...base, graduated: true, poolCreatorFees: 5n }, r0)).toEqual({ curveSweep: false, poolSweep: true, ammTransfer: true, collect: true, unwrap: false });
    expect(withdrawPlan({ ...base, ammVaultAmount: 5n }, r0).ammTransfer).toBe(false); // only after graduation
  });

  test('a pool sweep that has to create the AMM creator WSOL vault adds its rent to the withdraw cost', async () => {
    const placeId = 'cornershop-test:vault-graduated-no-ata';
    const { placeHash, vault, vaultState } = sv.placeAddresses(placeId);
    const mint = Keypair.generate().publicKey;
    const curve = curveWithBucket(0n, vault);
    curve[48] = 1; // complete
    const pool = new Uint8Array(301);
    pool.set(vault.toBytes(), 211);
    new DataView(pool.buffer).setBigUint64(279, 77_000n, true);
    const accounts: Record<string, ReturnType<typeof wireAccount> | null> = {
      [vaultState.toBase58()]: wireAccount(vaultStateBytes({ placeHash, mint, launcher: mint, owner: Keypair.generate().publicKey, nonce: 1n, withdrawn: 0n }), sv.SHOP_VAULT_PROGRAM_ID.toBase58(), rent(208)),
      [vault.toBase58()]: wireAccount(new Uint8Array(0), SYSTEM_PROGRAM, rent(0)),
      [sv.pumpCreatorVaultPda(vault).toBase58()]: wireAccount(new Uint8Array(0), SYSTEM_PROGRAM, rent(0)),
      [sv.bondingCurvePda(mint).toBase58()]: wireAccount(curve, PUMP_PROGRAM),
      [canonicalPoolPda(mint).toBase58()]: wireAccount(pool, 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'),
    };
    installFakeRpc((method, params) => {
      if (method === 'getMinimumBalanceForRentExemption') return Number(rent(params[0] as number));
      if (method === 'getMultipleAccounts') return { context: { slot: 1 }, value: (params[0] as string[]).map((k) => accounts[k] ?? null) };
      throw new Error(method);
    });
    const v = await getVault(placeId, mint.toBase58());
    expect(v.fees.total).toBe(77_000n);
    expect(v.withdrawCostLamports).toBe(5_000n + 1_703n + rent(165));
  });

  test('collect_creator_fee instruction == the pump IDL (discriminator + 5 accounts)', () => {
    const creator = Keypair.generate().publicKey;
    const ix = collectCreatorFeeIx(creator);
    const idlPath = join(dirname(require.resolve('@pump-fun/pump-sdk')), '../src/idl/pump.json');
    const idl = JSON.parse(readFileSync(idlPath, 'utf8')) as { instructions: { name: string; discriminator: number[]; accounts: { name: string }[] }[] };
    const c = idl.instructions.find((x) => x.name === 'collect_creator_fee')!;
    expect(Array.from(ix.data)).toEqual(c.discriminator);
    expect(ix.keys.length).toBe(c.accounts.length);
    expect(ix.keys[0].pubkey.equals(creator) && ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.toBase58()).toBe(pumpSdk.creatorVaultPda(creator).toBase58());
  });

  test('getVault: exact fees from vault, state, pump creator_vault, curve bucket, vault WSOL and AMM creator vault', async () => {
    const placeId = 'cornershop-test:vault-unit';
    const { placeHash, vault, vaultState } = sv.placeAddresses(placeId);
    const mint = Keypair.generate().publicKey;
    const pendingOwner = Keypair.generate().publicKey;
    const rent0 = rent(0);
    const rentState = rent(208);
    const accounts: Record<string, ReturnType<typeof wireAccount> | null> = {
      [vaultState.toBase58()]: wireAccount(vaultStateBytes({ placeHash, mint, launcher: Keypair.generate().publicKey, pending: { owner: pendingOwner, unlockTs: 1_800_000_000n }, nonce: 3n, withdrawn: 42n }), sv.SHOP_VAULT_PROGRAM_ID.toBase58(), rentState + 7n),
      [vault.toBase58()]: wireAccount(new Uint8Array(0), SYSTEM_PROGRAM, rent0 + 1_000n),
      [sv.pumpCreatorVaultPda(vault).toBase58()]: wireAccount(new Uint8Array(0), SYSTEM_PROGRAM, rent0 + 20_000n),
      [sv.vaultWsolAta(vault).toBase58()]: wireAccount(splTokenAccount(WSOL_MINT, vault, 300n), TOKEN_PROGRAM, rent(165) + 300n),
      [sv.bondingCurvePda(mint).toBase58()]: wireAccount(curveWithBucket(5_000n, vault), PUMP_PROGRAM),
      [ammCreatorVaultAta(vault).toBase58()]: wireAccount(splTokenAccount(WSOL_MINT, Keypair.generate().publicKey, 400n), TOKEN_PROGRAM, rent(165) + 400n),
    };
    const rpc = installFakeRpc((method, params) => {
      if (method === 'getMinimumBalanceForRentExemption') return Number(rent(params[0] as number));
      if (method === 'getMultipleAccounts') return { context: { slot: 1 }, value: (params[0] as string[]).map((k) => accounts[k] ?? null) };
      throw new Error(method);
    });
    const v = await getVault(placeId, mint.toBase58());
    expect(v.exists).toBe(true);
    expect(v.pendingOwner).toBe(pendingOwner.toBase58());
    expect(v.unlockTs).toBe(1_800_000_000);
    expect(v.claimNonce).toBe(3n);
    expect(v.totalWithdrawn).toBe(42n);
    expect(v.fees.withdrawableNow).toBe(1_000n + 7n);
    // pump creator vault above rent + curve bucket + whole vault WSOL account (closed into the vault) + AMM vault amount
    expect(v.fees.collectable).toBe(20_000n + 5_000n + (rent(165) + 300n) + 400n);
    expect(v.fees.total).toBe(v.fees.withdrawableNow + v.fees.collectable);
    // creator_vault exists → no one-time rent; 1 signature + (300 + sweep 55k + collect 27k + unwrap 15k + withdraw 8k
    // = 105,300 CU) × 10,000 µL (devnet price, under the vault cap) = 1,053 lamports. It was 250k CU × 10,000 µL.
    expect(withdrawCuLimit({ curveSweep: true, poolSweep: false, ammTransfer: false, collect: true, unwrap: true })).toBe(105_300);
    expect(v.withdrawCostLamports).toBe(5_000n + 1_053n);
    expect(rpc.httpRequests()).toBeLessThanOrEqual(2); // accounts + (first time) rent minimums, batched

    // withdraw instructions: sweep (bucket > 0), collect, unwrap (WSOL account), withdraw. AMM transfer only if graduated.
    const r = await readVault(placeId, mint.toBase58());
    const owner = Keypair.generate().publicKey;
    const ixs = await withdrawInstructions(owner, r);
    const programs = ixs.map((i) => i.programId.toBase58());
    expect(programs).toEqual([PUMP_PROGRAM, PUMP_PROGRAM, sv.SHOP_VAULT_PROGRAM_ID.toBase58(), sv.SHOP_VAULT_PROGRAM_ID.toBase58()]);
    expect(ixs[2].data[0]).toBe(sv.Ix.UnwrapWsol);
    expect(ixs[3].data[0]).toBe(sv.Ix.Withdraw);
    expect(ixs[3].keys[0].pubkey.equals(owner) && ixs[3].keys[0].isSigner).toBe(true);
  });

  test('a missing pump creator_vault adds its one-time rent to the withdraw cost', async () => {
    const placeId = 'cornershop-test:vault-unit-2';
    const { placeHash, vault, vaultState } = sv.placeAddresses(placeId);
    const mint = Keypair.generate().publicKey;
    const accounts: Record<string, ReturnType<typeof wireAccount> | null> = {
      [vaultState.toBase58()]: wireAccount(vaultStateBytes({ placeHash, mint, launcher: mint, owner: Keypair.generate().publicKey, nonce: 1n, withdrawn: 0n }), sv.SHOP_VAULT_PROGRAM_ID.toBase58(), rent(208)),
      [vault.toBase58()]: wireAccount(new Uint8Array(0), SYSTEM_PROGRAM, rent(0)),
      [sv.bondingCurvePda(mint).toBase58()]: wireAccount(curveWithBucket(253_621n, vault), PUMP_PROGRAM),
    };
    installFakeRpc((method, params) => {
      if (method === 'getMinimumBalanceForRentExemption') return Number(rent(params[0] as number));
      if (method === 'getMultipleAccounts') return { context: { slot: 1 }, value: (params[0] as string[]).map((k) => accounts[k] ?? null) };
      throw new Error(method);
    });
    const v = await getVault(placeId, mint.toBase58());
    expect(v.fees.total).toBe(253_621n);
    // sweep + collect + withdraw = 90,300 CU → 903 lamports priority, plus the one-time rent_min(0)
    expect(v.withdrawCostLamports).toBe(5_000n + 903n + rent(0));
  });
});

/* ------------------------------------------------------------------------------------------ withdraw safety */

describe('collectAndWithdraw', () => {
  const owner = Keypair.generate();
  const blockhash = Keypair.generate().publicKey.toBase58();

  /** An owned vault whose fees are `bucket` lamports in the curve bucket; pump's creator_vault exists unless `firstSweep`. */
  function ownedVault(placeId: string, bucket: bigint, firstSweep: boolean) {
    const { placeHash, vault, vaultState } = sv.placeAddresses(placeId);
    const mint = Keypair.generate().publicKey;
    const accounts: Record<string, ReturnType<typeof wireAccount> | null> = {
      [vaultState.toBase58()]: wireAccount(vaultStateBytes({ placeHash, mint, launcher: mint, owner: owner.publicKey, nonce: 1n, withdrawn: 0n }), sv.SHOP_VAULT_PROGRAM_ID.toBase58(), rent(208)),
      [vault.toBase58()]: wireAccount(new Uint8Array(0), SYSTEM_PROGRAM, rent(0)),
      [sv.bondingCurvePda(mint).toBase58()]: wireAccount(curveWithBucket(bucket, vault), PUMP_PROGRAM),
      ...(firstSweep ? {} : { [sv.pumpCreatorVaultPda(vault).toBase58()]: wireAccount(new Uint8Array(0), SYSTEM_PROGRAM, rent(0)) }),
    };
    const rpc = installFakeRpc((method, params) => {
      if (method === 'getMinimumBalanceForRentExemption') return Number(rent(params[0] as number));
      if (method === 'getMultipleAccounts') return { context: { slot: 1 }, value: (params[0] as string[]).map((k) => accounts[k] ?? null) };
      if (method === 'getLatestBlockhash') return { context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 1_000 } };
      if (method === 'simulateTransaction') return { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 48_106 } };
      throw new Error(method);
    });
    return { mint: mint.toBase58(), rpc };
  }

  /** A wallet that records what it was asked to sign, then declines (so nothing is ever sent). */
  function decliningSigner() {
    const asked: Uint8Array[] = [];
    const signer: WalletSigner = {
      address: owner.publicKey.toBase58(),
      walletName: 'Test',
      chain: 'solana:devnet',
      signTransaction: async (bytes) => {
        asked.push(bytes);
        throw Object.assign(new Error('User rejected the request.'), { code: 4001, name: 'WalletSignTransactionError' });
      },
    };
    return { signer, asked };
  }

  test('fees below the cost (first sweep pays pump creator_vault rent) → refused before signing, nothing asked', async () => {
    const { mint } = ownedVault('cornershop-test:withdraw-loss', 253_621n, true);
    const { signer, asked } = decliningSigner();
    const out = await collectAndWithdraw('cornershop-test:withdraw-loss', signer, () => {}, mint);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('uneconomic');
    expect(out.error.sent).toBe(false);
    expect(out.error.message).toMatch(/would cost you more than you receive/);
    expect(asked).toHaveLength(0);
  });

  test('worth it → the wallet is asked to sign a tx with the right-sized CU limit and price', async () => {
    const { mint } = ownedVault('cornershop-test:withdraw-ok', 2_000_000n, false);
    const { signer, asked } = decliningSigner();
    const out = await collectAndWithdraw('cornershop-test:withdraw-ok', signer, () => {}, mint);
    expect(!out.ok && out.error.code).toBe('rejected');
    expect(asked).toHaveLength(1);
    const ixs = VersionedTransaction.deserialize(asked[0]!).message.compiledInstructions;
    const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
    // [limit, price, sweep, collect, withdraw]: 300 + 55k + 27k + 8k, devnet price 10,000 µL (under the cap)
    expect(ixs).toHaveLength(5);
    expect(ixs[0]!.data[0]).toBe(2);
    expect(view(ixs[0]!.data).getUint32(1, true)).toBe(90_300);
    expect(ixs[1]!.data[0]).toBe(3);
    expect(view(ixs[1]!.data).getBigUint64(1, true)).toBe(10_000n);
  });

  test('acceptLoss (tests and scripts only) goes on to the wallet', async () => {
    const { mint } = ownedVault('cornershop-test:withdraw-accept', 253_621n, true);
    const { signer, asked } = decliningSigner();
    const out = await collectAndWithdraw('cornershop-test:withdraw-accept', signer, () => {}, mint, { acceptLoss: true });
    expect(!out.ok && out.error.code).toBe('rejected');
    expect(asked).toHaveLength(1);
  });
});

describe('withdrawOutcome', () => {
  const owner = Keypair.generate().publicKey.toBase58();
  const seg = (b: Uint8Array) => Buffer.from(b).toString('base64');
  const u64le = (v: bigint) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    return b;
  };
  const withdrawnLog = (amount: bigint) => `Program data: ${seg(Buffer.from('Withdrawn'))} ${seg(new Uint8Array(32).fill(1))} ${seg(new Uint8Array(32).fill(2))} ${seg(u64le(amount))} ${seg(u64le(amount))}`;
  const tx = (pre: number, post: number, fee: number, logs: string[] | null): TxJson => ({
    meta: { err: null, fee, preBalances: [pre], postBalances: [post], logMessages: logs },
    transaction: { signatures: ['x'], message: { accountKeys: [owner] } },
  });

  test('payout, received and cost (network fee) from the confirmed tx', () => {
    // 0.0063 SOL paid out, 12,000 lamports fee
    expect(withdrawOutcome(tx(1_000_000_000, 1_006_288_000, 12_000, [withdrawnLog(6_300_000n)]), owner)).toEqual({
      lamports: 6_288_000n,
      withdrawnLamports: 6_300_000n,
      feeLamports: 12_000n,
    });
  });

  test('a first withdraw: the cost includes the one-time creator_vault rent; received never goes negative', () => {
    const r = withdrawOutcome(tx(1_000_000_000, 1_000_000_000 + 253_621 - 5_903 - 890_880, 5_903, [withdrawnLog(253_621n)]), owner);
    expect(r.withdrawnLamports).toBe(253_621n);
    expect(r.lamports).toBe(0n);
    expect(r.feeLamports).toBe(5_903n + 890_880n);
  });

  test('no Withdrawn event → the meta fee; unreadable tx → all null', () => {
    expect(withdrawOutcome(tx(100_000, 90_000, 10_000, null), owner)).toEqual({ lamports: 0n, withdrawnLamports: null, feeLamports: 10_000n });
    expect(withdrawOutcome(null, owner)).toEqual({ lamports: null, withdrawnLamports: null, feeLamports: null });
  });
});
