/**
 * Real transaction plumbing for the UI (INTEGRATION.md §7.3): one tx at a time in `store.tx`,
 * TxProgress → copy, busy rules, and the devnet "Get test SOL" action.
 *
 * Nothing here signs by itself: `runTx` hands the connected wallet's signer to a chain-layer call
 * (src/chain via src/realdata/chain) that builds, co-signs, asks the wallet and sends.
 */
import type { OnProgress, TxError, TxOutcome, TxProgress, WalletSigner } from '../chain/types';
import { CLUSTER, IS_REAL } from '../mode';
import { useStore } from '../store';
import type { TxKind } from '../types';
import { openExternal } from '../lib/nav';
import { consentDeclinedError, hasConsent, requestConsent } from '../legal/consent';
import { currentSigner, preSendError, toTxError, walletUnsupportedError } from './chain';
import { loadWallet } from './index';
import { FEE_RESERVE_LAMPORTS, solCeil, solCeilSig, solFloor, solFloorSig } from './units';
import { shortAddr } from '../lib/format';

export const FAUCET_URL = 'https://faucet.solana.com';

/** Phases where closing the modal / leaving would lose a sent transaction (INTEGRATION.md §7.3). */
export function isBusyPhase(p: TxProgress | null | undefined): boolean {
  return !!p && (p.phase === 'sending' || p.phase === 'confirming' || p.phase === 'registering');
}

/** Button / row copy for a phase. */
export function phaseLabel(p: TxProgress | null | undefined, kind: TxKind): string {
  if (!p) return 'Preparing…';
  switch (p.phase) {
    case 'preparing':
      return 'Preparing…';
    case 'awaiting-signature':
      return `Approve in ${p.walletName || 'your wallet'}…`;
    case 'sending':
      return 'Sending…';
    case 'confirming': {
      const s = Math.floor((p.elapsedMs ?? 0) / 1000);
      return s >= 5 ? `Confirming… ${s}s` : 'Confirming on Solana…';
    }
    case 'registering':
      return kind === 'launch' ? 'Putting it on the map…' : kind === 'claim' ? 'Recording your claim…' : 'Updating…';
    case 'done':
    default:
      return 'Done';
  }
}

/** Helper line under the button while the wallet prompt is open. */
export function phaseHelper(p: TxProgress | null | undefined): string | null {
  return p?.phase === 'awaiting-signature' ? 'Check your wallet window' : null;
}

/**
 * Run one chain transaction for `placeId`. Mirrors progress into `store.tx`, maps anything thrown
 * to a TxError, and never throws. Refuses while another tx is busy. The first one in a browser waits
 * for the risk + Terms consent (declined = `rejected`, nothing sent).
 */
export interface RunTxOptions {
  onProgress?: OnProgress;
  /**
   * Wrap the wallet signer, e.g. to refuse signing once the user closed the modal while we were
   * still preparing ("cancellable, nothing was sent", INTEGRATION.md §7.3).
   */
  wrapSigner?: (s: WalletSigner) => WalletSigner;
}

/** A rejection the chain layer maps to `rejected` (as if the user cancelled in the wallet). */
export function userCancelled(): Error {
  return Object.assign(new Error('User rejected the request.'), { code: 4001, name: 'WalletSignTransactionError' });
}

export async function runTx<T>(
  kind: TxKind,
  placeId: string,
  op: (signer: WalletSigner, onProgress: OnProgress) => Promise<TxOutcome<T>>,
  opts: RunTxOptions = {},
): Promise<TxOutcome<T>> {
  const onProgress = opts.onProgress;
  if (!IS_REAL) return { ok: false, error: { code: 'unknown', message: 'Not available in the demo.', retryable: false, sent: false } };
  // One-time risk + Terms consent before the first real transaction (src/legal/consent.ts). Every flow starts its
  // transaction here, so none can skip it. Once on record this stays synchronous (no await).
  if (!hasConsent() && !(await requestConsent())) return { ok: false, error: consentDeclinedError() };
  const st = useStore.getState();
  if (st.chain.status === 'mismatch') {
    // the Worker serves another cluster than this build: stay read-only (INTEGRATION.md §1.3)
    return { ok: false, error: { code: 'wrong-network', message: 'Network mismatch. Reload, or open the demo.', retryable: false, sent: false } };
  }
  if (st.tx && isBusyPhase(st.tx.progress)) {
    return { ok: false, error: { code: 'unknown', message: 'Another transaction is still confirming. Wait a moment.', retryable: true, sent: false } };
  }
  const raw = currentSigner();
  const signer = raw && opts.wrapSigner ? opts.wrapSigner(raw) : raw;
  if (!signer) {
    const error = walletUnsupportedError();
    st.setTx({ kind, placeId, progress: null, error });
    return { ok: false, error };
  }
  let last: TxProgress = { phase: 'preparing', walletName: signer.walletName };
  const report: OnProgress = (p) => {
    last = { ...p, walletName: p.walletName ?? signer.walletName };
    const cur = useStore.getState().tx;
    // a later flow replaced this one: stop mirroring
    if (cur && (cur.kind !== kind || cur.placeId !== placeId)) return;
    useStore.getState().setTx({ kind, placeId, progress: last, error: null });
    onProgress?.(last);
  };
  report(last);
  let out: TxOutcome<T>;
  try {
    out = await op(signer, report);
  } catch (e) {
    const sent = !!last.signature;
    const error = await toTxError(e, { sent, signature: last.signature, walletName: signer.walletName }).catch(() => preSendError(e));
    out = { ok: false, error };
  }
  const cur = useStore.getState().tx;
  if (!cur || (cur.kind === kind && cur.placeId === placeId)) {
    useStore.getState().setTx(out.ok ? null : { kind, placeId, progress: null, error: out.error });
  }
  if (!out.ok && out.error.code === 'policy' && CLUSTER === 'devnet') {
    // devnet only: the Worker's §8.4 violations help debugging (never on mainnet)
    console.warn('[cornershop] co-sign refused', out.error.logs ?? []);
  }
  return out;
}

