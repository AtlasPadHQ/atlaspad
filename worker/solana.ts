/**
 * Solana JSON-RPC client for the Worker (Alchemy, INTEGRATION.md §1.7).
 *
 * THE ALCHEMY RULE: `rpcUrl(env)` below is the only place that builds the upstream URL, and nothing logs it. Errors
 * thrown from here never contain the URL (fetch failures become a generic `UpstreamError`). Responses are parsed and
 * only `result` / `error` objects travel further.
 */
import { b58encode, fromB64 } from './bytes';
import type { Env } from './env';
import { GENESIS } from './consts';
import { ApiErr } from './http';
import type { Cluster } from './wire';

export interface FetchDep {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
}

/** The ONLY builder of the Alchemy URL. Never log, return or embed its result. */
export function rpcUrl(env: Env, cluster: Cluster): string {
  const key = env.ALCHEMY_API_KEY?.trim();
  if (!key) throw new ApiErr('not_configured', 'RPC is not configured');
  return `https://solana-${cluster}.g.alchemy.com/v2/${encodeURIComponent(key)}`;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 0,
  ) {
    super(message);
  }
}

/** A JSON-RPC error object returned by the node (safe to forward: code + message only). */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export class BudgetExceeded extends Error {
  constructor() {
    super('fetch budget exceeded');
  }
}

export interface RpcRequest {
  method: string;
  params?: unknown[];
}

export interface RawResponse {
  /** Parsed JSON body (single object or array). */
  body: unknown;
  bytes: number;
}

const READ_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 15_000;
const MAX_INTERNAL_RESPONSE = 8_000_000;

/**
 * One RPC client per request or cron run. `budget` caps upstream fetches (cron ≤ 40, on-demand ≤ 10, requests ≤ 30).
 */
export class Rpc {
  fetches = 0;
  constructor(
    private readonly env: Env,
    readonly cluster: Cluster,
    private readonly deps: FetchDep,
    readonly budget = 30,
  ) {}

  get remaining(): number {
    return this.budget - this.fetches;
  }

