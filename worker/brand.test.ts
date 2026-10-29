/**
 * The AtlasPad rename on the Worker side. Website ownership markers: the AtlasPad meta tag / well-known file are
 * primary, the CORNERSHOP-era ones are still accepted, and only owner-controlled places count (worker/siteMarker.ts,
 * worker/website.ts). Plus the platform name in the moderation list (worker/moderation.ts) and the AtlasPad label on
 * alert webhooks (worker/ctx.ts).
 */
import './test/globals';
import { describe, expect, it } from 'vitest';
import { alert, type Deps } from './ctx';
import type { Env } from './env';
import { makeLogger } from './log';
import { moderationHit } from './moderation';
import { VERIFY_META_NAME, WELL_KNOWN_PATH, WELL_KNOWN_PATHS, websiteCodeForms, websiteCodeValue, websiteMetaTag } from './siteMarker';
import { FakeD1 } from './test/fakeD1';
import { findOwnershipProof, homeHeadHasCode, websiteCode, wellKnownHasCode, type SitePage } from './website';

const CODE = 'atlaspad-verify=7KQ2-M9XD';
const LEGACY = 'cornershop-verify=7KQ2-M9XD';
const txt = (text: string): SitePage => ({ text, contentType: 'text/plain' });
const html = (text: string): SitePage => ({ text, contentType: 'text/html' });

