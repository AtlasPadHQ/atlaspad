/**
 * Ed25519 signing keys from Worker secrets (INTEGRATION §1.6): base64 of the 64-byte Solana secret key
 * (seed ‖ pubkey), imported into WebCrypto as an OKP JWK. The pair is verified once (sign + verify with the stated
 * public key) so a corrupted secret fails closed instead of producing signatures for the wrong key.
 *
 * Callers: worker/attestor.ts (ATTESTOR_SECRET), worker/crank.ts (CRANK_SECRET), worker/dev/airdrop.ts
 * (DEV_FAUCET_SECRET). Never log the secret or the CryptoKey.
 */
import { b58encode, fromB64, toB64Url } from './bytes';

export interface SigningKey {
  publicKey: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

const cache = new Map<string, Promise<SigningKey>>();

export class KeyError extends Error {}

export function loadSigningKey(secretB64: string | undefined, label: string): Promise<SigningKey> {
  const raw = secretB64?.trim();
  if (!raw) return Promise.reject(new KeyError(`${label} not configured`));
  const hit = cache.get(raw);
  if (hit) return hit;
  const p = importKey(raw, label);
  p.catch(() => cache.delete(raw));
  if (cache.size > 8) cache.clear();
  cache.set(raw, p);
  return p;
}

async function importKey(raw: string, label: string): Promise<SigningKey> {
  let bytes: Uint8Array;
  try {
    bytes = parseSecret(raw);
  } catch {
    throw new KeyError(`${label} is malformed`);
  }
  const seed = bytes.subarray(0, 32);
  const pub = bytes.subarray(32, 64);
  const jwk: JsonWebKey = { kty: 'OKP', crv: 'Ed25519', d: toB64Url(seed), x: toB64Url(pub) };
  let priv: CryptoKey;
  let verifyKey: CryptoKey;
  try {
    priv = (await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign'])) as CryptoKey;
    verifyKey = (await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify'])) as CryptoKey;
  } catch {
    throw new KeyError(`${label} cannot be imported`);
  }
  const probe = new TextEncoder().encode(`cornershop key self-test ${label}`);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, priv, probe));
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, verifyKey, sig, probe);
  if (!ok) throw new KeyError(`${label}: secret key and public key do not match`);
  const publicKey = b58encode(pub);
  return {
    publicKey,
    async sign(message: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, priv, message));
    },
  };
}

/** Accepts base64 of 64 bytes, or the Solana CLI JSON array form (local dev convenience). */
function parseSecret(raw: string): Uint8Array {
  let bytes: Uint8Array;
  if (raw.startsWith('[')) {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr) || arr.some((n) => typeof n !== 'number' || n < 0 || n > 255 || !Number.isInteger(n))) throw new Error('bad array');
    bytes = Uint8Array.from(arr as number[]);
  } else {
    bytes = fromB64(raw);
  }
  if (bytes.length !== 64) throw new Error('secret must be 64 bytes');
  return bytes;
}

/** Test helper. */
export function __clearKeyCache(): void {
  cache.clear();
}
