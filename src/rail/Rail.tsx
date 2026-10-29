/**
 * Left rail (desktop/tablet, DESIGN §6.1) + mobile navigation drawer (§6.9).
 *
 * Rail, top → bottom: app icon (home: close any panel, clear selection, reset filters, keep the
 * viewport) · Live (live dot) · Top shops · Launched (unseen-launches badge) · My coins (amber
 * badge when you own a claimed shop with fees) · the selected place entry (`$TICKER` /
 * `New coin`; re-opens / expands its panel and pans to the pin when it is off-screen) · X (AtlasPad's account) and GitHub (the source code), both in a new tab · Help.
 * Items toggle their panel (the active item again closes it).
 *
 * Mobile (<768): the rail is not rendered; the drawer opens when store.railOpen is true (the
 * mobile search logo calls setRailOpen(true)). OWNED BY RAIL+FEED.
 */
import type { MouseEvent } from 'react';
import { useEffect } from 'react';
import { boundsContains } from '../lib/geo';
import { useIsMobile } from '../lib/media';
import { useStore } from '../store';
import { links } from '../config';
import { AppIcon, GitHubGlyph, Icon, XGlyph } from '../ui';
import Drawer from './Drawer';
import { badgeText, RAIL_ITEMS, useActivePanel, useLaunchedBadge, useLiveHealth, useMyCoinsBadge, type RailMode } from './railState';
import './rail.css';

interface RailItemProps {
  mode: RailMode;
  icon: string;
  label: string;
  active: boolean;
  count: number;
  health: 'live' | 'paused' | 'stalled';
}

function RailItem({ mode, icon, label, active, count, health }: RailItemProps) {
  const togglePanel = useStore((s) => s.togglePanel);
  const srExtra =
    mode === 'launched' && count > 0
      ? `, ${count} new`
      : mode === 'mine' && count > 0
        ? `, fees for ${count === 1 ? 'your shop' : `${count} of your shops`}`
        : '';
  return (
    <li>
      <button type="button" className={['rail-item', active ? 'active' : ''].filter(Boolean).join(' ')} aria-pressed={active} onClick={() => togglePanel(mode)}>
        <span className="ind">
          <Icon name={icon} />
          {mode === 'live' ? <i className={['live-dot', health === 'live' ? '' : 'idle'].filter(Boolean).join(' ')} aria-hidden="true" /> : null}
          {count > 0 ? (
            <i className={['badge', mode === 'mine' ? 'amber' : ''].filter(Boolean).join(' ')} aria-hidden="true">
              {badgeText(count)}
            </i>
          ) : null}
        </span>
        <span className="lbl">{label}</span>
        {srExtra ? <span className="sr">{srExtra}</span> : null}
      </button>
    </li>
  );
}

/** The selected place's rail entry (`$TICKER` or `New coin`). */
function RailPlace() {
  const place = useStore((s) => (s.panel === 'place' && s.selected.status !== 'error' ? s.selected.place : null));
  const coin = useStore((s) => (place ? s.coins[place.id] : undefined));
  if (!place) return null;

  const onClick = () => {
    const s = useStore.getState();
    const p = s.selected.place;
    if (!p) return;
    if (s.panelCollapsed) s.setPanelCollapsed(false);
    const b = s.viewport?.bounds;
    if (!b || !boundsContains(b, p.location)) s.flyTo(p.location);
  };

  const label = coin ? `$${coin.ticker}` : 'New coin';
  return (
    <>
      <div className="rail-sep" aria-hidden="true" />
      <button type="button" className="rail-place" onClick={onClick} aria-label={coin ? `${label}, ${coin.name}: show its panel` : 'New coin: show this shop’s panel'} data-tip={coin ? coin.name : undefined}>
        {coin ? (
          <span className="thumb" style={{ background: coin.logo.bg }} aria-hidden="true">
            {coin.logo.emoji}
          </span>
        ) : (
          <span className="thumb dashed" aria-hidden="true">
            <Icon name="rocket_launch" fill />
          </span>
        )}
        <span className="lbl" translate="no">
          {label}
        </span>
      </button>
    </>
  );
}

function DesktopRail() {
  const active = useActivePanel();
  const togglePanel = useStore((s) => s.togglePanel);
  const launched = useLaunchedBadge();
  const mine = useMyCoinsBadge();
  const health = useLiveHealth();

  const goHome = (e: MouseEvent<HTMLAnchorElement>) => {
    // let modified clicks open a new tab
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    const s = useStore.getState();
    s.closePanel();
    s.setCategory(null);
    s.setSearchOpen(false);
  };

  return (
    <nav className="rail" aria-label="Main">
      <a href="/" className="rail-home" aria-label="AtlasPad home" data-tip="AtlasPad home" onClick={goHome}>
        <AppIcon size={40} />
      </a>
      <ul className="rail-list">
        {RAIL_ITEMS.map((it) => (
          <RailItem
            key={it.mode}
            mode={it.mode}
            icon={it.icon}
            label={it.label}
            active={active === it.mode}
            count={it.mode === 'launched' ? launched : it.mode === 'mine' ? mine : 0}
            health={health}
          />
        ))}
      </ul>
      <RailPlace />
      <div className="rail-spacer" />
      <a className="rail-item rail-help rail-x" href={links.xProfile} target="_blank" rel="noopener noreferrer" aria-label={`AtlasPad on X, ${links.xHandle} (opens in a new tab)`} data-tip={`Follow ${links.xHandle}`}>
        <span className="ind">
          <XGlyph size={20} />
        </span>
        <span className="lbl">Follow</span>
      </a>
      <a className="rail-item rail-help rail-x" href={links.github} target="_blank" rel="noopener noreferrer" aria-label="AtlasPad source code on GitHub (opens in a new tab)" data-tip="Open source on GitHub">
        <span className="ind">
          <GitHubGlyph size={20} />
        </span>
        <span className="lbl">GitHub</span>
      </a>
      <button type="button" className={['rail-item', 'rail-help', active === 'help' ? 'active' : ''].filter(Boolean).join(' ')} aria-pressed={active === 'help'} onClick={() => togglePanel('help')}>
        <span className="ind">
          <Icon name="help" />
        </span>
        <span className="lbl">Help</span>
      </button>
    </nav>
  );
}

export default function Rail() {
  const mobile = useIsMobile();
  const railOpen = useStore((s) => s.railOpen);

  // the drawer only exists on mobile: close it when the window grows past the breakpoint
  useEffect(() => {
    if (!mobile && railOpen) useStore.getState().setRailOpen(false);
  }, [mobile, railOpen]);

  return mobile ? <Drawer /> : <DesktopRail />;
}
