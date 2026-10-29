/**
 * Minimal JSON-RPC client for the Worker's `/api/rpc` proxy (INTEGRATION.md §3.6, H3). Light module: no web3.js.
 * The browser never talks to an RPC provider directly; the endpoint is `${location.origin}/api/rpc` unless a Node
 * test/e2e sets another one with `setRpcEndpoint` (devnet only, see __e2e__).
 */
import type { RpcMethod } from '../../worker/wire';
import { RPC_LIMITS } from '../../worker/wire';
import { base58Encode } from './base58';
import type { Holding } from './types';

export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** JSON-RPC error (`code` = JSON-RPC code; -32005 = rate limited; -32099 = network/HTTP failure before a reply). */
export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}
export const RPC_NETWORK_ERROR = -32099;
export const RPC_RATE_LIMITED = -32005;

let endpoint: string | null = null;
let fetchImpl: typeof fetch | null = null;

/** Override the proxy URL (Node tests / e2e only). `null` restores `${origin}/api/rpc`. */
export function setRpcEndpoint(url: string | null, f?: typeof fetch): void {
  endpoint = url;
  fetchImpl = f ?? null;
}

export function rpcEndpoint(): string {
  if (endpoint) return endpoint;
  if (typeof location === 'undefined') throw new Error('rpc endpoint not configured');
  return new URL('/api/rpc', location.origin).href;
}

let nextId = 1;

