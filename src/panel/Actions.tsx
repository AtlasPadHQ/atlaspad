/**
 * Round action row (desktop/tablet `.actions`) and pills (mobile `.pills`), DESIGN §8.7 / §18.2.
 *
 * Launched:   Buy · Sell · Share · Claim (Owner / Payouts) · Open in Maps
 * Launchable: Launch · Watch (Watching) · Share · Claim · Open in Maps
 * Disabled actions use aria-disabled (so their tooltip still shows) and do nothing on click.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { LAUNCH_PULSE_EVENT } from '../lib/events';
import { openInMaps } from '../lib/nav';
import { prefersReducedMotion } from '../lib/media';
import { useStore } from '../store';
import type { Coin, Place, TradeSide } from '../types';
import { Icon, Popover } from '../ui';
import { OwnerPopoverBody } from './Header';
import { LAUNCH_NEEDS_GOOGLE, panelScroller, shareBlockReason, type OwnerState } from './util';


interface ActDef {
  key: string;
  icon: string;
  fill?: boolean;
  /** Desktop label. */
  label: string;
  /** Mobile pill label (defaults to `label`). */
  pill?: string;
  primary?: boolean;
  disabledTip?: string | null;
  onClick: () => void;
  ref?: RefObject<HTMLButtonElement>;
  pressed?: boolean;
}

function Act({ a, mobile, pulse }: { a: ActDef; mobile: boolean; pulse?: boolean }) {
  const disabled = !!a.disabledTip;
  const common = {
    ref: a.ref,
    type: 'button' as const,
    'aria-disabled': disabled || undefined,
    'aria-pressed': a.pressed,
    'data-tip': a.disabledTip ?? undefined,
    onClick: () => {
      if (!disabled) a.onClick();
      // touch screens show no tooltips (DESIGN §13.2): say why the action is unavailable
      else if (mobile && a.disabledTip) useStore.getState().toast(a.disabledTip, 'info');
    },
  };
  if (mobile) {
    return (
      <button {...common} className={['btn', a.primary ? 'btn-primary' : 'btn-outline', 'hit', pulse ? 'pulse' : ''].filter(Boolean).join(' ')}>
        <Icon name={a.icon} fill={a.fill || a.primary} />
        {a.pill ?? a.label}
      </button>
    );
  }
  return (
    <button {...common} className={['act', a.primary ? 'primary' : '', pulse ? 'pulse' : ''].filter(Boolean).join(' ')}>
      <span className="circ">
        <Icon name={a.icon} fill={a.fill || a.primary} />
      </span>
      <span className="t">{a.label}</span>
    </button>
  );
}

