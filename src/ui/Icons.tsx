/**
 * Icons: Material Symbols Rounded ligatures (`<Icon name="bolt" />`) plus the inline SVGs the
 * design specifies (app icon, watermark pin, SOL glyph, X glyph, GitHub mark, pin balloon). SHARED (src/ui).
 *
 * Adding a Material icon: add its name, alphabetically, to the `icon_names` list in index.html
 * (Google Fonts returns 400 for an unsorted list) — DESIGN §3.1.
 */
import { useId, type CSSProperties } from 'react';

export interface IconProps {
  /** Material Symbols ligature name, e.g. "rocket_launch". */
  name: string;
  /** Filled variant (FILL 1). */
  fill?: boolean;
  /** Font size in px (default 24 from `.ms`). */
  size?: number;
  /** Weight axis (400–700). */
  weight?: 400 | 500 | 600 | 700;
  className?: string;
  style?: CSSProperties;
  /** Spin (progress_activity). Respects reduced motion via CSS. */
  spin?: boolean;
}

export function Icon({ name, fill, size, weight, className, style, spin }: IconProps) {
  const variation =
    weight && weight !== 400
      ? { fontVariationSettings: `'FILL' ${fill ? 1 : 0},'wght' ${weight},'GRAD' 0,'opsz' 24` }
      : undefined;
  return (
    <span
      className={['ms', fill ? 'fill' : '', spin ? 'spin' : '', className ?? ''].filter(Boolean).join(' ')}
      aria-hidden="true"
      translate="no"
      style={{ ...(size ? { fontSize: size } : null), ...variation, ...style }}
    >
      {name}
    </span>
  );
}

/** Spinner per DESIGN §6: spinning `progress_activity`; reduced motion → static icon + "Working…". */
export function Spinner({ size = 18, label }: { size?: number; label?: string }) {
  return (
    <span className="spinner" role="status" aria-live="polite">
      <Icon name="progress_activity" size={size} spin />
      <span className="spinner-rm">Working…</span>
      {label ? <span className="sr">{label}</span> : null}
    </span>
  );
}

const PIN_PATH = 'M12 2.5c-3.9 0-7 3-7 6.9C5 14.6 12 21.5 12 21.5s7-6.9 7-12.1c0-3.9-3.1-6.9-7-6.9z';

/** App icon glyph (white pin, green dot) — goes inside the green `.app-icon` square. Never altered. */
export function AppGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={PIN_PATH} fill="#fff" />
      <circle cx="12" cy="9.4" r="4.1" fill="#0e7c47" />
      <ellipse cx="12" cy="9.4" rx="1.65" ry="4.1" fill="none" stroke="#fff" strokeWidth="0.85" />
      <path d="M7.9 9.4h8.2" stroke="#fff" strokeWidth="0.85" />
    </svg>
  );
}

/** Inverted pin (green pin, white globe) for the AtlasPad map watermark. */
export function WatermarkGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={PIN_PATH} fill="#0e7c47" />
      <circle cx="12" cy="9.4" r="4.1" fill="#fff" />
      <ellipse cx="12" cy="9.4" rx="1.65" ry="4.1" fill="none" stroke="#0e7c47" strokeWidth="0.85" />
      <path d="M7.9 9.4h8.2" stroke="#0e7c47" strokeWidth="0.85" />
    </svg>
  );
}

/** The 20px SOL currency marker (DESIGN §8.11) — the only place Solana colours appear. */
export function SolGlyph({ title }: { title?: string }) {
  // unique gradient id per instance (multiple glyphs on one page)
  const id = `solg${useId().replace(/:/g, '')}`;
  return (
    <span className="sol" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <svg viewBox="0 0 12 10" aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#9945ff" />
            <stop offset="1" stopColor="#14f195" />
          </linearGradient>
        </defs>
        <path fill={`url(#${id})`} d="M2.2 0H12L9.8 2.4H0zM0 3.8h9.8L12 6.2H2.2zM2.2 7.6H12L9.8 10H0z" />
      </svg>
    </span>
  );
}

/** X (Twitter) glyph, 18px, currentColor (DESIGN §12.5). */
export function XGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ fill: 'currentColor', flex: 'none' }}>
      <path d="M18.9 1.2h3.7l-8 9.1L24 22.8h-7.4l-5.8-7.6-6.6 7.6H.5l8.6-9.8L0 1.2h7.6l5.2 6.9 6.1-6.9zm-1.3 19.4h2L6.5 3.3H4.3l13.3 17.3z" />
    </svg>
  );
}

/** GitHub mark (Octicons `mark-github`, MIT), for the link to the source code. */
export function GitHubGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" style={{ fill: 'currentColor', flex: 'none' }}>
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

/** Pin balloon path (viewBox 0 0 40 54), DESIGN §7.1. */
export const BALLOON_PATH = 'M20 1C9.5 1 1 9.3 1 19.6 1 33.5 20 53 20 53s19-19.5 19-33.4C39 9.3 30.5 1 20 1z';

/** Selected-pin balloon SVG. `launchable` = white dashed balloon. */
export function BalloonSvg({ launchable }: { launchable?: boolean }) {
  return (
    <svg className="bsvg" viewBox="0 0 40 54" aria-hidden="true">
      {launchable ? (
        <path d={BALLOON_PATH} fill="#fff" stroke="#0e7c47" strokeWidth={2.5} strokeDasharray="4 3" />
      ) : (
        <path d={BALLOON_PATH} fill="#0e7c47" stroke="#0b6b3d" strokeWidth={1} />
      )}
    </svg>
  );
}

/** Raw markup strings for non-React pin layers (Google OverlayView / MapLibre markers). */
export const BALLOON_HTML = {
  coin: `<svg class="bsvg" viewBox="0 0 40 54" aria-hidden="true"><path d="${BALLOON_PATH}" fill="#0e7c47" stroke="#0b6b3d" stroke-width="1"/></svg>`,
  launchable: `<svg class="bsvg" viewBox="0 0 40 54" aria-hidden="true"><path d="${BALLOON_PATH}" fill="#fff" stroke="#0e7c47" stroke-width="2.5" stroke-dasharray="4 3"/></svg>`,
} as const;
