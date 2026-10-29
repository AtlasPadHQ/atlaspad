/**
 * `POST /api/rpc` — the browser's ONLY path to Solana (INTEGRATION H3, §3.6). JSON-RPC 2.0, single or batch (≤ 10),
 * strict method allowlist (`RPC_METHODS`) and per-method parameter rules, per-IP rate limits (RL_RPC; RL_SEND for
 * send/simulate), short shared caches, 1 MB response cap, and re-serialised responses (`{jsonrpc, id, result|error}`),
 * so nothing from the upstream URL or headers can reach the client. The Alchemy key is never in a response: as a last
 * guard any body containing it is redacted and an alert is raised. A sendTransaction that names a sanctioned wallet is
 * answered RPC_WALLET_BLOCKED and never relayed (worker/sanctions.ts). On mainnet a send or simulation that names none
 * of the app's programs is refused (`namesAppProgram`).
 */
import { b58decodeLen, fromB64 } from './bytes';
import { PUMP_AMM_PROGRAM, PUMP_PROGRAM, SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, TX_MAX_BYTES } from './consts';
import { alert, limit, type Ctx } from './ctx';
import { programIdOf, type Env } from './env';
import { ApiErr, readLimited } from './http';
import { reportSanctioned, sanctionedInTx } from './sanctions';
import { ensureGenesis, RpcError, UpstreamError } from './solana';
import { RPC_LIMITS, RPC_METHODS, RPC_WALLET_BLOCKED, type RpcMethod } from './wire';

type Id = string | number | null;

interface Req {
  jsonrpc: '2.0';
  id: Id;
  method: RpcMethod;
  params: unknown[];
}

type Res = { jsonrpc: '2.0'; id: Id; result: unknown } | { jsonrpc: '2.0'; id: Id; error: { code: number; message: string; data?: unknown } };

class ParamError extends Error {}

const err = (id: Id, code: number, message: string, data?: unknown): Res => ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

/* ------------------------------------------------------------------------------------------- param rules */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const COMMITMENTS = ['processed', 'confirmed', 'finalized'];

function pubkey(v: unknown): void {
  if (b58decodeLen(v, 32) === null) throw new ParamError('invalid public key');
}

function onlyKeys(cfg: unknown, allowed: string[]): Record<string, unknown> {
  if (cfg === undefined || cfg === null) return {};
  if (!isObj(cfg)) throw new ParamError('config must be an object');
  for (const k of Object.keys(cfg)) if (!allowed.includes(k)) throw new ParamError(`config.${k} not allowed`);
  if (cfg.commitment !== undefined && !COMMITMENTS.includes(cfg.commitment as string)) throw new ParamError('invalid commitment');
  if (cfg.preflightCommitment !== undefined && !COMMITMENTS.includes(cfg.preflightCommitment as string)) throw new ParamError('invalid preflightCommitment');
  if (cfg.minContextSlot !== undefined && !(Number.isInteger(cfg.minContextSlot) && (cfg.minContextSlot as number) >= 0)) throw new ParamError('invalid minContextSlot');
  return cfg;
}

function accountEncoding(cfg: Record<string, unknown>): void {
  if (cfg.encoding !== 'base64' && cfg.encoding !== 'jsonParsed') throw new ParamError('encoding must be base64 or jsonParsed');
  if (cfg.dataSlice !== undefined) {
    const d = cfg.dataSlice;
    if (!isObj(d) || !Number.isInteger(d.offset) || !Number.isInteger(d.length) || (d.offset as number) < 0 || (d.length as number) < 0) throw new ParamError('invalid dataSlice');
  }
}

function txBytes(v: unknown): number {
  if (typeof v !== 'string' || v.length > 2_000) throw new ParamError('invalid transaction');
  let b: Uint8Array;
  try {
    b = fromB64(v);
  } catch {
    throw new ParamError('transaction must be base64');
  }
  if (b.length === 0 || b.length > TX_MAX_BYTES) throw new ParamError(`transaction must be 1..${TX_MAX_BYTES} bytes`);
  return b.length;
}

function arity(p: unknown[], min: number, max: number): void {
  if (p.length < min || p.length > max) throw new ParamError('wrong number of params');
}

