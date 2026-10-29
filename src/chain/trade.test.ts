/**
 * Quotes == pump SDK on real devnet curve state; the min-out we show == the min-out encoded in the instruction;
 * buy/sell flows (fake RPC + keypair signer): phases, error mapping, wallet tampering, expiry retry.
 */
import { createRequire } from 'node:module';
import { describe, expect, test, vi } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import * as sv from '@cornershop/shop-vault-client';
import BN from 'bn.js';
import type { ConfigResponse } from '../../worker/wire';
import fixture from './__fixtures__/devnet.json';
import { MAX_PRICE_IMPACT_PCT, PUMP_FEE_CONFIG, PUMP_GLOBAL, PUMP_PROGRAM, TOKEN_2022, TOKEN_PROGRAM } from './constants';
import { initChain } from './context';
import { decodeBondingCurve } from './curve';
import { makePumpOps, type PumpSdkModule } from './pumpOps';
import { buy, quoteBuy, quoteSell, sell } from './trade';
import { installFakeRpc, wireAccount, type RpcHandler } from './__e2e__/fakeRpc';
import { keypairSigner } from './__e2e__/helpers';
import { b64ToBytes } from './rpc';
import type { TxProgress, WalletSigner } from './types';

vi.mock('../mode', () => ({ BUILD_CLUSTER: 'devnet', TEST_WALLET_BUILD: false, APP_MODE: 'real', IS_REAL: true, CLUSTER: 'devnet', assertRealMode: () => {} }));

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pumpSdk = require('@pump-fun/pump-sdk') as PumpSdkModule;
const ops = makePumpOps(pumpSdk, BN);
const big = (v: { toString(): string }) => BigInt(v.toString());

const live = fixture.curves.find((c) => decodeBondingCurve(b64ToBytes(c.data)).virtualTokenReserves > 0n && !decodeBondingCurve(b64ToBytes(c.data)).complete)!;
const MINT = live.mint;
const curveKey = sv.bondingCurvePda(new PublicKey(MINT)).toBase58();
const ata22 = sv.associatedTokenAddress(new PublicKey(curveKey), new PublicKey(MINT), new PublicKey(TOKEN_2022)).toBase58();
const ataSpl = sv.associatedTokenAddress(new PublicKey(curveKey), new PublicKey(MINT), new PublicKey(TOKEN_PROGRAM)).toBase58();

function tokenAccount(amount: bigint): Uint8Array {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return d;
}

