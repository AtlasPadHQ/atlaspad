/** Event decoding vs the SDK decoders on real devnet transactions (__fixtures__/devnet.json). */
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import * as sv from '@cornershop/shop-vault-client';
import fixture from './__fixtures__/devnet.json';
import { ammTradeEvents, fillFromTx, lamportDelta, pumpTradeEvents, pumpUserLamports, shopVaultEvents, withdrawnAmount, type TxJson } from './events';

const require = createRequire(import.meta.url);
/* eslint-disable @typescript-eslint/no-require-imports */
const pump = require('@pump-fun/pump-sdk');
const amm = require('@pump-fun/pump-swap-sdk');
const bs58 = require('bs58').default ?? require('bs58');
/* eslint-enable @typescript-eslint/no-require-imports */
const big = (v: { toString(): string }) => BigInt(v.toString());
const TAG = 'e445a52e51cb9a1d';

function sdkEvents(tx: TxJson, disc: string, decode: (b: Buffer) => Record<string, unknown>) {
  const out: Record<string, unknown>[] = [];
  for (const g of tx.meta?.innerInstructions ?? []) {
    for (const ix of g.instructions) {
      const d = Buffer.from(bs58.decode(ix.data));
      if (d.subarray(0, 8).toString('hex') === TAG && d.subarray(8, 16).toString('hex') === disc) out.push(decode(d.subarray(16)));
    }
  }
  return out;
}

const txs = (fixture.txs as unknown as { signature: string; tx: TxJson }[]).map((t) => t.tx);

