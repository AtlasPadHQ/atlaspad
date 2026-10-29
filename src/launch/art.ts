/**
 * Coin art for real launches (INTEGRATION.md §3.3 / §7.4). Every real coin gets an image:
 *  - uploads are re-encoded to a 512×512 WebP (quality 0.85, stepping down to stay ≤ 200 KB;
 *    PNG / JPEG when the browser can't encode WebP);
 *  - stickers are rendered (emoji 300 px, centred on the coin colour) to a 512×512 PNG.
 * The Worker re-checks type (magic bytes), size and squareness. Browser-only.
 */
import { IMAGE_MAX_BYTES } from '../../worker/wire';

export const ART_PX = 512;

function canvas(size = ART_PX): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  return { c, ctx };
}

function toBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      c.toBlob((b) => resolve(b), type, quality);
    } catch {
      resolve(null);
    }
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = src;
  });
}

/** Encode a canvas within the size cap: WebP 0.85 → 0.7 → 0.55, then JPEG, then PNG. */
export async function encodeCapped(c: HTMLCanvasElement, maxBytes = IMAGE_MAX_BYTES): Promise<Blob> {
  for (const q of [0.85, 0.7, 0.55]) {
    const b = await toBlob(c, 'image/webp', q);
    if (b && b.type === 'image/webp' && b.size <= maxBytes) return b;
    if (b && b.type !== 'image/webp') break; // no WebP encoder in this browser
  }
  for (const q of [0.85, 0.7]) {
    const b = await toBlob(c, 'image/jpeg', q);
    if (b && b.type === 'image/jpeg' && b.size <= maxBytes) return b;
  }
  const png = await toBlob(c, 'image/png');
  if (png && png.size <= maxBytes) return png;
  throw new Error('The image is too large. Try a simpler picture.');
}

/** Uploaded art (data: URL, already square-cropped by the details step) → ≤ 200 KB 512×512 image. */
export async function encodeUpload(dataUrl: string): Promise<Blob> {
  const img = await loadImage(dataUrl);
  const { c, ctx } = canvas();
  // centre-crop to square (defensive: the picker already crops)
  const s = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - s) / 2;
  const sy = (img.naturalHeight - s) / 2;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, s, s, 0, 0, ART_PX, ART_PX);
  return encodeCapped(c);
}

/** Sticker coin (emoji on its colour) → 512×512 PNG. */
export async function renderSticker(emoji: string, bg: string): Promise<Blob> {
  const { c, ctx } = canvas();
  ctx.fillStyle = /^#[0-9a-f]{6}$/i.test(bg) ? bg : '#dff3e6';
  ctx.fillRect(0, 0, ART_PX, ART_PX);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `300px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.fillText(emoji, ART_PX / 2, ART_PX / 2 + 16);
  const png = await toBlob(c, 'image/png');
  if (png && png.size <= IMAGE_MAX_BYTES) return png;
  return encodeCapped(c);
}
