/**
 * Fake upstreams for Worker tests: a JSON-RPC "cluster" (accounts, signatures, transactions, sends), Google Places
 * (New), Twilio Verify and the two price APIs, all behind one `fetch` that routes by URL. Plus byte builders for the
 * on-chain accounts the Worker decodes (SPEC §3 layouts, pump BondingCurve, ALT) and pump event instructions.
 */
import { b58decode, b58encode, concat, fromHex, toB64, u64le } from '../bytes';
import { ALT_KEYS, EVENT, GENESIS } from '../consts';

/* ------------------------------------------------------------------------------------------- byte builders */

const i64le = (v: bigint | number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(v), true);
  return b;
};
const key = (k: string) => b58decode(k);

export function configData(p: { attestor: string; guardian: string; governance: string; paused?: boolean; flavor?: 0 | 1; window?: number; probationUntil?: number }): Uint8Array {
  const d = new Uint8Array(256);
  d[0] = 1;
  d[1] = 1;
  d[2] = 255;
  d[3] = p.paused ? 1 : 0;
  d[4] = p.flavor ?? 1;
  d.set(key(p.attestor), 8);
  d.set(key(p.guardian), 80);
  d.set(key(p.governance), 152);
  d.set(i64le(p.window ?? 60), 224);
  d.set(i64le(p.probationUntil ?? 0), 232);
  d.set(i64le(300), 240);
  return d;
}

export function vaultStateData(p: {
  placeHashHex: string;
  mint: string;
  launcher: string;
  owner?: string | null;
  pending?: { owner: string; unlockTs: number; inProbation?: boolean } | null;
  nonce?: bigint;
  totalWithdrawn?: bigint;
  createdAt?: number;
  ownerSince?: number;
}): Uint8Array {
  const d = new Uint8Array(208);
  d[0] = 2;
  d[1] = 1;
  d[2] = 254;
  d[3] = 253;
  d[4] = p.owner ? 1 : 0;
  d[5] = p.pending ? 1 : 0;
  d[7] = p.pending?.inProbation ? 1 : 0;
  d.set(fromHex(p.placeHashHex), 8);
  d.set(key(p.mint), 40);
  d.set(key(p.launcher), 72);
  if (p.owner) d.set(key(p.owner), 104);
  if (p.pending) {
    d.set(key(p.pending.owner), 136);
    d.set(i64le(p.pending.unlockTs), 168);
  }
  d.set(u64le(p.nonce ?? 0n), 176);
  d.set(u64le(p.totalWithdrawn ?? 0n), 184);
  d.set(i64le(p.createdAt ?? 1_791_000_000), 192);
  d.set(i64le(p.ownerSince ?? 0), 200);
  return d;
}

export function altData(keys: readonly string[] = ALT_KEYS, frozen = true): Uint8Array {
  const d = new Uint8Array(56 + 32 * keys.length);
  new DataView(d.buffer).setUint32(0, 1, true);
  d.set(u64le(0xffff_ffff_ffff_ffffn), 4);
  if (!frozen) {
    d[21] = 1;
    d.set(key(keys[0]!), 22);
  }
  keys.forEach((k, i) => d.set(key(k), 56 + 32 * i));
  return d;
}

export interface CurveFields {
  vTok: bigint;
  vSol: bigint;
  rTok: bigint;
  rSol: bigint;
  supply?: bigint;
  complete?: boolean;
  creator: string;
  bucket?: bigint;
}

export function curveData(c: CurveFields): Uint8Array {
  const d = new Uint8Array(151);
  d.set(fromHex('17b7f83760d8ac60'), 0);
  d.set(u64le(c.vTok), 8);
  d.set(u64le(c.vSol), 16);
  d.set(u64le(c.rTok), 24);
  d.set(u64le(c.rSol), 32);
  d.set(u64le(c.supply ?? 1_000_000_000_000_000n), 40);
  d[48] = c.complete ? 1 : 0;
  d.set(key(c.creator), 49);
  d.set(u64le(c.bucket ?? 0n), 125);
  return d;
}

