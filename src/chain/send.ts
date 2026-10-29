/**
 * Sign → send → confirm without WebSockets (INTEGRATION.md §4.7). Heavy module (web3.js).
 *
 *  1. `awaiting-signature`: the wallet signs the serialized tx (`WalletSigner.signTransaction`).
 *  2. The returned MESSAGE must be byte-identical to ours (it was co-signed); the wallet's own signature is verified
 *     with WebCrypto Ed25519 when the browser has it; co-signatures the wallet dropped are re-applied.
 *  3. `sending`: `sendTransaction(base64, skipPreflight, maxRetries 0)` — we simulated already. The signature is
 *     known before the call, so a timeout still reports it.
 *  4. `confirming`: first poll after 0.7 s, then every 500 ms for the first 4 s, then every 800 ms, one batched
 *     request [getSignatureStatuses, getBlockHeight (+ sendTransaction of the same bytes every 1.5 s, 2 s after 6 s)];
 *     past `lastValidBlockHeight` with no status = expired (it can never land); hard cap 60 s.
 */
import { VersionedTransaction } from '@solana/web3.js';
import { RPC_WALLET_BLOCKED } from '../../worker/wire';
import { base58Encode } from './base58';
import { failFromTxError, TxFail, WALLET_BLOCKED_COPY } from './errors';
import { explorerTx } from './explorer';
import { bytesToB64, rpc, rpcBatch, RpcError } from './rpc';
import type { OnProgress, WalletSigner } from './types';
import type { TxJson } from './events';

export interface Built {
  /** Message + every non-wallet signature already applied (attestor, mint). */
  tx: VersionedTransaction;
  lastValidBlockHeight: number;
}

export interface Landed {
  signature: string;
  slot: number | null;
}

/**
 * Status polling: fast while a landing is likely (devnet/mainnet confirm in ~1-3 s), then the §4.7 800 ms cadence.
 * Faster first polls show success ~0.5 s sooner on average; one poll is one batched request.
 */
/** First status poll: a tx practically never confirms within 0.7 s of the send, so an earlier poll is wasted. */
const POLL_FIRST_MS = 700;
const POLL_FAST_MS = 500;
const POLL_FAST_FOR_MS = 4_000;
const POLL_MS = 800;
/** Rebroadcast the same bytes every 1.5 s at first (dropped packets are the usual reason a tx is slow), then every 2 s. */
const REBROADCAST_FAST_MS = 1_500;
const REBROADCAST_MS = 2_000;
const HARD_CAP_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
const isZero = (s: Uint8Array) => s.every((b) => b === 0);

/** Top-level program id per instruction (for error decoding). */
export function programIdsOf(tx: VersionedTransaction): string[] {
  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions.map((ci) => keys[ci.programIdIndex]?.toBase58() ?? '');
}

let ed25519Supported: boolean | null = null;

/** Verify one ed25519 signature with WebCrypto. Returns null when the platform can't verify (old browsers). */
async function verifyEd25519(pubkey: Uint8Array, sig: Uint8Array, msg: Uint8Array): Promise<boolean | null> {
  if (ed25519Supported === false) return null;
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const key = await subtle.importKey('raw', pubkey as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    ed25519Supported = true;
    return await subtle.verify({ name: 'Ed25519' }, key, sig as BufferSource, msg as BufferSource);
  } catch {
    ed25519Supported = false;
    return null;
  }
}

/** Ask the wallet to sign; enforce the byte-identical message; re-apply our co-signatures. */
export async function walletSign(b: Built, signer: WalletSigner, onProgress: OnProgress): Promise<VersionedTransaction> {
  onProgress({ phase: 'awaiting-signature', walletName: signer.walletName });
  const ours = b.tx.message.serialize();
  const out = await signer.signTransaction(b.tx.serialize());
  let signed: VersionedTransaction;
  try {
    signed = VersionedTransaction.deserialize(out);
  } catch {
    throw new TxFail('wallet-modified');
  }
  if (!eqBytes(signed.message.serialize(), ours)) throw new TxFail('wallet-modified');
  // Re-apply signatures we already hold (attestor, mint) if the wallet dropped them; they stay valid on the same message.
  b.tx.signatures.forEach((s, i) => {
    if (!isZero(s) && (signed.signatures[i] === undefined || isZero(signed.signatures[i]))) signed.signatures[i] = s;
  });
  const keys = signed.message.staticAccountKeys;
  const idx = keys.findIndex((k) => k.toBase58() === signer.address);
  if (idx < 0 || idx >= signed.message.header.numRequiredSignatures) throw new TxFail('wallet-modified');
  const sig = signed.signatures[idx];
  if (!sig || isZero(sig)) throw new TxFail('wallet-modified');
  const ok = await verifyEd25519(keys[idx].toBytes(), sig, ours);
  if (ok === false) throw new TxFail('wallet-modified');
  return signed;
}

