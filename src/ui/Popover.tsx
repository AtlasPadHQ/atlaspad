/**
 * Anchored popover (DESIGN §12.6: unclaimed info, owner info, wallet account menu, Layers).
 * Portal, positioned against an anchor element; closes on outside click, Esc (layered) and
 * scroll/resize. Width 280 by default. SHARED (src/ui).
 *
 *   const [open, setOpen] = useState(false); const ref = useRef<HTMLButtonElement>(null);
 *   <button ref={ref} aria-expanded={open} onClick={() => setOpen(o => !o)} />
 *   <Popover anchor={ref} open={open} onClose={() => setOpen(false)}>…</Popover>
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ESC_PRIORITY, useEscapeLayer } from '../lib/escape';

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'right-end' | 'top-start';

export interface PopoverProps {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  placement?: PopoverPlacement;
  width?: number;
  /** Gap to the anchor (px). */
  offset?: number;
  className?: string;
  /** role="dialog" (default) or "menu". */
  role?: 'dialog' | 'menu';
  ariaLabel?: string;
  children: ReactNode;
}

export function Popover({
  anchor,
  open,
  onClose,
  placement = 'bottom-start',
  width = 280,
  offset = 8,
  className,
  role = 'dialog',
  ariaLabel,
  children,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  useEscapeLayer(open, () => {
    onClose();
    anchor.current?.focus();
  }, ESC_PRIORITY.popover);

  useLayoutEffect(() => {
    if (!open) return;
    const compute = () => {
      const a = anchor.current?.getBoundingClientRect();
      if (!a) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = a.left;
      let top: number | undefined;
      let bottom: number | undefined;
      switch (placement) {
        case 'bottom-end':
          left = a.right - width;
          top = a.bottom + offset;
          break;
        case 'right-end':
          left = a.right + offset;
          bottom = vh - a.bottom;
          break;
        case 'top-start':
          bottom = vh - a.top + offset;
          break;
        case 'bottom-start':
        default:
          top = a.bottom + offset;
      }
      left = Math.max(8, Math.min(left, vw - width - 8));
      setPos({ left, top, bottom });
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [open, anchor, placement, width, offset]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, onClose, anchor]);

  if (!open || !pos || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={ref}
      className={['popover', className ?? ''].filter(Boolean).join(' ')}
      role={role}
      aria-label={ariaLabel}
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width }}
    >
      {children}
    </div>,
    document.body,
  );
}
