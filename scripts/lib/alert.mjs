/**
 * Alert delivery for the OPS scripts (scripts/watchdog.mjs): one POST to ALERT_WEBHOOK_URL, a Discord incoming webhook
 * (free; Slack works too). The URL is read from the environment (GitHub Actions secret) or `.env.server`, and it is a
 * secret: it carries the webhook token, so it is never printed, logged or put in a report. Same message shape as the
 * Worker's own alerts (worker/ctx.ts `alert()`): Discord `{ content }` with mentions off, Slack `{ text }`, at most
 * 1,900 characters.
 */
import { envValue } from './env.mjs';
import { redact, sleep } from './log.mjs';

/** The webhook URL (https only; the environment wins over `.env.server`), or null. Never print it. */
export function webhookUrl(env = process.env, fileValue = envValue('ALERT_WEBHOOK_URL')) {
  const v = (env.ALERT_WEBHOOK_URL ?? '').trim() || fileValue || '';
  return /^https:\/\/[^\s]+$/.test(v) ? v : null;
}

/**
 * JSON body for the webhook: Slack wants `text`, Discord (and the Worker's format) `content`. Discord gets
 * `allowed_mentions: { parse: [] }`: alert lines quote D1 alert messages (place ids, website hosts), so an
 * `@everyone` or role mention in them must not ping the channel.
 */
export function webhookBody(url, text) {
  const msg = redact(text).slice(0, 1900);
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* not a URL: the caller already refused it */
  }
  const slack = host === 'hooks.slack.com' || host.endsWith('.slack.com');
  return slack ? { text: msg } : { content: msg, allowed_mentions: { parse: [] } };
}

/**
 * The alert text for a watchdog run: a header line plus one bullet per critical finding (redacted, trimmed).
 * @param {{ cluster: string, findings: { what: string, detail?: string }[], resolved?: boolean }} o
 */
export function alertText({ cluster, findings, resolved = false }) {
  if (resolved) return `[AtlasPad watchdog · ${cluster}] RESOLVED: no critical finding any more.`;
  const lines = findings.slice(0, 8).map((f) => `• ${f.what}${f.detail ? ` — ${f.detail}` : ''}`.slice(0, 400));
  const more = findings.length > 8 ? `\n… and ${findings.length - 8} more (run node scripts/watchdog.mjs --cluster ${cluster})` : '';
  return `[AtlasPad watchdog · ${cluster}] CRITICAL (${findings.length}): act now, see RUNBOOK "Alerts".\n${lines.join('\n')}${more}`;
}

/**
 * Whether a loop run should post: on a new set of critical findings at once, the same set again at most once per
 * `repeatMs` (a reminder while it lasts), and one RESOLVED message when it clears.
 * @param {{ digest: string|null, at: number }|null} last  what was posted last (digest null = the RESOLVED message)
 * @param {string|null} digest  the current critical findings (null = none)
 * @returns {'critical'|'resolved'|null}
 */
export function alertDecision(last, digest, now, repeatMs = 3_600_000) {
  // `last` only ever records a post that was delivered (watchdog afterSend), so an undelivered alert is retried.
  if (digest) {
    if (!last || last.digest !== digest || now - last.at >= repeatMs) return 'critical';
    return null;
  }
  return last && last.digest ? 'resolved' : null;
}

/**
 * A stable digest of the critical findings, independent of order: `key` when a finding has one, else what + detail
 * without the countdown that changes every run (`(12.3 h)` before a veto deadline).
 */
export function findingsDigest(findings) {
  if (!findings.length) return null;
  return findings
    .map((f) => f.key ?? `${f.what}|${(f.detail ?? '').replace(/\(-?\d+(?:\.\d+)? h\)/g, '')}`)
    .sort()
    .join('\n');
}

/**
 * POST `text` to the webhook. One retry on 429/5xx (Discord's `retry_after` honoured up to 10 s). Never throws.
 * @returns {Promise<{ sent: boolean, status?: number, reason?: string }>}
 */
export async function postAlert(text, { url = webhookUrl(), fetchImpl = fetch, wait = sleep } = {}) {
  if (!url) return { sent: false, reason: 'ALERT_WEBHOOK_URL not set' };
  const body = JSON.stringify(webhookBody(url, text));
  let status;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10_000) });
      status = res.status;
      if (res.ok) return { sent: true, status };
      if (status !== 429 && status < 500) return { sent: false, status, reason: `HTTP ${status}` };
      let retryMs = 2_000;
      try {
        const j = await res.json();
        if (Number.isFinite(j?.retry_after)) retryMs = Math.min(10_000, Math.ceil(Number(j.retry_after) * 1000));
      } catch {
        /* no JSON body */
      }
      if (attempt === 0) await wait(retryMs);
    } catch (e) {
      if (attempt === 1) return { sent: false, reason: redact(e?.name ?? 'network error') };
      await wait(2_000);
    }
  }
  return { sent: false, status, reason: `HTTP ${status}` };
}