/** Send + confirm a fully signed tx (§4.7 steps 3–4). Throws TxFail with `sent: true` on failure. */
export async function sendAndConfirm(signed: VersionedTransaction, lastValidBlockHeight: number, onProgress: OnProgress, walletName?: string): Promise<Landed> {
  const raw = signed.serialize();
  const b64 = bytesToB64(raw);
  const signature = base58Encode(signed.signatures[0]);
  const explorerUrl = explorerTx(signature);
  onProgress({ phase: 'sending', walletName, signature, explorerUrl });
  const send = () => rpc<string>('sendTransaction', [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }], 15_000);
  try {
    await send();
  } catch (e) {
    const msg = String((e as Error)?.message ?? '');
    if (e instanceof RpcError && e.code !== -32099 && !/already been processed/i.test(msg)) {
      // A definitive refusal before broadcast (sanitize / blockhash): it was never accepted.
      if (/blockhash not found/i.test(msg)) throw new TxFail('expired', { sent: false });
      if (e.code === -32005) throw new TxFail('rate-limited', { sent: false });
      // sanctions screening at /api/rpc (worker/sanctions.ts): final, nothing was sent
      if (e.code === RPC_WALLET_BLOCKED) throw new TxFail('unknown', { sent: false, message: WALLET_BLOCKED_COPY, retryable: false });
      throw new TxFail('network', { sent: false });
    }
    // Timeouts / network: the tx may be in flight — keep confirming (and rebroadcasting).
  }
  const started = Date.now();
  let lastBroadcast = Date.now();
  let lastTick = 0;
  onProgress({ phase: 'confirming', walletName, signature, explorerUrl, elapsedMs: 0 });
  for (let poll = 0; ; poll++) {
    await sleep(poll === 0 ? POLL_FIRST_MS : Date.now() - started < POLL_FAST_FOR_MS ? POLL_FAST_MS : POLL_MS);
    const elapsed = Date.now() - started;
    if (elapsed - lastTick >= 1000) {
      lastTick = elapsed;
      onProgress({ phase: 'confirming', walletName, signature, explorerUrl, elapsedMs: elapsed });
    }
    // The rebroadcast rides in the same /api/rpc request as the status poll (INTEGRATION §8: one trade ≤ 12 requests).
    const rebroadcast = Date.now() - lastBroadcast >= (elapsed < 6_000 ? REBROADCAST_FAST_MS : REBROADCAST_MS);
    if (rebroadcast) lastBroadcast = Date.now();
    let status: { slot: number; err: unknown; confirmationStatus?: string } | null = null;
    let height: number | null = null;
    try {
      const [st, bh] = await rpcBatch([
        { method: 'getSignatureStatuses', params: [[signature], { searchTransactionHistory: false }] },
        { method: 'getBlockHeight', params: [{ commitment: 'confirmed' }] },
        ...(rebroadcast ? [{ method: 'sendTransaction' as const, params: [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] }] : []),
      ]);
      if (!(st instanceof Error)) status = (st as { value: ({ slot: number; err: unknown; confirmationStatus?: string } | null)[] }).value?.[0] ?? null;
      if (!(bh instanceof Error)) height = bh as number;
    } catch {
      /* transient: keep polling until the cap */
    }
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      if (status.err) {
        // Landed with an error: read the logs so the failing (possibly inner) program is decoded correctly.
        const tx = await fetchTx(signature, 3);
        throw failFromTxError(status.err, programIdsOf(signed), tx?.meta?.logMessages ?? undefined, { sent: true, signature, explorerUrl });
      }
      return { signature, slot: status.slot ?? null };
    }
    if (!status && height !== null && height > lastValidBlockHeight) {
      // One last look (the status cache may lag a slot) before declaring it dead.
      try {
        const st = await rpc<{ value: ({ err: unknown; confirmationStatus?: string; slot: number } | null)[] }>('getSignatureStatuses', [
          [signature],
          { searchTransactionHistory: false },
        ]);
        const s = st.value?.[0];
        if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
          if (s.err) throw failFromTxError(s.err, programIdsOf(signed), undefined, { sent: true, signature, explorerUrl });
          return { signature, slot: s.slot ?? null };
        }
        if (!s) throw new TxFail('expired', { sent: true, signature, explorerUrl });
      } catch (e) {
        if (e instanceof TxFail) throw e;
      }
    }
    if (elapsed >= HARD_CAP_MS) throw new TxFail('unconfirmed', { sent: true, signature, explorerUrl });
  }
}

