/**
 * The alert webhook (`ALERT_WEBHOOK_URL`, a secret): a Discord or Slack incoming webhook that receives one plain-text
 * message per alert. Used by `alert()` (worker/ctx.ts, ops alerts) and the owner alerts (worker/ownerAlerts.ts).
 *
 * The body is chosen by the webhook's host: Slack gets `{text}`, anything else Discord's `{content}` with mentions
 * switched off (shop names are user-chosen text, so an "@everyone" in one must never ping anybody). Best effort: a
 * 5-second timeout, and it never throws. The URL is a secret: it is never logged (the logger scrubs it too).
 */
import type { Env } from './env';

/** Discord allows 2000 characters per message; leave room for nothing to be cut mid-word by the server. */
export const WEBHOOK_MAX_CHARS = 1900;

/** The configured webhook, or null (unset, or not https). */
export function webhookUrl(env: Pick<Env, 'ALERT_WEBHOOK_URL'>): string | null {
  const hook = env.ALERT_WEBHOOK_URL?.trim();
  return hook && /^https:\/\/[^\s]+$/.test(hook) ? hook : null;
}

function isSlack(hook: string): boolean {
  try {
    const h = new URL(hook).hostname.toLowerCase();
    return h === 'hooks.slack.com' || h.endsWith('.slack.com');
  } catch {
    return false;
  }
}

/** The JSON body for `hook` (Slack `{text}`, else Discord `{content}` without mentions). */
export function webhookBody(hook: string, text: string): string {
  const t = text.slice(0, WEBHOOK_MAX_CHARS);
  return JSON.stringify(isSlack(hook) ? { text: t } : { content: t, allowed_mentions: { parse: [] } });
}

/** Posts `text` to the alert webhook. Resolves true when the webhook accepted it; never rejects. */
export async function postWebhook(env: Pick<Env, 'ALERT_WEBHOOK_URL'>, fetchFn: (input: string, init?: RequestInit) => Promise<Response>, text: string): Promise<boolean> {
  const hook = webhookUrl(env);
  if (!hook) return false;
  try {
    const res = await fetchFn(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: webhookBody(hook, text),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false; // best effort
  }
}
