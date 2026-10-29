/**
 * Fees card + fee mini in REAL mode (DESIGN §8.9 look, INTEGRATION.md §7.5 "Fees card states").
 * Money owed to the shop is exact lamports from the vault (indexer ≤ 10 min old; the owner and the
 * pending claimant read it live with `getVault`) and always rounds DOWN.
 *
 *   unclaimed      fees waiting / build up here · `I own this business`
 *   pending        h3 `Claim pending` · `unlocks in 2 d 23 h` → once unlocked, `Finalize` (anyone)
 *   claimed        `Claimed by the owner` · paid to the shop so far
 *   yours          `$X earned for your shop` · `Withdraw $Y` (when > 0; off with the reason while the network fee
 *                  would be ≥ the payout) · `Payout settings`
 * Plus the probation banner (SPEC §8.6) while the on-chain probation is running.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { TxError, VaultView } from '../chain/types';
import { countdown, dateLong, shortAddr, usdOwed } from '../lib/format';
import { openExternal } from '../lib/nav';
import { chain } from '../realdata/chain';
import { explorerTx } from '../realdata/explorer';
import { useCountdown, useTx, useUsdFresh } from '../realdata/hooks';
import { loadCoinDetail, refreshAfterTx } from '../realdata/index';
import { clearTx, isBusyPhase, phaseHelper, phaseLabel, runTx, withdrawLossWarning, withdrawToast } from '../realdata/tx';
import { lamportsToUsdFloor, solCeilSig, solFloorSig, u64 } from '../realdata/units';
import { useStore } from '../store';
import type { Coin } from '../types';
import { Button, Icon } from '../ui';
import type { OwnerState } from './util';

const VAULT_REFRESH_MS = 15_000;
/** shop-vault `NoPendingClaim` (programs/shop-vault/client constants): finalize found no claim in its window. */
const NO_PENDING_CLAIM = 118;

/** Live vault read for owners / pending claimants (exact lamports). Null until loaded. */
function useLiveVault(coin: Coin, enabled: boolean): { vault: VaultView | null; reload: () => void } {
  const [vault, setVault] = useState<VaultView | null>(null);
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  // re-read when the registry row moves (after an own tx / poll)
  const fp = `${coin.real?.feesWaitingLamports}|${coin.real?.ownerStatus}|${coin.owner ?? ''}`;
  useEffect(() => {
    if (!enabled) return;
    let on = true;
    let t: number | undefined;
    const load = async () => {
      try {
        const api = await chain();
        const v = await api.getVault(coin.placeId, coin.mint);
        // a vault that isn't on chain (yet / any more) says nothing: keep the registry numbers
        if (on) setVault(v.exists ? v : null);
      } catch {
        /* keep the registry numbers */
      }
      if (on) t = window.setTimeout(() => void load(), VAULT_REFRESH_MS);
    };
    void load();
    return () => {
      on = false;
      window.clearTimeout(t);
    };
  }, [enabled, coin.placeId, n, fp]);
  return { vault, reload };
}

/** SOL secondary line: exact lamports rounded down, 4 dp or 2 significant figures (`≈ 0.0063 SOL`, `≈ 0.000012 SOL`). */
function solLine(lamports: bigint | string): string {
  const v = u64(lamports);
  return v === 0n ? '0 SOL' : `≈ ${solFloorSig(v)} SOL`;
}

/** USD (rounded down to the cent; a non-zero amount under a cent reads `<$0.01`) or `—` when SOL/USD is stale/unknown. */
function useUsd(): (lamports: bigint | string) => string {
  const solUsd = useStore((s) => s.solUsd);
  const fresh = useUsdFresh();
  return (lamports) => (fresh && solUsd > 0 ? usdOwed(lamportsToUsdFloor(u64(lamports), solUsd), u64(lamports) > 0n) : '—');
}

function TxLine({ error, onRetry }: { error: TxError | null; onRetry?: () => void }) {
  if (!error) return null;
  const sig = error.signature;
  return (
    <p className="tx-err fees-err" role="alert">
      <span>{error.message}</span>
      {error.retryable && onRetry ? (
        <button type="button" className="link hit" onClick={onRetry}>
          Try again
        </button>
      ) : null}
      {sig ? (
        <button type="button" className="link hit" onClick={() => openExternal(error.explorerUrl ?? explorerTx(sig))}>
          View tx
        </button>
      ) : null}
    </p>
  );
}

