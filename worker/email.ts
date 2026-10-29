/**
 * The alert email: a free channel next to (or instead of) the webhook (worker/webhook.ts). Cloudflare Email Routing's
 * `send_email` binding `ALERT_EMAIL` (wrangler.jsonc env.devnet / env.mainnet) sends one plain-text message per alert
 * from `ALERT_EMAIL_FROM` (a public var, default alerts@atlaspad.online: the zone with Email Routing on) to
 * `ALERT_EMAIL_TO` (a SECRET: the owner's address, a verified destination address in Email Routing).
 *
 * The binding is unrestricted on purpose: Cloudflare only delivers to the account's verified destination addresses,
 * so the recipient lives in the secret and never in wrangler.jsonc, the code or the docs.
 *
 * Best effort like the webhook: a 10-second timeout, never throws, and nothing it logs names an address (the logger
 * scrubs ALERT_EMAIL_TO as a secret as well). `cloudflare:email` exists only in the Workers runtime, so it is imported
 * lazily behind `deps.emailMessage`: unit tests (Node) pass a fake and never resolve it.
 */
import { toB64, utf8 } from './bytes';
import type { Env } from './env';
import { errMsg, makeLogger, type Logger } from './log';

/** The zone with Email Routing on; the default sender is on it. */
export const ALERT_EMAIL_DOMAIN = 'atlaspad.online';
export const DEFAULT_ALERT_EMAIL_FROM = `alerts@${ALERT_EMAIL_DOMAIN}`;
export const ALERT_EMAIL_FROM_NAME = 'AtlasPad alerts';
/** Subjects stay under 120 characters (worker/notify.ts alertSubject); the builder cuts anything longer here too. */
export const SUBJECT_MAX_CHARS = 119;
/** Alerts are a few lines: a runaway message never becomes a huge email. */
export const EMAIL_MAX_CHARS = 20_000;
const SEND_TIMEOUT_MS = 10_000;

/** `new EmailMessage(from, to, raw)` from 'cloudflare:email' (the default), or a fake in tests. */
export type EmailMessageFactory = (from: string, to: string, raw: string) => EmailMessage | Promise<EmailMessage>;

export interface EmailDeps {
  now: () => number;
  emailMessage?: EmailMessageFactory;
}