describe('marker strings', () => {
  it('issues atlaspad-verify codes and names the AtlasPad tag and file first', () => {
    for (let i = 0; i < 20; i++) expect(websiteCode()).toMatch(/^atlaspad-verify=[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(VERIFY_META_NAME).toBe('atlaspad-verify');
    expect(WELL_KNOWN_PATH).toBe('/.well-known/atlaspad.txt');
    expect(WELL_KNOWN_PATHS).toEqual(['/.well-known/atlaspad.txt', '/.well-known/cornershop.txt']);
  });

  it('strips either label and always shows the AtlasPad tag', () => {
    expect(websiteCodeValue(CODE)).toBe('7KQ2-M9XD');
    expect(websiteCodeValue(LEGACY)).toBe('7KQ2-M9XD');
    expect(websiteCodeValue('7KQ2-M9XD')).toBe('7KQ2-M9XD');
    expect(websiteCodeForms(LEGACY)).toEqual(['7KQ2-M9XD', CODE, LEGACY]);
    expect(websiteMetaTag(CODE)).toBe('<meta name="atlaspad-verify" content="7KQ2-M9XD">');
    expect(websiteMetaTag(LEGACY)).toBe('<meta name="atlaspad-verify" content="7KQ2-M9XD">'); // a pre-rename claim
  });
});

describe('well-known file', () => {
  it('accepts the code (any label, or the bare value) as a whole line of a plain-text file', () => {
    expect(wellKnownHasCode(txt(`${CODE}\n`), CODE)).toBe(true);
    expect(wellKnownHasCode(txt('  7KQ2-M9XD  \r\n'), CODE)).toBe(true);
    expect(wellKnownHasCode(txt(`# AtlasPad\n${LEGACY}\n`), CODE)).toBe(true);
    expect(wellKnownHasCode(txt(`${CODE}\n`), LEGACY)).toBe(true); // a claim issued before the rename
  });

  it('refuses HTML, partial lines, other codes and oversized files', () => {
    expect(wellKnownHasCode(html(`${CODE}\n`), CODE)).toBe(false);
    expect(wellKnownHasCode(txt(`<!doctype html><p>${CODE}</p>`), CODE)).toBe(false);
    expect(wellKnownHasCode(txt(`hello ${CODE}\n`), CODE)).toBe(false);
    expect(wellKnownHasCode(txt('atlaspad-verify=AAAA-BBBB\n'), CODE)).toBe(false);
    expect(wellKnownHasCode(txt('other-verify=7KQ2-M9XD\n'), CODE)).toBe(false);
    expect(wellKnownHasCode(txt(`${'x'.repeat(4_100)}\n${CODE}`), CODE)).toBe(false);
  });
});

describe('home page meta tag', () => {
  const page = (head: string, body = '') => html(`<!doctype html><html><head><title>Cafe</title>${head}</head><body>${body}</body></html>`);

  it('accepts the atlaspad-verify tag and the legacy cornershop-verify tag in <head>', () => {
    expect(homeHeadHasCode(page('<meta name="atlaspad-verify" content="7KQ2-M9XD">'), CODE)).toBe(true);
    expect(homeHeadHasCode(page("<meta content='7KQ2-M9XD' name='ATLASPAD-VERIFY'>"), CODE)).toBe(true);
    expect(homeHeadHasCode(page('<meta name="cornershop-verify" content="7KQ2-M9XD">'), CODE)).toBe(true);
    expect(homeHeadHasCode(page(`<meta name="atlaspad-verify" content="${CODE}">`), CODE)).toBe(true);
    expect(homeHeadHasCode(page('<meta name="atlaspad-verify" content="7KQ2-M9XD">'), LEGACY)).toBe(true);
  });

  it('never counts visitor content: the body, scripts, comments, other names or another code', () => {
    expect(homeHeadHasCode(page('', `<meta name="atlaspad-verify" content="7KQ2-M9XD"><p>${CODE}</p>`), CODE)).toBe(false);
    expect(homeHeadHasCode(page('<script type="application/ld+json">{"r":"<meta name=\\"atlaspad-verify\\" content=\\"7KQ2-M9XD\\">"}</script>'), CODE)).toBe(false);
    expect(homeHeadHasCode(page('<!-- <meta name="atlaspad-verify" content="7KQ2-M9XD"> -->'), CODE)).toBe(false);
    expect(homeHeadHasCode(page('<meta name="google-site-verification" content="7KQ2-M9XD">'), CODE)).toBe(false);
    expect(homeHeadHasCode(page('<meta name="atlaspad-verify" content="AAAA-BBBB">'), CODE)).toBe(false);
    expect(homeHeadHasCode(txt('<head><meta name="atlaspad-verify" content="7KQ2-M9XD"></head>'), CODE)).toBe(false);
  });

  it('a verify tag quoted inside another tag`s attribute is text, not a tag (an og:description echoing a review)', () => {
    const nested = [
      '<meta property="og:description" content="Great! <meta name=atlaspad-verify content=7KQ2-M9XD> yes">',
      `<meta property="og:description" content='Great! <meta name="atlaspad-verify" content="7KQ2-M9XD"> yes'>`,
      '<meta property="og:description" content="<meta name=\'atlaspad-verify\' content=\'7KQ2-M9XD\'>">',
      '<meta name="description" content="x"><link rel="alternate" title="<meta name=cornershop-verify content=7KQ2-M9XD>" href="/feed">',
      '<meta property="og:description" content="Great!\n<meta name=atlaspad-verify\ncontent=7KQ2-M9XD>\nyes">',
    ];
    for (const head of nested) expect(homeHeadHasCode(page(head), CODE), head).toBe(false);
    // comments end where browsers end them ('<!-->', '<!--->', '--!>'), so text after them is not inside a comment
    expect(homeHeadHasCode(page('<!--><meta property="og:description" content="--><meta name=atlaspad-verify content=7KQ2-M9XD>">'), CODE)).toBe(false);
    expect(homeHeadHasCode(page('<!---><meta property="og:description" content="--><meta name=atlaspad-verify content=7KQ2-M9XD>">'), CODE)).toBe(false);
    expect(homeHeadHasCode(page('<!-- x --!><meta property="og:description" content="--><meta name=atlaspad-verify content=7KQ2-M9XD>">'), CODE)).toBe(false);
    expect(homeHeadHasCode(page('<!-- note --><meta name="atlaspad-verify" content="7KQ2-M9XD">'), CODE)).toBe(true);
    // in the <html> / <head> tags' own attributes too
    expect(homeHeadHasCode(html('<html data-x="<meta name=atlaspad-verify content=7KQ2-M9XD>"><head></head><body></body></html>'), CODE)).toBe(false);
    expect(homeHeadHasCode(html('<html><head data-x=\'<meta name="atlaspad-verify" content="7KQ2-M9XD">\'></head><body></body></html>'), CODE)).toBe(false);
    // a `</head>` or `<body>` quoted in an attribute does not end the head early, and a `>` in a value does not end a tag
    expect(homeHeadHasCode(page('<meta property="og:description" content="a </head><body> b"><meta name="atlaspad-verify" content="7KQ2-M9XD">'), CODE)).toBe(true);
    expect(homeHeadHasCode(page(`<meta property="og:description" content='5 > 4'><meta name="atlaspad-verify" content="7KQ2-M9XD">`), CODE)).toBe(true);
  });

  it('only a real <meta> whose own name and content match counts', () => {
    expect(homeHeadHasCode(page('<meta name=atlaspad-verify content=7KQ2-M9XD>'), CODE)).toBe(true);
    expect(homeHeadHasCode(page('<meta\n  name="atlaspad-verify"\n  content="7KQ2-M9XD"\n/>'), CODE)).toBe(true);
    expect(homeHeadHasCode(page('<META NAME="atlaspad-verify" CONTENT=" 7KQ2-M9XD ">'), CODE)).toBe(true);
    expect(homeHeadHasCode(page('<meta property="og:title" content="Cafe"/><meta name="atlaspad-verify" content="7KQ2-M9XD"/><link rel="icon" href="/f.ico">'), CODE)).toBe(true);
    expect(homeHeadHasCode(html('<!DOCTYPE html><?xml x?><html lang="en"><head><meta charset="utf-8"><meta name="atlaspad-verify" content="7KQ2-M9XD"></head><body>a < b</body></html>'), CODE)).toBe(true);
    // the first of a repeated attribute wins (as in a browser); <metadata> is not <meta>; the content must be its own
    expect(homeHeadHasCode(page('<meta name="description" name="atlaspad-verify" content="7KQ2-M9XD">'), CODE)).toBe(false);
    expect(homeHeadHasCode(page('<metadata name="atlaspad-verify" content="7KQ2-M9XD">'), CODE)).toBe(false);
    expect(homeHeadHasCode(page('<meta name="atlaspad-verify" data-content="7KQ2-M9XD">'), CODE)).toBe(false);
    expect(homeHeadHasCode(page('<meta name="atlaspad-verify"><meta name="x" content="7KQ2-M9XD">'), CODE)).toBe(false);
    // raw-text elements hide what is inside them; an unterminated tag, quote or head proves nothing
    for (const el of ['style', 'noscript', 'template', 'title', 'textarea']) {
      expect(homeHeadHasCode(page(`<${el}><meta name="atlaspad-verify" content="7KQ2-M9XD"></${el}>`), CODE), el).toBe(false);
    }
    expect(homeHeadHasCode(html('<html><head><meta name="atlaspad-verify" content="7KQ2-M9XD"'), CODE)).toBe(false);
    expect(homeHeadHasCode(html('<html><head><meta property="og:x" content="<meta name=atlaspad-verify content=7KQ2-M9XD>'), CODE)).toBe(false);
    expect(homeHeadHasCode(html('<html><head><meta name="atlaspad-verify" content="7KQ2-M9XD">'), CODE)).toBe(false);
  });
});

describe('findOwnershipProof', () => {
  /** A site: path → [content-type, body]; everything else 404. Records the paths requested, in order. */
  function site(pages: Record<string, [string, string]>, catchAll?: [string, string]) {
    const requested: string[] = [];
    const agents = new Set<string>();
    const deps: Deps = {
      now: () => 0,
      fetch: async (input: string, init?: RequestInit) => {
        const u = new URL(input);
        requested.push(u.pathname);
        agents.add((init?.headers as Record<string, string>)['user-agent'] ?? '');
        const p = pages[u.pathname] ?? catchAll;
        return p ? new Response(p[1], { status: 200, headers: { 'content-type': p[0] } }) : new Response('not found', { status: 404 });
      },
    };
    return { deps, requested, agents };
  }
  const HOST = 'www.mycafe.co.uk';

  it('checks /.well-known/atlaspad.txt first', async () => {
    const s = site({ '/.well-known/atlaspad.txt': ['text/plain', `${CODE}\n`] });
    expect(await findOwnershipProof(s.deps, HOST, CODE)).toBe('well-known');
    expect(s.requested).toEqual(['/.well-known/atlaspad.txt']);
    expect([...s.agents]).toEqual(['AtlasPadVerify/1.0 (+https://atlaspad.online)']);
  });

  it('still accepts the legacy /.well-known/cornershop.txt and the legacy meta tag', async () => {
    const legacyFile = site({ '/.well-known/cornershop.txt': ['text/plain', `${LEGACY}\n`] });
    expect(await findOwnershipProof(legacyFile.deps, HOST, CODE)).toBe('well-known');
    expect(legacyFile.requested).toEqual(['/.well-known/atlaspad.txt', '/.well-known/cornershop.txt']);
    const legacyMeta = site({ '/': ['text/html', '<html><head><meta name="cornershop-verify" content="7KQ2-M9XD"></head><body></body></html>'] });
    expect(await findOwnershipProof(legacyMeta.deps, HOST, CODE)).toBe('meta');
    expect(legacyMeta.requested).toEqual(['/.well-known/atlaspad.txt', '/.well-known/cornershop.txt', '/']);
  });

  it('a home page whose og:description quotes a review with a verify tag proves nothing (and the well-known files stay plain text)', async () => {
    const review = (q: string) => `<meta property="og:description" content=${q}Great! <meta name=atlaspad-verify content=7KQ2-M9XD> yes${q}>`;
    for (const q of ['"', "'"]) {
      const s = site({ '/': ['text/html', `<html><head>${review(q)}</head><body></body></html>`], '/.well-known/atlaspad.txt': ['text/html', `<html><head>${review(q)}</head></html>`] });
      expect(await findOwnershipProof(s.deps, HOST, CODE)).toBeNull();
      expect(s.requested).toEqual(['/.well-known/atlaspad.txt', '/.well-known/cornershop.txt', '/']);
    }
    const real = site({ '/': ['text/html', `<html><head>${review('"')}<meta name="atlaspad-verify" content="7KQ2-M9XD"></head><body></body></html>`] });
    expect(await findOwnershipProof(real.deps, HOST, CODE)).toBe('meta');
  });

  it('a catch-all site that echoes visitor text on every path proves nothing', async () => {
    const s = site({}, ['text/html', `<html><head><title>x</title></head><body>${CODE}<meta name="atlaspad-verify" content="7KQ2-M9XD"></body></html>`]);
    expect(await findOwnershipProof(s.deps, HOST, CODE)).toBeNull();
    expect(s.requested).toEqual(['/.well-known/atlaspad.txt', '/.well-known/cornershop.txt', '/']);
  });
});

describe('platform name', () => {
  it('a coin may not impersonate AtlasPad (or its old name)', () => {
    for (const bad of ['AtlasPad', 'ATLASPAD Rewards', 'Atl4sP4d', 'the atlaspad coin', 'AtlasPad.']) expect(moderationHit(bad), bad).toBe('atlaspad');
    expect(moderationHit('Cornershop Cafe')).toBe('cornershop');
    // our brand split across words is refused too ("Atlas Pad Rewards"); names that merely start the same way still launch
    expect(moderationHit('Atlas Pad Rewards')).toBe('atlaspad');
    for (const ok of ['Atlas Kebab', 'Launch Pad Cafe', 'The Atlas Bar', 'Atlas Padel Club']) expect(moderationHit(ok), ok).toBeNull();
  });

  it('our brand inside a longer word or with a suffix is caught too (all caps, lower case, separators)', () => {
    const bad = [
      'ATLASPAD', 'ATLASPADX', 'atlaspadz', 'AtlasPadz', 'AtlasPads', 'ATLASPADS', 'ATLASPADCOIN', 'ATLASPADTOKEN', 'atlaspadcoin',
      'theatlaspad', 'TheAtlasPad', '$ATLASPADX', 'atlas-padd', 'atlas_pad', 'atlas pad', 'Atlas.Pad.Token', 'ATLAS PAD INU', 'AtlasPadAI',
      '4TL4SP4DX', 'atl@spadx', 'Ａｔｌａｓｐａｄｓ',
      // spelt across words, with a token-style word run on to it
      'ATLAS PADCOIN', 'Atlas Padtoken', 'atlas_padinu', 'ATLAS-PADDAO', 'Atlas Padmoon', 'atlas.padswap', 'ATLAS PADDINGTONCOIN',
      // a real word next to it does not hide it
      'AtlasPadel AtlasPad', 'Atlas Paddle x ATLASPAD',
    ];
    for (const b of bad) expect(moderationHit(b), b).toBe('atlaspad');
    expect(moderationHit('AtlasPadOfficial')).not.toBeNull(); // 'official' is blocked anywhere as well
    expect(moderationHit('Corner Cafe', 'CAFE', 'Brought to you by ATLASPADX')).toBe('atlaspad');
  });

  it('a word after our brand never hides it, even one that would make a real word without the space', () => {
    const bad = [
      'AtlasPad Elite', 'Atlas Pad Elite', 'ATLASPAD ELECTION', 'AtlasPad Elon', 'atlaspad eleven', 'AtlasPad Dlux', 'AtlasPad Dock', 'Atlas Pad Dockyard',
      'AtlasPad El Dorado', 'AtlasPad Elegance Coin', 'AtlasPadElite', 'AtlasPadDock', 'AtlasPadDle', 'Atlas Pad Thai',
    ];
    for (const b of bad) expect(moderationHit(b), b).toBe('atlaspad');
  });

  it('real words that only start like our brand still launch', () => {
    const ok = [
      'Atlas Padel Club', 'AtlasPadel', 'ATLAS PADEL', 'TheAtlasPadel', 'Atlas Paddle Boards', 'AtlasPaddles', 'Atlas Paddling Club', 'Atlas Paddock Stables',
      'Atlas Paddington', 'Atlas Padstow', 'Atlas Padua', 'ATLAS PADRE', 'Atlas Padres', 'Atlas Padang Kitchen', 'Launch Pad Cafe', 'Pad Atlas',
      'Atlas Bar & Pad Thai',
      // camel case and compounds: the real word is judged as a word
      'AtlasPadelClub', 'Atlas PadelClub', 'TheAtlasPadelClub', 'AtlasPadelCafe', 'Atlas Paddleboards', 'AtlasPaddleBoards', 'Atlas Paddleboarding',
    ];
    for (const n of ok) expect(moderationHit(n), n).toBeNull();
    // a run across words is judged wherever it starts (documented in worker/moderation.ts)
    for (const b of ['Tapas at Las Padillas', 'AtlasPadsClub', 'AtlasPadElClub']) expect(moderationHit(b), b).toBe('atlaspad');
    // capitals then a capitalised word: the word starts at its own capital ("ATLASPAD|Elite"), not after it
    for (const b of ['AtlasPADElClub', 'ATLASPADElClub', 'ATLASPADElITE', 'ATLASPADReWards', 'AtlasPADResLabs', 'ATLASPADUaToken', 'AtlasPADReX']) {
      expect(moderationHit(b), b).toBe('atlaspad');
    }
    for (const n of ['ATLASPadelClub', 'ATLASPADELClub', 'Atlas PADDLEs', 'ATLAS PADDLEs Club']) expect(moderationHit(n), n).toBeNull();
  });
});

describe('alert webhook', () => {
  it('labels every post AtlasPad with the cluster', async () => {
    const posts: string[] = [];
    const env = { ASSETS: {} as Fetcher, ALERT_WEBHOOK_URL: 'https://discord.example/api/webhooks/1/x' } as Env;
    const deps: Deps = {
      now: () => 1_000_000,
      fetch: async (_input: string, init?: RequestInit) => {
        posts.push(String(init?.body));
        return new Response(null, { status: 204 });
      },
    };
    await alert({ db: new FakeD1().asD1(), env, deps, log: makeLogger(env), cluster: 'mainnet' }, 'warn', 'claim_website_verified', 'Website-code claim c1 verified');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!).content).toBe('[AtlasPad mainnet] WARN claim_website_verified: Website-code claim c1 verified');
  });
});
