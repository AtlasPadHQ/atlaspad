/**
 * One-time risk + Terms consent before a user's FIRST real transaction (launch, buy, sell, claim, finalize, withdraw).
 * `runTx` (src/realdata/tx.ts), the single path every flow uses to start a transaction, asks here before it touches
 * the wallet, so no flow can skip it. <ConsentGate/> (src/legal/ConsentGate.tsx, mounted once by SharedModals) shows
 * the request on top of whatever flow is open. Required on mainnet and asked on devnet too; the demo (?mode=demo)
 * never sends a transaction, so it never asks.
 *
 * Stored in localStorage `cs_consent` as `{ v, cluster, at }`. Bump CONSENT_VERSION when the Terms or the warning
 * change materially: everyone accepts again before their next transaction (Terms §15). When storage is blocked
 * (private mode), the acceptance lasts for this page load.
 */
import { useSyncExternalStore } from 'react';
import type { TxError } from '../chain/types';
import { loadJSON, removeKey, saveJSON } from '../lib/storage';
import { CLUSTER, IS_REAL } from '../mode';

export const CONSENT_VERSION = 1;
export const CONSENT_KEY = 'cs_consent';

export interface ConsentRecord {
  /** CONSENT_VERSION accepted. */
  v: number;
  /** The cluster it was accepted on: a devnet acceptance never counts for mainnet. */
  cluster: string;
  /** Epoch ms. */
  at: number;
}

let session: ConsentRecord | null = null;

function current(r: unknown): r is ConsentRecord {
  if (!r || typeof r !== 'object') return false;
  const c = r as Partial<ConsentRecord>;
  return c.v === CONSENT_VERSION && c.cluster === (CLUSTER ?? '') && typeof c.at === 'number' && Number.isFinite(c.at);
}

/** True when this browser accepted the current version on this cluster (always true in the demo). */
export function hasConsent(): boolean {
  if (!IS_REAL) return true;
  return current(session) || current(loadJSON<unknown>(CONSENT_KEY, null));
}

/** Forget the acceptance, so the next transaction asks again (tests; a future "reset" in settings). */
export function clearConsent(): void {
  session = null;
  removeKey(CONSENT_KEY);
}

/** Remember the acceptance (localStorage, plus this page load in case storage is blocked). */
export function recordConsent(now: number = Date.now()): ConsentRecord {
  const r: ConsentRecord = { v: CONSENT_VERSION, cluster: CLUSTER ?? '', at: now };
  session = r;
  saveJSON(CONSENT_KEY, r);
  return r;
}

/* ------------------------------------------------------------------ the open request */

let pending: Promise<boolean> | null = null;
let settle: ((accepted: boolean) => void) | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/**
 * Resolves true once the user accepts, false when they cancel. Resolves at once when consent is already on record.
 * A second caller while the sheet is open shares the same answer (one sheet, never a stack of them).
 */
export function requestConsent(): Promise<boolean> {
  if (hasConsent()) return Promise.resolve(true);
  if (pending) return pending;
  pending = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  emit();
  return pending;
}

/** The sheet's answer. Accepting records the consent first, so the waiting transaction sees it. */
export function resolveConsent(accepted: boolean): void {
  if (!pending) return;
  if (accepted) recordConsent();
  const done = settle;
  pending = null;
  settle = null;
  done?.(accepted);
  emit();
}

/** True while a transaction is waiting for the user's answer. */
export function consentRequested(): boolean {
  return pending !== null;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** React: is the consent sheet open? */
export function useConsentRequested(): boolean {
  return useSyncExternalStore(subscribe, consentRequested, consentRequested);
}

/** What `runTx` returns when the user cancels the sheet: like a cancelled wallet prompt, nothing was sent. */
export function consentDeclinedError(): TxError {
  return { code: 'rejected', message: 'Nothing was sent. Accept the risk warning and Terms to continue.', retryable: true, sent: false };
}
