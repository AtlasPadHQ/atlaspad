/**
 * JSON-RPC from this machine (INTEGRATION §1.7, §10.1).
 *
 * - Local scripts use the PUBLIC cluster endpoints (api.devnet.solana.com / api.mainnet-beta.solana.com). They never
 *   read or use the provider key (`ALCHEMY_API_KEY`): that key exists only to be piped into the Worker secret
 *   (secretPut.mjs). Public RPC works from this machine; only Cloudflare Workers are refused by it.
 * - RPC_URL in the environment overrides the endpoint (a local validator, or an endpoint you choose). Its value is
 *   never printed: label(url) = origin only.
 * - Errors are re-thrown with the URL removed and the message redacted.
 * - Reads retry with jitter on 429/5xx; sendTransaction is never retried here.
 */
import { redact, sleep } from './log.mjs';
import { GENESIS, PUBLIC_RPC } from './paths.mjs';

export function rpcUrl(cluster) {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  if (!PUBLIC_RPC[cluster]) throw new Error(`unknown cluster ${cluster}`);
  return PUBLIC_RPC[cluster];
}

/** The endpoint for a cluster plus a note when it is an override. Returns { url, fallback: string|null }. */
export async function pickRpc(cluster) {
  const url = rpcUrl(cluster);
  return { url, fallback: process.env.RPC_URL ? 'RPC_URL override' : null };
}

/** Origin only: never the path or query, which carry the key. */
export function label(url) {
  try {
    return new URL(url).origin;
  } catch {
    return 'rpc';
  }
}

export class RpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

let nextId = 1;
/**
 * @param {string} url
 * @param {string} method
 * @param {unknown[]} params
 * @param {{ timeoutMs?: number, retries?: number }} [opts]
 */
export async function rpc(url, method, params = [], opts = {}) {
  const isSend = method === 'sendTransaction' || method === 'requestAirdrop';
  const retries = opts.retries ?? (isSend ? 0 : 4);
  const timeoutMs = opts.timeoutMs ?? (isSend ? 15_000 : 15_000);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** attempt + Math.random() * 300);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastErr = new RpcError(`${method}: network error (${redact(e?.cause?.code ?? e?.name ?? 'fetch failed')}) at ${label(url)}`);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new RpcError(`${method}: HTTP ${res.status} from ${label(url)}`, res.status);
      continue;
    }
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RpcError(`${method}: non-JSON response (HTTP ${res.status}) from ${label(url)}`, res.status);
    }
    if (body.error) {
      const err = new RpcError(`${method}: ${redact(body.error.message ?? 'error')} (${body.error.code})`, body.error.code, body.error.data);
      if (body.error.code === 429 || body.error.code === -32005) {
        lastErr = err;
        continue;
      }
      throw err;
    }
    return body.result;
  }
  throw lastErr ?? new RpcError(`${method}: failed`);
}

export async function genesisHash(url) {
  return rpc(url, 'getGenesisHash', []);
}

/** Throws unless the RPC's genesis hash is the expected cluster's (H1). */
export async function assertGenesis(url, cluster) {
  const g = await genesisHash(url);
  if (g !== GENESIS[cluster]) {
    const other = Object.entries(GENESIS).find(([, v]) => v === g)?.[0] ?? 'unknown';
    throw new Error(`REFUSING: ${label(url)} is ${other} (genesis ${g}), expected ${cluster}`);
  }
  return g;
}

export async function getBalance(url, address, commitment = 'confirmed') {
  const r = await rpc(url, 'getBalance', [address, { commitment }]);
  return BigInt(r.value);
}

/** @returns {Promise<{lamports: bigint, owner: string, executable: boolean, data: Buffer} | null>} */
export async function getAccount(url, address, commitment = 'confirmed') {
  const r = await rpc(url, 'getAccountInfo', [address, { encoding: 'base64', commitment }]);
  return decodeAccount(r.value);
}

export async function getMultipleAccounts(url, addresses, commitment = 'confirmed') {
  const out = [];
  let slot = 0;
  for (let i = 0; i < addresses.length; i += 100) {
    const r = await rpc(url, 'getMultipleAccounts', [addresses.slice(i, i + 100), { encoding: 'base64', commitment }]);
    slot = Math.max(slot, r.context?.slot ?? 0);
    out.push(...r.value.map(decodeAccount));
  }
  return Object.assign(out, { slot });
}

function decodeAccount(v) {
  if (!v) return null;
  return {
    lamports: BigInt(v.lamports),
    owner: v.owner,
    executable: !!v.executable,
    data: Buffer.from(v.data[0], v.data[1] ?? 'base64'),
  };
}

export async function rentExempt(url, len) {
  return BigInt(await rpc(url, 'getMinimumBalanceForRentExemption', [len]));
}

/** Polls getSignatureStatuses until confirmed/finalized (no WebSockets). Returns the status or throws. */
export async function waitSignature(url, sig, { timeoutMs = 60_000, lastValidBlockHeight } = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = await rpc(url, 'getSignatureStatuses', [[sig], { searchTransactionHistory: false }]);
    const s = r.value[0];
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
      if (s.err) throw new RpcError(`transaction ${sig} failed: ${JSON.stringify(s.err)}`, 'onchain', s.err);
      return s;
    }
    if (lastValidBlockHeight !== undefined) {
      const h = await rpc(url, 'getBlockHeight', [{ commitment: 'confirmed' }]);
      if (h > lastValidBlockHeight) throw new RpcError(`transaction ${sig} expired (block height exceeded)`, 'expired');
    }
    if (Date.now() - t0 > timeoutMs) throw new RpcError(`transaction ${sig} not confirmed after ${timeoutMs / 1000}s`, 'unconfirmed');
    await sleep(800);
  }
}

/** Unix seconds from the Clock sysvar (the chain clock that unlock_ts is compared against). */
export async function chainTime(url) {
  const a = await getAccount(url, 'SysvarC1ock11111111111111111111111111111111');
  return a.data.readBigInt64LE(32);
}