/** Clear a finished / failed tx of this kind (modal closed, Try again). */
export function clearTx(kind?: TxKind): void {
  const cur = useStore.getState().tx;
  if (!cur || (kind && cur.kind !== kind) || isBusyPhase(cur.progress)) return;
  useStore.getState().setTx(null);
}

/* ------------------------------------------------------------------ insufficient SOL (§7.7) */

export interface Shortfall {
  needLamports: bigint;
  haveLamports: bigint;
  /** `Not enough SOL — you need about 0.1132 SOL (you have 0.05)` */
  message: string;
}

/** `balance ≥ cost + 0.005 SOL` before any wallet prompt; null when it fits (or the balance is unknown). */
export function shortfall(costLamports: bigint, balanceLamports: string | null, reserveLamports = FEE_RESERVE_LAMPORTS): Shortfall | null {
  if (balanceLamports == null) return null;
  let have: bigint;
  try {
    have = BigInt(balanceLamports);
  } catch {
    return null;
  }
  const need = costLamports + reserveLamports;
  if (have >= need) return null;
  return { needLamports: need, haveLamports: have, message: `Not enough SOL — you need about ${solCeil(need)} SOL (you have ${solFloor(have)})` };
}

/** Second line under a shortfall: devnet points at test SOL, mainnet asks to add SOL. */
export function shortfallHint(): string {
  return CLUSTER === 'devnet' ? 'Devnet SOL is free. Get some test SOL, then try again.' : 'Add SOL to your wallet to continue';
}

/** Message for a TxError of `insufficient-sol` that carries `needLamports`. */
export function insufficientMessage(err: TxError): string {
  if (err.code !== 'insufficient-sol' || !err.needLamports) return err.message;
  try {
    return `Not enough SOL. You need about ${solCeil(BigInt(err.needLamports))} SOL.`;
  } catch {
    return err.message;
  }
}

/* ------------------------------------------------------------------ withdraw */

/**
 * `Withdrew 0.0063 SOL to BMAo…8JhM · network fee 0.000012 SOL`: the vault payout (the `Withdrawn` event, rounded
 * down) and what the tx cost the owner (rounded up; a first withdraw's one-time rent included). Never "Withdrew 0 SOL":
 * an unknown or zero payout says only that the withdrawal is confirmed, and an unreadable tx claims no amount at all.
 */
export function withdrawToast(v: { withdrawnLamports: bigint | null; feeLamports: bigint | null }, wallet: string | null): string {
  const to = wallet ? shortAddr(wallet) : 'your wallet';
  const fee = v.feeLamports !== null && v.feeLamports > 0n ? ` · network fee ${solCeilSig(v.feeLamports)} SOL` : '';
  const paid = v.withdrawnLamports !== null && v.withdrawnLamports > 0n ? v.withdrawnLamports : null;
  return paid === null ? `Withdrawal confirmed to ${to}${fee}` : `Withdrew ${solFloorSig(paid)} SOL to ${to}${fee}`;
}

/**
 * Why the Withdraw button is off, or null when withdrawing pays out more than it costs. Cost ≥ fees waiting would take
 * the owner's money (the chain layer refuses it too, `uneconomic`). Unknown cost (vault not read yet) = no warning.
 */
export function withdrawLossWarning(readyLamports: bigint, costLamports: bigint | null | undefined): string | null {
  if (readyLamports <= 0n || costLamports == null || costLamports < readyLamports) return null;
  return `Network fee ≈ ${solCeilSig(costLamports)} SOL is more than the ${solFloorSig(readyLamports)} SOL waiting. Withdrawing now would cost you more than you receive.`;
}

/* ------------------------------------------------------------------ devnet test SOL */

let airdropping = false;

/**
 * `Get test SOL` (devnet only). The devnet test wallet asks our Worker's faucet (compiled out of
 * every other build — check-bundle proves it); any other wallet opens faucet.solana.com.
 */
export async function getTestSol(): Promise<void> {
  const st = useStore.getState();
  if (CLUSTER !== 'devnet') return;
  if (import.meta.env.VITE_TEST_WALLET === '1' && import.meta.env.VITE_CLUSTER === 'devnet') {
    const tw = (window as unknown as { __csTestWallet?: { address: string; airdrop: () => Promise<unknown> } }).__csTestWallet;
    if (tw && st.wallet.address === tw.address) {
      if (airdropping) return;
      airdropping = true;
      try {
        // the test wallet shows its own progress / result toasts, including the Worker's reason for a refusal
        // ("This wallet already has test SOL", faucet empty, daily limit); null = nothing was sent
        const got = await tw.airdrop();
        if (got !== null) await loadWallet({ force: true }).catch(() => {});
      } catch {
        useStore.getState().toast("Couldn't get test SOL right now. Try faucet.solana.com.", 'error', { label: 'Open', run: () => openExternal(FAUCET_URL) });
      } finally {
        airdropping = false;
      }
      return;
    }
  }
  openExternal(FAUCET_URL);
}