interface RpcReply {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

async function post(body: unknown, timeoutMs: number): Promise<unknown> {
  const f = fetchImpl ?? fetch;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res: Response;
  try {
    res = await f(rpcEndpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl?.signal,
    });
  } catch (e) {
    throw new RpcError(RPC_NETWORK_ERROR, `network: ${(e as Error)?.name === 'AbortError' ? 'timeout' : 'unreachable'}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res.status === 429) throw new RpcError(RPC_RATE_LIMITED, 'rate limited', undefined, 429);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new RpcError(RPC_NETWORK_ERROR, `network: HTTP ${res.status}`, undefined, res.status);
  }
  if (!res.ok && !(json && typeof json === 'object')) throw new RpcError(RPC_NETWORK_ERROR, `network: HTTP ${res.status}`, undefined, res.status);
  return json;
}

function unwrap<T>(reply: RpcReply | undefined): T {
  if (!reply || typeof reply !== 'object') throw new RpcError(RPC_NETWORK_ERROR, 'network: bad reply');
  if (reply.error) throw new RpcError(Number(reply.error.code ?? -32000), String(reply.error.message ?? 'rpc error'), reply.error.data);
  return reply.result as T;
}

/** One JSON-RPC call. Throws RpcError. */
export async function rpc<T>(method: RpcMethod, params: unknown[] = [], timeoutMs = method === 'sendTransaction' ? 15_000 : 10_000): Promise<T> {
  const id = nextId++;
  const reply = (await post({ jsonrpc: '2.0', id, method, params }, timeoutMs)) as RpcReply;
  return unwrap<T>(reply);
}

export interface RpcCall {
  method: RpcMethod;
  params: unknown[];
}

/**
 * Up to 10 calls in ONE HTTP request (the proxy's batch limit). Each entry is the result or an RpcError (per-call
 * errors do not reject the batch; transport errors do).
 */
export async function rpcBatch(calls: RpcCall[], timeoutMs = 10_000): Promise<unknown[]> {
  if (calls.length === 0) return [];
  if (calls.length > RPC_LIMITS.batchMax) throw new Error(`rpc batch of ${calls.length} > ${RPC_LIMITS.batchMax}`);
  const ids = calls.map(() => nextId++);
  const replies = await post(
    calls.map((c, i) => ({ jsonrpc: '2.0', id: ids[i], method: c.method, params: c.params })),
    timeoutMs,
  );
  if (!Array.isArray(replies)) {
    // A proxy-level error object for the whole batch (e.g. rate limit) → surface it for every call.
    const one = replies as RpcReply;
    const err = one?.error ? new RpcError(Number(one.error.code ?? -32000), String(one.error.message ?? 'rpc error')) : new RpcError(RPC_NETWORK_ERROR, 'network: bad batch reply');
    if (err.code === RPC_RATE_LIMITED) throw err;
    return calls.map(() => err);
  }
  const byId = new Map<unknown, RpcReply>((replies as RpcReply[]).map((r) => [r?.id, r]));
  return ids.map((id) => {
    try {
      return unwrap(byId.get(id));
    } catch (e) {
      return e;
    }
  });
}

/* ------------------------------------------------------------------------------------------------ decoding */

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export interface RawAccount {
  lamports: bigint;
  owner: string;
  data: Uint8Array;
  executable: boolean;
}

export interface WireAccount {
  lamports: number;
  owner: string;
  data: [string, string] | string;
  executable?: boolean;
}

export function decodeWireAccount(a: WireAccount | null | undefined): RawAccount | null {
  if (!a) return null;
  const d = Array.isArray(a.data) ? a.data[0] : a.data;
  return { lamports: BigInt(a.lamports), owner: a.owner, data: b64ToBytes(d ?? ''), executable: !!a.executable };
}

/** `getMultipleAccounts` (base64, confirmed) in chunks of 100 keys; one HTTP request per chunk. */
export async function getMultipleAccountsRaw(keys: string[], commitment: 'processed' | 'confirmed' = 'confirmed'): Promise<(RawAccount | null)[]> {
  const out: (RawAccount | null)[] = [];
  for (let i = 0; i < keys.length; i += RPC_LIMITS.multipleAccountsMax) {
    const chunk = keys.slice(i, i + RPC_LIMITS.multipleAccountsMax);
    const r = await rpc<{ value: (WireAccount | null)[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', commitment }]);
    for (const a of r.value) out.push(decodeWireAccount(a));
  }
  return out;
}

export async function getBalance(address: string): Promise<bigint> {
  const r = await rpc<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
  return BigInt(r.value);
}

const holdingsParams = (owner: string): unknown[] => [owner, { programId: TOKEN_2022_PROGRAM }, { encoding: 'base64', commitment: 'confirmed' }];

function decodeHoldings(r: { value?: { pubkey: string; account: WireAccount }[] }): Holding[] {
  const out: Holding[] = [];
  for (const { pubkey, account } of r.value ?? []) {
    const a = decodeWireAccount(account);
    if (!a || a.data.length < 72) continue;
    const amount = new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength).getBigUint64(64, true);
    if (amount > 0n) out.push({ mint: base58Encode(a.data.subarray(0, 32)), tokenAccount: pubkey, amount });
  }
  return out;
}

/** Every Token-2022 account the owner holds with amount > 0 (mint @0, amount @64, decoded from base64). */
export async function getToken2022Holdings(owner: string): Promise<Holding[]> {
  return decodeHoldings(await rpc<{ value: { pubkey: string; account: WireAccount }[] }>('getTokenAccountsByOwner', holdingsParams(owner)));
}

/**
 * SOL balance + Token-2022 holdings of a wallet in ONE `/api/rpc` request (a batch of two calls, both `confirmed`).
 * Every wallet read uses this (INTEGRATION §8: one trade ≤ 12 `/api/rpc` requests).
 */
export async function getWalletSnapshot(owner: string): Promise<{ lamports: bigint; holdings: Holding[] }> {
  const [bal, toks] = await rpcBatch([
    { method: 'getBalance', params: [owner, { commitment: 'confirmed' }] },
    { method: 'getTokenAccountsByOwner', params: holdingsParams(owner) },
  ]);
  if (bal instanceof Error) throw bal;
  if (toks instanceof Error) throw toks;
  return { lamports: BigInt((bal as { value: number }).value), holdings: decodeHoldings(toks as { value: { pubkey: string; account: WireAccount }[] }) };
}

const rentCache = new Map<number, bigint>();
/** `getMinimumBalanceForRentExemption`, cached forever per size (the proxy caches it too). */
export async function rentExempt(size: number): Promise<bigint> {
  const hit = rentCache.get(size);
  if (hit !== undefined) return hit;
  const v = BigInt(await rpc<number>('getMinimumBalanceForRentExemption', [size]));
  rentCache.set(size, v);
  return v;
}
