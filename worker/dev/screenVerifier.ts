/**
 * DEVNET ONLY — the on-screen phone "verifier" (INTEGRATION §3.5, H6). Compiled only into builds where
 * __CS_DEV_ENDPOINTS__ is true (worker/phone.ts imports it behind that inline guard) and used only when
 * CLUSTER === 'devnet'. It never calls anyone: it generates a 6-digit code with crypto.getRandomValues, returns it as
 * `devCode` for the UI ("Devnet: your code is 123 456") and keeps only HMAC('code:'+claimId+code).
 */
import { timingSafeEq, fromHex } from '../bytes';
import type { Env } from '../env';
import { hmacHex } from '../hmac';
import type { CheckResult, PhoneVerifier } from '../phone';

export function sixDigits(): string {
  // rejection sampling: uniform over 000000..999999
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0]!;
    if (v < 4_294_000_000) return String(v % 1_000_000).padStart(6, '0');
  }
}

export function screenVerifier(env: Env): PhoneVerifier {
  return {
    kind: 'screen',
    async start(_e164, claim) {
      const code = sixDigits();
      const codeHash = await hmacHex(env, 'code', `${claim.claimId}${code}`);
      return { ref: 'screen', devCode: code, codeHash };
    },
    async check(_ref, _e164, code, claim): Promise<CheckResult> {
      if (!claim.codeHash) return 'expired';
      const h = await hmacHex(env, 'code', `${claim.claimId}${code}`);
      return timingSafeEq(fromHex(h), fromHex(claim.codeHash)) ? 'approved' : 'pending';
    },
  };
}