/** Probation banner (SPEC §8.6): a claim requested now unlocks later and the owner may cancel it. */
export function ProbationBanner() {
  const until = useStore((s) => s.chain.config?.probationUntil ?? 0);
  const left = useCountdown(until > 0 ? until : null);
  if (!until || left <= 0) return null;
  return (
    <div className="dlg-box probation-banner" role="note">
      <Icon name="shield" />
      <div>
        <b>Our signing key changed recently</b>
        <small>Until {dateLong(until * 1000)}, new claims take longer and the shop's current owner can cancel them. Owners: withdraw any fees waiting.</small>
      </div>
    </div>
  );
}

/** Shared actions (Withdraw / Finalize) with tx states. */
function useVaultActions(coin: Coin) {
  const wallet = useStore((s) => s.wallet.address);
  const tx = useTx(['withdraw', 'finalize'], coin.placeId);
  const [error, setError] = useState<TxError | null>(null);
  const [running, setRunning] = useState<'withdraw' | 'finalize' | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** `reload` re-reads the live vault: after a payout, and after a refusal for cost (the card then shows why). */
  const withdraw = async (reload?: () => void) => {
    if (running) return;
    setRunning('withdraw');
    setError(null);
    const out = await runTx('withdraw', coin.placeId, async (signer, onProgress) => (await chain()).collectAndWithdraw(coin.placeId, signer, onProgress, coin.mint));
    if (!alive.current) return;
    setRunning(null);
    if (out.ok) {
      const st = useStore.getState();
      st.toast(withdrawToast(out.value, wallet), 'ok', {
        label: 'View tx',
        run: () => openExternal(out.explorerUrl || explorerTx(out.signature)),
      });
      void refreshAfterTx('withdraw', coin.mint);
      reload?.();
    } else if (out.error.code === 'rejected') clearTx('withdraw');
    else {
      setError(out.error);
      if (out.error.code === 'uneconomic') reload?.();
    }
  };

  const finalize = () => {
    const st = useStore.getState();
    st.requireWallet(() => {
      void (async () => {
        if (running) return;
        setRunning('finalize');
        setError(null);
        const out = await runTx('finalize', coin.placeId, async (signer, onProgress) => (await chain()).finalizeClaim(coin.placeId, signer, onProgress));
        if (!alive.current) return;
        setRunning(null);
        if (out.ok) {
          useStore.getState().toast('Claim finalized. The new owner can withdraw now.', 'ok', {
            label: 'View tx',
            run: () => openExternal(out.explorerUrl || explorerTx(out.signature)),
          });
          void refreshAfterTx('claim', coin.mint);
        } else if (out.error.code === 'rejected') clearTx('finalize');
        else if (out.error.programError?.program === 'shop_vault' && out.error.programError.code === NO_PENDING_CLAIM) {
          // Someone (usually our own crank, right when the window ends) finalized it first. Show the
          // shop as it is on chain now instead of an error under a button that can only fail again.
          clearTx('finalize');
          useStore.getState().toast('This claim was already finalized.', 'info');
          await loadCoinDetail(coin.mint, true).catch(() => null);
        } else {
          setError(out.error);
          // the card may be out of date (claim cancelled, already finalized after a send): re-read it from chain
          void loadCoinDetail(coin.mint, true).catch(() => null);
        }
      })();
    });
  };

  return { tx, error, running, withdraw, finalize, busy: !!running || isBusyPhase(tx?.progress) };
}

