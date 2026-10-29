/**
 * Tooltip layer (DESIGN §13.2). Mounted once by App. Any element with `data-tip="text"` gets a
 * tooltip: after 500ms hover (mouse only) or immediately on keyboard focus (:focus-visible);
 * hides on leave / blur / Esc / scroll. Placed 8px below the anchor (above if no room),
 * clamped to the viewport. Touch devices get no tooltips. SHARED (src/ui).
 *
 * IconButton sets data-tip from its label automatically; Button accepts `tip`.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface TipState {
  text: string;
  x: number;
  y: number;
  above: boolean;
}

const GAP = 8;

function findTipTarget(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? (node.closest('[data-tip]') as HTMLElement | null) : null;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<TipState | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const place = (el: HTMLElement) => {
      const text = el.getAttribute('data-tip');
      if (!text) return;
      const r = el.getBoundingClientRect();
      const above = r.bottom + GAP + 32 > window.innerHeight;
      anchorRef.current = el;
      setTip({ text, x: r.left + r.width / 2, y: above ? r.top - GAP : r.bottom + GAP, above });
    };
    const hide = () => {
      clearTimeout(timer.current);
      anchorRef.current = null;
      setTip(null);
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const el = findTipTarget(e.target);
      if (!el || el === anchorRef.current) return;
      clearTimeout(timer.current);
      setTip(null);
      timer.current = setTimeout(() => place(el), 500);
      anchorRef.current = el;
    };
    const onOut = (e: PointerEvent) => {
      const el = findTipTarget(e.target);
      if (!el) return;
      const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
      if (to && el.contains(to)) return;
      hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = findTipTarget(e.target);
      if (!el) return;
      let visible = false;
      try {
        visible = (e.target as Element).matches(':focus-visible');
      } catch {
        visible = false;
      }
      if (visible) place(el);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && anchorRef.current) hide();
    };
    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', hide);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, []);

  // clamp horizontally after measuring
  const [dx, setDx] = useState(0);
  useEffect(() => {
    const el = tipRef.current;
    if (!el || !tip) return;
    const r = el.getBoundingClientRect();
    let shift = 0;
    if (r.left < 8) shift = 8 - r.left;
    else if (r.right > window.innerWidth - 8) shift = window.innerWidth - 8 - r.right;
    setDx(shift);
  }, [tip]);

  if (!tip || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={tipRef}
      className="tooltip"
      role="tooltip"
      style={{
        left: tip.x,
        top: tip.y,
        transform: `translate(calc(-50% + ${dx}px), ${tip.above ? '-100%' : '0'})`,
      }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
