/**
 * Alert delivery to the site owner, on every channel that is set up, at once:
 *  - the webhook (worker/webhook.ts, `ALERT_WEBHOOK_URL`: a Discord or Slack incoming webhook), and
 *  - the email (worker/email.ts, the `ALERT_EMAIL` binding + `ALERT_EMAIL_TO`: Cloudflare Email Routing, free).
 * Either one is enough (go-mainnet requires one of them). Used by `alert()` (worker/ctx.ts) and the owner alerts
 * (worker/ownerAlerts.ts), which keep their own de-duplication and rate limits. Never rejects.
 */
import type { Deps } from './ctx';
import { emailConfigured, sendAlertEmail, SUBJECT_MAX_CHARS } from './email';
import type { Env } from './env';
import type { Logger } from './log';
import { postWebhook, webhookUrl } from './webhook';

export type AlertEnv = Pick<Env, 'ALERT_WEBHOOK_URL' | 'ALERT_EMAIL' | 'ALERT_EMAIL_TO' | 'ALERT_EMAIL_FROM' | 'PUBLIC_ORIGIN'>;

/** Which channels are set up. */
export function alertChannels(env: AlertEnv): { webhook: boolean; email: boolean } {
  return { webhook: webhookUrl(env) !== null, email: emailConfigured(env) };
}

/** Whether any channel is set up (nothing to deliver, or to rate-limit, otherwise). */
export function hasAlertChannel(env: AlertEnv): boolean {
  const c = alertChannels(env);
  return c.webhook || c.email;
}

/**
 * The email subject: `[AtlasPad mainnet] WARN owner_claim: Website-code claim requested: …`, one line, under 120
 * characters (cut with an ellipsis).
 */
export function alertSubject(cluster: string, severity: 'info' | 'warn' | 'critical', kind: string, summary: string): string {
  const s = `[AtlasPad ${cluster}] ${severity.toUpperCase()} ${kind}: ${summary}`
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s);
  return chars.length <= SUBJECT_MAX_CHARS ? s : `${chars.slice(0, SUBJECT_MAX_CHARS - 1).join('').trimEnd()}…`;
}

/**
 * Posts `text` to the webhook and emails it (with `subject`) in parallel. Resolves true when at least one channel
 * accepted it; never rejects.
 */
export async function deliverAlert(env: AlertEnv, deps: Pick<Deps, 'fetch' | 'now' | 'emailMessage'>, subject: string, text: string, log?: Pick<Logger, 'warn'>): Promise<boolean> {
  const [hook, mail] = await Promise.all([postWebhook(env, deps.fetch, text), sendAlertEmail(env, deps, subject, text, log)]);
  return hook || mail;
}