export function pumpGlobalData(): Uint8Array {
  const d = new Uint8Array(1088);
  d.set(u64le(1_073_000_000_000_000n), 73);
  d.set(u64le(1_000_000_000n), 81);
  d.set(u64le(793_100_000_000_000n), 89);
  d.set(u64le(1_000_000_000_000_000n), 97);
  return d;
}

export interface TradeEventFields {
  mint: string;
  sol: bigint;
  tokens: bigint;
  isBuy: boolean;
  user: string;
  ts: number;
  vSol: bigint;
  vTok: bigint;
  rSol: bigint;
  rTok: bigint;
  creator: string;
  creatorFee: bigint;
  /** pump protocol fee (@161); 0 when omitted. */
  fee?: bigint;
}

/** pump TradeEvent as an event-CPI instruction's data (base58), body ≥ 250 bytes like the real one. */
export function tradeEventIxData(e: TradeEventFields): string {
  const body = new Uint8Array(260);
  body.set(key(e.mint), 0);
  body.set(u64le(e.sol), 32);
  body.set(u64le(e.tokens), 40);
  body[48] = e.isBuy ? 1 : 0;
  body.set(key(e.user), 49);
  body.set(i64le(e.ts), 81);
  body.set(u64le(e.vSol), 89);
  body.set(u64le(e.vTok), 97);
  body.set(u64le(e.rSol), 105);
  body.set(u64le(e.rTok), 113);
  body.set(u64le(e.fee ?? 0n), 161);
  body.set(key(e.creator), 169);
  body.set(u64le(e.creatorFee), 209);
  return b58encode(concat(fromHex(EVENT.cpiTag), fromHex(EVENT.pumpTrade), body));
}

/* ------------------------------------------------------------------------------------------------ the chain */

export interface FakeAccount {
  lamports: bigint;
  owner: string;
  data: Uint8Array;
  executable?: boolean;
}

export interface FakeTx {
  slot: number;
  blockTime: number;
  err: unknown;
  accountKeys: string[];
  numRequiredSignatures: number;
  loaded?: { writable: string[]; readonly: string[] };
  inner: { programId: string; data: string }[];
  logs?: string[];
}

export class FakeChain {
  accounts = new Map<string, FakeAccount>();
  statuses = new Map<string, { slot: number; err: unknown; confirmationStatus: 'processed' | 'confirmed' | 'finalized' }>();
  txs = new Map<string, FakeTx>();
  /** newest first */
  sigsByAddress = new Map<string, { signature: string; slot: number; err: unknown; blockTime: number }[]>();
  slot = 300_000_000;
  blockHeight = 280_000_000;
  blockhash = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
  genesis: string = GENESIS.devnet;
  sent: string[] = [];
  simErr: unknown = null;
  calls: string[] = [];
  /** Every call with its params (tests that must tell apart reads of specific accounts). */
  callLog: { method: string; params: unknown[] }[] = [];
  onSend: ((txBase64: string) => string | void) | null = null;
  /** mint → getTokenLargestAccounts answer (largest first, ≤ 20 like the real RPC). */
  largest = new Map<string, { address: string; amount: string }[]>();

  set(addr: string, a: FakeAccount): void {
    this.accounts.set(addr, a);
  }

  /** Records a landed transaction (status, tx JSON, and per-address signature lists). */
  land(sig: string, t: Omit<FakeTx, 'slot' | 'blockTime' | 'err'> & { slot?: number; blockTime?: number; err?: unknown }, touched: string[] = t.accountKeys): void {
    const slot = t.slot ?? ++this.slot;
    const blockTime = t.blockTime ?? Math.floor(Date.now() / 1000);
    this.txs.set(sig, { ...t, slot, blockTime, err: t.err ?? null });
    this.statuses.set(sig, { slot, err: t.err ?? null, confirmationStatus: 'confirmed' });
    for (const a of new Set([...touched, ...(t.loaded?.writable ?? []), ...(t.loaded?.readonly ?? [])])) {
      const l = this.sigsByAddress.get(a) ?? [];
      l.unshift({ signature: sig, slot, err: t.err ?? null, blockTime });
      this.sigsByAddress.set(a, l);
    }
  }

