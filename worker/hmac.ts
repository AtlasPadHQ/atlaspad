/**
 * Domain-separated HMAC-SHA256 with the HMAC_KEY secret (INTEGRATION §1.6): phone hashes ('phone:'), IP hashes
 * ('ip:'), claim tokens ('tok:') and devnet screen codes ('code:'). The only reader of HMAC_KEY.
 */
import { fromB64, toHex } from './bytes';
import type { Env } from './env';
import { ApiErr } from './http';
import { ipKey } from './ipKey';

const keyCache = new Map<string, CryptoKey>();

async function hmacKey(env: Env): Promise<CryptoKey> {
  const raw = env.HMAC_KEY?.trim();
  if (!raw) throw new ApiErr('not_configured', 'Server key missing');
  const hit = keyCache.get(raw);
  if (hit) return hit;
  let bytes: Uint8Array;
  try {
    bytes = fromB64(raw);
  } catch {
    throw new ApiErr('not_configured', 'Server key invalid');
  }
  if (bytes.length < 16) throw new ApiErr('not_configured', 'Server key invalid');
  const k = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  keyCache.clear();
  keyCache.set(raw, k);
  return k;
}

export type HmacDomain = 'phone' | 'ip' | 'tok' | 'code';

/** hex(HMAC(HMAC_KEY, `${domain}:${value}`)), optionally truncated to `bytes`. */
export async function hmacHex(env: Env, domain: HmacDomain, value: string, bytes = 32): Promise<string> {
  const k = await hmacKey(env);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${domain}:${value}`)));
  return toHex(sig.subarray(0, bytes));
}

/**
 * IP → 16-byte hex HMAC; 'anon' when the key is missing (demo Worker / tests). Never stores the raw IP. IPv6 is hashed
 * on its /64 (worker/ipKey.ts), so every per-IP limit treats one IPv6 subscriber as one client.
 */
export async function ipHash(env: Env, ip: string): Promise<string> {
  if (!env.HMAC_KEY?.trim()) return 'anon';
  return hmacHex(env, 'ip', ipKey(ip), 16);
}