  /** POSTs a JSON-RPC payload and returns the parsed body. Retries once on 429/5xx for reads. */
  async raw(payload: unknown, opts: { send?: boolean; maxBytes?: number } = {}): Promise<RawResponse> {
    // H1 / §1.7: the first upstream call of every isolate verifies the genesis hash for CLUSTER; on a mismatch every
    // chain route fails closed with 503 chain_mismatch
    if (genesisOk.get(this.cluster) !== true) await this.verifyGenesis();
    const send = !!opts.send;
    const maxBytes = opts.maxBytes ?? MAX_INTERNAL_RESPONSE;
    const body = JSON.stringify(payload);
    for (let attempt = 0; ; attempt++) {
      if (this.fetches >= this.budget) throw new BudgetExceeded();
      this.fetches++;
      let res: Response;
      try {
        res = await this.deps.fetch(rpcUrl(this.env, this.cluster), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body,
          signal: AbortSignal.timeout(send ? SEND_TIMEOUT_MS : READ_TIMEOUT_MS),
        });
      } catch (e) {
        if (e instanceof ApiErr) throw e;
        if (!send && attempt === 0) {
          await sleep(150 + Math.random() * 250);
          continue;
        }
        throw new UpstreamError('rpc unreachable');
      }
      if ((res.status === 429 || res.status >= 500) && !send && attempt === 0) {
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        await sleep(200 + Math.random() * 400);
        continue;
      }
      if (res.status >= 400) {
        // Alchemy answers some JSON-RPC errors with HTTP 4xx (e.g. a method not on the plan): keep those as RPC errors
        if (res.status !== 429 && res.status < 500) {
          try {
            const t = await res.text();
            if (t.length <= 65_536) {
              const j = JSON.parse(t) as unknown;
              const isRpcErr = (x: unknown) => !!x && typeof x === 'object' && 'error' in (x as object);
              if (Array.isArray(j) ? j.every(isRpcErr) : isRpcErr(j)) return { body: j, bytes: t.length };
            }
          } catch {
            /* not JSON */
          }
        } else {
          try {
            await res.body?.cancel();
          } catch {
            /* ignore */
          }
        }
        throw new UpstreamError(res.status === 429 ? 'rpc rate limited' : 'rpc unavailable', res.status);
      }
      const len = Number(res.headers.get('content-length') ?? '0');
      if (len > maxBytes) {
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        throw new UpstreamError('response too large', 413);
      }
      const text = await res.text();
      if (text.length > maxBytes) throw new UpstreamError('response too large', 413);
      try {
        return { body: JSON.parse(text) as unknown, bytes: text.length };
      } catch {
        throw new UpstreamError('rpc returned non-JSON');
      }
    }
  }

  private async verifyGenesis(): Promise<void> {
    if (genesisOk.get(this.cluster) === false) throw new ApiErr('chain_mismatch', 'RPC is on the wrong cluster');
    if (this.fetches >= this.budget) throw new BudgetExceeded();
    this.fetches++;
    let g: unknown;
    try {
      const res = await this.deps.fetch(rpcUrl(this.env, this.cluster), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] }),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      g = res.ok ? ((await res.json()) as { result?: unknown }).result : undefined;
    } catch (e) {
      if (e instanceof ApiErr) throw e;
      g = undefined;
    }
    if (typeof g !== 'string') throw new UpstreamError('rpc unavailable');
    const ok = g === GENESIS[this.cluster];
    genesisOk.set(this.cluster, ok);
    if (!ok) throw new ApiErr('chain_mismatch', 'RPC is on the wrong cluster');
  }

  async call<T>(method: string, params: unknown[] = [], opts: { send?: boolean } = {}): Promise<T> {
    const { body } = await this.raw({ jsonrpc: '2.0', id: 1, method, params }, opts);
    return unwrap<T>(body);
  }

  /** JSON-RPC batch (≤ 10 per call). Each entry resolves to its result or an RpcError. */
  async batch<T>(reqs: RpcRequest[]): Promise<(T | RpcError)[]> {
    const out: (T | RpcError)[] = [];
    for (let i = 0; i < reqs.length; i += 10) {
      const chunk = reqs.slice(i, i + 10);
      if (chunk.length === 1) {
        try {
          out.push(await this.call<T>(chunk[0]!.method, chunk[0]!.params ?? []));
        } catch (e) {
          if (e instanceof RpcError) out.push(e);
          else throw e;
        }
        continue;
      }
      const { body } = await this.raw(chunk.map((r, j) => ({ jsonrpc: '2.0', id: j, method: r.method, params: r.params ?? [] })));
      if (!Array.isArray(body)) throw new UpstreamError('rpc batch returned non-array');
      const byId = new Map<number, unknown>();
      for (const item of body) if (item && typeof item === 'object') byId.set(Number((item as { id?: unknown }).id), item);
      for (let j = 0; j < chunk.length; j++) {
        const item = byId.get(j);
        if (!item) {
          out.push(new RpcError(-32000, 'missing batch response'));
          continue;
        }
        try {
          out.push(unwrap<T>(item));
        } catch (e) {
          if (e instanceof RpcError) out.push(e);
          else throw e;
        }
      }
    }
    return out;
  }

  /* ----------------------------------------------------------------------------------------- typed helpers */

  async getMultipleAccounts(keys: string[], commitment = 'confirmed'): Promise<{ slot: number; accounts: (AccountRaw | null)[] }> {
    const accounts: (AccountRaw | null)[] = [];
    let slot = 0;
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const r = await this.call<{ context: { slot: number }; value: (RpcAccount | null)[] }>('getMultipleAccounts', [
        chunk,
        { encoding: 'base64', commitment },
      ]);
      slot = Math.max(slot, r.context?.slot ?? 0);
      for (const a of r.value ?? []) accounts.push(a ? decodeAccount(a) : null);
    }
    return { slot, accounts };
  }

  async getAccount(key: string, commitment = 'confirmed'): Promise<AccountRaw | null> {
    const r = await this.call<{ value: RpcAccount | null }>('getAccountInfo', [key, { encoding: 'base64', commitment }]);
    return r.value ? decodeAccount(r.value) : null;
  }

  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const hit = blockhashCache;
    const now = this.deps.now();
    if (hit && hit.cluster === this.cluster && now - hit.at < 2_000) return hit.v;
    const r = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    blockhashCache = { cluster: this.cluster, at: now, v: r.value };
    return r.value;
  }

  async getSignatureStatus(sig: string): Promise<SignatureStatus | null> {
    const r = await this.call<{ value: (SignatureStatus | null)[] }>('getSignatureStatuses', [[sig], { searchTransactionHistory: false }]);
    return r.value?.[0] ?? null;
  }

  async getTransaction(sig: string): Promise<RpcTransaction | null> {
    return this.call<RpcTransaction | null>('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  }

  async getTransactions(sigs: string[]): Promise<(RpcTransaction | null)[]> {
    const res = await this.batch<RpcTransaction | null>(
      sigs.map((s) => ({ method: 'getTransaction', params: [s, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }] })),
    );
    return res.map((r) => (r instanceof RpcError ? null : r));
  }

  async getSignaturesForAddress(address: string, opts: { until?: string; before?: string; limit: number }): Promise<SignatureInfo[]> {
    const o: Record<string, unknown> = { limit: opts.limit, commitment: 'confirmed' };
    if (opts.until) o.until = opts.until;
    if (opts.before) o.before = opts.before;
    return (await this.call<SignatureInfo[]>('getSignaturesForAddress', [address, o])) ?? [];
  }

  async getBalance(address: string): Promise<bigint> {
    const r = await this.call<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
    return BigInt(r.value ?? 0);
  }

  /** Fills the rent cache for several sizes with one JSON-RPC batch. */
  async prefetchRent(sizes: number[]): Promise<void> {
    const miss = sizes.filter((n) => !rentCache.has(`${this.cluster}:${n}`));
    if (!miss.length) return;
    const res = await this.batch<number>(miss.map((n) => ({ method: 'getMinimumBalanceForRentExemption', params: [n] })));
    res.forEach((r, i) => {
      if (typeof r === 'number') rentCache.set(`${this.cluster}:${miss[i]}`, BigInt(r));
    });
  }

  async rentMin(size: number): Promise<bigint> {
    const k = `${this.cluster}:${size}`;
    const hit = rentCache.get(k);
    if (hit !== undefined) return hit;
    const v = BigInt(await this.call<number>('getMinimumBalanceForRentExemption', [size]));
    rentCache.set(k, v);
    return v;
  }

  async sendTransaction(txBase64: string): Promise<string> {
    return this.call<string>('sendTransaction', [txBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }], { send: true });
  }

  async simulate(txBase64: string): Promise<{ err: unknown; logs: string[] | null; unitsConsumed?: number }> {
    const r = await this.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>('simulateTransaction', [
      txBase64,
      { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'processed' },
    ]);
    return r.value;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function unwrap<T>(body: unknown): T {
  if (!body || typeof body !== 'object') throw new UpstreamError('rpc returned an invalid body');
  const b = body as { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
  if (b.error) {
    const code = typeof b.error.code === 'number' ? b.error.code : -32000;
    const message = typeof b.error.message === 'string' ? b.error.message.slice(0, 300) : 'rpc error';
    throw new RpcError(code, message, b.error.data);
  }
  if (!('result' in b)) throw new UpstreamError('rpc returned no result');
  return b.result as T;
}

/* ------------------------------------------------------------------------------------------------ types */

export interface RpcAccount {
  lamports: number;
  owner: string;
  data: [string, string] | string;
  executable: boolean;
  space?: number;
}

export interface AccountRaw {
  lamports: bigint;
  owner: string;
  data: Uint8Array;
  executable: boolean;
}

export function decodeAccount(a: RpcAccount): AccountRaw {
  const d = Array.isArray(a.data) ? a.data[0] : a.data;
  return { lamports: BigInt(a.lamports), owner: a.owner, data: d ? fromB64(d) : new Uint8Array(0), executable: !!a.executable };
}

export interface SignatureStatus {
  slot: number;
  confirmations: number | null;
  err: unknown;
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime?: number | null;
}

export interface RpcInnerIx {
  programIdIndex: number;
  accounts: number[];
  data: string;
  stackHeight?: number | null;
}

export interface RpcTransaction {
  slot: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    innerInstructions?: { index: number; instructions: RpcInnerIx[] }[] | null;
    logMessages?: string[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
      instructions: RpcInnerIx[];
      recentBlockhash: string;
      addressTableLookups?: unknown[] | null;
    };
  };
  version?: 'legacy' | 0;
}

/** Static keys followed by loaded writable and readonly keys (runtime account order). */
export function txAccountKeys(tx: RpcTransaction): string[] {
  const keys = [...tx.transaction.message.accountKeys];
  const la = tx.meta?.loadedAddresses;
  if (la) keys.push(...la.writable, ...la.readonly);
  return keys;
}

export function isConfirmed(s: SignatureStatus | null): boolean {
  return !!s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized');
}

/* ------------------------------------------------------------------------------------------ per-isolate caches */

let blockhashCache: { cluster: Cluster; at: number; v: { blockhash: string; lastValidBlockHeight: number } } | null = null;
const rentCache = new Map<string, bigint>();
const genesisOk = new Map<Cluster, boolean>();

/**
 * Genesis check (H1): once per isolate, `getGenesisHash` must equal the expected hash for CLUSTER. Throws
 * `503 chain_mismatch` when it does not (every chain route then fails closed).
 */
export async function ensureGenesis(rpc: Rpc): Promise<void> {
  if (genesisOk.get(rpc.cluster) === true) return;
  try {
    await rpc.call<string>('getGenesisHash'); // raw() runs the genesis check first
  } catch (e) {
    if (e instanceof ApiErr) throw e;
    throw new ApiErr('unavailable', 'The network is not reachable right now');
  }
}

export function genesisStatus(cluster: Cluster): boolean | undefined {
  return genesisOk.get(cluster);
}

/** Test helper. */
export function __resetSolanaCaches(): void {
  blockhashCache = null;
  rentCache.clear();
  genesisOk.clear();
}

/** base58 signature of a serialized transaction (first signature). */
export function firstSignature(tx: Uint8Array): string {
  // shortvec(n) then 64-byte signatures; a launch / claim tx has < 128 signatures, so the prefix is one byte.
  return b58encode(tx.subarray(1, 65));
}