  private acct(addr: string, encoding: string) {
    const a = this.accounts.get(addr);
    if (!a) return null;
    return { lamports: Number(a.lamports), owner: a.owner, executable: !!a.executable, rentEpoch: 0, space: a.data.length, data: [toB64(a.data), encoding === 'base64' ? 'base64' : 'base64'] };
  }

  rpc(method: string, params: unknown[]): unknown {
    this.calls.push(method);
    this.callLog.push({ method, params });
    const ctx = { slot: this.slot };
    switch (method) {
      case 'getGenesisHash':
        return this.genesis;
      case 'getSlot':
        return this.slot;
      case 'getBlockHeight':
        return this.blockHeight;
      case 'getLatestBlockhash':
        return { context: ctx, value: { blockhash: this.blockhash, lastValidBlockHeight: this.blockHeight + 150 } };
      case 'getAccountInfo':
        return { context: ctx, value: this.acct(params[0] as string, 'base64') };
      case 'getMultipleAccounts':
        return { context: ctx, value: (params[0] as string[]).map((k) => this.acct(k, 'base64')) };
      case 'getBalance':
        return { context: ctx, value: Number(this.accounts.get(params[0] as string)?.lamports ?? 0n) };
      case 'getMinimumBalanceForRentExemption':
        return 890_880 + ((params[0] as number) ?? 0) * 6_960;
      case 'getSignatureStatuses':
        return { context: ctx, value: (params[0] as string[]).map((s) => this.statuses.get(s) ?? null).map((s) => (s ? { ...s, confirmations: 0 } : null)) };
      case 'getSignaturesForAddress': {
        const [addr, o] = params as [string, { limit: number; until?: string; before?: string }];
        let l = this.sigsByAddress.get(addr) ?? [];
        if (o.before) {
          const i = l.findIndex((s) => s.signature === o.before);
          l = i >= 0 ? l.slice(i + 1) : [];
        }
        if (o.until) {
          const i = l.findIndex((s) => s.signature === o.until);
          if (i >= 0) l = l.slice(0, i);
        }
        return l.slice(0, o.limit).map((s) => ({ ...s, memo: null, confirmationStatus: 'confirmed' }));
      }
      case 'getTransaction': {
        const t = this.txs.get(params[0] as string);
        if (!t) return null;
        const keys = t.accountKeys;
        const all = [...keys, ...(t.loaded?.writable ?? []), ...(t.loaded?.readonly ?? [])];
        const idx = (k: string) => {
          const i = all.indexOf(k);
          if (i < 0) throw new Error(`fake tx: ${k} not in account keys`);
          return i;
        };
        return {
          slot: t.slot,
          blockTime: t.blockTime,
          version: 0,
          meta: {
            err: t.err,
            fee: 5000,
            preBalances: [],
            postBalances: [],
            innerInstructions: t.inner.length ? [{ index: 0, instructions: t.inner.map((ix) => ({ programIdIndex: idx(ix.programId), accounts: [], data: ix.data, stackHeight: 2 })) }] : [],
            logMessages: t.logs ?? [],
            loadedAddresses: t.loaded ?? { writable: [], readonly: [] },
          },
          transaction: {
            signatures: [params[0]],
            message: {
              accountKeys: keys,
              header: { numRequiredSignatures: t.numRequiredSignatures, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
              instructions: [],
              recentBlockhash: this.blockhash,
            },
          },
        };
      }
      case 'sendTransaction': {
        this.sent.push(params[0] as string);
        const sig = this.onSend?.(params[0] as string);
        return sig ?? b58encode(Uint8Array.from(atob(params[0] as string), (c) => c.charCodeAt(0)).subarray(1, 65));
      }
      case 'simulateTransaction':
        return { context: ctx, value: { err: this.simErr, logs: [], unitsConsumed: 1234, accounts: null } };
      case 'getRecentPrioritizationFees':
        return [{ slot: 1, prioritizationFee: 0 }, { slot: 2, prioritizationFee: 20_000 }, { slot: 3, prioritizationFee: 40_000 }];
      case 'getTokenAccountsByOwner':
        return { context: ctx, value: [] };
      case 'getProgramAccounts':
        return [];
      case 'getTokenLargestAccounts':
        return { context: ctx, value: (this.largest.get(params[0] as string) ?? []).slice(0, 20).map((a) => ({ ...a, decimals: 6, uiAmount: null, uiAmountString: a.amount })) };
      default:
        throw Object.assign(new Error('method not found'), { rpcCode: -32601 });
    }
  }

  handle(body: unknown): unknown {
    const one = (r: { id: unknown; method: string; params?: unknown[] }) => {
      try {
        return { jsonrpc: '2.0', id: r.id, result: this.rpc(r.method, r.params ?? []) };
      } catch (e) {
        return { jsonrpc: '2.0', id: r.id, error: { code: (e as { rpcCode?: number }).rpcCode ?? -32000, message: (e as Error).message } };
      }
    };
    return Array.isArray(body) ? body.map(one) : one(body as never);
  }
}

/* ------------------------------------------------------------------------------------------- other upstreams */

export interface FakePlace {
  id: string;
  businessStatus?: string;
  primaryType?: string;
  types?: string[];
  location?: { latitude: number; longitude: number };
  internationalPhoneNumber?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  /** Places API addressComponents; a place that does not set it is in London (GB_ADDRESS). `undefined` = none. */
  addressComponents?: unknown[];
}

/** addressComponents of a place in London: the default for fake places (the geo-block needs a country). */
export const GB_ADDRESS = [
  { longText: 'London', shortText: 'London', types: ['postal_town'] },
  { longText: 'England', shortText: 'England', types: ['administrative_area_level_1', 'political'] },
  { longText: 'United Kingdom', shortText: 'GB', types: ['country', 'political'] },
];

export class FakeWorld {
  chain = new FakeChain();
  places = new Map<string, FakePlace>();
  twilio = { started: [] as Record<string, string>[], checks: [] as Record<string, string>[], approveCode: '123456', codeLength: 6, startError: null as null | { status: number; code: number } };
  sites = new Map<string, string>();
  requests: string[] = [];
  solUsd = 150.25;

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    this.requests.push(`${init?.method ?? 'GET'} ${url.origin}${url.pathname}`);
    const jsonRes = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (/^solana-(devnet|mainnet)\.g\.alchemy\.com$/.test(url.hostname)) {
      return jsonRes(this.chain.handle(JSON.parse(String(init?.body))));
    }
    if (url.hostname === 'places.googleapis.com') {
      const id = decodeURIComponent(url.pathname.replace('/v1/places/', ''));
      const found = this.places.get(id);
      if (!found) return jsonRes({ error: { code: 404 } }, 404);
      const p = { addressComponents: GB_ADDRESS, ...found };
      const mask = (new Headers(init?.headers).get('x-goog-fieldmask') ?? '').split(',');
      return jsonRes(Object.fromEntries(Object.entries(p).filter(([k]) => mask.includes(k))));
    }
    if (url.hostname === 'verify.twilio.com') {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
      if (url.pathname.endsWith('/Verifications')) {
        if (this.twilio.startError) return jsonRes({ code: this.twilio.startError.code, message: 'x', status: this.twilio.startError.status }, this.twilio.startError.status);
        this.twilio.started.push(form);
        return jsonRes({ sid: `VE${'a'.repeat(32)}`, status: 'pending' }, 201);
      }
      if (url.pathname.endsWith('/VerificationCheck')) {
        this.twilio.checks.push(form);
        return jsonRes({ status: form.Code === this.twilio.approveCode ? 'approved' : 'pending' });
      }
      return jsonRes({ sid: 'VA', code_length: this.twilio.codeLength });
    }
    if (url.hostname === 'lite-api.jup.ag' || url.hostname === 'api.jup.ag') {
      return jsonRes({ So11111111111111111111111111111111111111112: { usdPrice: this.solUsd } });
    }
    if (url.hostname === 'hermes.pyth.network') {
      return jsonRes({ parsed: [{ price: { price: String(Math.round(this.solUsd * 1e8)), expo: -8 } }] });
    }
    const site = this.sites.get(`${url.hostname}${url.pathname}`);
    if (site !== undefined) return new Response(site, { status: 200, headers: { 'content-type': url.pathname.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8' } });
    return new Response('not found', { status: 404 });
  };
}