/**
 * One full attempt loop: build → wallet signs → send → confirm. When the blockhash expires before the tx lands
 * (slow approval or a dropped packet; it can then never land), `build` runs again with a fresh blockhash and the
 * wallet is asked again, at most `maxAttempts` times. Everything else propagates.
 */
export async function executeWithRetry(
  build: (attempt: number) => Promise<Built>,
  signer: WalletSigner,
  onProgress: OnProgress,
  maxAttempts = 3,
): Promise<Landed & { tx: VersionedTransaction }> {
  for (let attempt = 1; ; attempt++) {
    const b = await build(attempt);
    const builtAt = Date.now();
    const signed = await walletSign(b, signer, onProgress);
    // A slow approval may have outlived the blockhash: then sending is pointless and nothing was sent.
    if (Date.now() - builtAt > 40_000) {
      const h = await blockHeight().catch(() => null);
      if (h !== null && h > b.lastValidBlockHeight) {
        if (attempt < maxAttempts) continue;
        throw new TxFail('expired', { sent: false });
      }
    }
    try {
      const landed = await sendAndConfirm(signed, b.lastValidBlockHeight, onProgress, signer.walletName);
      return { ...landed, tx: signed };
    } catch (e) {
      if (e instanceof TxFail && e.code === 'expired' && attempt < maxAttempts) continue;
      throw e;
    }
  }
}

/**
 * Fetch the confirmed tx (json). Retries briefly — `getTransaction` can lag `getSignatureStatuses` by a slot — but
 * gives up after ~1.8 s so a success is never held back (callers fall back to the quote, marked `estimated`).
 */
export async function fetchTx(signature: string, tries = 4): Promise<TxJson | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const tx = await rpc<TxJson | null>('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      if (tx?.meta) return tx;
    } catch {
      /* retry */
    }
    if (i < tries - 1) await sleep(300 * (i + 1));
  }
  return null;
}

export interface SimResult {
  err: unknown;
  logs: string[];
  unitsConsumed?: number;
}

/** `simulateTransaction` without signature checks (the wallet hasn't signed yet). Maps failures to TxFail. */
export async function simulate(tx: VersionedTransaction, extra: { needLamports?: bigint } = {}): Promise<SimResult> {
  const r = await rpc<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>('simulateTransaction', [
    bytesToB64(tx.serialize()),
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'processed' },
  ]);
  const v = r.value;
  if (v.err) {
    const f = failFromTxError(v.err, programIdsOf(tx), v.logs ?? undefined, { sent: false });
    if (f.code === 'insufficient-sol' && extra.needLamports) throw new TxFail('insufficient-sol', { ...f.detail, needLamports: extra.needLamports.toString() });
    throw f;
  }
  return { err: null, logs: v.logs ?? [], unitsConsumed: v.unitsConsumed };
}

export interface RecentBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

let primed: (RecentBlockhash & { at: number }) | null = null;

/** Remember a blockhash read in another batched request (market.readCurve), so a trade can skip its own read. */
export function primeBlockhash(v: RecentBlockhash): void {
  if (v && typeof v.blockhash === 'string' && Number.isFinite(v.lastValidBlockHeight)) primed = { ...v, at: Date.now() };
}

/**
 * Latest blockhash (confirmed) through the proxy. With `maxAgeMs`, a blockhash primed by a batched read at most that
 * old is used instead of a new request (trades: the click-time quote already fetched one in the same request; a
 * 10 s-old blockhash still has ~50 s of validity, and an expiry is retried with a fresh one by executeWithRetry).
 */
export async function latestBlockhash(opts: { maxAgeMs?: number } = {}): Promise<RecentBlockhash> {
  const max = opts.maxAgeMs ?? 0;
  if (max > 0 && primed && Date.now() - primed.at <= max) return { blockhash: primed.blockhash, lastValidBlockHeight: primed.lastValidBlockHeight };
  const r = await rpc<{ value: RecentBlockhash }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  primeBlockhash(r.value);
  return r.value;
}

/** Current block height (confirmed). */
export async function blockHeight(): Promise<number> {
  return rpc<number>('getBlockHeight', [{ commitment: 'confirmed' }]);
}
