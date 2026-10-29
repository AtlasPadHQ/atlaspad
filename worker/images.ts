/**
 * Image sniffing for coin art (INTEGRATION §3.3 step 7): the declared type AND the magic bytes must both be PNG,
 * JPEG or WebP (SVG and GIF are refused), and the dimensions are parsed from the header. Pure, no decoding.
 */
export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageInfo {
  type: ImageType;
  width: number;
  height: number;
  ext: 'png' | 'jpg' | 'webp';
}

const be16 = (d: Uint8Array, o: number) => (d[o]! << 8) | d[o + 1]!;
const be32 = (d: Uint8Array, o: number) => ((d[o]! << 24) >>> 0) + (d[o + 1]! << 16) + (d[o + 2]! << 8) + d[o + 3]!;
const le16 = (d: Uint8Array, o: number) => d[o]! | (d[o + 1]! << 8);
const le24 = (d: Uint8Array, o: number) => d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16);

export function sniffImage(d: Uint8Array): ImageInfo | null {
  // PNG: signature + IHDR first
  if (d.length >= 24 && d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47 && d[4] === 0x0d && d[5] === 0x0a && d[6] === 0x1a && d[7] === 0x0a) {
    if (String.fromCharCode(d[12]!, d[13]!, d[14]!, d[15]!) !== 'IHDR') return null;
    return { type: 'image/png', width: be32(d, 16), height: be32(d, 20), ext: 'png' };
  }
  // JPEG: SOI, then markers until a SOFn
  if (d.length >= 4 && d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) {
    let o = 2;
    while (o + 9 < d.length) {
      if (d[o] !== 0xff) return null;
      let marker = d[o + 1]!;
      while (marker === 0xff && o + 2 < d.length) {
        o++;
        marker = d[o + 1]!;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        o += 2;
        continue;
      }
      const len = be16(d, o + 2);
      if (len < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (o + 9 > d.length) return null;
        return { type: 'image/jpeg', height: be16(d, o + 5), width: be16(d, o + 7), ext: 'jpg' };
      }
      if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before any SOF
      o += 2 + len;
    }
    return null;
  }
  // WebP: RIFF <size> WEBP <chunk>
  if (d.length >= 30 && String.fromCharCode(d[0]!, d[1]!, d[2]!, d[3]!) === 'RIFF' && String.fromCharCode(d[8]!, d[9]!, d[10]!, d[11]!) === 'WEBP') {
    const chunk = String.fromCharCode(d[12]!, d[13]!, d[14]!, d[15]!);
    if (chunk === 'VP8 ') {
      if (d[23] !== 0x9d || d[24] !== 0x01 || d[25] !== 0x2a) return null;
      return { type: 'image/webp', width: le16(d, 26) & 0x3fff, height: le16(d, 28) & 0x3fff, ext: 'webp' };
    }
    if (chunk === 'VP8L') {
      if (d[20] !== 0x2f) return null;
      const b = d[21]! | (d[22]! << 8) | (d[23]! << 16) | (d[24]! << 24);
      return { type: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1, ext: 'webp' };
    }
    if (chunk === 'VP8X') {
      return { type: 'image/webp', width: le24(d, 24) + 1, height: le24(d, 27) + 1, ext: 'webp' };
    }
    return null;
  }
  return null;
}

export const EXT_TYPE: Record<string, ImageType> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
export const TYPE_EXT: Record<ImageType, 'png' | 'jpg' | 'webp'> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
