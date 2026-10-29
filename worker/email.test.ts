/**
 * The alert email (worker/email.ts) and the alert fan-out (worker/notify.ts), with a fake `send_email` binding and a
 * fake EmailMessage factory (Node never resolves 'cloudflare:email'):
 *  - the MIME builder: headers, RFC 2047 subjects, RFC 2822 dates, CRLF, base64 at 76 columns, header-injection safety;
 *  - sendAlertEmail: a no-op without the binding or a valid ALERT_EMAIL_TO, one message otherwise, never throws, never
 *    logs an address;
 *  - deliverAlert: webhook only, email only, both, both failing;
 *  - alert() and the owner alerts send the email with their usual de-duplication and hourly limits.
 */
import './test/globals';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeUtf8Strict, fromB64 } from './bytes';
import { alert, type Deps } from './ctx';
import {
  ALERT_EMAIL_FROM_NAME,
  alertEmailFrom,
  alertEmailTo,
  buildAlertMime,
  cleanAddress,
  DEFAULT_ALERT_EMAIL_FROM,
  emailConfigured,
  encodeHeaderValue,
  newMessageId,
  rfc2822Date,
  sendAlertEmail,
  SUBJECT_MAX_CHARS,
  type EmailMessageFactory,
} from './email';
import type { Env } from './env';
import { makeLogger } from './log';
import { alertChannels, alertSubject, deliverAlert, hasAlertChannel } from './notify';
import { notifyOwner, OWNER_ALERTS_PER_HOUR, ownerAlertFor } from './ownerAlerts';
import { FakeD1 } from './test/fakeD1';

/** A placeholder recipient: real addresses never appear in the repository. */
const TO = 'owner@example.com';
const HOOK = 'https://discord.com/api/webhooks/77/email-test-hook-token';
const NOW = Date.UTC(2026, 9, 26, 9, 5, 7);

/* ------------------------------------------------------------------------------------------------ helpers */

interface Made {
  from: string;
  to: string;
  raw: string;
}

/** A fake `send_email` binding plus the EmailMessage factory the Worker would get from 'cloudflare:email'. */
function fakeMail(mode: 'ok' | 'reject' | 'hang' = 'ok') {
  const made: Made[] = [];
  const sent: Made[] = [];
  const emailMessage: EmailMessageFactory = (from, to, raw) => {
    const m = { from, to, raw };
    made.push(m);
    return m;
  };
  const binding = {
    send: async (m: EmailMessage) => {
      if (mode === 'reject') throw new Error(`destination address ${TO} is not a verified address`);
      if (mode === 'hang') return new Promise<never>(() => {});
      sent.push(m as unknown as Made);
      return { messageId: 'cf-message-id' };
    },
  } as unknown as SendEmail;
  return { made, sent, emailMessage, binding };
}

/** A webhook fetch that records posts and answers `status`. */
function fakeHook(status = 204) {
  const posts: string[] = [];
  const fetch = async (_input: string, init?: RequestInit) => {
    posts.push((JSON.parse(String(init?.body)) as { content: string }).content);
    return new Response(null, { status });
  };
  return { posts, fetch };
}

const decodeB64Utf8 = (b64: string) => new TextDecoder().decode(fromB64(b64));

/** Splits a raw message into header lines (unfolded), the raw body lines and the decoded body text. */
function parse(raw: string) {
  const split = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, split);
  const bodyLines = raw.slice(split + 4).replace(/\r\n$/, '').split('\r\n');
  const headerLines = head.replace(/\r\n[ \t]/g, ' ').split('\r\n');
  const header = (name: string) => headerLines.find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim();
  return { head, headerLines, header, bodyLines, body: decodeB64Utf8(bodyLines.join('')) };
}

/** The text of a header made of RFC 2047 encoded words (whitespace between words is not part of it). */
function decodeWords(v: string): string {
  if (!v.startsWith('=?')) return v;
  return [...v.matchAll(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g)].map((m) => decodeB64Utf8(m[1]!)).join('');
}