function Row({ acts, mobile, pulse, children }: { acts: ActDef[]; mobile: boolean; pulse?: boolean; children?: ReactNode }) {
  return (
    <div className={mobile ? 'pills' : 'actions'} role="group" aria-label="Actions">
      {acts.map((a, i) => (
        <Act key={a.key} a={a} mobile={mobile} pulse={pulse && i === 0} />
      ))}
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ launched */

export function LaunchedActions({
  place,
  coin,
  owner,
  mobile,
  onTrade,
}: {
  place: Place;
  coin: Coin;
  owner: OwnerState;
  mobile: boolean;
  onTrade: (side: TradeSide) => void;
}) {
  const wallet = useStore((s) => s.wallet.address);
  const held = useStore((s) => s.holdings[coin.placeId] ?? 0);
  const openModal = useStore((s) => s.openModal);
  const requireWallet = useStore((s) => s.requireWallet);
  const claimRef = useRef<HTMLButtonElement>(null);
  const [ownerPop, setOwnerPop] = useState(false);

  const claim: ActDef =
    owner === 'claimed'
      ? { key: 'claim', icon: 'verified', fill: true, label: 'Owner', ref: claimRef, onClick: () => setOwnerPop((o) => !o) }
      : owner === 'yours'
        ? { key: 'claim', icon: 'verified', fill: true, label: 'Payouts', onClick: () => openModal({ kind: 'claim', placeId: coin.placeId, step: 'payout' }) }
        : { key: 'claim', icon: 'verified', label: 'Claim', onClick: () => openModal({ kind: 'claim', placeId: coin.placeId }) };

  const buy: ActDef = {
    key: 'buy',
    icon: 'add_shopping_cart',
    label: 'Buy',
    pill: `Buy $${coin.ticker}`,
    primary: true,
    onClick: () => requireWallet(() => onTrade('buy')),
  };
  const sell: ActDef = {
    key: 'sell',
    icon: 'sell',
    label: 'Sell',
    disabledTip: wallet && !(held > 0) ? `You don't hold $${coin.ticker}` : null,
    onClick: () => requireWallet(() => onTrade('sell')),
  };
  const share: ActDef = { key: 'share', icon: 'ios_share', label: 'Share', onClick: () => openModal({ kind: 'share', placeId: coin.placeId, variant: 'coin' }) };
  const maps: ActDef = { key: 'maps', icon: 'open_in_new', label: 'Open in Maps', onClick: () => openInMaps(place) };

  const acts = mobile ? [buy, sell, claim, share, maps] : [buy, sell, share, claim, maps];
  return (
    <Row acts={acts} mobile={mobile}>
      <Popover anchor={claimRef} open={ownerPop && owner === 'claimed'} onClose={() => setOwnerPop(false)} ariaLabel="Shop owner" className="ph-pop">
        <OwnerPopoverBody coin={coin} close={() => setOwnerPop(false)} />
      </Popover>
    </Row>
  );
}

/* ------------------------------------------------------------------ launchable */

export function LaunchableActions({
  place,
  mobile,
  launchBlocked,
  preclaimed,
  notBusiness = null,
}: {
  place: Place;
  mobile: boolean;
  /** Reason Launch is unavailable (tooltip), or null. */
  launchBlocked: string | null;
  /** The connected wallet verified this place already → Payouts. */
  preclaimed: boolean;
  /** Not a launchable business (city, road, plus code, closed…): Watch / Claim are off too. */
  notBusiness?: string | null;
}) {
  const watching = useStore((s) => s.watch.includes(place.id));
  const openModal = useStore((s) => s.openModal);
  const requireWallet = useStore((s) => s.requireWallet);
  const [pulse, setPulse] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const claimable = place.source === 'google' || place.source === 'demo';

  // Map: launchable balloon clicked → scroll the panel to the top and pulse Launch once (200ms)
  useEffect(() => {
    const onPulse = () => {
      const scroller = panelScroller(rowRef.current);
      if (scroller) scroller.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      setPulse(false);
      requestAnimationFrame(() => setPulse(true));
    };
    window.addEventListener(LAUNCH_PULSE_EVENT, onPulse);
    return () => window.removeEventListener(LAUNCH_PULSE_EVENT, onPulse);
  }, []);
  useEffect(() => {
    if (!pulse) return;
    const t = setTimeout(() => setPulse(false), 260);
    return () => clearTimeout(t);
  }, [pulse]);

  const acts: ActDef[] = [
    {
      key: 'launch',
      icon: 'rocket_launch',
      label: 'Launch',
      pill: 'Launch a coin',
      primary: true,
      disabledTip: launchBlocked,
      onClick: () => openModal({ kind: 'launch', place }),
    },
    {
      key: 'watch',
      icon: watching ? 'notifications_active' : 'notifications',
      fill: watching,
      label: watching ? 'Watching' : 'Watch',
      pressed: watching,
      disabledTip: notBusiness,
      onClick: () =>
        requireWallet(() => {
          const st = useStore.getState();
          const on = st.toggleWatch(place.id);
          if (on === null) return;
          st.toast(on ? 'Added to Watching in My coins.' : 'Stopped watching this shop.', on ? 'ok' : 'info', undefined, on ? 'notifications_active' : undefined);
        }),
    },
    {
      key: 'share',
      icon: 'ios_share',
      label: 'Share',
      disabledTip: shareBlockReason(place),
      onClick: () => openModal({ kind: 'share', placeId: place.id, variant: 'place' }),
    },
    {
      key: 'claim',
      icon: 'verified',
      fill: preclaimed,
      label: preclaimed ? 'Payouts' : 'Claim',
      disabledTip: notBusiness ?? (claimable ? null : LAUNCH_NEEDS_GOOGLE),
      onClick: () => openModal({ kind: 'claim', placeId: place.id, ...(preclaimed ? { step: 'payout' as const } : {}) }),
    },
    { key: 'maps', icon: 'open_in_new', label: 'Open in Maps', onClick: () => openInMaps(place) },
  ];
  const ordered = mobile ? [acts[0], acts[1], acts[3], acts[2], acts[4]] : acts;

  return (
    <div ref={rowRef} className="act-wrap">
      <Row acts={ordered.filter((a): a is ActDef => !!a)} mobile={mobile} pulse={pulse} />
    </div>
  );
}