export function RealFeesCard({ coin, owner }: { coin: Coin; owner: OwnerState }) {
  const openModal = useStore((s) => s.openModal);
  const openHelp = useStore((s) => s.openHelp);
  const wallet = useStore((s) => s.wallet.address);
  const usd = useUsd();
  const real = coin.real;
  const pendingMine = !!real?.pendingOwner && real.pendingOwner === wallet;
  const live = useLiveVault(coin, owner === 'yours' || pendingMine);
  const actions = useVaultActions(coin);
  const unlockIn = useCountdown(real?.unlockTs ?? null);
  const lossId = useId();
  if (!real) return null;

  const waiting = live.vault ? live.vault.fees.total : u64(real.feesWaitingLamports);
  const withdrawable = live.vault ? live.vault.fees.total : waiting;
  const claim = () => openModal({ kind: 'claim', placeId: coin.placeId });
  const learn = (
    <button type="button" className="link" onClick={() => openHelp('fees')}>
      Learn more
    </button>
  );
  const banner = <ProbationBanner />;

  if (owner === 'yours') {
    const earned = live.vault ? live.vault.totalWithdrawn + live.vault.fees.total : u64(real.feesEarnedLamports);
    const label = actions.running === 'withdraw' ? phaseLabel(actions.tx?.progress, 'withdraw') : `Withdraw ${usd(withdrawable) === '—' ? solLine(withdrawable).replace('≈ ', '') : usd(withdrawable)}`;
    const cost = live.vault?.withdrawCostLamports;
    // the fee would eat the payout: Withdraw is off, with the reason (the chain layer refuses it too)
    const loss = withdrawLossWarning(withdrawable, cost);
    const txError = loss && actions.error?.code === 'uneconomic' ? null : actions.error;
    return (
      <>
        {banner}
        <section className="fees claimed" aria-label="Fees for your shop">
          <div className="fees-top">
            <span className="fees-ic">
              <Icon name="verified" fill />
            </span>
            <div>
              <h3>
                <b className="num">{usd(earned)}</b> earned for your shop
              </h3>
              <span className="fees-sol num">{solLine(withdrawable)} ready to withdraw</span>
              {withdrawable > 0n && cost !== undefined && !loss ? (
                // the owner pays the withdraw tx (and, once per coin, pump's creator-vault rent): rounded UP, never understated
                <span className="fees-sol num">Network fee ≈ {solCeilSig(cost)} SOL</span>
              ) : null}
              <p>
                Owner wallet{' '}
                <span className="num" translate="no">
                  {shortAddr(coin.owner)}
                </span>{' '}
                · only you can withdraw
              </p>
            </div>
          </div>
          <div className="fees-cta">
            {withdrawable > 0n ? (
              <Button
                variant="primary"
                icon="account_balance_wallet"
                loading={actions.running === 'withdraw'}
                disabled={actions.busy || !!loss}
                aria-describedby={loss ? lossId : undefined}
                onClick={() => void actions.withdraw(live.reload)}
              >
                {label}
              </Button>
            ) : null}
            <Button variant="tonal" disabled={actions.busy} onClick={() => openModal({ kind: 'claim', placeId: coin.placeId, step: 'payout' })}>
              Payout settings
            </Button>
            {withdrawable > 0n ? null : learn}
          </div>
          {loss ? (
            <p className="tx-help" id={lossId}>
              {loss}
            </p>
          ) : null}
          {actions.running ? <p className="tx-help">{phaseHelper(actions.tx?.progress)}</p> : null}
          <TxLine error={txError} onRetry={() => void actions.withdraw(live.reload)} />
        </section>
      </>
    );
  }

  if (owner === 'claimed') {
    const paid = u64(real.feesWithdrawnLamports);
    return (
      <>
        {banner}
        <section className="fees claimed" aria-label="Fees for this shop">
          <div className="fees-top">
            <span className="fees-ic">
              <Icon name="verified" fill />
            </span>
            <div>
              <h3>Claimed by the owner</h3>
              <p>
                <b className="num">{usd(paid)}</b> paid to the shop so far · {solLine(paid)}
              </p>
            </div>
          </div>
          <div className="fees-cta">{learn}</div>
        </section>
      </>
    );
  }

  if (owner === 'pending') {
    const unlocked = !!real.unlockTs && unlockIn <= 0;
    return (
      <>
        {banner}
        <section className="fees" aria-label="Claim pending for this shop">
          <div className="fees-top">
            <span className="fees-ic">
              <Icon name="schedule" />
            </span>
            <div>
              <h3>Claim pending</h3>
              <span className="fees-sol num">
                {usd(waiting)} waiting · {solLine(waiting)}
              </span>
              <p>
                {unlocked
                  ? pendingMine
                    ? 'Your public window is over. Finalize to become the owner.'
                    : 'The public window is over. Anyone can finalize it.'
                  : `${pendingMine ? 'Your claim' : 'It'} unlocks in ${countdown(unlockIn)}${real.inProbation ? ' (longer: our signing key changed recently)' : ''}. Anyone can dispute a wrong claim until then.`}
              </p>
            </div>
          </div>
          <div className="fees-cta">
            {unlocked ? (
              <Button variant="amber" icon="task_alt" loading={actions.running === 'finalize'} disabled={actions.busy} onClick={actions.finalize}>
                {actions.running === 'finalize' ? phaseLabel(actions.tx?.progress, 'finalize') : 'Finalize'}
              </Button>
            ) : (
              <Button variant="amber" icon="storefront" disabled>
                Verification in progress
              </Button>
            )}
            {pendingMine ? null : (
              <button type="button" className="link" onClick={() => openModal({ kind: 'report', placeId: coin.placeId, reason: 'impersonation' })}>
                Dispute
              </button>
            )}
            {learn}
          </div>
          {actions.running ? <p className="tx-help">{phaseHelper(actions.tx?.progress)}</p> : null}
          <TxLine error={actions.error} onRetry={actions.finalize} />
        </section>
      </>
    );
  }

  return (
    <>
      {banner}
      <section className="fees" aria-label="Fees waiting for this shop">
        <div className="fees-top">
          <span className="fees-ic">
            <Icon name="payments" fill />
          </span>
          <div>
            {waiting > 0n ? (
              <h3>
                <b className="num">{usd(waiting)}</b> waiting for this shop
              </h3>
            ) : (
              <h3>Fees for this shop build up here</h3>
            )}
            {waiting > 0n ? <span className="fees-sol num">{solLine(waiting)}</span> : null}
            <p translate="no">{`100% of creator fees from $${coin.ticker} are held for the owner. We take nothing.`}</p>
          </div>
        </div>
        <div className="fees-cta">
          <Button variant="amber" icon="storefront" onClick={claim}>
            I own this business
          </Button>
          {learn}
        </div>
      </section>
    </>
  );
}

