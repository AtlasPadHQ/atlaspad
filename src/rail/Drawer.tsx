/**
 * Mobile navigation drawer (DESIGN §6.9; replaces the rail below 768px). Opened by the green
 * app-icon logo in the mobile search pill (store.setRailOpen(true)). Left drawer over a scrim:
 * header (app icon + CORNERSHOP), items Live (live dot) · Top shops · Launched (badge) ·
 * My coins (amber badge) · divider · Help · About AtlasPad · AtlasPad on X · Source code on GitHub (both in a new tab), footer mode chip (DEMO / DEVNET; none on mainnet) +
 * Business opt-out.
 *
 * Items behave like the rail items and close the drawer. Scrim tap, Esc (drawer layer) and the
 * close button close it; Tab is trapped inside; focus returns to the opener.
 * OWNED BY RAIL+FEED.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { links } from '../config';
import { ESC_PRIORITY, useEscapeLayer } from '../lib/escape';
import { useStore } from '../store';
import { AppIcon, GitHubGlyph, Icon, IconButton, ModeChip, usePresence, Wordmark, XGlyph } from '../ui';
import { badgeText, RAIL_ITEMS, useLaunchedBadge, useLiveHealth, useMyCoinsBadge } from './railState';

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Drawer() {
  const open = useStore((s) => s.railOpen);
  const { mounted, state } = usePresence(open, 200);
  if (!mounted || typeof document === 'undefined') return null;
  return createPortal(<DrawerSheet open={open} state={state} />, document.body);
}

function DrawerSheet({ open, state }: { open: boolean; state: 'open' | 'closing' | 'closed' }) {
  const panel = useStore((s) => s.panel);
  const setRailOpen = useStore((s) => s.setRailOpen);
  const launched = useLaunchedBadge();
  const mine = useMyCoinsBadge();
  const health = useLiveHealth();
  const ref = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  const close = () => setRailOpen(false);
  useEscapeLayer(open, close, ESC_PRIORITY.drawer);

  // focus in on open, back to the opener on close
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    const root = ref.current;
    const target = root?.querySelector<HTMLElement>('.drawer-item.active') ?? root?.querySelector<HTMLElement>('.drawer-item');
    target?.focus({ preventScroll: true });
    return () => {
      const opener = openerRef.current as HTMLElement | null;
      // don't steal focus from whatever the chosen item opened (panel, modal, search)
      const active = document.activeElement;
      const lost = !active || active === document.body || (root?.contains(active) ?? false);
      if (lost && opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    };
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const root = ref.current;
    if (!root) return;
    const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const go = (mode: 'live' | 'top' | 'launched' | 'mine' | 'help') => {
    const s = useStore.getState();
    s.togglePanel(mode);
    s.setRailOpen(false);
  };

  const about = () => {
    const s = useStore.getState();
    s.openHelp(null);
    s.setRailOpen(false);
    // "About AtlasPad opens Help at the top"
    requestAnimationFrame(() => document.querySelector('.panel-scroll')?.scrollTo({ top: 0 }));
  };

  const optOut = () => useStore.getState().openModal({ kind: 'optout' });

  return (
    <>
      <div className="scrim" data-state={state} aria-hidden="true" onClick={close} />
      <div ref={ref} className="drawer" data-state={state} role="dialog" aria-modal="true" aria-label="Menu" tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="drawer-h">
          <AppIcon size={32} />
          <Wordmark />
          <IconButton icon="close" label="Close menu" className="hit" onClick={close} noTip />
        </div>
        <nav aria-label="Main">
          <ul className="drawer-list">
            {RAIL_ITEMS.map((it) => {
              const active = panel === it.mode;
              const count = it.mode === 'launched' ? launched : it.mode === 'mine' ? mine : 0;
              return (
                <li key={it.mode}>
                  <button type="button" className={['drawer-item', active ? 'active' : ''].filter(Boolean).join(' ')} aria-pressed={active} onClick={() => go(it.mode)}>
                    <span className="di">
                      <Icon name={it.icon} />
                      {it.mode === 'live' ? <i className={['live-dot', health === 'live' ? '' : 'idle'].filter(Boolean).join(' ')} aria-hidden="true" /> : null}
                    </span>
                    <span className="dl">{it.label}</span>
                    {count > 0 ? (
                      <span className={['drawer-badge', it.mode === 'mine' ? 'amber' : ''].filter(Boolean).join(' ')}>
                        <span aria-hidden="true">{badgeText(count)}</span>
                        <span className="sr">{it.mode === 'launched' ? `${count} new` : `fees for ${count === 1 ? 'your shop' : `${count} of your shops`}`}</span>
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <hr className="drawer-sep" />
          <ul className="drawer-list">
            <li>
              <button type="button" className={['drawer-item', panel === 'help' ? 'active' : ''].filter(Boolean).join(' ')} aria-pressed={panel === 'help'} onClick={() => go('help')}>
                <span className="di">
                  <Icon name="help" />
                </span>
                <span className="dl">Help</span>
              </button>
            </li>
            <li>
              <button type="button" className="drawer-item" onClick={about}>
                <span className="di">
                  <Icon name="info" />
                </span>
                <span className="dl">About AtlasPad</span>
              </button>
            </li>
            <li>
              <a className="drawer-item drawer-x" href={links.xProfile} target="_blank" rel="noopener noreferrer" onClick={close}>
                <span className="di">
                  <XGlyph size={20} />
                </span>
                <span className="dl">Follow {links.xHandle}</span>
                <span className="sr"> on X (opens in a new tab)</span>
              </a>
            </li>
            <li>
              <a className="drawer-item drawer-x" href={links.github} target="_blank" rel="noopener noreferrer" onClick={close}>
                <span className="di">
                  <GitHubGlyph size={20} />
                </span>
                <span className="dl">Source code on GitHub</span>
                <span className="sr"> (opens in a new tab)</span>
              </a>
            </li>
          </ul>
        </nav>
        <div className="drawer-f">
          <ModeChip full />
          <button type="button" className="drawer-optout hit" onClick={optOut}>
            Business opt-out
          </button>
        </div>
      </div>
    </>
  );
}