export function checkParams(method: RpcMethod, p: unknown[]): void {
  switch (method) {
    case 'getAccountInfo': {
      arity(p, 2, 2);
      pubkey(p[0]);
      accountEncoding(onlyKeys(p[1], ['commitment', 'encoding', 'dataSlice', 'minContextSlot']));
      return;
    }
    case 'getMultipleAccounts': {
      arity(p, 2, 2);
      if (!Array.isArray(p[0]) || p[0].length === 0 || p[0].length > RPC_LIMITS.multipleAccountsMax) throw new ParamError(`1..${RPC_LIMITS.multipleAccountsMax} keys`);
      p[0].forEach(pubkey);
      accountEncoding(onlyKeys(p[1], ['commitment', 'encoding', 'dataSlice', 'minContextSlot']));
      return;
    }
    case 'getBalance':
    case 'getTokenAccountBalance':
      arity(p, 1, 2);
      pubkey(p[0]);
      onlyKeys(p[1], ['commitment', 'minContextSlot']);
      return;
    case 'getLatestBlockhash':
    case 'getBlockHeight':
    case 'getSlot':
      arity(p, 0, 1);
      onlyKeys(p[0], ['commitment', 'minContextSlot']);
      return;
    case 'getGenesisHash':
      arity(p, 0, 0);
      return;
    case 'getSignatureStatuses': {
      arity(p, 1, 2);
      if (!Array.isArray(p[0]) || p[0].length === 0 || p[0].length > RPC_LIMITS.signatureStatusesMax) throw new ParamError(`1..${RPC_LIMITS.signatureStatusesMax} signatures`);
      for (const s of p[0]) if (b58decodeLen(s, 64) === null) throw new ParamError('invalid signature');
      const cfg = onlyKeys(p[1], ['searchTransactionHistory']);
      if (cfg.searchTransactionHistory !== undefined && cfg.searchTransactionHistory !== false) throw new ParamError('searchTransactionHistory must be false');
      return;
    }
    case 'getSignaturesForAddress': {
      arity(p, 2, 2);
      pubkey(p[0]);
      const cfg = onlyKeys(p[1], ['limit', 'before', 'until', 'commitment', 'minContextSlot']);
      if (!Number.isInteger(cfg.limit) || (cfg.limit as number) < 1 || (cfg.limit as number) > RPC_LIMITS.signaturesForAddressMax) throw new ParamError(`limit 1..${RPC_LIMITS.signaturesForAddressMax} required`);
      for (const k of ['before', 'until']) if (cfg[k] !== undefined && b58decodeLen(cfg[k], 64) === null) throw new ParamError(`invalid ${k}`);
      return;
    }
    case 'getTransaction': {
      arity(p, 2, 2);
      if (b58decodeLen(p[0], 64) === null) throw new ParamError('invalid signature');
      const cfg = onlyKeys(p[1], ['maxSupportedTransactionVersion', 'encoding', 'commitment']);
      if (cfg.maxSupportedTransactionVersion !== 0) throw new ParamError('maxSupportedTransactionVersion must be 0');
      if (cfg.encoding !== undefined && !['json', 'jsonParsed', 'base64'].includes(cfg.encoding as string)) throw new ParamError('invalid encoding');
      if (cfg.commitment === 'processed') throw new ParamError('commitment processed is not supported');
      return;
    }
    case 'sendTransaction': {
      arity(p, 2, 2);
      txBytes(p[0]);
      const cfg = onlyKeys(p[1], ['encoding', 'skipPreflight', 'preflightCommitment', 'maxRetries', 'minContextSlot']);
      if (cfg.encoding !== 'base64') throw new ParamError("encoding 'base64' required");
      if (cfg.skipPreflight !== undefined && typeof cfg.skipPreflight !== 'boolean') throw new ParamError('invalid skipPreflight');
      if (cfg.maxRetries !== undefined && !(Number.isInteger(cfg.maxRetries) && (cfg.maxRetries as number) >= 0 && (cfg.maxRetries as number) <= 5)) throw new ParamError('maxRetries 0..5');
      return;
    }
    case 'simulateTransaction': {
      arity(p, 2, 2);
      txBytes(p[0]);
      const cfg = onlyKeys(p[1], ['encoding', 'sigVerify', 'replaceRecentBlockhash', 'commitment', 'accounts', 'innerInstructions', 'minContextSlot']);
      if (cfg.encoding !== 'base64') throw new ParamError("encoding 'base64' required");
      for (const k of ['sigVerify', 'replaceRecentBlockhash', 'innerInstructions']) if (cfg[k] !== undefined && typeof cfg[k] !== 'boolean') throw new ParamError(`invalid ${k}`);
      if (cfg.accounts !== undefined) {
        const a = cfg.accounts;
        if (!isObj(a) || !Array.isArray(a.addresses) || a.addresses.length > RPC_LIMITS.simulateAccountsMax) throw new ParamError(`accounts.addresses ≤ ${RPC_LIMITS.simulateAccountsMax}`);
        a.addresses.forEach(pubkey);
        if (a.encoding !== undefined && a.encoding !== 'base64' && a.encoding !== 'jsonParsed') throw new ParamError('invalid accounts.encoding');
        for (const k of Object.keys(a)) if (k !== 'addresses' && k !== 'encoding') throw new ParamError(`accounts.${k} not allowed`);
      }
      return;
    }
    case 'getTokenAccountsByOwner': {
      arity(p, 3, 3);
      pubkey(p[0]);
      const f = p[1];
      if (!isObj(f) || Object.keys(f).length !== 1) throw new ParamError('filter must be {mint} or {programId}');
      if ('mint' in f) pubkey(f.mint);
      else if ('programId' in f) {
        if (f.programId !== SPL_TOKEN_PROGRAM && f.programId !== TOKEN_2022_PROGRAM) throw new ParamError('programId must be SPL Token or Token-2022');
      } else throw new ParamError('filter must be {mint} or {programId}');
      accountEncoding(onlyKeys(p[2], ['commitment', 'encoding', 'dataSlice', 'minContextSlot']));
      return;
    }
    case 'getFeeForMessage': {
      arity(p, 1, 2);
      txBytes(p[0]);
      onlyKeys(p[1], ['commitment', 'minContextSlot']);
      return;
    }
    case 'getMinimumBalanceForRentExemption':
      arity(p, 1, 2);
      if (!Number.isInteger(p[0]) || (p[0] as number) < 0 || (p[0] as number) > 10_485_760) throw new ParamError('invalid size');
      onlyKeys(p[1], ['commitment']);
      return;
  }
}

