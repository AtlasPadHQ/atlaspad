/**
 * List rows for the rail panels (DESIGN §10.1 `.frow`): avatar with event badge, two text
 * lines, right column. Rows show OUR data only — ticker, launcher-typed coin name, launcher-
 * picked category, simulated on-chain numbers — never Google names/ratings/addresses/photos.
 * OWNED BY RAIL+FEED.
 */
import type { ReactNode } from 'react';
import { pct, shortAddr, solApprox, timeAgoLong, usdCompact, usdFull, usdOwed } from '../lib/format';
import { lamportsToSol, solFloorSig, u64 } from '../realdata/units';
import { coinCategoryLabel } from '../store';
import type { Coin, FeedEvent } from '../types';
import { Icon } from '../ui';
import { openCoin, type TopSort } from './util';
import { tradeSol } from '../panel/Trades';
import './feed.css';

/* ------------------------------------------------------------------ building blocks */

export interface AvatarBadge {
  icon: string;
  /** CSS colour (token var). */
  color: string;
}

export function Avatar({ emoji, bg, badge }: { emoji: string; bg: string; badge?: AvatarBadge | null }) {
  return (
    <span className="av" style={{ background: bg }} aria-hidden="true">
      <span className="av-em">{emoji}</span>
      {badge ? (
        <i style={{ background: badge.color }}>
          <Icon name={badge.icon} />
        </i>
      ) : null}
    </span>
  );
}

/** `$TICKER` in bold, never translated. */
export function Tick({ ticker }: { ticker: string }) {
  return (
    <b translate="no" className="tick">
      ${ticker}
    </b>
  );
}

export interface ListRowProps {
  avatar: ReactNode;
  /** Leading node before the avatar (leaderboard rank). */
  lead?: ReactNode;
  t1: ReactNode;
  t2: ReactNode;
  rt?: ReactNode;
  rtSmall?: ReactNode;
  rtSmallClass?: string;
  fresh?: boolean;
  onClick: () => void;
  /** Extra trailing control rendered beside the row button (not inside it). */
  trailing?: ReactNode;
  className?: string;
}

export function ListRow({ avatar, lead, t1, t2, rt, rtSmall, rtSmallClass, fresh, onClick, trailing, className }: ListRowProps) {
  return (
    <li className={['frow-li', trailing ? 'has-trailing' : '', className ?? ''].filter(Boolean).join(' ')}>
      <button type="button" className={['frow', fresh ? 'new' : ''].filter(Boolean).join(' ')} onClick={onClick}>
        {lead}
        {avatar}
        <span className="tx">
          <span className="t1">{t1}</span>
          <span className="t2">{t2}</span>
        </span>
        {rt != null ? (
          <span className="rt">
            {rt}
            {rtSmall != null ? <small className={rtSmallClass}>{rtSmall}</small> : null}
          </span>
        ) : null}
      </button>
      {trailing}
    </li>
  );
}

/* ------------------------------------------------------------------ Live feed row (§10.2) */

const BADGE = {
  buy: { icon: 'arrow_upward', color: 'var(--cs-up)' },
  sell: { icon: 'arrow_downward', color: 'var(--cs-down)' },
  launch: { icon: 'rocket_launch', color: 'var(--cs-green)' },
  claim: { icon: 'payments', color: 'var(--cs-amber-bright)' },
  claimPending: { icon: 'schedule', color: 'var(--cs-amber-bright)' },
  owner: { icon: 'verified', color: 'var(--cs-green)' },
  pump: { icon: 'bolt', color: 'var(--cs-up)' },
} as const;

/** The event's wallet, or `You` when it is the connected wallet (never just "made in this browser"). */
function Who({ wallet, you }: { wallet: string; you?: string | null }) {
  if (you && wallet === you) return <span className="who-you">You</span>;
  return (
    <span className="mono" translate="no">
      {shortAddr(wallet)}
    </span>
  );
}

