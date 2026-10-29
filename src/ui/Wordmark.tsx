/**
 * AtlasPad identity: app icon, wordmark, brand lockup, map watermark. SHARED (src/ui).
 * Never use Google's logo, wordmark or palette in our chrome (BRIEF).
 */
import { useEffect, useRef, useState } from 'react';
import { LAYOUT_EVENT } from '../lib/events';
import { useStore } from '../store';
import { AppGlyph, WatermarkGlyph } from './Icons';

/**
 * The map's own attribution (Google: logo, "Keyboard shortcuts", "Map data ©", "Terms",
 * "Report a map error"; MapLibre fallback: attribution + logo). Nothing of ours may cover it.
 */
const ATTRIBUTION_SEL = [
  '#mapwrap .gm-style .gm-style-cc',
  '#mapwrap .gm-style a[href^="https://maps.google.com/maps"]',
  '#mapwrap .maplibregl-ctrl-attrib',
  '#mapwrap .maplibregl-ctrl-logo',
].join(',');
/** Breathing room between the watermark and the attribution (px). */
const ATTRIBUTION_GAP = 8;

/** True when the watermark box (as laid out, even while hidden) overlaps the map's attribution. */
function watermarkBlocked(el: HTMLElement): boolean {
  const w = el.getBoundingClientRect();
  if (w.width === 0) return false;
  for (const a of document.querySelectorAll<HTMLElement>(ATTRIBUTION_SEL)) {
    const r = a.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const g = ATTRIBUTION_GAP;
    if (w.left < r.right + g && w.right > r.left - g && w.top < r.bottom + g && w.bottom > r.top - g) return true;
  }
  return false;
}

/** Green rounded square with the white pin (40px rail default; hero 32px). */
export function AppIcon({ size = 40, radius }: { size?: number; radius?: number }) {
  const glyph = Math.round(size * 0.6);
  return (
    <span className="app-icon" aria-hidden="true" style={{ width: size, height: size, borderRadius: radius ?? (size <= 32 ? 10 : 12) }}>
      <span style={{ width: glyph, height: glyph, display: 'grid' }}>
        <AppGlyph />
      </span>
    </span>
  );
}

/** "ATLASPAD" wordmark: 16/20 800, stretch 120%, tracking .6px. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={['wordmark', className ?? ''].filter(Boolean).join(' ')} translate="no">
      ATLASPAD
    </span>
  );
}

/** App icon + wordmark (hero, drawer header). */
export function Brand({ iconSize = 32 }: { iconSize?: number }) {
  return (
    <span className="brand">
      <AppIcon size={iconSize} />
      <Wordmark />
    </span>
  );
}

/**
 * Map watermark (desktop/tablet, aria-hidden, non-interactive). DESIGN §6.8.
 * Centred on the map; on a narrow map (tablet widths, panel open) that centre can fall on Google's
 * right-aligned attribution row, which must never be covered (§6.8, §17). So the watermark measures
 * the attribution after every layout change and steps aside (visibility hidden) while they'd touch.
 */
export function Watermark() {
  const ref = useRef<HTMLDivElement>(null);
  const [blocked, setBlocked] = useState(false);
  const panel = useStore((s) => s.panel);
  const collapsed = useStore((s) => s.panelCollapsed);
  const viewport = useStore((s) => s.viewport);
  const mapType = useStore((s) => s.layers.mapType);
  const provider = useStore((s) => s.provider);
  const hero = useStore((s) => s.heroDismissed);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer = 0;
    const check = () => {
      window.clearTimeout(timer);
      timer = 0;
      setBlocked(watermarkBlocked(el));
    };
    const soon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(check, 120);
    };
    check();
    // the attribution is created and re-labelled by the map asynchronously
    const late = [600, 2000, 5000].map((ms) => window.setTimeout(check, ms));
    window.addEventListener('resize', soon);
    window.addEventListener(LAYOUT_EVENT, soon);
    return () => {
      window.clearTimeout(timer);
      late.forEach((t) => window.clearTimeout(t));
      window.removeEventListener('resize', soon);
      window.removeEventListener(LAYOUT_EVENT, soon);
    };
  }, [panel, collapsed, viewport, mapType, provider, hero]);

  return (
    <div ref={ref} className={['watermark', blocked ? 'is-blocked' : ''].filter(Boolean).join(' ')} aria-hidden="true">
      <WatermarkGlyph />
      <span translate="no">ATLASPAD</span>
    </div>
  );
}
