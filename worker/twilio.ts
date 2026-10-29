/**
 * Twilio Verify adapter (mainnet; INTEGRATION §3.5). Voice call with a 6-digit code; the Verify service must be
 * created with `code_length = 6` (checked by /api/health). The only reader of TWILIO_ACCOUNT_SID /
 * TWILIO_AUTH_TOKEN / TWILIO_VERIFY_SID. Twilio errors are never forwarded raw, and the number is never logged.
 *
 *   start: POST https://verify.twilio.com/v2/Services/{sid}/Verifications       To, Channel=call, Locale=en
 *   check: POST https://verify.twilio.com/v2/Services/{sid}/VerificationCheck   VerificationSid (or To), Code
 *   Basic auth base64(ACCOUNT_SID:AUTH_TOKEN), 10 s timeout.
 *   Errors: 60203 (max sends) / 60202 (max checks) → too_many_attempts · 60410 (fraud block) / 60605 (geo
 *   permission) → premium ("We can't call this number") · 20404 on check → expired · anything else → upstream.
 */
import type { Deps } from './ctx';
import type { Env } from './env';
import { ApiErr } from './http';
import type { CheckResult, PhoneVerifier } from './phone';

const BASE = 'https://verify.twilio.com/v2/Services';
const TIMEOUT_MS = 10_000;

interface TwilioErrorBody {
  code?: number;
  message?: string;
  status?: number;
}

export class TwilioVerifier implements PhoneVerifier {
  readonly kind = 'call' as const;
  constructor(
    private readonly env: Env,
    private readonly deps: Deps,
  ) {}

  private auth(): string {
    const sid = this.env.TWILIO_ACCOUNT_SID?.trim() ?? '';
    const tok = this.env.TWILIO_AUTH_TOKEN?.trim() ?? '';
    return `Basic ${btoa(`${sid}:${tok}`)}`;
  }

  private service(): string {
    const s = this.env.TWILIO_VERIFY_SID?.trim() ?? '';
    if (!/^VA[0-9a-fA-F]{32}$/.test(s)) throw new ApiErr('not_configured', "Phone verification isn't available yet");
    return s;
  }

  private async post(path: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await this.deps.fetch(`${BASE}/${this.service()}/${path}`, {
        method: 'POST',
        headers: { authorization: this.auth(), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (e instanceof ApiErr) throw e;
      throw new ApiErr('upstream', "We couldn't start the call. Try again.");
    }
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: res.status, body };
  }

  async start(e164: string): Promise<{ ref: string }> {
    const { status, body } = await this.post('Verifications', { To: e164, Channel: 'call', Locale: 'en' });
    if (status >= 200 && status < 300 && typeof body.sid === 'string') return { ref: body.sid };
    throw mapError(body as TwilioErrorBody, 'start');
  }

  async check(ref: string, e164: string, code: string): Promise<CheckResult> {
    // by verification sid when we have it (no second phone lookup), else by number
    const target: Record<string, string> = /^VE[0-9a-fA-F]{32}$/.test(ref) ? { VerificationSid: ref } : { To: e164 };
    const { status, body } = await this.post('VerificationCheck', { ...target, Code: code });
    if (status >= 200 && status < 300) {
      const s = body.status;
      if (s === 'approved') return 'approved';
      if (s === 'canceled' || s === 'expired') return 'expired';
      return 'pending';
    }
    const e = body as TwilioErrorBody;
    if (e.code === 20404 || status === 404) return 'expired';
    if (e.code === 60202) return 'max_attempts';
    throw mapError(e, 'check');
  }

  /** /api/health: the Verify service exists and sends 6-digit codes. */
  async health(): Promise<'ok' | 'mismatch' | 'error'> {
    try {
      const res = await this.deps.fetch(`${BASE}/${this.service()}`, {
        headers: { authorization: this.auth(), accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return 'error';
      const j = (await res.json()) as { code_length?: number };
      return j.code_length === 6 ? 'ok' : 'mismatch';
    } catch {
      return 'error';
    }
  }
}

export function mapError(e: TwilioErrorBody, phase: 'start' | 'check'): ApiErr {
  switch (e.code) {
    case 60203:
    case 60202:
      return new ApiErr('too_many_attempts', 'Too many calls to this number. Try again later.', { retryAfterSec: 600 });
    case 60410:
    case 60605:
    case 21215:
    case 21216:
      return new ApiErr('premium', "We can't call this number.");
    default:
      return new ApiErr('upstream', phase === 'start' ? "We couldn't start the call. Try again." : "We couldn't check the code. Try again.");
  }
}
