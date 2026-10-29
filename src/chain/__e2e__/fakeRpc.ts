/**
 * Test-only fake JSON-RPC endpoint (unit tests never touch a network). Handles single calls and batches like the
 * Worker proxy; a handler returns the `result`, or throws `{ code, message }` for a JSON-RPC error.
 */
import { setRpcEndpoint } from '../rpc';

export interface RpcLogEntry {
  method: string;
  params: unknown[];
}
export type RpcHandler = (method: string, params: unknown[]) => unknown;

export function installFakeRpc(handler: RpcHandler): { calls: RpcLogEntry[]; httpRequests: () => number } {
  const calls: RpcLogEntry[] = [];
  let http = 0;
  const f: typeof fetch = async (_url, init) => {
    http++;
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    const one = async (req: { id: number; method: string; params: unknown[] }) => {
      calls.push({ method: req.method, params: req.params });
      try {
        return { jsonrpc: '2.0', id: req.id, result: await handler(req.method, req.params ?? []) };
      } catch (e) {
        const err = e as { code?: number; message?: string };
        return { jsonrpc: '2.0', id: req.id, error: { code: err.code ?? -32000, message: err.message ?? 'error' } };
      }
    };
    const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  setRpcEndpoint('http://fake-rpc.test/', f);
  return { calls, httpRequests: () => http };
}

/** `getMultipleAccounts`/`getAccountInfo` wire shape for raw bytes. */
export function wireAccount(data: Uint8Array, owner: string, lamports: bigint | number = 1_000_000) {
  return { lamports: Number(lamports), owner, data: [Buffer.from(data).toString('base64'), 'base64'], executable: false, rentEpoch: 0 };
}