const mime = (over: Partial<Parameters<typeof buildAlertMime>[0]> = {}) =>
  buildAlertMime({ from: DEFAULT_ALERT_EMAIL_FROM, to: TO, subject: 'subject', text: 'text', date: NOW, messageId: 'alert.test@atlaspad.online', ...over });

afterEach(() => {
  vi.useRealTimers();
});

/* ======================================================================================== the MIME builder */

describe('buildAlertMime', () => {
  it('builds a plain-text RFC 5322 message: headers, CRLF line endings, base64 body wrapped at 76 columns', () => {
    const text = `[AtlasPad mainnet] Website-code claim requested\nShop: Corner Cafe ($CAFE)\n${'x'.repeat(300)}\n`;
    const raw = mime({ subject: '[AtlasPad mainnet] WARN owner_claim: Website-code claim requested', text });
    expect(raw).not.toMatch(/[^\r]\n/); // every line break is CRLF
    expect(raw).not.toMatch(/\r(?!\n)/);
    expect(raw.endsWith('\r\n')).toBe(true);
    const p = parse(raw);
    expect(p.headerLines).toEqual([
      `From: ${ALERT_EMAIL_FROM_NAME} <alerts@atlaspad.online>`,
      `To: ${TO}`,
      'Subject: [AtlasPad mainnet] WARN owner_claim: Website-code claim requested',
      'Date: Mon, 26 Oct 2026 09:05:07 +0000',
      'Message-ID: <alert.test@atlaspad.online>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      'Auto-Submitted: auto-generated',
    ]);
    // base64 only, 76 characters a line (the last one shorter), and the text's line breaks become CRLF
    for (const l of p.bodyLines) expect(l).toMatch(/^[A-Za-z0-9+/=]{1,76}$/);
    expect(p.bodyLines.slice(0, -1).every((l) => l.length === 76)).toBe(true);
    expect(p.bodyLines.length).toBeGreaterThan(4);
    expect(p.body).toBe(text.replace(/\n/g, '\r\n'));
  });

  it('non-ASCII subjects and bodies: RFC 2047 encoded words of whole characters, folded; UTF-8 body', () => {
    const subject = `Café ☕ Ünïcode ${'日本語'.repeat(8)} 🎉 end`;
    const raw = mime({ subject, text: 'Shop: Café ☕ 🎉\nZürich' });
    const p = parse(raw);
    const physical = p.head.split('\r\n');
    // RFC 2047 section 2: a header line holding an encoded word is at most 76 characters (the first one included)
    for (const l of physical) expect(l.length, l).toBeLessThanOrEqual(76);
    expect(physical.some((l) => l.startsWith('Subject: =?UTF-8?B?'))).toBe(true);
    const words = p.header('Subject')!.split(' ');
    expect(words.length).toBeGreaterThan(2); // folded over several lines
    for (const w of words) {
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(w.length).toBeLessThanOrEqual(75);
      expect(() => decodeUtf8Strict(fromB64(w.slice(10, -2)))).not.toThrow(); // whole characters
    }
    expect(decodeWords(p.header('Subject')!)).toBe(subject);
    expect(p.body).toBe('Shop: Café ☕ 🎉\r\nZürich');
    expect(encodeHeaderValue('plain ascii')).toBe('plain ascii');
  });

  it('header injection: CR/LF never reach a header, and addresses must be one plain address', () => {
    const p = parse(mime({ subject: 'hello\r\nBcc: victim@example.org\r\n\r\nfake body', fromName: 'Evil\r\nCc: x@example.org' }));
    expect(p.headerLines).toHaveLength(9);
    expect(p.headerLines.some((l) => /^(Bcc|Cc):/i.test(l))).toBe(false);
    expect(p.header('Subject')).toBe('hello Bcc: victim@example.org fake body');
    expect(p.header('From')).toBe('"Evil Cc: x@example.org" <alerts@atlaspad.online>');
    // a recipient or sender with a line break, a second address or a display name is refused outright
    for (const bad of [`${TO}\r\nBcc: evil@example.org`, `${TO}, evil@example.org`, `Owner <${TO}>`, 'owner@example', 'a b@example.com', '.owner@example.com', 'ow..ner@example.com', '']) {
      expect(cleanAddress(bad), JSON.stringify(bad)).toBeNull();
      expect(() => mime({ to: bad }), JSON.stringify(bad)).toThrow(/plain email address/);
      expect(() => mime({ from: bad }), JSON.stringify(bad)).toThrow(/plain email address/);
    }
    expect(cleanAddress(` ${TO}\r\n`)).toBe(TO);
    expect(cleanAddress('first.last+alerts@mail.example.co.uk')).toBe('first.last+alerts@mail.example.co.uk');
    // the Message-ID keeps only id characters, and always has a domain
    expect(parse(mime({ messageId: '<x>\r\nBcc: y@example.org' })).header('Message-ID')).toBe('<xBccy@example.org>');
    expect(parse(mime({ messageId: 'bare-id' })).header('Message-ID')).toBe('<bare-id@atlaspad.online>');
  });

  it(`subjects are one line of at most ${SUBJECT_MAX_CHARS} characters; dates and message ids`, () => {
    const p = parse(mime({ subject: `${'a'.repeat(200)}\n` }));
    expect(p.header('Subject')).toBe('a'.repeat(SUBJECT_MAX_CHARS));
    expect(parse(mime({ subject: ' \r\n ' })).header('Subject')).toBe('AtlasPad alert');
    expect(rfc2822Date(NOW)).toBe('Mon, 26 Oct 2026 09:05:07 +0000');
    expect(rfc2822Date(Date.UTC(2027, 0, 3, 23, 59, 0))).toBe('Sun, 03 Jan 2027 23:59:00 +0000');
    expect(newMessageId(NOW)).toMatch(/^alert\.[0-9a-z]+\.[0-9a-f]{16}@atlaspad\.online$/);
    expect(newMessageId(NOW)).not.toBe(newMessageId(NOW));
  });
});

