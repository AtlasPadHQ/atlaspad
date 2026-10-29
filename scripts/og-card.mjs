#!/usr/bin/env node
/**
 * Renders the AtlasPad share card: design/og-card.html → public/og.png (1200×630), with the local headless Chrome and
 * local fonts only (no network). The Worker serves this file for every /api/og/* share image (worker/share.ts), and
 * index.html names it as og:image / twitter:image on https://atlaspad.online.
 *
 *   node scripts/og-card.mjs [--chrome <path to Chrome or Chromium>] [--out public/og.png]
 *   CHROME=<path> works too. Default: /Applications/Google Chrome.app (macOS).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fatal, ok, parseArgs } from './lib/log.mjs';
import { ROOT } from './lib/paths.mjs';

export const CARD = { width: 1200, height: 630 };
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
export function pngSize(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || sig.some((b, i) => buf[i] !== b) || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Headless Chrome flags for one screenshot of `htmlUrl` into `out` (own throwaway profile, never the user's). */
export function chromeArgs(htmlUrl, out, profileDir) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profileDir}`,
    `--window-size=${CARD.width},${CARD.height}`,
    '--virtual-time-budget=5000',
    `--screenshot=${out}`,
    htmlUrl,
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chrome = String(args.chrome ?? process.env.CHROME ?? MAC_CHROME);
  if (!existsSync(chrome)) fatal(`Chrome not found at ${chrome}: pass --chrome <path>`, 64);
  const out = resolve(ROOT, String(args.out ?? 'public/og.png'));
  const html = pathToFileURL(join(ROOT, 'design', 'og-card.html')).href;
  const profile = mkdtempSync(join(tmpdir(), 'atlaspad-og-'));
  try {
    const code = await new Promise((done) => {
      const child = spawn(chrome, chromeArgs(html, out, profile), { stdio: ['ignore', 'ignore', 'pipe'] });
      child.on('close', done);
      child.on('error', () => done(1));
    });
    if (code !== 0) fatal(`Chrome exited with ${code}`);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  const size = pngSize(readFileSync(out));
  if (!size || size.width !== CARD.width || size.height !== CARD.height) fatal(`${out} is ${JSON.stringify(size)}, expected ${CARD.width}×${CARD.height}`);
  ok(`${out} (${size.width}×${size.height})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => fatal(e.message));
}
