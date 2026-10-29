/**
 * Coin avatar ("sticker"): the coin's emoji on its pastel `--bg`, or its uploaded art, in a
 * circle. Used by rows, search, rail, modals. Plus the address blob. SHARED (src/ui).
 */
import type { CSSProperties, ReactNode } from 'react';
import { addressGradient } from '../lib/logo';
import type { LogoSpec } from '../types';

export interface StickerProps {
  logo: LogoSpec;
  /** Diameter in px (default 40). Emoji is ~50% of it. */
  size?: number;
  /** Prefer the uploaded image over the emoji (default true). Pins always use the emoji. */
  preferImage?: boolean;
  /** Alt text when the image is shown (e.g. "Bosphorus Grill coin art"); emoji is aria-hidden. */
  alt?: string;
  className?: string;
  style?: CSSProperties;
  /** Small badge in the bottom-right (e.g. the feed's event icon). */
  badge?: ReactNode;
}

export function Sticker({ logo, size = 40, preferImage = true, alt = '', className, style, badge }: StickerProps) {
  const img = preferImage && logo.kind === 'upload' ? logo.dataUrl : null;
  return (
    <span
      className={['sticker', className ?? ''].filter(Boolean).join(' ')}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5), background: logo.bg, ...style }}
    >
      {img ? <img src={img} alt={alt} draggable={false} /> : <span aria-hidden="true">{logo.emoji}</span>}
      {badge}
    </span>
  );
}

/** Gradient address blob (DESIGN §8.12), 28px by default. */
export function AddrBlob({ address, size = 28 }: { address: string; size?: number }) {
  return <span className="blob" aria-hidden="true" style={{ width: size, height: size, background: addressGradient(address) }} />;
}
