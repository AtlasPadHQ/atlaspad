/**
 * Legal + disclosure rules on the Worker: the fixed affiliation disclaimer at the end of every coin's metadata
 * description (within the length limit), "atlaspad" in the launch-name blocklist, and the 180-day retention of
 * reports / opt-outs (names and emails) promised by public/privacy.html.
 */
import './test/globals';
import { describe, expect, it } from 'vitest';
import { CONFIG_PDA, SHOP_VAULT_PROGRAM_ID } from './consts';
import { DAY, type Deps } from './ctx';
import { COIN_DISCLAIMER, withDisclaimer } from './disclaimer';
import type { Env } from './env';
import { runIndexer } from './indexer';
import { moderationHit } from './moderation';
import { buildCtx, handlePhase2 } from './router';
import { configData, FakeWorld } from './test/fakeChain';
import { FakeD1 } from './test/fakeD1';
import { NodeBuffer, web3 } from './test/launchFixture';
import { DESCRIPTION_MAX_CHARS, type MetadataUploadResponse } from './wire';

const ORIGIN = 'https://cornershop-devnet.tiejiucai.workers.dev';
const len = (s: string) => [...s].length;

describe('coin metadata disclaimer', () => {
  it('is the fixed sentence, alone when there is no description', () => {
    expect(COIN_DISCLAIMER).toBe('Community coin. Not affiliated with this business unless claimed on atlaspad.online.');
    expect(withDisclaimer('')).toBe(COIN_DISCLAIMER);
    expect(withDisclaimer('   ')).toBe(COIN_DISCLAIMER);
  });

  it("follows the launcher's text after a blank line", () => {
    expect(withDisclaimer('Best flat white in E8')).toBe(`Best flat white in E8\n\n${COIN_DISCLAIMER}`);
  });

  it('never exceeds the limit: the launcher text is cut (with …), never the disclaimer', () => {
    for (const n of [150, 194, 195, 220, DESCRIPTION_MAX_CHARS]) {
      const out = withDisclaimer('x'.repeat(n));
      expect(len(out), String(n)).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
      expect(out.endsWith(`\n\n${COIN_DISCLAIMER}`), String(n)).toBe(true);
    }
    const fits = 'y'.repeat(DESCRIPTION_MAX_CHARS - len(COIN_DISCLAIMER) - 2);
    expect(withDisclaimer(fits)).toBe(`${fits}\n\n${COIN_DISCLAIMER}`);
    const cut = withDisclaimer(`${fits}z`);
    expect(len(cut)).toBe(DESCRIPTION_MAX_CHARS);
    expect(cut.startsWith(`${fits.slice(0, -1)}…\n\n`)).toBe(true);
  });

  it('cuts on a grapheme boundary (no split emoji or accent) and drops trailing spaces', () => {
    const flags = '🇬🇧'.repeat(200); // each flag = 2 code points
    const out = withDisclaimer(flags);
    const user = out.slice(0, out.indexOf('…'));
    expect(len(user) % 2).toBe(0);
    expect(len(out)).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
    const accents = 'é'.repeat(150);
    const a = withDisclaimer(accents);
    expect(a.slice(0, a.indexOf('…')).endsWith('é')).toBe(true);
    const budget = DESCRIPTION_MAX_CHARS - len(COIN_DISCLAIMER) - 2;
    expect(withDisclaimer(`${'a'.repeat(budget - 2)}  bbbb`)).toBe(`${'a'.repeat(budget - 2)}…\n\n${COIN_DISCLAIMER}`);
  });

  it('a stricter limit still keeps the whole disclaimer', () => {
    expect(withDisclaimer('hello', 50)).toBe(COIN_DISCLAIMER);
  });
});

describe('launch-name blocklist', () => {
  it('blocks our own brand, alone, in names, leetspeak or split in two words', () => {
    for (const bad of ['AtlasPad', 'ATLASPAD Cafe', 'atlaspad coin', 'Atl4sP4d', 'Atlas Pad', 'ATLAS-PAD', 'the atlas.pad bakery']) expect(moderationHit(bad), bad).not.toBeNull();
    expect(moderationHit('Corner Cafe', 'CAFE', 'Brought to you by AtlasPad')).toBe('atlaspad');
  });

  it('accents, fullwidth / styled letters, Cyrillic or Greek look-alikes and spelt-out letters do not get past it', () => {
    const spoofs = [
      '\u00c4tlasPad', // Ä
      'Atlas P\u00e4d Cafe', // ä in the second word
      '\uff21\uff34\uff2c\uff21\uff33\uff30\uff21\uff24', // fullwidth
      '\ud835\udc00\ud835\udc2d\ud835\udc25\ud835\udc1a\ud835\udc2c\ud835\udc0f\ud835\udc1a\ud835\udc1d', // mathematical bold
      '\u0410tlasPad', // Cyrillic А
      'Atl\u0430s P\u0430d', // Cyrillic а twice, two words
      '\u0391TLASPAD', // Greek Alpha
      'Atl@s Pad',
      '@tlasPad',
      'A T L A S P A D',
      'A.T.L.A.S.P.A.D Coffee',
      'At las Pad',
      'AtlasPadCoin', // camel case
      'The MyAtlasPad Token',
    ];
    for (const bad of spoofs) expect(moderationHit(bad), bad).toBe('atlaspad');
    expect(moderationHit('C\u00f6rnershop')).toBe('cornershop');
    expect(moderationHit('\u0405\u043el\u0430n\u0430 Barbers')).toBe('solana'); // Cyrillic Ѕ, о, а
  });

  it('folding does not create false hits on real names (and fixes accented ones)', () => {
    for (const ok of ['Caf\u00e9 Sol\u00e9', 'Atlas Padel', 'Pad Thai Atlas', 'Kebab at Las Palmas', '\u041a\u043e\u0444\u0435\u0439\u043d\u044f \u0410\u0442\u043b\u0430\u0441', '\u039a\u03b1\u03c6\u03ad \u0386\u03c4\u03bb\u03b1\u03c2', 'Rock & Roll $5 Pizza', 'Cafe@Home', 'AtlasPadel Club', 'SolCafe']) {
      expect(moderationHit(ok), ok).toBeNull();
    }
  });

  it('still blocks the internal name, and leaves real businesses alone', () => {
    expect(moderationHit('Cornershop')).toBe('cornershop');
    for (const ok of ['Atlas Padel Club', 'Atlas Cafe', 'Launch Pad Bar', 'Atlas Bar & Pad Thai', 'Pad Atlas']) expect(moderationHit(ok), ok).toBeNull();
  });
});

