/**
 * Dialog shell (DESIGN §12.1). SHARED (src/ui).
 *
 *  - Portal to <body>, scrim + `.dialog`; role="dialog" aria-modal aria-labelledby.
 *  - Focus moves to `[data-autofocus]`, else the first field, else the primary button, else
 *    the dialog; it returns to the opener on close. Tab is trapped.
 *  - Esc and scrim click close, unless `busy` (Launching / Calling steps): then both do nothing.
 *  - Mobile (<768): bottom sheet with a grab handle and a sticky footer (CSS).
 *  - Open/close animations per DESIGN §14 (reduced motion: instant).
 *
 * Compose: <Modal><ModalHeader steps={…} current={1} onClose={…}/> <h2 id=…/> … <ModalFooter>…</ModalFooter></Modal>
 */
import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { CLUSTER, IS_REAL } from '../mode';
import { createPortal } from 'react-dom';
import { ESC_PRIORITY, useEscapeLayer } from '../lib/escape';
import { isMobileNow } from '../lib/media';
import { IconButton } from './Button';
import { Icon } from './Icons';
import { usePresence } from './usePresence';

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Visible, enabled focusable elements inside `root`, in DOM order. */
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** True when `el` can take focus right now (not disabled / aria-disabled, and rendered). */
function isFocusable(el: HTMLElement): boolean {
  if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return false;
  return el.offsetParent !== null || el.getClientRects().length > 0;
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** id of the visible h2 (preferred). */
  labelledBy?: string;
  /** Accessible name when there is no visible heading. */
  ariaLabel?: string;
  /** Busy step: Esc / scrim / close button do nothing. */
  busy?: boolean;
  /** Desktop width in px (default 520; wallet 420). */
  width?: number;
  className?: string;
  /** Extra class on the scrim (e.g. a darker lightbox scrim). */
  scrimClassName?: string;
  /** Selector of the element to focus first. */
  initialFocus?: string;
  role?: 'dialog' | 'alertdialog';
  /** Hide the mobile grab handle. */
  noHandle?: boolean;
  /**
   * Where focus goes on close when the opener is gone (e.g. Launch replaced the launchable panel):
   * a selector, default the open place panel's heading. Never <body> (Phase-1 minor #2).
   */
  returnFocus?: string;
  children: ReactNode;
}

/**
 * Dialogs portal to <body> in the order they open, so the last open one is on top (the consent sheet over a launch).
 * Only that one traps Tab; otherwise two traps would keep pulling focus away from each other.
 */
function isTopDialog(root: HTMLElement): boolean {
  const open = document.querySelectorAll<HTMLElement>('.dialog:not([data-state="closing"])');
  return open.length === 0 || open[open.length - 1] === root;
}

/** Default return target: the place panel heading (`.ph-title`), else the panel, else the map. */
const RETURN_FOCUS_FALLBACK = '.ph-title';

/** Focus `sel` (made focusable with tabIndex -1 when needed); false when nothing matched. */
function focusFallback(sel: string | undefined): boolean {
  for (const s of [sel, RETURN_FOCUS_FALLBACK, '#panel', '#map'].filter((x): x is string => !!x)) {
    const el = document.querySelector<HTMLElement>(s);
    if (!el || !el.isConnected || el.closest('[hidden],[inert]')) continue;
    if (!el.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) el.tabIndex = -1;
    el.focus({ preventScroll: true });
    if (document.activeElement === el) return true;
  }
  return false;
}

