/**
 * Place panel header blocks (DESIGN §8.2, §8.4, §8.6): coin hero / launchable `.lhero`, the
 * launched `.ph` (name, ticker/price line, meta, owner line + info popovers) and the launchable
 * `.ph`. Plus the Unclaimed / Owner popovers (§12.6).
 */
import { useRef, useState, type ReactNode } from 'react';
import { links } from '../config';
import { dateLong, launchedAgo, plural, shortAddr, usdCompact, usdPrice } from '../lib/format';
import { openExternal } from '../lib/nav';
import { coinCategoryLabel, useStore } from '../store';
import type { Coin } from '../types';
import { BackChip, Change, Icon, Popover, useTickFlash } from '../ui';
import { useNow, type OwnerState } from './util';

/* ------------------------------------------------------------------ hero (desktop/tablet) */

export function CoinHero({ coin }: { coin: Coin }) {
  const openModal = useStore((s) => s.openModal);
  const [broken, setBroken] = useState(false);
  const logo = coin.logo;
  if (logo.kind === 'upload' && !broken) {
    const credit = logo.credit;
    const alt = `${coin.name} coin art`;
    return (
      <div className="hero">
        <img src={logo.dataUrl} alt={alt} onError={() => setBroken(true)} draggable={false} />
        <button
          type="button"
          className="hero-btn"
          onClick={() => openModal({ kind: 'lightbox', src: logo.dataUrl, alt, credit: credit?.text ?? 'Uploaded by launcher' })}
        >
          <Icon name="photo_library" />
          Coin art
        </button>
        <span className="hero-credit">{creditNode(credit)}</span>
      </div>
    );
  }
  return (
    <div className="hero hero-sticker" style={{ background: logo.bg }} aria-hidden="true">
      <span className="hero-face">{logo.emoji}</span>
    </div>
  );
}

function creditNode(credit: { text: string; href?: string } | undefined): ReactNode {
  if (!credit) return 'Uploaded by launcher';
  // "Uploaded by launcher · Photo: Unsplash" — link the photographer source (new tab)
  const m = credit.text.match(/^(.*Photo: )(.+)$/);
  if (credit.href && m) {
    return (
      <>
        {m[1]}
        <a href={credit.href} target="_blank" rel="noopener noreferrer">
          {m[2]}
        </a>
      </>
    );
  }
  return credit.text;
}

