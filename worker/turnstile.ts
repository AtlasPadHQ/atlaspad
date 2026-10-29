/**
 * Cloudflare Turnstile (INTEGRATION §1.9): when TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY are set, /api/claim/call
 * requires a valid `turnstileToken`. The only reader of TURNSTILE_SECRET_KEY. The client IP is not sent.
 */
import type { Deps } from './ctx';
import { hasSecret, type Env } from './env';
import { ApiErr } from './http';

export function turnstileEnabled(env: Env): boolean {
  return hasSecret(env.TURNSTILE_SITE_KEY) && hasSecret(env.TURNSTILE_SECRET_KEY);
}

export async function verifyTurnstile(env: Env, deps: Deps, token: string | undefined): Promise<void> {
  if (!turnstileEnabled(env)) return;
  if (!token || token.length > 2048) throw new ApiErr('bad_request', 'Complete the check first');
  let ok = false;
  try {
    const res = await deps.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY!.trim(), response: token }).toString(),
      signal: AbortSignal.timeout(5_000),
    });
    const j = (await res.json()) as { success?: boolean };
    ok = j.success === true;
  } catch {
    throw new ApiErr('upstream', "We couldn't verify the check. Try again.");
  }
  if (!ok) throw new ApiErr('bad_request', 'The check failed. Try again.');
}