export function Modal({
  open,
  onClose,
  labelledBy,
  ariaLabel,
  busy = false,
  width,
  className,
  scrimClassName,
  initialFocus,
  role = 'dialog',
  noHandle,
  returnFocus,
  children,
}: ModalProps) {
  const { mounted, state } = usePresence(open, isMobileNow() ? 300 : 200);
  const dialogRef = useRef<HTMLElement>(null);
  const openerRef = useRef<Element | null>(null);
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEscapeLayer(open, () => {
    if (!busyRef.current) onClose();
    return true; // a busy modal swallows Esc (does not fall through to the panel)
  }, ESC_PRIORITY.modal);

  // Focus in on open, back to the opener on close (DESIGN §12.1).
  // The preferred target can still be disabled when the dialog opens (the claim modal's
  // `Call me with a code` waits for the listing lookup). focus() on a disabled button does
  // nothing, so focus would stay on the opener behind the scrim (or on <body> after a mouse
  // click). Instead, park focus on the dialog itself and move it to the target as soon as the
  // target is enabled, unless the user has moved focus inside the dialog in the meantime.
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement;
    // The dialog is committed before this effect runs, so focus synchronously (no rAF: it is
    // throttled in background tabs / embedded previews).
    const root = dialogRef.current;
    let observer: MutationObserver | null = null;
    let onUserFocus: ((e: FocusEvent) => void) | null = null;
    if (root && !root.contains(document.activeElement)) {
      const preferred = (): HTMLElement | null =>
        (initialFocus ? root.querySelector<HTMLElement>(initialFocus) : null) ??
        root.querySelector<HTMLElement>('[data-autofocus]') ??
        root.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]):not([type="checkbox"]), select:not([disabled]), textarea:not([disabled])') ??
        root.querySelector<HTMLElement>('.btn-primary');
      const target = preferred();
      if (target && isFocusable(target)) {
        target.focus({ preventScroll: true });
      } else {
        root.focus({ preventScroll: true });
        if (target) {
          // Still parked on the dialog (or focus fell to <body>): follow the target once it is
          // enabled. Any focus the user moves inside the dialog cancels this.
          const parked = () => {
            const a = document.activeElement;
            return !a || a === root || a === document.body;
          };
          const stop = () => {
            observer?.disconnect();
            observer = null;
            if (onUserFocus) root.removeEventListener('focusin', onUserFocus);
            onUserFocus = null;
          };
          onUserFocus = (e) => {
            if (e.target !== root) stop();
          };
          root.addEventListener('focusin', onUserFocus);
          observer = new MutationObserver(() => {
            if (!parked()) return stop();
            const next = preferred();
            if (next && isFocusable(next)) {
              stop();
              next.focus({ preventScroll: true });
            }
          });
          observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'hidden'] });
        }
      }
    }
    return () => {
      observer?.disconnect();
      if (root && onUserFocus) root.removeEventListener('focusin', onUserFocus);
      const opener = openerRef.current as HTMLElement | null;
      if (opener && opener !== document.body && document.contains(opener) && typeof opener.focus === 'function') {
        opener.focus({ preventScroll: true });
        return;
      }
      // The opener is gone (the panel re-rendered underneath): once the new UI has committed, focus
      // its heading instead of leaving focus on <body>. (A timer, not rAF: rAF is throttled in
      // background / embedded panes.)
      const sel = returnFocusRef.current;
      const dlg = dialogRef.current;
      setTimeout(() => {
        const a = document.activeElement;
        // focus still inside the closing dialog (exit animation) counts as "nowhere"
        if (a && a !== document.body && a !== document.documentElement && !(dlg && dlg.contains(a))) return;
        focusFallback(sel);
      }, 30);
    };
  }, [open, initialFocus]);

  // Tab is trapped (DESIGN §12.1). The dialog's own keydown handler only sees Tab while focus is
  // inside it; focus can also sit outside (a control behind the scrim, <body> after a click, a
  // control that was disabled or removed, e.g. code boxes while a code is checked). Catch Tab at
  // the document and move focus into the dialog instead of letting it walk the page behind.
  useEffect(() => {
    if (!open) return;
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root || !isTopDialog(root)) return;
      const a = document.activeElement;
      if (a && a !== document.body && root.contains(a) && !(a instanceof HTMLElement && a.matches(':disabled'))) return;
      e.preventDefault();
      const items = focusables(root);
      (e.shiftKey ? items[items.length - 1] : items[0])?.focus() ?? root.focus();
    };
    document.addEventListener('keydown', onDocKey, true);
    return () => document.removeEventListener('keydown', onDocKey, true);
  }, [open]);

  if (!mounted || typeof document === 'undefined') return null;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Tab') return;
    const root = dialogRef.current;
    if (!root) return;
    const items = focusables(root);
    if (items.length === 0) {
      e.preventDefault();
      root.focus();
      return;
    }
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

  return createPortal(
    <>
      <div
        className={['scrim', scrimClassName ?? ''].filter(Boolean).join(' ')}
        data-state={state}
        aria-hidden="true"
        onClick={() => {
          if (!busyRef.current && open) onClose();
        }}
      />
      <section
        ref={dialogRef}
        className={['dialog', className ?? ''].filter(Boolean).join(' ')}
        data-state={state}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : ariaLabel}
        aria-busy={busy || undefined}
        tabIndex={-1}
        style={width ? ({ '--dialog-w': `${width}px` } as CSSProperties) : undefined}
        onKeyDown={onKeyDown}
      >
        {noHandle ? null : <span className="dlg-handle" aria-hidden="true" />}
        {children}
      </section>
    </>,
    document.body,
  );
}

