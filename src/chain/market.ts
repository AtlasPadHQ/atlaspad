/**
 * Fresh market state for quotes and trade building (INTEGRATION.md §4.3): ONE `getMultipleAccounts` per quote
 * ([curve, curve ATA ×2, + Global + FeeConfig when the 60 s cache is stale]) through `/api/rpc`, decoded with the
 * pump SDK, plus the light rent helpers. Heavy module.
 */
import { PublicKey } from '@solana/web3.js';
import { associatedTokenAddress, bondingCurvePda } from '@cornershop/shop-vault-client';
import { PUMP_FEE_CONFIG, PUMP_GLOBAL, PUMP_PROGRAM, TOKEN_2022, TOKEN_PROGRAM } from './constants';
import { loadPump } from './context';
import { decodeBondingCurve, type CurveState } from './curve';
import { TxFail } from './errors';
import type { CurveSnapshot, PumpOps, SdkFeeConfig, SdkGlobal } from './pumpOps';
import { RPC_LIMITS } from '../../worker/wire';
import { decodeWireAccount, getMultipleAccountsRaw, rpcBatch, type RawAccount, type WireAccount } from './rpc';
import { primeBlockhash, type RecentBlockhash } from './send';

const GLOBALS_TTL_MS = 60_000;
const PUMP_PK = new PublicKey(PUMP_PROGRAM);

let globals: { global: SdkGlobal; feeConfig: SdkFeeConfig; at: number } | null = null;

function decodeGlobals(ops: PumpOps, g: RawAccount | null, f: RawAccount | null): { global: SdkGlobal; feeConfig: SdkFeeConfig } {
  if (!g || !f) throw new TxFail('network', { message: "We couldn't read pump.fun's settings. Try again." });
  return { global: ops.decodeGlobal(g.data, PUMP_PK), feeConfig: ops.decodeFeeConfig(f.data, new PublicKey(f.owner)) };
}

/** pump Global + FeeConfig (cached 60 s). */
export async function pumpGlobals(): Promise<{ global: SdkGlobal; feeConfig: SdkFeeConfig }> {
  const ops = await loadPump();
  if (globals && Date.now() - globals.at < GLOBALS_TTL_MS) return globals;
  const [g, f] = await getMultipleAccountsRaw([PUMP_GLOBAL, PUMP_FEE_CONFIG]);
  globals = { ...decodeGlobals(ops, g, f), at: Date.now() };
  return globals;
}

/**
 * The accounts AND a recent blockhash in ONE `/api/rpc` request (a batch of two calls): a trade built right after this
 * read reuses the blockhash instead of asking for one (INTEGRATION §8: one trade ≤ 12 `/api/rpc` requests).
 */
async function readWithBlockhash(keys: string[]): Promise<(RawAccount | null)[]> {
  if (keys.length > RPC_LIMITS.multipleAccountsMax) return getMultipleAccountsRaw(keys);
  const [accs, bh] = await rpcBatch([
    { method: 'getMultipleAccounts', params: [keys, { encoding: 'base64', commitment: 'confirmed' }] },
    { method: 'getLatestBlockhash', params: [{ commitment: 'confirmed' }] },
  ]);
  if (accs instanceof Error) throw accs;
  if (!(bh instanceof Error)) primeBlockhash((bh as { value: RecentBlockhash }).value);
  return ((accs as { value: (WireAccount | null)[] }).value ?? []).map((a) => decodeWireAccount(a));
}

export interface MarketRead {
  ops: PumpOps;
  snapshot: CurveSnapshot;
  /** Light decode (bigint) of the same account. */
  curve: CurveState;
  /** Extra accounts requested by the caller, in order. */
  extra: (RawAccount | null)[];
  at: number;
}

/** Curve state of `mint` (+ `extra` accounts in the same request). Throws TxFail when the coin has no curve. */
export async function readCurve(mint: string, extra: string[] = []): Promise<MarketRead> {
  const ops = await loadPump();
  const mintPk = new PublicKey(mint);
  const curvePk = bondingCurvePda(mintPk);
  const atas = [TOKEN_2022, TOKEN_PROGRAM].map((p) => associatedTokenAddress(curvePk, mintPk, new PublicKey(p)).toBase58());
  const stale = !globals || Date.now() - globals.at >= GLOBALS_TTL_MS;
  const keys = [curvePk.toBase58(), ...atas, ...(stale ? [PUMP_GLOBAL, PUMP_FEE_CONFIG] : []), ...extra];
  const accs = await readWithBlockhash(keys);
  const curveAcc = accs[0];
  if (!curveAcc || curveAcc.owner !== PUMP_PROGRAM) {
    throw new TxFail('unknown', { message: "We couldn't find this coin's market on Solana.", retryable: true });
  }
  if (stale) globals = { ...decodeGlobals(ops, accs[3], accs[4]), at: Date.now() };
  const ataBal = (a: RawAccount | null) => (a && a.data.length >= 72 ? new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true) : 0n);
  const snapshot: CurveSnapshot = {
    curve: ops.decodeCurve(curveAcc.data, PUMP_PK),
    global: globals!.global,
    feeConfig: globals!.feeConfig,
    curveBaseTokenBalance: ataBal(accs[1]) + ataBal(accs[2]),
  };
  return { ops, snapshot, curve: decodeBondingCurve(curveAcc.data), extra: accs.slice(stale ? 5 : 3), at: Date.now() };
}

/* ------------------------------------------------------------------------------------------ rent */

const rentCache = new Map<number, bigint>();

/** `getMinimumBalanceForRentExemption` for several sizes in ONE HTTP request (misses only), cached forever. */
export async function rentFor(sizes: number[]): Promise<Map<number, bigint>> {
  const missing = [...new Set(sizes)].filter((s) => !rentCache.has(s));
  for (let i = 0; i < missing.length; i += 10) {
    const chunk = missing.slice(i, i + 10);
    const res = await rpcBatch(chunk.map((s) => ({ method: 'getMinimumBalanceForRentExemption' as const, params: [s] })));
    res.forEach((r, j) => {
      if (r instanceof Error) throw r;
      rentCache.set(chunk[j], BigInt(r as number));
    });
  }
  return new Map(sizes.map((s) => [s, rentCache.get(s)!]));
}