describe('pump TradeEvent', () => {
  test('every field matches SDK decodeTradeEventBc', () => {
    let n = 0;
    for (const tx of txs) {
      const mine = pumpTradeEvents(tx);
      const sdk = sdkEvents(tx, 'bddb7fd34ee661ee', (b) => pump.PUMP_SDK.decodeTradeEventBc(b));
      expect(mine.length).toBe(sdk.length);
      mine.forEach((e, i) => {
        const s = sdk[i] as Record<string, { toString(): string; toBase58?: () => string }>;
        expect(e.mint).toBe(s.mint.toBase58!());
        expect(e.solAmount).toBe(big(s.solAmount));
        expect(e.tokenAmount).toBe(big(s.tokenAmount));
        expect(e.isBuy).toBe(s.isBuy as unknown as boolean);
        expect(e.user).toBe(s.user.toBase58!());
        expect(e.timestamp).toBe(Number(big(s.timestamp)));
        expect(e.virtualSolReserves).toBe(big(s.virtualSolReserves));
        expect(e.virtualTokenReserves).toBe(big(s.virtualTokenReserves));
        expect(e.realSolReserves).toBe(big(s.realSolReserves));
        expect(e.realTokenReserves).toBe(big(s.realTokenReserves));
        expect(e.feeRecipient).toBe(s.feeRecipient.toBase58!());
        expect(e.fee).toBe(big(s.fee));
        expect(e.creator).toBe(s.creator.toBase58!());
        expect(e.creatorFee).toBe(big(s.creatorFee));
        expect(e.ixName).toBe(s.ixName as unknown as string);
        expect(e.buybackFee).toBe(big(s.buybackFee));
        expect(e.cashback).toBe(big(s.cashback));
        n++;
      });
    }
    expect(n).toBeGreaterThanOrEqual(6);
  });

  test('user lamports (sol ± fee ± creator_fee) == the signer balance change (fee and new-account rent removed)', () => {
    let checked = 0;
    for (const tx of txs) {
      const keys = [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
      for (const e of pumpTradeEvents(tx)) {
        if (keys[0] !== e.user) continue;
        if (keys.some((k, i) => k === e.mint && tx.meta!.preBalances[i] === 0)) continue; // create txs: many accounts
        // Rent of new accounts the trader funded (ATA, volume accumulator). A v2 buy may also create pump's
        // creator_vault: the trader funds only its rent_min(0); the rest of its balance is the creator fee.
        const creatorVault = sv.pumpCreatorVaultPda(new PublicKey(e.creator)).toBase58();
        const createdRent = keys.reduce(
          (s, k, i) => s + (tx.meta!.preBalances[i] === 0 ? (k === creatorVault ? BigInt(fixture.rent0) : BigInt(tx.meta!.postBalances[i])) : 0n),
          0n,
        );
        const delta = lamportDelta(tx, e.user, true)!; // + fee
        const paid = pumpUserLamports(e);
        expect(e.isBuy ? -delta - createdRent : delta).toBe(paid);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  test('fillFromTx returns the exact fill for the trader', () => {
    const tx = txs.find((t) => pumpTradeEvents(t).some((e) => e.isBuy))!;
    const e = pumpTradeEvents(tx).find((x) => x.isBuy)!;
    const fill = fillFromTx(tx, { mint: e.mint, user: e.user, side: 'buy' })!;
    expect(fill.tokens).toBe(e.tokenAmount);
    expect(fill.lamports).toBe(e.solAmount + e.fee + e.creatorFee);
    expect(fill.estimated).toBe(false);
    expect(fillFromTx(tx, { mint: e.mint, user: e.user, side: 'sell' })).toBeNull();
  });
});

describe('pump-amm Buy/Sell events', () => {
  const ammFx = fixture.amm as unknown as { tx: TxJson; side: 'buy' | 'sell' } | null;
  test.skipIf(!ammFx)('decode matches SDK decodeBuyEventAmm / decodeSellEventAmm', () => {
    const tx = ammFx!.tx;
    const mine = ammTradeEvents(tx);
    const disc = ammFx!.side === 'buy' ? '67f4521f2cf57777' : '3e2f370aa503dc2a';
    const sdk = sdkEvents(tx, disc, (b) => (ammFx!.side === 'buy' ? pump.PUMP_SDK.decodeBuyEventAmm(b) : pump.PUMP_SDK.decodeSellEventAmm(b)));
    const sdk2 = sdk.length ? sdk : sdkEvents(tx, disc, (b) => amm.PUMP_AMM_SDK.decodeBuyEvent?.(b) ?? {});
    expect(mine.filter((e) => e.side === ammFx!.side).length).toBe(sdk2.length);
    const e = mine.find((x) => x.side === ammFx!.side)!;
    const s = sdk2[0] as Record<string, { toString(): string; toBase58?: () => string }>;
    expect(e.baseAmount).toBe(big(ammFx!.side === 'buy' ? s.baseAmountOut : s.baseAmountIn));
    expect(e.userQuoteAmount).toBe(big(ammFx!.side === 'buy' ? s.userQuoteAmountIn : s.userQuoteAmountOut));
    expect(e.pool).toBe(s.pool.toBase58!());
    expect(e.user).toBe(s.user.toBase58!());
    expect(e.coinCreator).toBe(s.coinCreator.toBase58!());
    expect(e.coinCreatorFee).toBe(big(s.coinCreatorFee));
    expect(e.lpFee).toBe(big(s.lpFee));
    expect(e.protocolFee).toBe(big(s.protocolFee));
  });
});

describe('shop-vault log events (SPEC §7)', () => {
  const seg = (b: Uint8Array) => Buffer.from(b).toString('base64');
  const u64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return b;
  };
  test('Withdrawn amount is read from the third field', () => {
    const logs = [
      'Program 6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x invoke [1]',
      `Program data: ${seg(Buffer.from('Withdrawn'))} ${seg(new Uint8Array(32).fill(1))} ${seg(new Uint8Array(32).fill(2))} ${seg(u64(253_621n))} ${seg(u64(900_000n))}`,
      'Program 6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x success',
    ];
    expect(shopVaultEvents(logs).map((e) => e.name)).toEqual(['Withdrawn']);
    expect(withdrawnAmount(logs)).toBe(253_621n);
    expect(withdrawnAmount(['Program data: AAAA'])).toBeNull();
    expect(withdrawnAmount(null)).toBeNull();
  });
});