/* ------------------------------------------------------------------ Worker routes + cron */

const world = new FakeWorld();
const db = new FakeD1();
const b64 = (u: Uint8Array) => NodeBuffer.from(u).toString('base64');
const env: Env = {
  ASSETS: { fetch: async () => new Response('x') } as unknown as Fetcher,
  DB: db.asD1(),
  CLUSTER: 'devnet',
  PUBLIC_ORIGIN: ORIGIN,
  PROGRAM_ID: SHOP_VAULT_PROGRAM_ID,
  MAX_DEV_BUY_LAMPORTS: '1000000000',
  PRIORITY_FEE_DEFAULT: '10000',
  GOOGLE_SERVER_KEY: 'google-server-key-test-0003',
  ALCHEMY_API_KEY: 'alchemy-secret-legal-test',
  ATTESTOR_SECRET: b64(web3.Keypair.generate().secretKey),
  CRANK_SECRET: b64(web3.Keypair.generate().secretKey),
  HMAC_KEY: b64(crypto.getRandomValues(new Uint8Array(32))),
};
const clock = Date.UTC(2026, 9, 26, 12);
const deps: Deps = { fetch: world.fetch, now: () => clock, sleep: async () => {} };
const exec = { waitUntil: () => undefined };

function png(w: number, h: number): Uint8Array {
  const d = new Uint8Array(64);
  d.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(d.buffer).setUint32(16, w);
  new DataView(d.buffer).setUint32(20, h);
  return d;
}

describe('metadata route', () => {
  it('the served metadata JSON carries the disclaimer; the registry keeps the launcher text', async () => {
    const f = new FormData();
    f.set('name', 'Corner Cafe');
    f.set('symbol', 'CAFE');
    f.set('description', 'Best flat white in E8');
    f.set('placeId', 'ChIJlegal00000000001');
    f.set('image', new Blob([png(512, 512)], { type: 'image/png' }), 'art.png');
    const res = (await handlePhase2(new Request(`${ORIGIN}/api/metadata`, { method: 'POST', body: f, headers: { origin: ORIGIN, 'cf-connecting-ip': '203.0.113.7' } }), env, exec, deps))!;
    expect(res.status).toBe(200);
    const up = (await res.json()) as MetadataUploadResponse;
    const meta = (await (await handlePhase2(new Request(up.uri), env, exec, deps))!.json()) as { description: string };
    expect(meta.description).toBe(`Best flat white in E8\n\n${COIN_DISCLAIMER}`);
    expect(db.get<{ description: string }>('SELECT description FROM metadata WHERE id = ?', up.metadataId)!.description).toBe('Best flat white in E8');
  });

  it('a link in the description is still refused (the disclaimer is ours, added after the checks)', async () => {
    const f = new FormData();
    f.set('name', 'Corner Cafe');
    f.set('symbol', 'CAFE');
    f.set('description', 'claim on atlaspad.online');
    f.set('placeId', 'ChIJlegal00000000001');
    f.set('image', new Blob([png(512, 512)], { type: 'image/png' }), 'art.png');
    const res = (await handlePhase2(new Request(`${ORIGIN}/api/metadata`, { method: 'POST', body: f, headers: { origin: ORIGIN, 'cf-connecting-ip': '203.0.113.7' } }), env, exec, deps))!;
    expect(((await res.json()) as { error: string }).error).toBe('moderation');
  });
});

describe('retention', () => {
  it('reports and opt-outs lose their names and emails after 180 days (the takedown record stays)', async () => {
    world.chain.set(CONFIG_PDA, { lamports: 1n, owner: SHOP_VAULT_PROGRAM_ID, data: configData({ attestor: web3.Keypair.generate().publicKey.toBase58(), guardian: web3.Keypair.generate().publicKey.toBase58(), governance: web3.Keypair.generate().publicKey.toBase58(), window: 60 }) });
    const add = db.raw.prepare("INSERT INTO reports(kind, place_id, reason, details, contact, created_at) VALUES (?, 'ChIJlegal00000000001', ?, ?, ?, ?)");
    add.run('optout', 'optout', 'Name: Old Owner', 'old@example.com', clock - 181 * DAY);
    add.run('report', 'impersonation', null, null, clock - 181 * DAY);
    add.run('optout', 'optout', 'Name: New Owner', 'new@example.com', clock - 179 * DAY);
    const r = await runIndexer((await buildCtx(env, exec, deps, 'cron'))!);
    expect(r.jobs.retention).toBe('ok');
    const rows = db.all<{ kind: string; details: string | null; contact: string | null }>('SELECT kind, details, contact FROM reports ORDER BY id');
    expect(rows).toEqual([
      { kind: 'optout', details: null, contact: null },
      { kind: 'report', details: null, contact: null },
      { kind: 'optout', details: 'Name: New Owner', contact: 'new@example.com' },
    ]);
  });
});
