/**
 * Copy guard for real money: nothing the app, the Worker or the static pages ship may overstate how the fees work
 * ("go straight to the shop", "nobody, including us, can move the money") or call a community coin "official".
 * Accurate wording: 100% of creator fees are held in the shop's vault for its verified owner (public/terms.html §6).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

const OVERSTATED: readonly RegExp[] = [
  /straight to the shop/i,
  /come straight to our shop/i,
  /nobody, including us, can move/i,
  /only that wallet can ever withdraw/i,
  /creator fees? go(?:es)? to the shop(?!'s vault)/i,
  /every creator fee goes to/i,
  /\bofficial coin/i,
];

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, ext));
    else if (ext.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('fee and affiliation copy', () => {
  it('no shipped text overstates where the fees go or calls a coin official', () => {
    const shipped = [
      ...files(join(ROOT, 'src'), /\.tsx?$/),
      ...files(join(ROOT, 'worker'), /\.ts$/),
      join(ROOT, 'index.html'),
      ...files(join(ROOT, 'public'), /\.html$/),
    ];
    expect(shipped.length).toBeGreaterThan(50);
    const hits: string[] = [];
    for (const f of shipped) {
      const raw = readFileSync(f, 'utf8');
      // code comments are not shipped copy (HTML is checked whole)
      const text = /\.tsx?$/.test(f) ? raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ') : raw;
      for (const re of OVERSTATED) {
        const m = re.exec(text);
        if (m) hits.push(`${relative(ROOT, f)}: "${m[0]}"`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the Terms and Privacy pages cover every point the real-money launch needs', () => {
    const html = (name: string) => readFileSync(join(ROOT, 'public', name), 'utf8');
    const page = (name: string) => html(name).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const terms = page('terms.html');
    for (const must of [
      'operated from London, United Kingdom',
      'hello@atlaspad.online',
      '18 or older',
      'VPN',
      'launch interface for coins on pump.fun',
      'not affiliated with',
      "AtlasPad's attestor decides who becomes the owner",
      'guardian',
      'governance',
      'upgrade authority held by a multisig',
      '0% of creator fees',
      "pump.fun's own fees apply",
      'Memecoins can go to zero',
      'cannot be reversed',
      'Smart-contract risk',
      'Third-party risk',
      'No investment advice',
      'not impersonate',
      'not abuse trademarks',
      'Names are permanent',
      'A code proves control of the listed contact, not legal ownership',
      '72-hour public window',
      'Disputes',
      'Cancellation',
      'Takedown and opt-out',
      'Limitation of liability',
      'Changes to these terms',
      'law of England and Wales',
    ]) {
      expect(terms.includes(must), must).toBe(true);
    }
    // the Google Maps Platform terms and privacy links stay
    for (const href of ['https://maps.google.com/help/terms_maps/', 'https://policies.google.com/privacy']) expect(html('terms.html').includes(`href="${href}"`), href).toBe(true);
    const privacy = page('privacy.html');
    for (const must of [
      'UK GDPR',
      'hello@atlaspad.online',
      'HMAC',
      'Public wallet addresses',
      'hash of the number',
      '180 days',
      'permanently',
      'Cloudflare',
      'Google Maps Platform',
      'Alchemy',
      'pump.fun programs',
      'Twilio',
      "Information Commissioner's Office",
      'local storage',
    ]) {
      expect(privacy.includes(must), must).toBe(true);
    }
  });

  // Terms §6 may call governance a multisig only once Squads vault A holds it on chain (deploy/mainnet.json records the
  // handover). Until then it is a single key, and the Terms say so; after the handover this fails until §6 is reverted.
  it('Terms §6 describes governance as it is recorded in deploy/mainnet.json', () => {
    const dep = JSON.parse(readFileSync(join(ROOT, 'deploy', 'mainnet.json'), 'utf8')) as { governance?: string; squadsAVault?: string };
    const terms = readFileSync(join(ROOT, 'public', 'terms.html'), 'utf8').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const handedOver = !!dep.governance && dep.governance === dep.squadsAVault;
    expect(/governance multisig/i.test(terms), 'governance multisig').toBe(handedOver);
    expect(terms.includes('governance key (being moved to a multisig)'), 'governance key (being moved to a multisig)').toBe(!handedOver);
  });

  it('the guard itself catches the old wording', () => {
    for (const old of ['all creator fees go straight to the shop.', '100% of creator fees go to the shop.', 'One official coin per place', 'nobody, including us, can move the money']) {
      expect(OVERSTATED.some((re) => re.test(old)), old).toBe(true);
    }
    expect(OVERSTATED.some((re) => re.test("100% of creator fees go to this shop's vault"))).toBe(false);
    expect(OVERSTATED.some((re) => re.test("100% of creator fees are held for the shop's verified owner."))).toBe(false);
  });
});