/** `.lhero` launchable illustration (decorative). */
/** `blocked`: a place that can never get a coin (not a business / closed): no rocket, no launch wording. */
export function LaunchHero({ blocked = false }: { blocked?: boolean }) {
  return (
    <div className={['lhero', blocked ? 'is-blocked' : ''].filter(Boolean).join(' ')} aria-hidden="true">
      <div className="lh-ghost g1" />
      <div className="lh-ghost g2" />
      <div className="lh-ghost g3" />
      <div className="lh-coin">
        <Icon name={blocked ? 'block' : 'rocket_launch'} fill={!blocked} />
      </div>
      <span className="lh-cap">{blocked ? "Can't have a coin" : 'No coin yet'}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ popovers (§12.6) */

function InfoButton({ label, children, width = 280 }: { label: string; children: (close: () => void) => ReactNode; width?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="ph-info hit"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="info" size={15} />
      </button>
      <Popover anchor={ref} open={open} onClose={() => setOpen(false)} width={width} ariaLabel={label} className="ph-pop">
        {children(() => setOpen(false))}
      </Popover>
    </>
  );
}

export function UnclaimedPopoverBody({ close }: { close: () => void }) {
  const openHelp = useStore((s) => s.openHelp);
  return (
    <>
      <p className="pop-p">
        Anyone can launch a coin for any shop. Until the owner verifies, the coin isn't affiliated with the business and all creator fees are held
        for them.
      </p>
      <button
        type="button"
        className="link-btn pop-link"
        onClick={() => {
          close();
          openHelp('claiming');
        }}
      >
        How claiming works
      </button>
    </>
  );
}

export function OwnerPopoverBody({ coin, close }: { coin: Coin; close: () => void }) {
  const payout = coin.payoutWallet ?? coin.owner;
  return (
    <>
      <p className="pop-p">Claimed by the owner on {dateLong(coin.claimedAt ?? coin.launchedAt)}. Fees are held in the shop's vault for the owner wallet.</p>
      {payout ? (
        <button
          type="button"
          className="link-btn pop-link"
          onClick={() => {
            close();
            openExternal(links.solscanAccount(payout));
          }}
        >
          View payout wallet on Solscan
        </button>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ launched header (§8.4) */

export function OwnerLine({ coin, state }: { coin: Coin; state: OwnerState }) {
  switch (state) {
    case 'yours':
      return (
        <div className="ph-unclaimed verified">
          <Icon name="verified" fill />
          <span>
            You own this shop · fees go to{' '}
            <span className="num" translate="no">
              {shortAddr(coin.payoutWallet ?? coin.owner)}
            </span>
          </span>
        </div>
      );
    case 'claimed':
      return (
        <div className="ph-unclaimed verified">
          <Icon name="verified" fill />
          <span>Claimed · verified owner</span>
          <InfoButton label="About the verified owner">{(close) => <OwnerPopoverBody coin={coin} close={close} />}</InfoButton>
        </div>
      );
    case 'pending':
      return (
        <div className="ph-unclaimed">
          <Icon name="schedule" />
          <span>Owner verification in progress</span>
        </div>
      );
    case 'unclaimed':
    default:
      return (
        <div className="ph-unclaimed">
          <Icon name="storefront" />
          <span>Unclaimed · not affiliated with this business</span>
          <InfoButton label="What unclaimed means">{(close) => <UnclaimedPopoverBody close={close} />}</InfoButton>
        </div>
      );
  }
}

export function LaunchedHeader({ coin, state, mobile }: { coin: Coin; state: OwnerState; mobile: boolean }) {
  const flash = useTickFlash(coin.priceUsd);
  const now = useNow(60_000);
  return (
    <header className="ph" data-sheet-drag>
      <div className="ph-head">
        {mobile ? <BackChip inline /> : null}
        <h1 className="ph-title">{coin.name}</h1>
      </div>
      <div className="ph-coin">
        <span className="ticker" translate="no">
          ${coin.ticker}
        </span>
        <span className={['price', 'num', flash].filter(Boolean).join(' ')}>{usdPrice(coin.priceUsd)}</span>
        {coin.real && !coin.real.change24hKnown ? <span className="muted">—</span> : <Change value={coin.change24h} />}
        <span className="muted">· {usdCompact(coin.marketCapUsd)} mcap</span>
      </div>
      <div className="ph-row ph-meta">
        <span>{coinCategoryLabel(coin)} coin</span>
        <span className="dot-sep">·</span>
        {/* real mode: holders come from an hourly count; unknown → not shown */}
        {coin.real && !coin.real.holdersKnown ? null : (
          <>
            <span>{plural(coin.holders, 'holder')}</span>
            <span className="dot-sep">·</span>
          </>
        )}
        <span>{launchedAgo(coin.launchedAt, now)}</span>
      </div>
      <OwnerLine coin={coin} state={state} />
    </header>
  );
}

/* ------------------------------------------------------------------ launchable header (§8.6) */

export function LaunchableHeader({
  mobile,
  draftTicker,
  preclaimedBy,
  notLaunchable,
}: {
  mobile: boolean;
  /** Ticker the user typed earlier in the launch modal (`.ticker.ghost`). */
  draftTicker?: string | null;
  /** Payout wallet when the connected wallet verified this shop before it had a coin. */
  preclaimedBy?: string | null;
  /** Why this place can never get a coin (not a business / closed), Phase-1 minor #4. */
  notLaunchable?: string | null;
}) {
  if (notLaunchable) {
    return (
      <header className="ph" data-sheet-drag>
        <div className="ph-head">
          {mobile ? <BackChip inline /> : null}
          <h1 className="ph-title">{"This place can't have a coin"}</h1>
        </div>
        <div className="ph-row ph-meta">
          <span>{notLaunchable === "This place can't have a coin" ? 'Only open businesses can be launched' : notLaunchable}</span>
        </div>
      </header>
    );
  }
  return (
    <header className="ph" data-sheet-drag>
      <div className="ph-head">
        {mobile ? <BackChip inline /> : null}
        <h1 className="ph-title">Be the first to launch this shop</h1>
      </div>
      {draftTicker ? (
        <div className="ph-coin">
          <span className="ticker ghost" translate="no">
            ${draftTicker}
          </span>
          <span className="sr">Your draft ticker, not launched yet</span>
        </div>
      ) : null}
      <div className="ph-row ph-meta">
        <span>One coin per place</span>
        <span className="dot-sep">·</span>
        <span>first launch wins</span>
      </div>
      {preclaimedBy ? (
        <div className="ph-unclaimed verified">
          <Icon name="verified" fill />
          <span>
            You own this shop · fees go to{' '}
            <span className="num" translate="no">
              {shortAddr(preclaimedBy)}
            </span>
          </span>
        </div>
      ) : (
        <div className="ph-unclaimed">
          <Icon name="payments" />
          <span>100% of creator fees are held for the owner</span>
        </div>
      )}
    </header>
  );
}