function marketAccounts(keys: string[]) {
  return keys.map((k) =>
    k === curveKey
      ? wireAccount(b64ToBytes(live.data), PUMP_PROGRAM)
      : k === ata22
        ? wireAccount(tokenAccount(BigInt(live.curveAta ?? '0')), TOKEN_2022)
        : k === ataSpl
          ? null
          : k === PUMP_GLOBAL
            ? wireAccount(b64ToBytes(fixture.global), PUMP_PROGRAM)
            : k === PUMP_FEE_CONFIG
              ? wireAccount(b64ToBytes(fixture.feeConfig), 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ')
              : null,
  );
}

const config = {
  cluster: 'devnet',
  genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  publicOrigin: 'https://cornershop-devnet.tiejiucai.workers.dev',
  attestor: Keypair.generate().publicKey.toBase58(),
  alt: Keypair.generate().publicKey.toBase58(),
  priorityFeeMicroLamports: 10_000,
  maxDevBuyLamports: '1000000000',
  explorer: { tx: 'https://solscan.io/tx/{sig}?cluster=devnet', address: 'https://solscan.io/account/{address}?cluster=devnet', token: 'https://solscan.io/token/{mint}?cluster=devnet' },
} as unknown as ConfigResponse;
initChain(config, { rpcUrl: 'http://fake-rpc.test/', pumpSdk, backend: { indexTx: async () => null } as never });

const sdkState = () => {
  const acc = (b64: string, owner: string) => ({ data: Buffer.from(b64, 'base64'), owner: new PublicKey(owner), lamports: 0, executable: false });
  return {
    global: pumpSdk.PUMP_SDK.decodeGlobal(acc(fixture.global, PUMP_PROGRAM)),
    feeConfig: pumpSdk.PUMP_SDK.decodeFeeConfig(acc(fixture.feeConfig, PUMP_PROGRAM)),
    curve: pumpSdk.PUMP_SDK.decodeBondingCurve(acc(live.data, PUMP_PROGRAM)),
  };
};

/** Default chain behaviour for a successful trade. */
function happyRpc(over: Partial<Record<string, (params: unknown[]) => unknown>> = {}): ReturnType<typeof installFakeRpc> & { sent: VersionedTransaction[] } {
  const sent: VersionedTransaction[] = [];
  const h: RpcHandler = (method, params) => {
    if (over[method]) return over[method]!(params);
    switch (method) {
      case 'getMultipleAccounts':
        return { context: { slot: 1 }, value: marketAccounts(params[0] as string[]) };
      case 'getLatestBlockhash':
        return { context: { slot: 1 }, value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 } };
      case 'simulateTransaction':
        return { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 75_000 } };
      case 'sendTransaction':
        sent.push(VersionedTransaction.deserialize(b64ToBytes(params[0] as string)));
        return 'sig';
      case 'getSignatureStatuses':
        return { context: { slot: 2 }, value: [{ slot: 2, err: null, confirmationStatus: 'confirmed' }] };
      case 'getBlockHeight':
        return 900;
      case 'getTransaction':
        return null;
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return { ...installFakeRpc(h), sent };
}

describe('quotes == pump SDK on a real devnet curve', () => {
  test.each([1_000_000n, 50_000_000n, 250_000_000n])('quoteBuy(%s) tokensOut == getBuyV3TokenAmountFromQuoteAmount', async (lamports) => {
    const rpc = happyRpc();
    const q = await quoteBuy(MINT, lamports);
    const s = sdkState();
    const sdkTokens = pumpSdk.getBuyV3TokenAmountFromQuoteAmount({
      global: s.global,
      feeConfig: s.feeConfig,
      mintSupply: s.curve.tokenTotalSupply,
      bondingCurve: s.curve,
      amount: new BN(lamports.toString()),
      curveBaseTokenBalance: new BN(live.curveAta ?? '0'),
    });
    expect(q.tokensOut).toBe(big(sdkTokens));
    expect(q.venue).toBe('curve');
    expect(q.priceAfter).toBeGreaterThan(q.priceBefore);
    expect(q.feeLamports).toBeGreaterThan(0n);
    expect(q.creatorFeeLamports).toBeGreaterThan(0n);
    expect(rpc.httpRequests()).toBeLessThanOrEqual(1); // one getMultipleAccounts per quote
  });

  test('min tokens out shown == min_tokens_out encoded in buy_exact_quote_in_v3 (round down)', async () => {
    happyRpc();
    const q = await quoteBuy(MINT, 100_000_000n, 200);
    expect(q.minTokensOut).toBe(q.tokensOut - (q.tokensOut * 20n) / 1000n);
    const s = sdkState();
    const ixs = await ops.buyIxs({
      s: { ...s, curveBaseTokenBalance: BigInt(live.curveAta ?? '0') },
      mint: new PublicKey(MINT),
      user: Keypair.generate().publicKey,
      tokensOut: q.tokensOut,
      lamportsIn: q.lamportsIn,
      slippageBps: q.slippageBps,
      tokenProgram: new PublicKey(TOKEN_2022),
      buybackFeeRecipient: new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD'),
    });
    const data = ixs[ixs.length - 1].data;
    expect(Buffer.from(data.subarray(0, 8)).toString('hex')).toBe('e1f7501ed5b38488'); // buy_exact_quote_in_v3
    expect(data.readBigUInt64LE(8)).toBe(q.lamportsIn); // spendable_quote_in
    expect(data.readBigUInt64LE(16)).toBe(q.minTokensOut); // min_tokens_out
  });

  test('quoteSell lamportsOut == getSellSolAmountFromTokenAmount; min_sol_output encoded == shown', async () => {
    happyRpc();
    const tokens = 1_234_567_890_123n;
    const q = await quoteSell(MINT, tokens);
    const s = sdkState();
    const sdkOut = pumpSdk.getSellSolAmountFromTokenAmount({ global: s.global, feeConfig: s.feeConfig, mintSupply: s.curve.tokenTotalSupply, bondingCurve: s.curve, amount: new BN(tokens.toString()) });
    expect(q.lamportsOut).toBe(big(sdkOut));
    expect(q.priceAfter).toBeLessThan(q.priceBefore);
    const ixs = await ops.sellIxs({
      s: { ...s, curveBaseTokenBalance: 0n },
      mint: new PublicKey(MINT),
      user: Keypair.generate().publicKey,
      tokensIn: tokens,
      lamportsOut: q.lamportsOut,
      slippageBps: 200,
      tokenProgram: new PublicKey(TOKEN_2022),
      buybackFeeRecipient: new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD'),
    });
    const data = ixs[ixs.length - 1].data;
    expect(data.readBigUInt64LE(8)).toBe(tokens);
    expect(data.readBigUInt64LE(16)).toBe(q.minLamportsOut);
  });
});

describe('buy / sell flows', () => {
  test('buy: phases, one tx, compute budget + pump buy, fill falls back to the quote when the tx is not readable', async () => {
    const rpc = happyRpc();
    const kp = Keypair.generate();
    const q = await quoteBuy(MINT, 50_000_000n);
    const phases: TxProgress[] = [];
    const out = await buy(q, keypairSigner(kp, 'Solflare'), (p) => phases.push(p));
    expect(out.ok).toBe(true);
    expect([...new Set(phases.map((p) => p.phase))]).toEqual(['preparing', 'awaiting-signature', 'sending', 'confirming', 'done']);
    expect(rpc.sent.length).toBe(1);
    const tx = rpc.sent[0];
    const programs = tx.message.compiledInstructions.map((ci) => tx.message.staticAccountKeys[ci.programIdIndex].toBase58());
    expect(programs[0]).toBe('ComputeBudget111111111111111111111111111111');
    expect(programs[programs.length - 1]).toBe(PUMP_PROGRAM);
    expect(tx.message.staticAccountKeys[0].equals(kp.publicKey)).toBe(true);
    if (out.ok) expect(out.value).toMatchObject({ side: 'buy', tokens: q.tokensOut, lamports: q.lamportsIn, estimated: true });
    expect(rpc.httpRequests()).toBeLessThanOrEqual(12);
  });

  test('price impact above MAX_PRICE_IMPACT_PCT is refused before the wallet opens', async () => {
    const rpc = happyRpc();
    const q = await quoteBuy(MINT, 50_000_000n);
    let asked = false;
    const out = await buy({ ...q, priceImpactPct: MAX_PRICE_IMPACT_PCT + 1 }, { ...keypairSigner(Keypair.generate()), signTransaction: async () => ((asked = true), new Uint8Array()) }, () => {});
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatchObject({ code: 'price-impact', sent: false });
    expect(asked).toBe(false);
    expect(rpc.sent.length).toBe(0);
  });

  test('simulation slippage (pump 6042) → "The price moved" before signing', async () => {
    const rpc = happyRpc({ simulateTransaction: () => ({ context: { slot: 1 }, value: { err: { InstructionError: [3, { Custom: 6042 }] }, logs: [] } }) });
    const q = await quoteBuy(MINT, 50_000_000n);
    const out = await buy(q, keypairSigner(Keypair.generate()), () => {});
    expect(!out.ok && out.error.code).toBe('slippage');
    expect(rpc.sent.length).toBe(0);
  });

  test('insufficient SOL in simulation → message with the amount needed', async () => {
    happyRpc({ simulateTransaction: () => ({ context: { slot: 1 }, value: { err: { InstructionError: [3, { Custom: 1 }] }, logs: ['Transfer: insufficient lamports 1, need 50000000'] } }) });
    const q = await quoteBuy(MINT, 50_000_000n);
    const out = await buy(q, keypairSigner(Keypair.generate()), () => {});
    expect(!out.ok && out.error.code).toBe('insufficient-sol');
    if (!out.ok) expect(out.error.message).toBe('Not enough SOL. You need about 0.055 SOL.');
  });

  test('wallet rejection → rejected, nothing sent', async () => {
    const rpc = happyRpc();
    const q = await quoteBuy(MINT, 50_000_000n);
    const signer: WalletSigner = { ...keypairSigner(Keypair.generate(), 'Backpack'), signTransaction: async () => Promise.reject({ code: 4001, message: 'User rejected the request.' }) };
    const out = await buy(q, signer, () => {});
    expect(!out.ok && out.error).toMatchObject({ code: 'rejected', message: 'You cancelled in Backpack.', sent: false });
    expect(rpc.sent.length).toBe(0);
  });

  test('a wallet that changes the message (or signs with another key) is refused before sending', async () => {
    const rpc = happyRpc();
    const kp = Keypair.generate();
    const q = await quoteBuy(MINT, 50_000_000n);
    const tamper: WalletSigner = {
      ...keypairSigner(kp),
      async signTransaction(bytes) {
        const tx = VersionedTransaction.deserialize(bytes);
        tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
        tx.sign([kp]);
        return tx.serialize();
      },
    };
    const out1 = await buy(q, tamper, () => {});
    expect(!out1.ok && out1.error.code).toBe('wallet-modified');
    const wrongKey: WalletSigner = {
      ...keypairSigner(kp),
      async signTransaction(bytes) {
        const tx = VersionedTransaction.deserialize(bytes);
        tx.signatures[0] = new Uint8Array(64).fill(7);
        return tx.serialize();
      },
    };
    const out2 = await buy(q, wrongKey, () => {});
    expect(!out2.ok && out2.error.code).toBe('wallet-modified');
    expect(rpc.sent.length).toBe(0);
  });

  test('blockhash expiry with no status → rebuilt with a fresh blockhash and re-signed (it can never land twice)', async () => {
    let sends = 0;
    let signs = 0;
    const rpc = happyRpc({
      sendTransaction: () => (++sends, 'sig'),
      getSignatureStatuses: () => ({ context: { slot: 2 }, value: [sends >= 2 ? { slot: 3, err: null, confirmationStatus: 'confirmed' } : null] }),
      getBlockHeight: () => (sends >= 2 ? 900 : 1_001),
    });
    const kp = Keypair.generate();
    const q = await quoteBuy(MINT, 50_000_000n);
    const signer: WalletSigner = { ...keypairSigner(kp), signTransaction: (b) => (signs++, keypairSigner(kp).signTransaction(b)) };
    const out = await buy(q, signer, () => {});
    expect(out.ok).toBe(true);
    expect(signs).toBe(2);
    expect(sends).toBeGreaterThanOrEqual(2);
    void rpc;
  }, 20_000);

  test('landed with an error → onchain error with sent: true and an explorer link', async () => {
    happyRpc({
      getSignatureStatuses: () => ({ context: { slot: 2 }, value: [{ slot: 2, err: { InstructionError: [2, { Custom: 6003 }] }, confirmationStatus: 'confirmed' }] }),
    });
    const q = await quoteSell(MINT, 1_000_000n);
    const out = await sell(q, keypairSigner(Keypair.generate()), () => {});
    expect(!out.ok && out.error).toMatchObject({ code: 'slippage', sent: true });
    if (!out.ok) expect(out.error.explorerUrl).toMatch(/solscan\.io\/tx\/.+\?cluster=devnet/);
  });
});