/* ======================================================================================== sendAlertEmail */

describe('sendAlertEmail', () => {
  const deps = (m: ReturnType<typeof fakeMail>) => ({ now: () => NOW, emailMessage: m.emailMessage });

  it('is a no-op without the ALERT_EMAIL binding or a valid ALERT_EMAIL_TO (nothing is built or sent)', async () => {
    const m = fakeMail();
    const cases: Partial<Env>[] = [
      {},
      { ALERT_EMAIL: m.binding },
      { ALERT_EMAIL_TO: TO },
      { ALERT_EMAIL: m.binding, ALERT_EMAIL_TO: '' },
      { ALERT_EMAIL: m.binding, ALERT_EMAIL_TO: 'not an address' },
      { ALERT_EMAIL: m.binding, ALERT_EMAIL_TO: `${TO}, second@example.com` },
      { ALERT_EMAIL: m.binding, ALERT_EMAIL_TO: `${TO}\r\nBcc: evil@example.org` },
    ];
    for (const env of cases) {
      expect(await sendAlertEmail(env, deps(m), 's', 't'), JSON.stringify(Object.keys(env))).toBe(false);
      expect(emailConfigured(env)).toBe(false);
    }
    expect(m.made).toHaveLength(0);
    expect(m.sent).toHaveLength(0);
  });

  it('sends one message from "AtlasPad alerts <alerts@atlaspad.online>" to ALERT_EMAIL_TO', async () => {
    const m = fakeMail();
    const env: Partial<Env> = { ALERT_EMAIL: m.binding, ALERT_EMAIL_TO: ` ${TO} ` };
    expect(emailConfigured(env)).toBe(true);
    expect(alertEmailTo(env)).toBe(TO);
    expect(await sendAlertEmail(env, deps(m), '[AtlasPad mainnet] CRITICAL creator_changed: curve.creator != vault', 'line one\nline two')).toBe(true);
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]).toBe(m.made[0]); // the binding gets exactly the EmailMessage built from (from, to, raw)
    expect(m.made[0]).toMatchObject({ from: 'alerts@atlaspad.online', to: TO });
    const p = parse(m.made[0]!.raw);
    expect(p.header('From')).toBe('AtlasPad alerts <alerts@atlaspad.online>');
    expect(p.header('To')).toBe(TO);
    expect(p.header('Subject')).toBe('[AtlasPad mainnet] CRITICAL creator_changed: curve.creator != vault');
    expect(p.header('Date')).toBe('Mon, 26 Oct 2026 09:05:07 +0000');
    expect(p.header('Message-ID')).toMatch(/^<alert\.[0-9a-z]+\.[0-9a-f]{16}@atlaspad\.online>$/);
    expect(p.body).toBe('line one\r\nline two');
  });

  it('ALERT_EMAIL_FROM: an address on atlaspad.online or the PUBLIC_ORIGIN host, else alerts@atlaspad.online', async () => {
    expect(alertEmailFrom({})).toBe(DEFAULT_ALERT_EMAIL_FROM);
    expect(alertEmailFrom({ ALERT_EMAIL_FROM: 'ops@atlaspad.online' })).toBe('ops@atlaspad.online');
    expect(alertEmailFrom({ ALERT_EMAIL_FROM: 'alerts@cornershop-devnet.tiejiucai.workers.dev', PUBLIC_ORIGIN: 'https://cornershop-devnet.tiejiucai.workers.dev' })).toBe(
      'alerts@cornershop-devnet.tiejiucai.workers.dev',
    );
    expect(alertEmailFrom({ ALERT_EMAIL_FROM: 'alerts@other.example' })).toBe(DEFAULT_ALERT_EMAIL_FROM);
    expect(alertEmailFrom({ ALERT_EMAIL_FROM: 'alerts@atlaspad.online.evil.example' })).toBe(DEFAULT_ALERT_EMAIL_FROM);
    expect(alertEmailFrom({ ALERT_EMAIL_FROM: 'x\r\nBcc: y@atlaspad.online' })).toBe(DEFAULT_ALERT_EMAIL_FROM);
    const m = fakeMail();
    await sendAlertEmail({ ALERT_EMAIL: m.binding, ALERT_EMAIL_TO: TO, ALERT_EMAIL_FROM: 'ops@atlaspad.online' }, deps(m), 's', 't');
    expect(m.made[0]!.from).toBe('ops@atlaspad.online');
    expect(parse(m.made[0]!.raw).header('From')).toBe('AtlasPad alerts <ops@atlaspad.online>');
  });

  it('never throws: a refused send, a failing factory or a send that never answers resolve false, and no address is logged', async () => {
    const logs: string[] = [];
    const log = { warn: (event: string, fields?: unknown) => void logs.push(JSON.stringify({ event, fields })) };
    const refused = fakeMail('reject');
    expect(await sendAlertEmail({ ALERT_EMAIL: refused.binding, ALERT_EMAIL_TO: TO }, deps(refused), 's', 't', log)).toBe(false);
    expect(logs.at(-1)).toContain('alert_email.failed');
    expect(logs.at(-1)).toContain('[address]');
    const broken = fakeMail();
    const throwing: EmailMessageFactory = () => {
      throw new Error(`cannot build a message for ${TO}`);
    };
    expect(await sendAlertEmail({ ALERT_EMAIL: broken.binding, ALERT_EMAIL_TO: TO }, { now: () => NOW, emailMessage: throwing }, 's', 't', log)).toBe(false);
    expect(broken.sent).toHaveLength(0);

    vi.useFakeTimers();
    const hanging = fakeMail('hang');
    const pending = sendAlertEmail({ ALERT_EMAIL: hanging.binding, ALERT_EMAIL_TO: TO }, deps(hanging), 's', 't', log);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBe(false);
    expect(logs.at(-1)).toContain('no answer in 10 s');
    expect(logs.join('\n')).not.toContain(TO);

    // the default logger scrubs the recipient too (ALERT_EMAIL_TO is a secret)
    vi.useRealTimers();
    const lines: string[] = [];
    const orig = console.warn;
    console.warn = (s: string) => void lines.push(s);
    try {
      expect(await sendAlertEmail({ ALERT_EMAIL: refused.binding, ALERT_EMAIL_TO: TO }, deps(refused), 's', 't')).toBe(false);
      makeLogger({ ASSETS: {} as Fetcher, ALERT_EMAIL_TO: TO }).warn('x', { to: TO });
    } finally {
      console.warn = orig;
    }
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain(TO);
  });
});