/* ----------------------------------------------------------------------------------- app transactions */

/**
 * The programs our own transactions invoke: shop-vault (launch, claim request / finalize / cancel, withdraw), pump
 * (launch, curve trades, fee sweep + collect) and pump-amm (graduated trades). Every transaction the app sends invokes
 * at least one of them (src/chain/launch.ts, trade.ts, amm.ts, vault.ts), so pump's fee program is left out.
 */
export function appProgramKeys(env: Env): Uint8Array[] {
  return [programIdOf(env), PUMP_PROGRAM, PUMP_AMM_PROGRAM].map((k) => b58decodeLen(k, 32)).filter((k): k is Uint8Array => k !== null);
}

/**
 * True when a base64 wire transaction contains one of `programs` anywhere in its bytes. The same raw scan as
 * sanctionedInTx (worker/sanctions.ts), no decode: an invoked program is always a static account key (a v0 lookup table
 * cannot supply a program id), so a transaction of ours always passes. It keeps /api/rpc from being a free general
 * Solana RPC on our key; it is not a security boundary (anyone can name a program without calling it). Never throws.
 */
export function namesAppProgram(txBase64: unknown, programs: readonly Uint8Array[]): boolean {
  if (typeof txBase64 !== 'string') return false;
  let b: Uint8Array;
  try {
    b = fromB64(txBase64);
  } catch {
    return false;
  }
  for (let o = 0; o + 32 <= b.length; o++) {
    for (const k of programs) {
      if (b[o] !== k[0]) continue;
      let j = 1;
      while (j < 32 && b[o + j] === k[j]) j++;
      if (j === 32) return true;
    }
  }
  return false;
}

