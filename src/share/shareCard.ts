/**
 * 1200×675 share card PNG (DESIGN §12.5), drawn client-side on a canvas for the prototype.
 * Our own procedural street pattern on #e8e6e1 — never Google tiles, photos or any Google content
 * (coin name/ticker are the launcher's typed values; the launchable card shows no place data at all).
 *
 * Contract: renderShareCard(coin: Coin): Promise<Blob>
 * Extras: renderShareCard(coin, variant) for 'claimed' / 'launched' looks, renderPlaceShareCard()
 * for a shop without a coin.
 */
import { shareOrigin } from '../config';
import { CLUSTER, IS_REAL } from '../mode';
import { pct, usdCompact, usdFull } from '../lib/format';
import { BALLOON_PATH } from '../ui';
import { feesWaiting } from '../store';
import type { Coin, ShareVariant } from '../types';

export const CARD_W = 1200;
export const CARD_H = 675;
const BAND_H = 96;
const AREA_H = CARD_H - BAND_H; // 579

const C = {
  bg: '#e8e6e1',
  text: '#1f1f1f',
  text2: '#5e5e5e',
  green: '#0e7c47',
  greenBright: '#15a35a',
  greenContainer: '#d7f5e1',
  onGreenContainer: '#0b4d2b',
  up: '#0e7c47',
  down: '#cc2f3a',
  amberContainer: '#ffedd0',
  onAmber: '#6b3a00',
  amberBright: '#f59e0b',
  divider: '#e3e3e3',
};

const FONT = '"Roboto Flex", Roboto, "Helvetica Neue", Arial, sans-serif';
const ICONS = '"Material Symbols Rounded"';
const PIN = 'M12 2.5c-3.9 0-7 3-7 6.9C5 14.6 12 21.5 12 21.5s7-6.9 7-12.1c0-3.9-3.1-6.9-7-6.9z';

export type CardVariant = ShareVariant | 'claimed';

/* ------------------------------------------------------------------ helpers */

async function ensureFonts(): Promise<boolean> {
  if (typeof document === 'undefined' || !document.fonts) return false;
  try {
    await Promise.all([
      document.fonts.load(`800 120px ${FONT}`),
      document.fonts.load(`600 44px ${FONT}`),
      document.fonts.load(`700 30px ${FONT}`),
      document.fonts.load(`400 24px ${FONT}`),
      document.fonts.load(`48px ${ICONS}`, 'rocket_launch'),
    ]);
    await document.fonts.ready;
  } catch {
    /* draw with fallbacks */
  }
  try {
    return document.fonts.check(`48px ${ICONS}`, 'rocket_launch');
  } catch {
    return false;
  }
}

