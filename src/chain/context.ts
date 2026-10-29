/**
 * Chain-layer runtime state: the `/api/config` snapshot, the web3 Connection (through `/api/rpc` only, H3), the Worker
 * backend, and the lazy pump SDK loader. Heavy module (web3.js).
 *
 * Node tests and the devnet e2e call `initChain(cfg, { rpcUrl, backend, pumpSdk })`; the browser calls `initChain(cfg)`.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import type { ConfigResponse } from '../../worker/wire';
import { CLUSTER, IS_REAL, assertRealMode } from '../mode';
import { httpBackend, type ChainBackend } from './api';
import { TxFail } from './errors';
import { setExplorerTemplates } from './explorer';
import { makePumpOps, type PumpOps, type PumpSdkModule } from './pumpOps';
import { setRpcEndpoint } from './rpc';

export interface ChainInitOptions {
  /** Node only: an RPC URL to use instead of `${origin}/api/rpc` (never logged). */
  rpcUrl?: string;
  /** Node e2e only: a local backend instead of the Worker routes. */
  backend?: ChainBackend;
  /** Node only: the CJS pump SDK module (its ESM build does not load under plain Node). */
  pumpSdk?: PumpSdkModule;
}

let cfg: ConfigResponse | null = null;
let conn: Connection | null = null;
let backendImpl: ChainBackend = httpBackend;
let rpcUrlOverride: string | null = null;
let injectedSdk: PumpSdkModule | null = null;
let opsP: Promise<PumpOps> | null = null;

/** Once, after `/api/config` (APP), or again when the config changes (new ALT, attestor, priority fee…). */
export function initChain(c: ConfigResponse, opts: ChainInitOptions = {}): void {
  cfg = c;
  setExplorerTemplates(c.explorer);
  if (opts.backend) backendImpl = opts.backend;
  if (opts.pumpSdk) {
    injectedSdk = opts.pumpSdk;
    opsP = null;
  }
  if (opts.rpcUrl !== undefined && opts.rpcUrl !== rpcUrlOverride) {
    rpcUrlOverride = opts.rpcUrl;
    setRpcEndpoint(opts.rpcUrl);
    conn = null;
  }
}

export function chainConfig(): ConfigResponse {
  if (!cfg) throw new TxFail('network', { message: "We couldn't load the network settings. Reload and try again." });
  return cfg;
}

export function isInitialised(): boolean {
  return cfg !== null;
}

export function backend(): ChainBackend {
  return backendImpl;
}

/**
 * web3 Connection through the Worker proxy (INTEGRATION.md §1.7). No WebSocket is ever opened: we never call
 * `confirmTransaction` or an `on*` subscription (web3.js only connects its socket on a subscription).
 */
export function connection(): Connection {
  if (!conn) {
    const url = rpcUrlOverride ?? new URL('/api/rpc', location.origin).href;
    conn = new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true, wsEndpoint: 'wss://invalid.invalid' });
  }
  return conn;
}

/**
 * Guard for every signing flow: real mode, an initialised config, and the config's cluster equal to this build's.
 * (Node e2e runs with VITE_CLUSTER=devnet so `CLUSTER` is 'devnet' there too.)
 */
export function assertCanSign(what: string): ConfigResponse {
  assertRealMode(what);
  const c = chainConfig();
  if (!IS_REAL || (CLUSTER && c.cluster !== CLUSTER)) throw new TxFail('wrong-network');
  return c;
}

/** The pump SDK + bn.js, loaded once into their own chunk (`import('@pump-fun/pump-sdk')`). */
export function loadPump(): Promise<PumpOps> {
  opsP ??= (async () => {
    const [sdk, bnMod] = await Promise.all([
      injectedSdk ? Promise.resolve(injectedSdk) : (import('@pump-fun/pump-sdk') as Promise<PumpSdkModule>),
      import('bn.js'),
    ]);
    const BN = ((bnMod as { default?: unknown }).default ?? bnMod) as Parameters<typeof makePumpOps>[1];
    return makePumpOps(sdk, BN);
  })().catch((e: unknown) => {
    opsP = null;
    throw e;
  });
  return opsP;
}

export const pk = (s: string | PublicKey): PublicKey => (typeof s === 'string' ? new PublicKey(s) : s);
