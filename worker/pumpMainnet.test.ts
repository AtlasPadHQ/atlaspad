/**
 * The Worker's own pump decoders (indexer events, Global) against TODAY'S MAINNET pump.fun: the read-only capture in
 * src/chain/__fixtures__/mainnet.json (see src/chain/mainnet.test.ts). After the 2026-10-19 pump / pump-amm upgrade
 * trade events end with a new `quote_transfer_fee` u64 and Global is 1,088 bytes; the Worker reads fixed offsets and
 * must still agree with @pump-fun/pump-sdk 3.2.0. The same upgrade gave pump-amm `admin_cto_pool`: the indexer alerts
 * when a registered pool's trade names a coin_creator other than the vault.
 */
import './test/globalsMainnet';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { decodePumpGlobal } from './chainState';
import type { Ctx } from './ctx';
import { decodePumpEvents, type AmmTrade, type CurveTrade } from './events';
import { ingestTransactions } from './indexer';
import type { RpcTransaction } from './solana';
import { FakeD1 } from './test/fakeD1';

const require = createRequire(import.meta.url);
const pump = require('@pump-fun/pump-sdk');
const bs58 = require('bs58').default ?? require('bs58');
const fx = JSON.parse(readFileSync(decodeURIComponent(new URL('../src/chain/__fixtures__/mainnet.json', import.meta.url).pathname), 'utf8')) as {
  global: string;
  txs: { tx: RpcTransaction }[];
  amm: { tx: RpcTransaction; side: 'buy' | 'sell'; pool: string } | null;
};
const big = (v: { toString(): string }) => BigInt(v.toString());
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function sdkBodies(tx: RpcTransaction, disc: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const g of tx.meta?.innerInstructions ?? []) {
    for (const ix of g.instructions) {
      const d: Uint8Array = bs58.decode(ix.data);
      const hex = (a: number, b: number) => Array.from(d.subarray(a, b), (x) => x.toString(16).padStart(2, '0')).join('');
      if (d.length >= 16 && hex(0, 8) === 'e445a52e51cb9a1d' && hex(8, 16) === disc) out.push(d.subarray(16));
    }
  }
  return out;
}

describe('Worker pump decoders vs mainnet (2026-10-26 capture)', () => {
  it('decodePumpGlobal reads the 1,088-byte Global like the SDK', () => {
    const data = b64(fx.global);
    expect(data.length).toBe(1088);
    const mine = decodePumpGlobal(data);
    const sdk = pump.PUMP_SDK.decodeGlobal({ data: Buffer.from(data), owner: pump.PUMP_PROGRAM_ID, lamports: 0, executable: false });
    expect(mine.initialVirtualTokenReserves).toBe(big(sdk.initialVirtualTokenReserves));
    expect(mine.initialVirtualQuoteReserves).toBe(big(sdk.initialVirtualSolReserves));
    expect(mine.initialRealTokenReserves).toBe(big(sdk.initialRealTokenReserves));
    expect(mine.tokenTotalSupply).toBe(big(sdk.tokenTotalSupply));
  });

  it('indexer curve trades (decodePumpEvents) match SDK decodeTradeEventBc on every mainnet trade', () => {
    let n = 0;
    for (const { tx } of fx.txs) {
      const mine = decodePumpEvents(tx).filter((e): e is CurveTrade => e.kind === 'curve');
      const sdk = sdkBodies(tx, 'bddb7fd34ee661ee').map((b) => pump.PUMP_SDK.decodeTradeEventBc(Buffer.from(b)));
      expect(mine.length).toBe(sdk.length);
      mine.forEach((e, i) => {
        const s = sdk[i];
        expect(e.mint).toBe(s.mint.toBase58());
        expect(e.solAmount).toBe(big(s.solAmount));
        expect(e.tokenAmount).toBe(big(s.tokenAmount));
        expect(e.isBuy).toBe(s.isBuy);
        expect(e.user).toBe(s.user.toBase58());
        expect(e.virtualSol).toBe(big(s.virtualSolReserves));
        expect(e.virtualToken).toBe(big(s.virtualTokenReserves));
        expect(e.realToken).toBe(big(s.realTokenReserves));
        expect(e.fee).toBe(big(s.fee));
        expect(e.creator).toBe(s.creator.toBase58());
        expect(e.creatorFee).toBe(big(s.creatorFee));
        n++;
      });
    }
    expect(n).toBeGreaterThanOrEqual(6);
  });

  it.skipIf(!fx.amm)('indexer AMM trades match the SDK on a mainnet PumpSwap trade', () => {
    const a = fx.amm!;
    const mine = decodePumpEvents(a.tx).filter((e): e is AmmTrade => e.kind === 'amm' && e.isBuy === (a.side === 'buy'));
    const sdk = sdkBodies(a.tx, a.side === 'buy' ? '67f4521f2cf57777' : '3e2f370aa503dc2a').map((b) => (a.side === 'buy' ? pump.PUMP_SDK.decodeBuyEventAmm(Buffer.from(b)) : pump.PUMP_SDK.decodeSellEventAmm(Buffer.from(b))));
    expect(mine.length).toBe(sdk.length);
    expect(mine[0]!.baseAmount).toBe(big(a.side === 'buy' ? sdk[0].baseAmountOut : sdk[0].baseAmountIn));
    expect(mine[0]!.pool).toBe(sdk[0].pool.toBase58());
    expect(mine[0]!.coinCreator).toBe(sdk[0].coinCreator.toBase58());
    expect(mine[0]!.coinCreatorFee).toBe(big(sdk[0].coinCreatorFee));
  });
});