/* --------------------------------------------------------------------------------------------- caches */

const cache = new Map<string, { exp: number; v: unknown }>();
const TTL: Partial<Record<RpcMethod, number>> = {
  getLatestBlockhash: 1_000,
  getBlockHeight: 1_000,
  getGenesisHash: Number.POSITIVE_INFINITY,
  getMinimumBalanceForRentExemption: Number.POSITIVE_INFINITY,
  getAccountInfo: 1_000,
  getMultipleAccounts: 1_000,
};

export function __resetRpcProxyCache(): void {
  cache.clear();
}

/* ---------------------------------------------------------------------------------------------- handler */

function parseReq(v: unknown): Req | Res {
  if (!isObj(v)) return err(null, -32600, 'invalid request');
  const id = v.id;
  const okId = id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
  if (v.jsonrpc !== '2.0' || !okId || (typeof id === 'string' && id.length > 64)) return err(null, -32600, 'invalid request');
  if (typeof v.method !== 'string' || !(RPC_METHODS as readonly string[]).includes(v.method)) return err(id as Id, -32601, 'method not allowed');
  const params = v.params === undefined ? [] : v.params;
  if (!Array.isArray(params)) return err(id as Id, -32602, 'params must be an array');
  try {
    checkParams(v.method as RpcMethod, params);
  } catch (e) {
    return err(id as Id, -32602, e instanceof ParamError ? `invalid params: ${e.message}` : 'invalid params');
  }
  return { jsonrpc: '2.0', id: id as Id, method: v.method as RpcMethod, params };
}

const isRes = (x: Req | Res): x is Res => 'error' in x || 'result' in x;