/* ======================================================================================== the fan-out */

describe('deliverAlert', () => {
  const run = async (env: Partial<Env>, m: ReturnType<typeof fakeMail>, h: ReturnType<typeof fakeHook>) =>
    deliverAlert(env, { fetch: h.fetch, now: () => NOW, emailMessage: m.emailMessage }, '[AtlasPad devnet] WARN x: y', '[AtlasPad devnet] WARN x: y\nmore', { warn: () => {} });

  it('email only: one email, no webhook post', async () => {
    const m = fakeMail();
    const h = fakeHook();
    const env = { ALERT_EMAIL: m.binding, ALERT_EMAIL_TO: TO };
    expect(alertChannels(env)).toEqual({ webhook: false, email: true });
    expect(await run(env, m, h)).toBe(true);
    expect(m.sent).toHaveLength(1);
    expect(h.posts).toHaveLength(0);
    expect(parse(m.sent[0]!.raw).body).toBe('[AtlasPad devnet] WARN x: y\r\nmore');
  });

  it('webhook only: one post, no email (the binding without ALERT_EMAIL_TO stays quiet)', async () => {
    const m = fakeMail();
    const h = fakeHook();
    const env = { ALERT_WEBHOOK_URL: HOOK, ALERT_EMAIL: m.binding };
    expect(alertChannels(env)).toEqual({ webhook: true, email: false });
    expect(await run(env, m, h)).toBe(true);
    expect(h.posts).toEqual(['[AtlasPad devnet] WARN x: y\nmore']);
    expect(m.made).toHaveLength(0);
  });

  it('both: the same alert on both channels; one failing channel is enough', async () => {
    const m = fakeMail();
    const h = fakeHook();
    const env = { ALERT_WEBHOOK_URL: HOOK, ALERT_EMAIL: m.binding, ALERT_EMAIL_TO: TO };
    expect(await run(env, m, h)).toBe(true);
    expect(h.posts).toHaveLength(1);
    expect(m.sent).toHaveLength(1);
    expect(await run({ ...env, ALERT_EMAIL: fakeMail('reject').binding }, m, h)).toBe(true); // webhook delivered
    const down = fakeHook(500);
    expect(await run(env, m, down)).toBe(true); // email delivered
    expect(m.sent).toHaveLength(2);
  });

  it('both failing, or nothing set up: false, and nothing throws', async () => {
    const m = fakeMail('reject');
    const h = fakeHook(500);
    expect(await run({ ALERT_WEBHOOK_URL: HOOK, ALERT_EMAIL: m.binding, ALERT_EMAIL_TO: TO }, m, h)).toBe(false);
    expect(h.posts).toHaveLength(1);
    expect(m.made).toHaveLength(1);
    expect(hasAlertChannel({})).toBe(false);
    expect(await run({}, fakeMail(), h)).toBe(false);
  });

  it(`subjects: "[AtlasPad <cluster>] <SEVERITY> <kind>: <summary>", one line, under 120 characters`, () => {
    expect(alertSubject('mainnet', 'warn', 'owner_claim', 'Website-code claim requested: needs a human check before unlock')).toBe(
      '[AtlasPad mainnet] WARN owner_claim: Website-code claim requested: needs a human check before unlock',
    );
    const long = alertSubject('mainnet', 'critical', 'creator_changed', `pump TradeEvent creator ${'7'.repeat(44)} is not the vault for ${'9'.repeat(44)}\n(admin_cto?)`);
    expect(Array.from(long).length).toBeLessThan(120);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toMatch(/[\r\n]/);
  });
});

