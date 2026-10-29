/**
 * Static place-panel sections: How-it-works steps (§8.6), About tab (§8.5), footer (§8.13),
 * loading skeletons (§13.3) and the error state.
 */
import { usePhoneOff } from '../claim/phoneOff';
import { categoryLabel } from '../lib/categories';
import { dateLong, shortAddr } from '../lib/format';
import { useStore } from '../store';
import type { Coin } from '../types';
import { Button, EmptyState, Icon, Sk } from '../ui';
import { LaunchHero } from './Header';
import type { OwnerState } from './util';

export function Steps({ full }: { full?: boolean }) {
  const phoneOff = usePhoneOff();
  return (
    <ol className={['steps', full ? 'full' : ''].filter(Boolean).join(' ')} aria-label="How it works">
      <li>
        <span className="sn" aria-hidden="true">
          1
        </span>
        <span>
          <b>Launch</b>
          <small>~20 seconds</small>
        </span>
      </li>
      <li>
        <span className="sn" aria-hidden="true">
          2
        </span>
        <span>
          <b>People trade</b>
          <small>fees build up</small>
        </span>
      </li>
      <li>
        <span className="sn" aria-hidden="true">
          3
        </span>
        <span>
          <b>Owner claims</b>
          <small>{phoneOff ? 'website code' : 'phone check'}</small>
        </span>
      </li>
    </ol>
  );
}

const OWNER_TEXT: Record<OwnerState, string> = {
  unclaimed: 'Unclaimed · not affiliated with this business',
  pending: 'Owner verification in progress',
  claimed: 'Claimed · verified owner',
  yours: 'You own this shop',
};

export function AboutCoin({ coin, owner }: { coin: Coin; owner: OwnerState }) {
  const me = useStore((s) => s.wallet.address);
  const phoneOff = usePhoneOff();
  return (
    <>
      <h4 className="sec-h">About this coin</h4>
      <div className="info">
        {coin.description ? (
          <div className="irow static">
            <Icon name="info" />
            <span className="main about-desc">{coin.description}</span>
          </div>
        ) : null}
        <div className="irow static">
          <Icon name="rocket_launch" />
          <span className="main">
            Launched by{' '}
            <span className="num" translate="no">
              {me && coin.launcher === me ? 'you' : shortAddr(coin.launcher)}
            </span>
          </span>
        </div>
        <div className="irow static">
          <Icon name="schedule" />
          <span className="main">Launched {dateLong(coin.launchedAt)}</span>
        </div>
        <div className="irow static">
          <Icon name="storefront" />
          <span className="main">
            <small>Category</small>
            {categoryLabel(coin.place.category)}
          </span>
        </div>
        <div className="irow static">
          <Icon name="toll" />
          <span className="main">Launchpad: pump.fun</span>
        </div>
      </div>
      <h4 className="sec-h">Fees &amp; owner</h4>
      <div className="info">
        <div className="irow static">
          <Icon name="payments" />
          <span className="main">100% of creator fees go to this shop's vault</span>
        </div>
        <div className="irow static">
          <Icon name="verified" fill={owner === 'claimed' || owner === 'yours'} />
          <span className="main">
            {owner === 'yours' ? `You own this shop · fees go to ${shortAddr(coin.payoutWallet ?? coin.owner)}` : OWNER_TEXT[owner]}
          </span>
        </div>
        <div className="irow static">
          <Icon name={phoneOff ? 'language' : 'call'} />
          <span className="main">{phoneOff ? "Owners verify with a code on the shop's own website" : 'Owners verify by a phone call to the number on the Google listing'}</span>
        </div>
      </div>
    </>
  );
}

export function PanelFoot({ placeId, launched }: { placeId: string; launched: boolean }) {
  const openModal = useStore((s) => s.openModal);
  if (launched) {
    return (
      <p className="foot">
        Coins are launched by anyone. The business has not endorsed this coin.{' '}
        <button type="button" className="link-btn" onClick={() => openModal({ kind: 'report', placeId })}>
          Report
        </button>
        {' · '}
        <button type="button" className="link-btn" onClick={() => openModal({ kind: 'optout', placeId })}>
          Business opt-out
        </button>
      </p>
    );
  }
  return (
    <p className="foot">
      Coins on AtlasPad are launched by the public and are not affiliated with the business.{' '}
      <button type="button" className="link-btn" onClick={() => openModal({ kind: 'optout', placeId })}>
        Business opt-out
      </button>
    </p>
  );
}

/* ------------------------------------------------------------------ skeletons (§13.3) */

export function GoogleSkeleton() {
  return (
    <div className="gmp-slot is-loading" aria-hidden="true">
      <div className="gmp-sk static">
        <div className="gmp-sk-media">
          <Sk h="100%" r={0} className="m1" />
          <Sk h="100%" r={0} />
          <Sk h="100%" r={0} />
        </div>
        <div className="gmp-sk-text">
          <Sk w="60%" h={22} />
          <Sk w="40%" h={14} />
          <Sk w="70%" h={14} />
        </div>
      </div>
    </div>
  );
}

export function PanelSkeleton({ launchable, mobile }: { launchable: boolean; mobile: boolean }) {
  return (
    <div className="pp-sk" aria-busy="true" aria-label="Loading place">
      {mobile ? null : launchable ? <LaunchHero /> : <Sk h={240} r={0} className="sk-hero" />}
      <div className="ph sk-ph">
        <Sk w="60%" h={22} />
        <Sk w="80%" h={20} />
        <Sk w="50%" h={14} />
      </div>
      {launchable ? (
        <GoogleSkeleton />
      ) : (
        <>
          <div className="sk-acts">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className="sk-act">
                <Sk w={40} h={40} r="50%" />
                <Sk w={32} h={10} />
              </span>
            ))}
          </div>
          <div className="sk-block">
            <Sk h={112} r={16} />
          </div>
          <div className="sk-block">
            <Sk w="40%" h={28} />
            <Sk h={84} r={8} />
          </div>
        </>
      )}
    </div>
  );
}

export function PanelError({ message }: { message?: string }) {
  const closePanel = useStore((s) => s.closePanel);
  return (
    <div className="pp-error" data-sheet-drag>
      <EmptyState icon="error" title="Couldn't open this place" body={message || 'Something went wrong. Try again from the map.'}>
        <Button variant="outline" onClick={closePanel}>
          Close
        </Button>
      </EmptyState>
    </div>
  );
}
