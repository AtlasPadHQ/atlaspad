/**
 * Fees-waiting card (desktop/tablet `.fees`) and fee mini (mobile `.fee-mini`), DESIGN §8.9.
 * States: unclaimed (fees > 0 / = 0), verification in progress, claimed (visitor), you own it.
 * Plus the mobile `.strip` (chart card · fee mini · coin art).
 */
import { solApprox, shortAddr, usdFull } from '../lib/format';
import { feesWaiting, isOwnPendingClaim, useStore } from '../store';
import type { Coin } from '../types';
import { Button, Icon } from '../ui';
import { ChartCard } from './CoinSummary';
import { RealFeeMini, RealFeesCard } from './RealFees';
import type { OwnerState } from './util';

function useSolUsd() {
  return useStore((s) => s.solUsd);
}

export function FeesCard({ coin, owner }: { coin: Coin; owner: OwnerState }) {
  return coin.real ? <RealFeesCard coin={coin} owner={owner} /> : <DemoFeesCard coin={coin} owner={owner} />;
}

function DemoFeesCard({ coin, owner }: { coin: Coin; owner: OwnerState }) {
  const solUsd = useSolUsd();
  const openModal = useStore((s) => s.openModal);
  const openHelp = useStore((s) => s.openHelp);
  const waiting = feesWaiting(coin);
  const claim = () => openModal({ kind: 'claim', placeId: coin.placeId });
  const learn = (
    <button type="button" className="link" onClick={() => openHelp('fees')}>
      Learn more
    </button>
  );

  if (owner === 'claimed' || owner === 'yours') {
    const mine = owner === 'yours';
    return (
      <section className="fees claimed" aria-label="Fees for this shop">
        <div className="fees-top">
          <span className="fees-ic">
            <Icon name="verified" fill />
          </span>
          <div>
            {mine ? (
              <h3>
                <b className="num">{usdFull(coin.feesEarnedUsd)}</b> earned for your shop
              </h3>
            ) : (
              <h3>Claimed by the owner</h3>
            )}
            {mine ? (
              <p>
                Paid to{' '}
                <span className="num" translate="no">
                  {shortAddr(coin.payoutWallet ?? coin.owner)}
                </span>{' '}
                · first payout after the 72-hour hold
              </p>
            ) : (
              <p>
                <b className="num">{usdFull(coin.feesClaimedUsd)}</b> paid to the shop so far · {solApprox(coin.feesClaimedUsd / solUsd)}
              </p>
            )}
          </div>
        </div>
        <div className="fees-cta">
          {mine ? (
            <Button variant="tonal" onClick={() => openModal({ kind: 'claim', placeId: coin.placeId, step: 'payout' })}>
              Payout settings
            </Button>
          ) : null}
          {learn}
        </div>
      </section>
    );
  }

  const pending = owner === 'pending';
  // this browser sent the manual-review claim (DESIGN §12.3): it isn't "an owner", it's you
  const ownPending = pending && isOwnPendingClaim(coin.placeId);
  return (
    <section className="fees" aria-label="Fees waiting for this shop">
      <div className="fees-top">
        <span className="fees-ic">
          <Icon name="payments" fill />
        </span>
        <div>
          {waiting > 0 || pending ? (
            <h3>
              <b className="num">{usdFull(waiting)}</b> waiting for this shop
            </h3>
          ) : (
            <h3>Fees for this shop build up here</h3>
          )}
          {waiting > 0 ? <span className="fees-sol num">{solApprox(waiting / solUsd)}</span> : null}
          <p translate="no">
            {ownPending
              ? 'Your claim is being reviewed. Usually within 3 days.'
              : pending
                ? 'An owner is verifying right now.'
                : `100% of creator fees from $${coin.ticker} are held for the owner. We take nothing.`}
          </p>
        </div>
      </div>
      <div className="fees-cta">
        <Button variant="amber" icon="storefront" disabled={pending} onClick={claim}>
          {pending ? 'Verification in progress' : 'I own this business'}
        </Button>
        {learn}
      </div>
    </section>
  );
}

export function FeeMini({ coin, owner }: { coin: Coin; owner: OwnerState }) {
  return coin.real ? <RealFeeMini coin={coin} owner={owner} /> : <DemoFeeMini coin={coin} owner={owner} />;
}

function DemoFeeMini({ coin, owner }: { coin: Coin; owner: OwnerState }) {
  const solUsd = useSolUsd();
  const openModal = useStore((s) => s.openModal);
  const waiting = feesWaiting(coin);
  if (owner === 'claimed' || owner === 'yours') {
    return (
      <div className="fee-mini claimed">
        <Icon name="verified" fill />
        <b className="num">
          {usdFull(owner === 'yours' ? coin.feesEarnedUsd : coin.feesClaimedUsd)}
          <span>{solApprox((owner === 'yours' ? coin.feesEarnedUsd : coin.feesClaimedUsd) / solUsd)}</span>
        </b>
        <small>{owner === 'yours' ? 'earned for your shop' : 'Claimed'}</small>
        {owner === 'yours' ? (
          <Button variant="tonal" onClick={() => openModal({ kind: 'claim', placeId: coin.placeId, step: 'payout' })}>
            Payout settings
          </Button>
        ) : null}
      </div>
    );
  }
  const pending = owner === 'pending';
  return (
    <div className="fee-mini">
      <Icon name="payments" fill />
      <b className="num">
        {usdFull(waiting)}
        <span>{solApprox(waiting / solUsd)}</span>
      </b>
      <small>waiting for this shop</small>
      <Button variant="amber" className="hit" disabled={pending} onClick={() => openModal({ kind: 'claim', placeId: coin.placeId })}>
        {pending ? 'Verification in progress' : 'I own this business'}
      </Button>
    </div>
  );
}

/** Mobile `.strip`: chart card (→ Coin tab) · fee mini · coin art (→ lightbox; hidden for stickers). */
export function MobileStrip({ coin, owner, onChart }: { coin: Coin; owner: OwnerState; onChart: () => void }) {
  const openModal = useStore((s) => s.openModal);
  const logo = coin.logo;
  return (
    <div className="strip">
      <ChartCard coin={coin} onOpen={onChart} />
      <FeeMini coin={coin} owner={owner} />
      {logo.kind === 'upload' ? (
        <button
          type="button"
          className="ph-img"
          aria-label="Coin art"
          onClick={() =>
            openModal({ kind: 'lightbox', src: logo.dataUrl, alt: `${coin.name} coin art`, credit: logo.credit?.text ?? 'Uploaded by launcher' })
          }
        >
          <img src={logo.dataUrl} alt="" draggable={false} />
          <small>Coin art</small>
        </button>
      ) : null}
    </div>
  );
}