export function RealFeeMini({ coin, owner }: { coin: Coin; owner: OwnerState }) {
  const openModal = useStore((s) => s.openModal);
  const usd = useUsd();
  const real = coin.real;
  const unlockIn = useCountdown(real?.unlockTs ?? null);
  const actions = useVaultActions(coin);
  if (!real) return null;
  const waiting = u64(real.feesWaitingLamports);
  if (owner === 'claimed' || owner === 'yours') {
    const v = owner === 'yours' ? u64(real.feesEarnedLamports) : u64(real.feesWithdrawnLamports);
    return (
      <div className="fee-mini claimed">
        <Icon name="verified" fill />
        <b className="num">
          {usd(v)}
          <span>{solLine(v)}</span>
        </b>
        <small>{owner === 'yours' ? 'earned for your shop' : 'Claimed'}</small>
        {owner === 'yours' ? (
          <Button variant="tonal" onClick={() => openModal({ kind: 'claim', placeId: coin.placeId, step: 'payout' })}>
            {waiting > 0n ? 'Withdraw' : 'Payout settings'}
          </Button>
        ) : null}
      </div>
    );
  }
  if (owner === 'pending') {
    return (
      <div className="fee-mini">
        <Icon name="schedule" />
        <b className="num">
          {usd(waiting)}
          <span>{solLine(waiting)}</span>
        </b>
        <small>{unlockIn > 0 ? `Claim pending · ${countdown(unlockIn)}` : 'Claim pending · ready'}</small>
        {real.unlockTs && unlockIn <= 0 ? (
          <Button variant="amber" className="hit" loading={actions.running === 'finalize'} disabled={actions.busy} onClick={actions.finalize}>
            {actions.running === 'finalize' ? phaseLabel(actions.tx?.progress, 'finalize') : 'Finalize'}
          </Button>
        ) : (
          <Button variant="amber" className="hit" disabled>
            Verification in progress
          </Button>
        )}
        {actions.error ? (
          <small className="tx-err" role="alert">
            {actions.error.message}
          </small>
        ) : null}
      </div>
    );
  }
  return (
    <div className="fee-mini">
      <Icon name="payments" fill />
      <b className="num">
        {usd(waiting)}
        <span>{solLine(waiting)}</span>
      </b>
      <small>waiting for this shop</small>
      <Button variant="amber" className="hit" onClick={() => openModal({ kind: 'claim', placeId: coin.placeId })}>
        I own this business
      </Button>
    </div>
  );
}
