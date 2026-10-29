/**
 * Price sparkline (DESIGN §8.10): 48 points, no axes/grid. Up = green stroke + green fill
 * gradient (.22 → 0) + green end dot; down = red. Drawn at the element's real pixel size
 * (ResizeObserver) so strokes and the end dot are never stretched.
 *
 * Interactive mode (`onScrub`): pointer/touch drag shows a 1px guide + 8px dot on the nearest
 * point and reports its index; ←/→ step, Home/End jump, Esc restores. role="slider".
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ESC_PRIORITY, useEscapeLayer } from '../lib/escape';

export interface SparklineProps {
  prices: readonly number[];
  height: number;
  up: boolean;
  className?: string;
  /** End dot (default true). */
  dot?: boolean;
  /** Interactive scrubbing. Called with the hovered index, or null when released. */
  onScrub?: (index: number | null) => void;
  ariaLabel?: string;
  /** aria-valuetext for the scrubbed point. */
  valueText?: (index: number) => string;
}

interface Pt {
  x: number;
  y: number;
}

/** The vertical scale always covers at least this share of the price (0.5%). */
const MIN_SPAN = 0.005;

/**
 * Point positions in a `w` × `height` box. A near-zero span (float noise from re-expressing USD, a dust trade) is drawn
 * flat at mid-height and a small one stays small: never stretched to the full height as a fake crash or spike.
 */
export function sparkPoints(prices: readonly number[], w: number, height: number, dot: boolean): Pt[] {
  const n = prices.length;
  if (n === 0 || w <= 0) return [];
  const padR = dot ? 6 : 1;
  const usable = Math.max(1, w - padR - 1);
  let min = Infinity;
  let max = -Infinity;
  for (const p of prices) {
    if (p < min) min = p;
    if (p > max) max = p;
  }
  const span = Math.max(max - min, Math.max(Math.abs(max), Math.abs(min)) * MIN_SPAN);
  const mid = (max + min) / 2;
  // a span of its own fills the band from 6 (top) to height - 4 (bottom), as before; mid-height is the band's middle
  return prices.map((p, i) => ({
    x: 1 + (n > 1 ? (i / (n - 1)) * usable : usable / 2),
    y: (height + 2) / 2 - (span > 0 ? ((p - mid) / span) * (height - 10) : 0),
  }));
}

export function Sparkline({ prices, height, up, className, dot = true, onScrub, ariaLabel, valueText }: SparklineProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const gid = `spk${useId().replace(/:/g, '')}`;
  const [idx, setIdx] = useState<number | null>(null);
  const dragging = useRef(false);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setW(Math.max(0, Math.round(el.clientWidth)));
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const pts = useMemo<Pt[]>(() => sparkPoints(prices, w, height, dot), [prices, w, height, dot]);

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const first = pts[0];
  const area = last && first ? `${line} L${last.x.toFixed(1)} ${height} L${first.x.toFixed(1)} ${height} Z` : '';

  const setScrub = (i: number | null) => {
    setIdx(i);
    onScrub?.(i);
  };

  // Esc while scrubbing restores (and must not close the panel underneath)
  useEscapeLayer(onScrub != null && idx != null, () => setScrub(null), ESC_PRIORITY.popover);

  // reset when the series changes length (range switch)
  useEffect(() => {
    setIdx(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prices.length]);

  const indexAt = (clientX: number): number | null => {
    const el = wrapRef.current;
    if (!el || pts.length === 0) return null;
    const r = el.getBoundingClientRect();
    const x = clientX - r.left;
    let best = 0;
    let bestD = Infinity;
    pts.forEach((p, i) => {
      const d = Math.abs(p.x - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!onScrub) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setScrub(indexAt(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!onScrub) return;
    if (e.pointerType === 'mouse' || dragging.current) setScrub(indexAt(e.clientX));
  };
  const end = () => {
    if (!onScrub) return;
    dragging.current = false;
    setScrub(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!onScrub || pts.length === 0) return;
    const n = pts.length;
    const cur = idx ?? n - 1;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (e.key === 'ArrowRight') next = Math.min(n - 1, cur + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next == null) return;
    e.preventDefault();
    setScrub(next);
  };

  const sel = idx != null ? pts[idx] : undefined;
  const interactive = !!onScrub;
  const n = prices.length;

  return (
    <div
      ref={wrapRef}
      className={['spark', up ? 'is-up' : 'is-down', interactive ? 'is-live' : '', className ?? ''].filter(Boolean).join(' ')}
      style={{ height }}
      role={interactive ? 'slider' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? ariaLabel : undefined}
      aria-hidden={interactive ? undefined : true}
      aria-valuemin={interactive ? 0 : undefined}
      aria-valuemax={interactive ? Math.max(0, n - 1) : undefined}
      aria-valuenow={interactive ? (idx ?? n - 1) : undefined}
      aria-valuetext={interactive && valueText ? valueText(idx ?? n - 1) : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') end();
      }}
      onBlur={() => {
        if (idx != null) setScrub(null);
      }}
      onKeyDown={onKeyDown}
    >
      {w > 0 && pts.length > 0 ? (
        <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" className="spk-stop0" />
              <stop offset="1" className="spk-stop1" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gid})`} />
          <path d={line} className="spk-line" fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {sel ? <line className="spk-guide" x1={sel.x} x2={sel.x} y1={0} y2={height} /> : null}
          {sel ? <circle className="spk-dot" cx={sel.x} cy={sel.y} r={4} /> : null}
          {dot && last && !sel ? <circle className="spk-dot" cx={last.x} cy={last.y} r={4} strokeWidth={2} /> : null}
        </svg>
      ) : null}
    </div>
  );
}