export async function handleRpc(ctx: Ctx, request: Request): Promise<Response> {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  let raw: Uint8Array;
  try {
    raw = await readLimited(request, 8_192);
  } catch {
    return new Response(JSON.stringify(err(null, -32600, 'request too large')), { status: 413, headers });
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response(JSON.stringify(err(null, -32700, 'parse error')), { status: 400, headers });
  }
  const batch = Array.isArray(body);
  const items = batch ? (body as unknown[]) : [body];
  if (items.length === 0 || items.length > RPC_LIMITS.batchMax) {
    return new Response(JSON.stringify(err(null, -32600, `batch of 1..${RPC_LIMITS.batchMax}`)), { status: 400, headers });
  }
  const parsed = items.map(parseReq);

  // rate limits: everything per IP, plus sends / simulations
  const sends = parsed.filter((p) => !isRes(p) && (p.method === 'sendTransaction' || p.method === 'simulateTransaction')).length;
  try {
    for (let i = 0; i < parsed.length; i++) await limit(ctx.env.RL_RPC, `rpc:${ctx.ipHash}`);
    for (let i = 0; i < sends; i++) await limit(ctx.env.RL_SEND, `send:${ctx.ipHash}`);
  } catch (e) {
    if (e instanceof ApiErr && e.code === 'rate_limited') {
      const out = parsed.map((p) => err(isRes(p) ? p.id : p.id, -32005, 'rate limited'));
      return new Response(JSON.stringify(batch ? out : out[0]), { status: 429, headers: { ...headers, 'retry-after': '5' } });
    }
    throw e;
  }

  const now = ctx.deps.now();
  const results: (Res | undefined)[] = parsed.map((p) => (isRes(p) ? p : undefined));
  const upstream: { i: number; req: Req; key: string | null }[] = [];
  // mainnet only: devnet SOL is free, and scripts/e2e-devnet.ts funds its test keys with plain transfers through here
  const appPrograms = ctx.cluster === 'mainnet' ? appProgramKeys(ctx.env) : null;
  parsed.forEach((p, i) => {
    if (isRes(p)) return;
    // sanctions screening (worker/sanctions.ts): never relay a send from or naming a sanctioned wallet
    const blocked = p.method === 'sendTransaction' ? sanctionedInTx(p.params[0]) : null;
    if (blocked) {
      reportSanctioned(ctx, blocked, 'sendTransaction');
      results[i] = err(p.id, RPC_WALLET_BLOCKED, 'wallet blocked');
      return;
    }
    if (appPrograms && (p.method === 'sendTransaction' || p.method === 'simulateTransaction') && !namesAppProgram(p.params[0], appPrograms)) {
      results[i] = err(p.id, -32602, 'invalid params: not an AtlasPad transaction');
      return;
    }
    const ttl = TTL[p.method];
    const key = ttl ? `${ctx.cluster}:${p.method}:${JSON.stringify(p.params)}` : null;
    const hit = key ? cache.get(key) : undefined;
    if (hit && hit.exp > now) results[i] = { jsonrpc: '2.0', id: p.id, result: hit.v };
    else upstream.push({ i, req: p, key });
  });

  if (upstream.length) {
    const rpc = ctx.rpc(4);
    try {
      await ensureGenesis(rpc);
    } catch (e) {
      const m = e instanceof ApiErr && e.code === 'chain_mismatch' ? 'chain mismatch' : 'upstream unavailable';
      for (const u of upstream) results[u.i] = err(u.req.id, -32000, m);
      return finish(ctx, batch, results, headers);
    }
    const reads = upstream.filter((u) => u.req.method !== 'sendTransaction' && u.req.method !== 'simulateTransaction');
    const writes = upstream.filter((u) => u.req.method === 'sendTransaction' || u.req.method === 'simulateTransaction');
    const run = async (group: typeof upstream, send: boolean) => {
      if (!group.length) return;
      const payload = group.map((u, j) => ({ jsonrpc: '2.0', id: j, method: u.req.method, params: u.req.params }));
      try {
        const r = await rpc.raw(group.length === 1 ? payload[0] : payload, { send, maxBytes: RPC_LIMITS.responseBytesMax });
        const arr = Array.isArray(r.body) ? (r.body as unknown[]) : [r.body];
        const byId = new Map<number, Record<string, unknown>>();
        for (const it of arr) if (isObj(it)) byId.set(Number(it.id), it);
        group.forEach((u, j) => {
          const it = byId.get(j);
          if (!it) return void (results[u.i] = err(u.req.id, -32000, 'upstream unavailable'));
          if (isObj(it.error)) {
            const code = typeof it.error.code === 'number' ? it.error.code : -32000;
            const message = typeof it.error.message === 'string' ? it.error.message.slice(0, 500) : 'rpc error';
            // send / simulate errors carry logs + InstructionError the client maps to final copy (§4.8)
            results[u.i] = err(u.req.id, code, message, send ? it.error.data : undefined);
            return;
          }
          if (!('result' in it)) return void (results[u.i] = err(u.req.id, -32000, 'upstream unavailable'));
          results[u.i] = { jsonrpc: '2.0', id: u.req.id, result: it.result };
          if (u.key) {
            const ttl = TTL[u.req.method]!;
            cache.set(u.key, { exp: ttl === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : now + ttl, v: it.result });
            if (cache.size > 2_000) for (const k of [...cache.keys()].slice(0, 500)) cache.delete(k);
          }
        });
      } catch (e) {
        const msg = e instanceof UpstreamError && e.httpStatus === 413 ? 'response too large' : 'upstream unavailable';
        if (e instanceof RpcError) {
          for (const u of group) results[u.i] = err(u.req.id, e.code, e.message);
        } else {
          for (const u of group) results[u.i] = err(u.req.id, -32000, msg);
        }
      }
    };
    await Promise.all([run(reads, false), run(writes, true)]);
  }
  return finish(ctx, batch, results, headers);
}

function finish(ctx: Ctx, batch: boolean, results: (Res | undefined)[], headers: Record<string, string>): Response {
  const out = results.map((r) => r ?? err(null, -32000, 'upstream unavailable'));
  let text = JSON.stringify(batch ? out : out[0]);
  const key = ctx.env.ALCHEMY_API_KEY?.trim();
  if (key && key.length >= 6 && text.includes(key)) {
    text = text.split(key).join('[redacted]');
    ctx.waitUntil(alert(ctx, 'critical', 'rpc_key_leak', 'An RPC response contained the RPC key; it was redacted before reaching the client'));
  }
  return new Response(text, { status: 200, headers });
}