export function FeedRow({ ev, now, fresh, you }: { ev: FeedEvent; now: number; fresh: boolean; you: string | null }) {
  const t1 = (
    <>
      <Tick ticker={ev.ticker} /> · {ev.name}
    </>
  );
  const ago = timeAgoLong(ev.ts, now);
  const open = () => openCoin(ev.placeId);
  switch (ev.kind) {
    case 'trade': {
      const up = ev.side === 'buy';
      return (
        <ListRow
          fresh={fresh}
          onClick={open}
          avatar={<Avatar emoji={ev.emoji} bg={ev.bg} badge={up ? BADGE.buy : BADGE.sell} />}
          t1={t1}
          t2={
            <>
              <Who wallet={ev.wallet} you={you} />
              {up ? ' bought' : ' sold'}
            </>
          }
          rt={<span className={up ? 'up' : 'down'}>{tradeSol(ev)}</span>}
          rtSmall={ago}
        />
      );
    }
    case 'launch':
      return (
        <ListRow
          fresh={fresh}
          onClick={open}
          avatar={<Avatar emoji={ev.emoji} bg={ev.bg} badge={BADGE.launch} />}
          t1={t1}
          t2={
            <>
              <Who wallet={ev.wallet} you={you} /> launched · first launch wins
            </>
          }
          rt={<span className="new-tag">New</span>}
          rtSmall={ago}
        />
      );
    case 'claim':
      // Real mode: an ownership request (public window, still disputable), its finalization (verified owner) and
      // payouts are separate events; only a payout shows money, and its amount is the exact withdrawal.
      if (ev.stage === 'requested') {
        return (
          <ListRow
            fresh={fresh}
            onClick={open}
            avatar={<Avatar emoji={ev.emoji} bg={ev.bg} badge={BADGE.claimPending} />}
            t1={t1}
            t2={
              <>
                <Who wallet={ev.wallet} you={you} /> requested ownership · public window
              </>
            }
            rt={<span className="amb">Requested</span>}
            rtSmall={ago}
          />
        );
      }
      if (ev.stage === 'finalized') {
        return (
          <ListRow
            fresh={fresh}
            onClick={open}
            avatar={<Avatar emoji={ev.emoji} bg={ev.bg} badge={BADGE.owner} />}
            t1={t1}
            t2={
              <>
                <Who wallet={ev.wallet} you={you} /> became the verified owner
              </>
            }
            rt={<span className="up">Verified</span>}
            rtSmall={ago}
          />
        );
      }
      if (ev.stage === 'withdrawn') {
        return (
          <ListRow
            fresh={fresh}
            onClick={open}
            avatar={<Avatar emoji={ev.emoji} bg={ev.bg} badge={BADGE.claim} />}
            t1={t1}
            t2={
              <>
                <Who wallet={ev.wallet} you={you} /> withdrew fees
              </>
            }
            rt={<span className="amb">{ev.usd > 0 ? usdFull(ev.usd) : `${solFloorSig(ev.lamports ?? '0')} SOL`}</span>}
            rtSmall={ago}
          />
        );
      }
      return (
        <ListRow
          fresh={fresh}
          onClick={open}
          avatar={<Avatar emoji={ev.emoji} bg={ev.bg} badge={BADGE.claim} />}
          t1={t1}
          t2={
            <>
              <Who wallet={ev.wallet} you={you} /> claimed fees
            </>
          }
          rt={<span className="amb">{usdFull(ev.usd)}</span>}
          rtSmall={ago}
        />
      );
    case 'pump':
    default:
      return (
        <ListRow
          fresh={fresh}
          onClick={open}
          avatar={<Avatar emoji={ev.emoji} bg={ev.bg} badge={BADGE.pump} />}
          t1={t1}
          t2="burst of buys"
          rt={<span className="up">{pct(ev.kind === 'pump' ? ev.changePct : 0)}</span>}
          rtSmall={ago}
        />
      );
  }
}

/* ------------------------------------------------------------------ Top shops row (§10.3) */

/** Fees earned in USD; real coins with sub-cent fees read `<$0.01`, never `$0`. */
function feesEarnedText(coin: Coin): string {
  return coin.real ? usdOwed(coin.feesEarnedUsd, u64(coin.real.feesEarnedLamports) > 0n) : usdFull(coin.feesEarnedUsd);
}

export function TopRow({ coin, rank, sort, solUsd, fresh }: { coin: Coin; rank: number; sort: TopSort; solUsd: number; fresh?: boolean }) {
  const label = coinCategoryLabel(coin);
  const verified = coin.claimed && coin.ownerVerified;
  const t1 = (
    <>
      <Tick ticker={coin.ticker} />
      {verified ? (
        <>
          <Icon name="verified" fill size={16} className="vf" />
          <span className="sr">, owner verified</span>
        </>
      ) : null}{' '}
      · {coin.name}
    </>
  );
  const common = {
    fresh,
    onClick: () => openCoin(coin.placeId),
    lead: <span className="rank">{rank}</span>,
    avatar: <Avatar emoji={coin.logo.emoji} bg={coin.logo.bg} />,
    t1,
  };
  if (sort === 'fees') {
    return (
      <ListRow
        {...common}
        t2={`${label} · ${usdCompact(coin.marketCapUsd)} mcap`}
        rt={<span className="amb">{feesEarnedText(coin)}</span>}
        rtSmall={coin.real ? solApprox(lamportsToSol(coin.real.feesEarnedLamports)) : solApprox(solUsd > 0 ? coin.feesEarnedUsd / solUsd : 0)}
      />
    );
  }
  return (
    <ListRow
      {...common}
      t2={
        <>
          {label} · <span className="amb fw6">{feesEarnedText(coin)}</span> fees
        </>
      }
      rt={usdCompact(coin.marketCapUsd)}
      rtSmall={pct(coin.change24h)}
      rtSmallClass={coin.change24h < 0 ? 'down' : 'up'}
    />
  );
}

/* ------------------------------------------------------------------ scope chips (§10.3) */

export type Scope = 'everywhere' | 'area';

/** `Everywhere` · `This area` chips (`.lp-tabs` style, single-select). */
export function ScopeTabs({ value, onChange, label }: { value: Scope; onChange: (v: Scope) => void; label: string }) {
  const opts: { key: Scope; text: string }[] = [
    { key: 'everywhere', text: 'Everywhere' },
    { key: 'area', text: 'This area' },
  ];
  return (
    <div className="lp-tabs" role="group" aria-label={label}>
      {opts.map((o) => (
        <button key={o.key} type="button" className={['hit', value === o.key ? 'on' : ''].filter(Boolean).join(' ')} aria-pressed={value === o.key} onClick={() => onChange(o.key)}>
          {o.text}
        </button>
      ))}
    </div>
  );
}