/* ------------------------------------------------------------------ parts */

export interface StepperProps {
  labels: readonly string[];
  /** 0-based index of the current step. */
  current: number;
  /** Indices shown as done (✓), e.g. a skipped Sign in step. Defaults to all before `current`. */
  done?: readonly number[];
}

export function Stepper({ labels, current, done }: StepperProps) {
  const doneSet = new Set(done ?? labels.map((_, i) => i).filter((i) => i < current));
  return (
    <ol className="stepper" aria-label="Progress">
      {labels.map((l, i) => (
        <li key={l} className={i === current ? 'on' : doneSet.has(i) ? 'done' : ''} aria-current={i === current ? 'step' : undefined}>
          {l}
        </li>
      ))}
    </ol>
  );
}

export interface ModalHeaderProps {
  /** Stepper (omit for single-step modals). */
  steps?: StepperProps;
  onClose: () => void;
  /** Disable the close button (busy steps). */
  closeDisabled?: boolean;
  /** Extra leading content (e.g. a "Back" text button) when there is no stepper. */
  lead?: ReactNode;
}

export function ModalHeader({ steps, onClose, closeDisabled, lead }: ModalHeaderProps) {
  return (
    <header className="dlg-h">
      {steps ? <Stepper {...steps} /> : (lead ?? <span />)}
      <IconButton icon="close" label="Close" onClick={onClose} disabled={closeDisabled} />
    </header>
  );
}

/** `.demo-note`: "Demo — no real transaction" (claim modal: "Demo — no real call is made"). */
export function DemoNote({ text = 'Demo — no real transaction', className }: { text?: string; className?: string }) {
  return (
    <span className={['demo-note', className ?? ''].filter(Boolean).join(' ')}>
      <Icon name="info" />
      {text}
    </span>
  );
}

/**
 * The note under actions for this mode (INTEGRATION.md §7.2): demo `Demo — no real transaction`
 * (or `text`), devnet `Devnet — test SOL, no real value`, mainnet `Real transaction on Solana`.
 */
export function ModeNote({ text, className }: { text?: string; className?: string }) {
  if (!IS_REAL) return <DemoNote text={text} className={className} />;
  return <DemoNote text={CLUSTER === 'devnet' ? 'Devnet — test SOL, no real value' : 'Real transaction on Solana'} className={className} />;
}

/** Footer: mode note (left) · spacer · secondary + primary buttons (children). Pass note={false} to hide it. */
export function ModalFooter({ note, children }: { note?: string | false; children?: ReactNode }) {
  return (
    <footer className="dlg-f">
      {note === false ? null : IS_REAL && note === undefined ? <ModeNote className="dlg-f-note" /> : <DemoNote text={note} className="dlg-f-note" />}
      <span className="dlg-f-spacer" />
      {children}
    </footer>
  );
}

/** Wrap each step's content; changing `stepKey` plays the step-change animation (DESIGN §14). */
export function ModalStep({ stepKey, children }: { stepKey: string; children: ReactNode }) {
  return (
    <div key={stepKey} className="dlg-step">
      {children}
    </div>
  );
}