/** A plain addr-spec only: no display name, quotes, spaces, commas or angle brackets (nothing a header could abuse). */
const ADDRESS_RE = /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** One plain address (`name@example.com`), CR/LF and surrounding space removed, or null when it is not one. */
export function cleanAddress(s: string | null | undefined): string | null {
  const a = String(s ?? '')
    .replace(/[\r\n]/g, '')
    .trim();
  if (a.length > 254 || !ADDRESS_RE.test(a)) return null;
  const local = a.slice(0, a.indexOf('@'));
  return local.startsWith('.') || local.endsWith('.') || local.includes('..') ? null : a;
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/** The recipient (the ALERT_EMAIL_TO secret), or null when it is unset or not one plain address. */
export function alertEmailTo(env: Pick<Env, 'ALERT_EMAIL_TO'>): string | null {
  return cleanAddress(env.ALERT_EMAIL_TO);
}

/**
 * The sender: ALERT_EMAIL_FROM when it is an address on atlaspad.online or on the PUBLIC_ORIGIN host, else the default
 * alerts@atlaspad.online (Email Routing only sends from a zone that has it on, so any other domain would fail).
 */
export function alertEmailFrom(env: Pick<Env, 'ALERT_EMAIL_FROM' | 'PUBLIC_ORIGIN'>): string {
  const a = cleanAddress(env.ALERT_EMAIL_FROM);
  if (!a) return DEFAULT_ALERT_EMAIL_FROM;
  const allowed = [ALERT_EMAIL_DOMAIN];
  try {
    const host = new URL(env.PUBLIC_ORIGIN?.trim() ?? '').hostname.toLowerCase();
    if (host) allowed.push(host);
  } catch {
    /* no PUBLIC_ORIGIN: atlaspad.online only */
  }
  return allowed.includes(domainOf(a)) ? a : DEFAULT_ALERT_EMAIL_FROM;
}

/** Whether the email channel is on: the binding and a valid ALERT_EMAIL_TO. */
export function emailConfigured(env: Pick<Env, 'ALERT_EMAIL' | 'ALERT_EMAIL_TO'>): boolean {
  return !!env.ALERT_EMAIL && alertEmailTo(env) !== null;
}

/* ------------------------------------------------------------------------------------------------ the message */

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
/** RFC 5322 atext plus space: a display name that needs no quoting. */
const PLAIN_PHRASE = /^[A-Za-z0-9 !#$%&'*+/=?^_`{|}~-]+$/;
/**
 * Bytes per RFC 2047 word: 39 bytes = 52 base64 characters, 64 with `=?UTF-8?B?…?=` (limit 75). RFC 2047 also limits
 * every header line holding an encoded word to 76 characters: "Subject: " + 64 = 73.
 */
const WORD_BYTES = 39;

/** One header value: no line breaks or other control characters, whitespace collapsed. */
function headerText(s: string): string {
  return s
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first `n` characters (code points, never half a surrogate pair). */
function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join('');
}

/**
 * A header value as is when it is printable ASCII, else RFC 2047 `=?UTF-8?B?…?=` words (whole characters each, at
 * most 64 characters long) folded with CRLF + space.
 */
export function encodeHeaderValue(s: string): string {
  if (PRINTABLE_ASCII.test(s)) return s;
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const ch of s) {
    const n = utf8.encode(ch).length;
    if (chunk && bytes + n > WORD_BYTES) {
      words.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += ch;
    bytes += n;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${toB64(utf8.encode(w))}?=`).join('\r\n ');
}

function displayName(name: string): string {
  const n = headerText(name).replace(/["\\]/g, '');
  if (!n) return '';
  if (PLAIN_PHRASE.test(n)) return n;
  return PRINTABLE_ASCII.test(n) ? `"${n}"` : encodeHeaderValue(n);
}

/** RFC 5322 date-time in UTC: `Mon, 26 Oct 2026 09:00:00 +0000`. */
export function rfc2822Date(ms: number): string {
  return new Date(ms).toUTCString().replace(/GMT$/, '+0000');
}

/** A fresh Message-ID (without the angle brackets) on `domain`. */
export function newMessageId(now: number, domain = ALERT_EMAIL_DOMAIN): string {
  const r = crypto.getRandomValues(new Uint8Array(8));
  const hex = Array.from(r, (b) => b.toString(16).padStart(2, '0')).join('');
  return `alert.${now.toString(36)}.${hex}@${domain}`;
}

export interface AlertMime {
  /** Sender address (the display name is `fromName`, default "AtlasPad alerts"). */
  from: string;
  fromName?: string;
  to: string;
  subject: string;
  text: string;
  /** Unix ms (or a Date). */
  date: number | Date;
  /** `local@domain`, without angle brackets; a bare id gets `@atlaspad.online`. */
  messageId: string;
}

/**
 * The raw RFC 5322 message: plain text, UTF-8, base64 body wrapped at 76 characters, CRLF line endings. Header
 * injection safe: CR/LF never reach a header (subject and names are cleaned, addresses must be one plain address).
 * Throws on an invalid address (sendAlertEmail never lets that escape).
 */
export function buildAlertMime(m: AlertMime): string {
  const from = cleanAddress(m.from);
  const to = cleanAddress(m.to);
  if (!from || !to) throw new Error('alert email: not a plain email address');
  const name = displayName(m.fromName ?? ALERT_EMAIL_FROM_NAME);
  const subject = cut(headerText(m.subject), SUBJECT_MAX_CHARS) || 'AtlasPad alert';
  const at = m.messageId.lastIndexOf('@');
  const idLeft = (at >= 0 ? m.messageId.slice(0, at) : m.messageId).replace(/[^A-Za-z0-9._%+-]/g, '') || 'alert';
  const idRight = (at >= 0 ? m.messageId.slice(at + 1) : '').replace(/[^A-Za-z0-9.-]/g, '') || ALERT_EMAIL_DOMAIN;
  const headers = [
    `From: ${name ? `${name} <${from}>` : from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${rfc2822Date(m.date instanceof Date ? m.date.getTime() : m.date)}`,
    `Message-ID: <${idLeft}@${idRight}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    // RFC 3834: an automated message (no vacation auto-replies to alerts@)
    'Auto-Submitted: auto-generated',
  ];
  const body = toB64(utf8.encode(cut(m.text, EMAIL_MAX_CHARS).replace(/\r\n|\r|\n/g, '\r\n')));
  const lines = body.match(/.{1,76}/g) ?? [];
  return `${headers.join('\r\n')}\r\n\r\n${lines.join('\r\n')}\r\n`;
}

/* ------------------------------------------------------------------------------------------------ sending */

async function runtimeEmailMessage(from: string, to: string, raw: string): Promise<EmailMessage> {
  const { EmailMessage } = await import('cloudflare:email');
  return new EmailMessage(from, to, raw);
}

/** An error message without any email address in it (logs never name the recipient). */
function noAddresses(e: unknown): string {
  return errMsg(e).replace(/[^\s@<>"',;:()]+@[^\s@<>"',;:()]+/g, '[address]');
}

/**
 * Emails `subject` + `text` to ALERT_EMAIL_TO through the ALERT_EMAIL binding. Resolves true when Cloudflare accepted
 * it; false (a no-op) without the binding or a valid ALERT_EMAIL_TO, and false on any failure. Never rejects.
 */
export async function sendAlertEmail(
  env: Pick<Env, 'ALERT_EMAIL' | 'ALERT_EMAIL_TO' | 'ALERT_EMAIL_FROM' | 'PUBLIC_ORIGIN'>,
  deps: EmailDeps,
  subject: string,
  text: string,
  log?: Pick<Logger, 'warn'>,
): Promise<boolean> {
  const binding = env.ALERT_EMAIL;
  const to = alertEmailTo(env);
  if (!binding || !to) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const from = alertEmailFrom(env);
    const now = deps.now();
    const raw = buildAlertMime({ from, to, subject, text, date: now, messageId: newMessageId(now, domainOf(from)) });
    const message = await (deps.emailMessage ?? runtimeEmailMessage)(from, to, raw);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${SEND_TIMEOUT_MS / 1000} s`)), SEND_TIMEOUT_MS);
    });
    await Promise.race([binding.send(message), timeout]);
    return true;
  } catch (e) {
    (log ?? makeLogger(env as Env)).warn('alert_email.failed', { error: noAddresses(e) });
    return false; // best effort
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
