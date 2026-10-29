/**
 * The attestor key (SPEC D2/D9, §8.4; INTEGRATION H7). The ONLY reader of `ATTESTOR_SECRET`.
 *
 * It signs exclusively `Approved` tokens produced by worker/policy.ts (approveLaunch / approveClaim) after every
 * SPEC §8.4 check passed on the message the Worker decoded itself. There is no other signing entry point and no
 * generic "sign these bytes" function; each approval signs exactly once.
 */
import type { Env } from './env';
import { ApiErr } from './http';
import { KeyError, loadSigningKey } from './keys';
import { consumeApproved, type Approved } from './policy';

/** The attestor public key derived from the secret (base58), or null when the secret is missing/invalid. */
export async function attestorPubkey(env: Env): Promise<string | null> {
  try {
    return (await loadSigningKey(env.ATTESTOR_SECRET, 'ATTESTOR_SECRET')).publicKey;
  } catch {
    return null;
  }
}

/** Signs an approved message. Throws (never signs) for anything that is not a fresh approval token. */
export async function signApproved(env: Env, approved: Approved): Promise<{ signature: Uint8Array; attestor: string }> {
  let key;
  try {
    key = await loadSigningKey(env.ATTESTOR_SECRET, 'ATTESTOR_SECRET');
  } catch (e) {
    throw new ApiErr('unavailable', e instanceof KeyError ? 'Signing is not available right now' : 'Signing failed');
  }
  const bytes = consumeApproved(approved);
  const signature = await key.sign(bytes);
  return { signature, attestor: key.publicKey };
}
