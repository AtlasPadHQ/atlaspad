/**
 * Coin art helpers: deterministic default stickers, address blobs, and logo accessors.
 * SHARED (src/lib). Pure.
 */
import type { CategoryKey, LogoSpec } from '../types';
import { categoryDef, COIN_SWATCHES } from './categories';
import { hashString } from './rand';

/**
 * Deterministic sticker for an id (e.g. a place ID): an emoji from the category's 6 stickers
 * and a pastel swatch, both chosen by hashing the id. Same id → same sticker, always.
 */
export function stickerFor(id: string, category: CategoryKey = 'other'): LogoSpec {
  const h = hashString(id);
  const stickers = categoryDef(category).stickers;
  const emoji = stickers[h % stickers.length] ?? categoryDef(category).emoji;
  const bg = COIN_SWATCHES[(h >>> 8) % COIN_SWATCHES.length] ?? COIN_SWATCHES[0];
  return { kind: 'sticker', emoji, bg };
}

/** The launch modal default: first sticker of the category on the first swatch. */
export function defaultLogo(category: CategoryKey): LogoSpec {
  return { kind: 'sticker', emoji: categoryDef(category).emoji, bg: COIN_SWATCHES[0] };
}

/** Emoji used on pins / avatars for any logo. */
export function logoEmoji(logo: LogoSpec): string {
  return logo.emoji;
}

/** Image src when the logo is uploaded art, else null. */
export function logoImage(logo: LogoSpec): string | null {
  return logo.kind === 'upload' ? logo.dataUrl : null;
}

/** The 5 address-blob gradients (DESIGN §8.12). */
export const ADDRESS_GRADIENTS = [
  'linear-gradient(135deg,#7ad3a3,#0e7c47)',
  'linear-gradient(135deg,#ffd27a,#f59e0b)',
  'linear-gradient(135deg,#a8c3ff,#5b7bd5)',
  'linear-gradient(135deg,#ffb3b8,#cc2f3a)',
  'linear-gradient(135deg,#d1b3ff,#7b4fd5)',
] as const;

/** Gradient for an address blob, picked by hashing the address. */
export function addressGradient(address: string): string {
  return ADDRESS_GRADIENTS[hashString(address) % ADDRESS_GRADIENTS.length] ?? ADDRESS_GRADIENTS[0];
}

/**
 * Resize an uploaded image File to a square, centre-cropped data URL (default 512px, WebP/JPEG).
 * Browser-only (uses canvas). Rejects for non-images. Used by the launch modal before saving
 * so localStorage stays small (LIMITS.artMaxPx).
 */
export async function fileToSquareDataUrl(file: File, size = 512): Promise<string> {
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) throw new Error('unsupported-type');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('decode-failed'));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const out = Math.min(size, side);
    const canvas = document.createElement('canvas');
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no-canvas');
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out);
    const webp = canvas.toDataURL('image/webp', 0.85);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