function setFont(ctx: CanvasRenderingContext2D, weight: number, size: number, stretch: CanvasFontStretch = 'normal') {
  ctx.font = `${weight} ${size}px ${FONT}`;
  try {
    ctx.fontStretch = stretch;
  } catch {
    /* older engines */
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Fit text into maxWidth by trimming with an ellipsis. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Background: map grey + white "streets" at 20°/115°/160° + three faint green dots. */
function drawStreets(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const band = (cx: number, cy: number, deg: number, width: number) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-1600, -width / 2, 3200, width);
    ctx.restore();
  };
  // three 22px avenues
  band(260, 300, 20, 22);
  band(820, 260, 115, 22);
  band(980, 520, 160, 22);
  // four 12px streets
  band(120, 520, 160, 12);
  band(560, 120, 20, 12);
  band(1080, 220, 115, 12);
  band(420, 470, 115, 12);
  // faint green dots
  ctx.fillStyle = 'rgba(21,163,90,.35)';
  for (const [x, y] of [
    [1040, 140],
    [700, 470],
    [1130, 430],
  ] as const) {
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Amber DEMO chip, 40px tall, 48px from top/right. Real mode: a purple `DEVNET · test SOL` chip on
 * devnet (INTEGRATION.md §7.1), nothing on mainnet.
 */
function drawDemoChip(ctx: CanvasRenderingContext2D) {
  if (IS_REAL && CLUSTER !== 'devnet') return;
  const devnet = IS_REAL;
  setFont(ctx, 700, 24);
  const label = devnet ? 'DEVNET' : 'DEMO';
  const rest = devnet ? ' · test SOL' : ' · simulated prices';
  const wLabel = ctx.measureText(label).width;
  setFont(ctx, 500, 24);
  const wRest = ctx.measureText(rest).width;
  const w = 20 + 12 + 10 + wLabel + wRest + 20;
  const h = 48;
  const x = CARD_W - 48 - w;
  const y = 48;
  ctx.save();
  ctx.shadowColor = 'rgba(60,64,67,.25)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = devnet ? '#ede7ff' : C.amberContainer;
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = devnet ? '#7b4fd5' : C.amberBright;
  ctx.beginPath();
  ctx.arc(x + 26, y + h / 2, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = devnet ? '#3b2a8c' : C.onAmber;
  ctx.textBaseline = 'middle';
  setFont(ctx, 700, 24);
  ctx.fillText(label, x + 42, y + h / 2 + 1);
  setFont(ctx, 500, 24);
  ctx.fillText(rest, x + 42 + wLabel, y + h / 2 + 1);
}

function drawBalloon(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(w / 40, h / 54);
  const p = new Path2D(BALLOON_PATH);
  ctx.shadowColor = 'rgba(0,0,0,.3)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = C.green;
  ctx.fill(p);
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = '#0b6b3d';
  ctx.lineWidth = 1;
  ctx.stroke(p);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(20, 19.6, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Coin avatar: 280px circle at (96,150), 12px white ring, soft shadow; art or sticker. */
async function drawAvatar(ctx: CanvasRenderingContext2D, coin: Coin | null, iconsOk: boolean) {
  const cx = 96 + 140;
  const cy = 150 + 140;
  const r = 140;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.18)';
  ctx.shadowBlur = 32;
  ctx.shadowOffsetY = 12;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 12, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();

  if (!coin) {
    // launchable: dashed white coin with a green rocket
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.setLineDash([14, 10]);
    ctx.lineWidth = 6;
    ctx.strokeStyle = C.green;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.green;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (iconsOk) {
      ctx.font = `150px ${ICONS}`;
      ctx.fillText('rocket_launch', cx, cy + 4);
    } else {
      ctx.font = `120px ${FONT}`;
      ctx.fillText('🚀', cx, cy + 6);
    }
    ctx.textAlign = 'left';
    return;
  }

  let drewArt = false;
  if (coin.logo.kind === 'upload') {
    const img = await loadImage(coin.logo.dataUrl);
    if (img && img.naturalWidth > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - side) / 2;
      const sy = (img.naturalHeight - side) / 2;
      ctx.drawImage(img, sx, sy, side, side, cx - r, cy - r, r * 2, r * 2);
      ctx.restore();
      drewArt = true;
    }
  }
  if (!drewArt) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = coin.logo.bg;
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `150px ${FONT}`;
    ctx.fillStyle = C.text;
    ctx.fillText(coin.logo.emoji, cx, cy + 8);
    ctx.textAlign = 'left';
  }
  // 64×86 balloon pin at the avatar's bottom-right
  drawBalloon(ctx, cx + r * 0.62, cy + r * 0.32, 64, 86);
}

function drawVerifiedBadge(ctx: CanvasRenderingContext2D, x: number, cy: number, size: number) {
  ctx.beginPath();
  ctx.arc(x + size / 2, cy, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = C.green;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = size * 0.11;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x + size * 0.28, cy + size * 0.02);
  ctx.lineTo(x + size * 0.44, cy + size * 0.17);
  ctx.lineTo(x + size * 0.73, cy - size * 0.15);
  ctx.stroke();
}

interface Line {
  h: number;
  draw: (y: number) => void;
}

/** Draws the right-hand text column vertically centred in the area above the band. */
function drawTextColumn(lines: Line[], gap: number) {
  const total = lines.reduce((s, l) => s + l.h, 0) + gap * (lines.length - 1);
  let y = Math.max(40, (AREA_H - total) / 2);
  for (const l of lines) {
    l.draw(y);
    y += l.h + gap;
  }
}

function pillLine(ctx: CanvasRenderingContext2D, text: string, bg: string, fg: string, maxW: number): Line {
  return {
    h: 72,
    draw: (y) => {
      setFont(ctx, 700, 30);
      const label = fitText(ctx, text, maxW - 56);
      const w = Math.min(maxW, ctx.measureText(label).width + 56);
      roundRect(ctx, 448, y, w, 72, 36);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.fillStyle = fg;
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 448 + 28, y + 37);
    },
  };
}

function drawBand(ctx: CanvasRenderingContext2D) {
  const y = AREA_H;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, y, CARD_W, BAND_H);
  ctx.fillStyle = C.divider;
  ctx.fillRect(0, y, CARD_W, 1);
  // app icon 48
  const ix = 48;
  const iy = y + (BAND_H - 48) / 2;
  roundRect(ctx, ix, iy, 48, 48, 14);
  ctx.fillStyle = C.green;
  ctx.fill();
  ctx.save();
  ctx.translate(ix + 7, iy + 7);
  ctx.scale(34 / 24, 34 / 24);
  ctx.fillStyle = '#ffffff';
  ctx.fill(new Path2D(PIN));
  ctx.beginPath();
  ctx.arc(12, 9.4, 3.6, 0, Math.PI * 2);
  ctx.fillStyle = C.green;
  ctx.fill();
  ctx.restore();
  // wordmark
  ctx.fillStyle = C.text;
  ctx.textBaseline = 'middle';
  setFont(ctx, 800, 28, 'expanded');
  try {
    ctx.letterSpacing = '1px';
  } catch {
    /* ignore */
  }
  ctx.fillText('ATLASPAD', ix + 48 + 16, y + BAND_H / 2 + 1);
  try {
    ctx.letterSpacing = '0px';
  } catch {
    /* ignore */
  }
  // url
  setFont(ctx, 400, 24);
  ctx.fillStyle = C.text2;
  ctx.textAlign = 'right';
  ctx.fillText(new URL(shareOrigin()).host, CARD_W - 48, y + BAND_H / 2 + 1);
  ctx.textAlign = 'left';
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

function newCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable');
  return { canvas, ctx };
}

