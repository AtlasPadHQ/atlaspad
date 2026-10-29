/**
 * Panel container (DESIGN §8.1–§8.3, §10). SHARED (src/ui). Rendered by src/PanelHost.tsx.
 *
 * Desktop/tablet (≥768): `.panel` side panel (x 72→480) with `.panel-card`, a collapse tab
 * (collapsed = panel hidden, tab stays at x 72 with "Expand side panel"), and the back chip at
 * top:72 left:16 of the card when the place was opened from a list panel.
 *
 * Mobile (<768): bottom sheet with snaps peek 148px / half 52dvh / full 100dvh−72px:
 *  - drag the `.handle` or any element marked `data-sheet-drag` (put it on your header): the
 *    sheet follows the finger 1:1; release snaps to the nearest snap, or to the next one in the
 *    fling direction if |velocity| > 0.5 px/ms; dragging down from Peek closes.
 *  - in Full, when the content is scrolled to the top, dragging down on the content drags the sheet.
 *  - tap the handle: Peek → Half → Full → Peek; keyboard: Enter/Space cycle, ↑/↓ one snap.
 *  - `.ph-x` Share (optional) + Close buttons; the sheet height is published as `--sheet-h`.
 *
 * Content scroll: `scrollKey` change → scrollTop 0; `restoreScroll` (back navigation) restores
 * the last position saved for that key. Content components should mark their header area with
 * `data-sheet-drag` and, on mobile, render <BackChip inline /> left of their title themselves.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as RKeyboardEvent,
  type PointerEvent as RPointerEvent,
  type ReactNode,
} from 'react';
import { ESC_PRIORITY, useEscapeLayer } from '../lib/escape';
import { useIsMobile } from '../lib/media';
import { useStore } from '../store';
import type { ListPanelMode, SheetSnap } from '../types';
import { IconButton } from './Button';
import { Icon } from './Icons';
import type { PresenceState } from './usePresence';

const SNAP_CSS: Record<SheetSnap, string> = {
  peek: '148px',
  half: '52dvh',
  // var(--sheet-full) (tokens.css): stops below the search pill, DEMO chip and Google's map logo
  full: 'var(--sheet-full)',
};
const ORDER: SheetSnap[] = ['peek', 'half', 'full'];
const FLING = 0.5; // px/ms

/** Pixel height of a CSS length (resolves calc(), dvh and env() exactly as the sheet does). */
function cssPx(value: string, fallback: number): number {
  const probe = document.createElement('div');
  probe.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;width:0;height:${value}`;
  document.body.append(probe);
  const h = probe.getBoundingClientRect().height;
  probe.remove();
  return h > 0 ? h : fallback;
}

function snapHeights(): Record<SheetSnap, number> {
  const vh = window.innerHeight;
  return { peek: 148, half: Math.round(vh * 0.52), full: Math.round(cssPx('var(--sheet-full)', vh - 126)) };
}

const savedScroll = new Map<string, number>();

export const LIST_PANEL_LABELS: Record<ListPanelMode, string> = {
  results: 'Results',
  live: 'Live',
  top: 'Top shops',
  launched: 'Launched',
  mine: 'My coins',
};

/** Back chip ("← Live"): returns to the previous list panel. Renders nothing without history. */
export function BackChip({ inline }: { inline?: boolean }) {
  const prev = useStore((s) => s.panelHistory[s.panelHistory.length - 1]);
  const back = useStore((s) => s.back);
  if (!prev) return null;
  return (
    <button type="button" className={['back-chip', 'hit', inline ? 'inline' : ''].filter(Boolean).join(' ')} onClick={() => back()}>
      <Icon name="arrow_back" size={18} />
      {LIST_PANEL_LABELS[prev]}
    </button>
  );
}

export interface PanelShellProps {
  ariaLabel: string;
  /** Presence state from PanelHost (open / closing). */
  state: PresenceState;
  collapsed: boolean;
  onClose: () => void;
  onCollapse: (collapsed: boolean) => void;
  /** Mobile `.ph-x` Share button (place panel). */
  onShare?: () => void;
  /** Show the desktop back chip. */
  showBack?: boolean;
  /** Changing it resets the scroll position (place id / panel mode). */
  scrollKey: string;
  /** Restore the saved scroll for `scrollKey` (back navigation). */
  restoreScroll?: boolean;
  children: ReactNode;
}

export function PanelShell({
  ariaLabel,
  state,
  collapsed,
  onClose,
  onCollapse,
  onShare,
  showBack,
  scrollKey,
  restoreScroll,
  children,
}: PanelShellProps) {
  const mobile = useIsMobile();
  const snap = useStore((s) => s.sheetSnap);
  const setSheetSnap = useStore((s) => s.setSheetSnap);
  const asideRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const open = state === 'open';

  useEscapeLayer(open && !(collapsed && !mobile), () => onClose(), ESC_PRIORITY.panel);

  /* ---------------- --sheet-h (mobile) */
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!mobile) {
      root.style.removeProperty('--sheet-h');
      return;
    }
    root.style.setProperty('--sheet-h', SNAP_CSS[snap]);
    return () => {
      root.style.removeProperty('--sheet-h');
    };
  }, [mobile, snap]);

  /* ---------------- scroll reset / restore */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = restoreScroll ? (savedScroll.get(scrollKey) ?? 0) : 0;
  }, [scrollKey, restoreScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) savedScroll.set(scrollKey, el.scrollTop);
  };

  /* ---------------- sheet drag */
  const drag = useRef<{
    startY: number;
    startH: number;
    lastY: number;
    lastT: number;
    v: number;
    moved: boolean;
    fromHandle: boolean;
    h: number;
  } | null>(null);

  const setDragHeight = (h: number) => {
    document.documentElement.style.setProperty('--sheet-h', `${Math.round(h)}px`);
  };

  const settle = useCallback(
    (h: number, v: number) => {
      asideRef.current?.classList.remove('dragging');
      const H = snapHeights();
      let target: SheetSnap | 'close';
      if (v > FLING) {
        // fling down → next snap below the current height
        const below = [...ORDER].reverse().find((k) => H[k] < h - 8);
        target = below ?? 'close';
      } else if (v < -FLING) {
        target = ORDER.find((k) => H[k] > h + 8) ?? 'full';
      } else if (h < H.peek - 48) {
        target = 'close';
      } else {
        target = ORDER.reduce((best, k) => (Math.abs(H[k] - h) < Math.abs(H[best] - h) ? k : best), 'half' as SheetSnap);
      }
      if (target === 'close') {
        onClose();
        return;
      }
      // restore the CSS value (re-applied even if the snap didn't change)
      document.documentElement.style.setProperty('--sheet-h', SNAP_CSS[target]);
      setSheetSnap(target);
    },
    [onClose, setSheetSnap],
  );

  const cycle = () => setSheetSnap(ORDER[(ORDER.indexOf(snap) + 1) % ORDER.length] as SheetSnap);

  const beginDrag = (y: number, fromHandle: boolean) => {
    const h = asideRef.current?.getBoundingClientRect().height ?? snapHeights()[snap];
    drag.current = { startY: y, startH: h, lastY: y, lastT: performance.now(), v: 0, moved: false, fromHandle, h };
  };

  const moveDrag = (y: number) => {
    const d = drag.current;
    if (!d) return;
    const t = performance.now();
    const dt = Math.max(1, t - d.lastT);
    d.v = 0.7 * ((y - d.lastY) / dt) + 0.3 * d.v;
    d.lastY = y;
    d.lastT = t;
    if (!d.moved && Math.abs(y - d.startY) > 4) {
      d.moved = true;
      asideRef.current?.classList.add('dragging');
    }
    if (d.moved) {
      d.h = Math.max(0, Math.min(snapHeights().full, d.startH - (y - d.startY)));
      setDragHeight(d.h);
    }
  };

  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      if (d.fromHandle) cycle();
      return;
    }
    // stale velocity (finger held still before release) does not count as a fling
    const v = performance.now() - d.lastT > 120 ? 0 : d.v;
    settle(d.h, v);
  };

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!mobile || e.button !== 0) return;
    const target = e.target as Element;
    const handle = target.closest('.handle');
    const zone = handle ?? target.closest('[data-sheet-drag]');
    if (!zone) return;
    if (!handle && target.closest('button, a, input, select, textarea, [role="button"]')) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    beginDrag(e.clientY, !!handle);
  };

  // content drag at the top of a Full sheet (touch)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !mobile) return;
    let startY = 0;
    let active = false;
    const onStart = (e: TouchEvent) => {
      startY = e.touches[0]?.clientY ?? 0;
      active = false;
    };
    const onMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (!active) {
        if (useStore.getState().sheetSnap === 'full' && el.scrollTop <= 0 && y - startY > 6) {
          active = true;
          beginDrag(startY, false);
        } else return;
      }
      e.preventDefault();
      moveDrag(y);
    };
    const onEnd = () => {
      if (active) endDrag();
      active = false;
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobile]);

  const onHandleKey = (e: RKeyboardEvent<HTMLDivElement>) => {
    const i = ORDER.indexOf(snap);
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      cycle();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSheetSnap(ORDER[Math.min(ORDER.length - 1, i + 1)] as SheetSnap);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSheetSnap(ORDER[Math.max(0, i - 1)] as SheetSnap);
    }
  };

  /* ---------------- render */
  if (!mobile && collapsed) {
    return (
      <button
        type="button"
        className="collapse-tab is-collapsed"
        aria-label="Expand side panel"
        data-tip="Expand side panel"
        onClick={() => onCollapse(false)}
      >
        <Icon name="arrow_right" />
      </button>
    );
  }

  return (
    <aside ref={asideRef} className="panel" data-state={state} data-snap={mobile ? snap : undefined} aria-label={ariaLabel}>
      <div className="panel-card" onPointerDown={onPointerDown} onPointerMove={(e) => drag.current && moveDrag(e.clientY)} onPointerUp={endDrag} onPointerCancel={endDrag}>
        {mobile ? (
          <>
            <div className="handle" role="button" tabIndex={0} aria-label="Resize sheet" onKeyDown={onHandleKey} />
            <div className="ph-x">
              {onShare ? <IconButton icon="share" label="Share" className="hit" onClick={onShare} /> : null}
              <IconButton icon="close" label="Close" className="hit" onClick={onClose} />
            </div>
          </>
        ) : showBack ? (
          <BackChip />
        ) : null}
        <div ref={scrollRef} className="panel-scroll" onScroll={onScroll}>
          {state === 'closing' ? null : children}
        </div>
      </div>
      {mobile ? null : (
        <button
          type="button"
          className="collapse-tab"
          aria-label="Collapse side panel"
          data-tip="Collapse side panel"
          onClick={() => onCollapse(true)}
        >
          <Icon name="arrow_left" />
        </button>
      )}
    </aside>
  );
}