describe('indexer: a graduated coin whose pump-amm coin_creator is not its vault (SPEC T13)', () => {
  // pump-amm's admin_cto_pool (new in the 2026-10-19 upgrade, replacing admin_set_coin_creator) can point a pool's
  // creator fees elsewhere, as admin_cto does on the curve: the indexer must raise the same critical alert.
  async function ingestAs(vault: string) {
    const db = new FakeD1();
    const a = fx.amm!;
    const trade = decodePumpEvents(a.tx).find((e): e is AmmTrade => e.kind === 'amm')!;
    db.raw.prepare("INSERT INTO assets(id, content_type, bytes, width, height, created_at) VALUES ('a', 'image/png', x'00', 1, 1, 0)").run();
    db.raw.prepare("INSERT INTO metadata(id, json, name, symbol, description, image_id, place_id, created_at) VALUES ('m', '{}', 'Pool Cafe', 'POOL', '', 'a', 'ChIJpool', 0)").run();
    db.raw
      .prepare(
        `INSERT INTO coins(place_id, place_hash, mint, vault, vault_state, bonding_curve, ticker, name, category, emoji, bg, metadata_id, launcher, created_at, launch_sig, launch_slot, cluster, updated_at, graduated, complete, pool)
         VALUES ('ChIJpool', 'ab', ?, ?, 'vs', 'bc', 'POOL', 'Pool Cafe', 'cafe', '☕', '#000000', 'm', 'l', 0, 'sig', 1, 'mainnet', 0, 1, 1, ?)`,
      )
      .run('PoolCafeMint1111111111111111111111111111111', vault, a.pool);
    const pending: Promise<unknown>[] = [];
    const quiet = () => undefined;
    const ctx = {
      env: {},
      cluster: 'mainnet',
      db: db.asD1(),
      deps: { now: () => Date.UTC(2026, 9, 26, 12), fetch: () => Promise.reject(new Error('no network')) },
      log: { error: quiet, warn: quiet, info: quiet, debug: quiet },
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
    } as unknown as Ctx;
    const written = await ingestTransactions(ctx, [{ sig: 'amm-sig', tx: a.tx }], decodePumpGlobal(b64(fx.global)));
    await Promise.all(pending);
    return { written, coinCreator: trade.coinCreator, alerts: db.raw.prepare("SELECT severity, kind, message FROM alerts WHERE kind = 'creator_changed'").all() as { severity: string; message: string }[] };
  }

  it.skipIf(!fx.amm)('vault = the pool coin_creator: the trade is indexed, no alert', async () => {
    const coinCreator = decodePumpEvents(fx.amm!.tx).find((e): e is AmmTrade => e.kind === 'amm')!.coinCreator;
    const r = await ingestAs(coinCreator);
    expect(r.written).toBeGreaterThanOrEqual(1);
    expect(r.alerts).toEqual([]);
  });

  it.skipIf(!fx.amm)('coin_creator moved away from the vault: critical creator_changed alert', async () => {
    const r = await ingestAs('VauLt1111111111111111111111111111111111111');
    expect(r.written).toBeGreaterThanOrEqual(1);
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]!.severity).toBe('critical');
    expect(r.alerts[0]!.message).toContain(`pump-amm coin_creator ${r.coinCreator} is not the vault`);
  });
});
