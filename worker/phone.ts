/**
 * Phone verification adapters (INTEGRATION §3.5 step 7).
 *  - mainnet: Twilio Verify voice call (worker/twilio.ts), when all three TWILIO_* secrets exist; without them phone
 *             verification is simply off (/api/config phoneVerification 'none', /api/claim/call 503 not_configured);
 *  - devnet:  the on-screen code (worker/dev/screenVerifier.ts), compiled only with __CS_DEV_ENDPOINTS__ and only
 *             used when CLUSTER === 'devnet' (H6). It never calls anyone.
 * The phone number reaches a verifier only in memory; it is never logged or stored (only HMAC('phone:'+E.164)).
 */
import type { Deps } from './ctx';
import { hasSecret, type Env } from './env';
import { ApiErr } from './http';
import { TwilioVerifier } from './twilio';
import type { Cluster } from './wire';

export type CheckResult = 'approved' | 'pending' | 'expired' | 'max_attempts';

export interface PhoneVerifier {
  kind: 'call' | 'screen';
  /** Starts a verification. `codeHash` (screen only) is what the claim row stores; never the code itself. */
  start(e164: string, claim: { claimId: string }): Promise<{ ref: string; devCode?: string; codeHash?: string }>;
  check(ref: string, e164: string, code: string, claim: { claimId: string; codeHash: string | null }): Promise<CheckResult>;
}

export function twilioConfigured(env: Env): boolean {
  return hasSecret(env.TWILIO_ACCOUNT_SID) && hasSecret(env.TWILIO_AUTH_TOKEN) && hasSecret(env.TWILIO_VERIFY_SID);
}

/** Some, but not all, of the three TWILIO_* secrets are set: a setup mistake (phone verification stays off). */
export function twilioPartlyConfigured(env: Env): boolean {
  return !twilioConfigured(env) && [env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_VERIFY_SID].some(hasSecret);
}

/**
 * 'screen' on devnet builds, 'call' with Twilio (all three TWILIO_* secrets), otherwise 'none': phone verification is
 * off (mainnet starts without Twilio) and the claim modal points owners to the website code instead.
 */
export function phoneMode(env: Env, cluster: Cluster): 'call' | 'screen' | 'none' {
  if (cluster === 'devnet') {
    if (__CS_DEV_ENDPOINTS__) return 'screen';
    return twilioConfigured(env) ? 'call' : 'none';
  }
  return twilioConfigured(env) ? 'call' : 'none';
}

export async function getVerifier(env: Env, deps: Deps, cluster: Cluster): Promise<PhoneVerifier> {
  if (cluster === 'devnet') {
    if (__CS_DEV_ENDPOINTS__) {
      const m = await import('./dev/screenVerifier');
      return m.screenVerifier(env);
    }
  }
  if (twilioConfigured(env)) return new TwilioVerifier(env, deps);
  throw new ApiErr('not_configured', "Phone verification isn't available yet");
}