/* ======================================================================================== alert() and owner alerts */

describe('alert() and the owner alerts send the email', () => {
  function setup(cluster: 'devnet' | 'mainnet') {
    const m = fakeMail();
    const h = fakeHook();
    let clock = NOW;
    const env = { ASSETS: {} as Fetcher, ALERT_EMAIL: m.binding, ALERT_EMAIL_TO: TO } as Env;
    const deps: Deps = { fetch: h.fetch, now: () => clock, emailMessage: m.emailMessage };
    const ctx = { db: new FakeD1().asD1(), env, deps, log: makeLogger(env), cluster, origin: cluster === 'mainnet' ? 'https://atlaspad.online' : 'https://cornershop-devnet.tiejiucai.workers.dev' };
    return { m, h, ctx, tick: (ms: number) => void (clock += ms) };
  }

  it('alert(): warn and critical alerts are emailed (once per kind + ref and hour), info alerts are not', async () => {
    const { m, h, ctx } = setup('mainnet');
    await alert(ctx, 'warn', 'claim_website_verified', 'Website-code claim c1 verified', 'c1');
    await alert(ctx, 'warn', 'claim_website_verified', 'Website-code claim c1 verified', 'c1');
    await alert(ctx, 'info', 'faucet_low', 'faucet low');
    expect(h.posts).toHaveLength(0);
    expect(m.sent).toHaveLength(1);
    const p = parse(m.sent[0]!.raw);
    expect(p.header('Subject')).toBe('[AtlasPad mainnet] WARN claim_website_verified: Website-code claim c1 verified');
    expect(p.body).toBe('[AtlasPad mainnet] WARN claim_website_verified: Website-code claim c1 verified');
  });

  it('an owner claim alert is emailed with the webhook text as the body; de-duplicated; held back past the hourly limit', async () => {
    const { m, ctx, tick } = setup('devnet');
    const unlockTs = Math.floor(NOW / 1000) + 259_200;
    const ev = { kind: 'claim', placeId: 'ChIJemailcafe0000001', method: 'website', newOwner: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', previousOwner: null, nonce: 1, unlockTs, websiteHost: 'www.emailcafe.co.uk' } as const;
    await notifyOwner(ctx, ev);
    await notifyOwner(ctx, ev); // the confirm route and the program monitor race on the same claim: one email
    expect(m.sent).toHaveLength(1);
    const expected = ownerAlertFor(ev, null, { cluster: 'devnet', origin: ctx.origin, now: NOW });
    const p = parse(m.sent[0]!.raw);
    expect(p.header('Subject')).toBe('[AtlasPad devnet] WARN owner_claim: Website-code claim requested: needs a human check before unlock');
    expect(p.header('Subject')).toBe(expected.subject);
    expect(p.body).toBe(expected.text.replace(/\n/g, '\r\n'));
    expect(p.body).toContain('Claimant: 7xKX…gAsU');
    expect(p.body).toContain('claims-admin.mjs --env devnet cancel ChIJemailcafe0000001');
    expect(p.body).not.toMatch(/@|\+44/); // never a phone number or an email address

    // the reports lane: at most OWNER_ALERTS_PER_HOUR emails an hour, then one "held back" email
    tick(60_000);
    for (let i = 0; i < OWNER_ALERTS_PER_HOUR + 3; i++) await notifyOwner(ctx, { kind: 'report', placeId: null, mint: `Mint${i}`, reason: 'scam' });
    expect(m.sent).toHaveLength(1 + OWNER_ALERTS_PER_HOUR + 1);
    const held = parse(m.sent.at(-1)!.raw);
    expect(held.header('Subject')).toBe(`[AtlasPad devnet] WARN owner_alerts: more than ${OWNER_ALERTS_PER_HOUR} report alerts this hour, the rest are held back`);
    expect(held.body).toContain('List them: node scripts/watchdog.mjs --cluster devnet');
  });
});