/* ------------------------------------------------------------------ public */

async function drawCoinCard(coin: Coin, variant: CardVariant, allowArt: boolean): Promise<Blob> {
  const iconsOk = await ensureFonts();
  const { canvas, ctx } = newCanvas();
  drawStreets(ctx);
  drawDemoChip(ctx);
  await drawAvatar(ctx, allowArt ? coin : { ...coin, logo: { kind: 'sticker', emoji: coin.logo.emoji, bg: coin.logo.bg } }, iconsOk);

  const claimed = coin.claimed || variant === 'claimed' || variant === 'owner';
  const maxW = 680;
  const lines: Line[] = [];

  // ticker: 120px 800, stretch ~110%, shrinks to fit (min 88px)
  let size = 120;
  const tickerText = `$${coin.ticker}`;
  const badge = claimed ? 56 + 20 : 0;
  setFont(ctx, 800, size, 'semi-expanded');
  while (size > 88 && ctx.measureText(tickerText).width > maxW - badge) {
    size -= 4;
    setFont(ctx, 800, size, 'semi-expanded');
  }
  const tickerSize = size;
  lines.push({
    h: tickerSize,
    draw: (y) => {
      setFont(ctx, 800, tickerSize, 'semi-expanded');
      ctx.fillStyle = C.green;
      ctx.textBaseline = 'middle';
      const t = fitText(ctx, tickerText, maxW - badge);
      ctx.fillText(t, 448, y + tickerSize / 2 + 4);
      if (claimed) drawVerifiedBadge(ctx, 448 + ctx.measureText(t).width + 20, y + tickerSize / 2 + 2, 56);
    },
  });
  lines.push({
    h: 52,
    draw: (y) => {
      setFont(ctx, 600, 44);
      ctx.fillStyle = C.text;
      ctx.textBaseline = 'middle';
      ctx.fillText(fitText(ctx, coin.name, maxW), 448, y + 27);
    },
  });
  lines.push({
    h: 44,
    draw: (y) => {
      setFont(ctx, 600, 36);
      ctx.textBaseline = 'middle';
      const change = pct(coin.change24h);
      ctx.fillStyle = coin.change24h < 0 ? C.down : C.up;
      ctx.fillText(change, 448, y + 23);
      const w = ctx.measureText(change).width;
      ctx.fillStyle = C.text2;
      ctx.fillText(` · ${usdCompact(coin.marketCapUsd)} mcap`, 448 + w, y + 23);
    },
  });
  if (variant === 'launched') lines.push(pillLine(ctx, 'Just launched', C.greenContainer, C.onGreenContainer, maxW));
  else if (claimed) lines.push(pillLine(ctx, 'Claimed by the owner', C.greenContainer, C.onGreenContainer, maxW));
  else lines.push(pillLine(ctx, `💰 ${usdFull(feesWaiting(coin))} waiting for this shop`, C.amberContainer, C.onAmber, maxW));

  drawTextColumn(lines, 18);
  drawBand(ctx);
  return toBlob(canvas);
}

/**
 * Coin share card. `variant`: 'coin' (default; claimed coins get the claimed look automatically),
 * 'launched' (pill `Just launched`), 'owner' / 'claimed' (verified badge + `Claimed by the owner`).
 * Falls back to the sticker if the art can't be drawn (cross-origin image without CORS).
 */
export async function renderShareCard(coin: Coin, variant: CardVariant = 'coin'): Promise<Blob> {
  try {
    return await drawCoinCard(coin, variant, true);
  } catch {
    return drawCoinCard(coin, variant, false);
  }
}

/** Card for a shop with no coin yet: dashed coin + rocket, `No coin yet`, `First launch wins.` */
export async function renderPlaceShareCard(): Promise<Blob> {
  const iconsOk = await ensureFonts();
  const { canvas, ctx } = newCanvas();
  drawStreets(ctx);
  drawDemoChip(ctx);
  await drawAvatar(ctx, null, iconsOk);
  const maxW = 680;
  const lines: Line[] = [
    {
      h: 100,
      draw: (y) => {
        setFont(ctx, 800, 100, 'semi-expanded');
        ctx.fillStyle = C.green;
        ctx.textBaseline = 'middle';
        ctx.fillText(fitText(ctx, 'No coin yet', maxW), 448, y + 54);
      },
    },
    {
      h: 52,
      draw: (y) => {
        setFont(ctx, 600, 44);
        ctx.fillStyle = C.text;
        ctx.textBaseline = 'middle';
        ctx.fillText('First launch wins.', 448, y + 27);
      },
    },
    pillLine(ctx, '100% of creator fees held for the shop', C.amberContainer, C.onAmber, maxW),
  ];
  drawTextColumn(lines, 22);
  drawBand(ctx);
  return toBlob(canvas);
}
