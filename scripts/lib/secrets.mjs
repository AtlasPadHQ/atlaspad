/**
 * Every secret value this machine knows, in every encoding a leak would plausibly take, held in memory only.
 * Used for: redacting script output (log.mjs), scanning built bundles (check-bundle.mjs) and scanning live API
 * responses (smoke.mjs). Callers get booleans and NAMES of leaked secrets, never the values.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { b58encode } from './b58.mjs';
import { envServer, envLocal, PUBLIC_ENV_NAMES } from './env.mjs';
import { KEYS_DIR } from './paths.mjs';

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** @returns {{ name: string, value: string }[]} (value never leaves the calling process) */
export function knownSecrets({ includeKeys = true } = {}) {
  const out = [];
  for (const [name, value] of envServer()) {
    if (!value || PUBLIC_ENV_NAMES.has(name) || value.length < 8) continue;
    out.push({ name: `.env.server:${name}`, value });
  }
  // Twilio Basic auth header value, if both parts are known.
  const sid = envServer().get('TWILIO_ACCOUNT_SID');
  const tok = envServer().get('TWILIO_AUTH_TOKEN');
  if (sid && tok) out.push({ name: 'twilio-basic-auth', value: Buffer.from(`${sid}:${tok}`).toString('base64') });
  if (!includeKeys || !existsSync(KEYS_DIR)) return out;
  for (const f of readdirSync(KEYS_DIR)) {
    const p = join(KEYS_DIR, f);
    let text;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    if (f.endsWith('.key')) {
      const v = text.trim();
      if (v.length >= 16) {
        out.push({ name: `.keys/${f}`, value: v });
        const raw = Buffer.from(v, 'base64');
        if (raw.length >= 16) {
          out.push({ name: `.keys/${f} (hex)`, value: raw.toString('hex') });
          out.push({ name: `.keys/${f} (b64url)`, value: b64url(raw) });
        }
      }
      continue;
    }
    if (!f.endsWith('.json')) continue;
    let arr;
    try {
      arr = JSON.parse(text);
    } catch {
      continue;
    }
    if (!Array.isArray(arr) || arr.length !== 64) continue;
    const bytes = Uint8Array.from(arr);
    const seed = bytes.subarray(0, 32);
    const tag = `.keys/${f}`;
    out.push({ name: `${tag} (json)`, value: JSON.stringify(arr) });
    out.push({ name: `${tag} (json, spaced)`, value: arr.join(', ') });
    out.push({ name: `${tag} (base64)`, value: Buffer.from(bytes).toString('base64') });
    out.push({ name: `${tag} (base64url)`, value: b64url(bytes) });
    out.push({ name: `${tag} (base58)`, value: b58encode(bytes) });
    out.push({ name: `${tag} (seed base64)`, value: Buffer.from(seed).toString('base64').replace(/=+$/, '') });
    out.push({ name: `${tag} (seed base64url)`, value: b64url(seed) });
    out.push({ name: `${tag} (seed base58)`, value: b58encode(seed) });
    out.push({ name: `${tag} (seed hex)`, value: Buffer.from(seed).toString('hex') });
  }
  return out;
}

/** The browser key is meant to ship; it is not a secret, but scripts still never print it. */
export function browserKeyValue() {
  return envLocal().get('VITE_GOOGLE_MAPS_KEY') || undefined;
}

/** Raw 32-byte seeds of every keypair (binary leak check). */
export function knownSeeds() {
  const out = [];
  if (!existsSync(KEYS_DIR)) return out;
  for (const f of readdirSync(KEYS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const arr = JSON.parse(readFileSync(join(KEYS_DIR, f), 'utf8'));
      if (Array.isArray(arr) && arr.length === 64) out.push({ name: `.keys/${f} (raw seed)`, bytes: Buffer.from(arr.slice(0, 32)) });
    } catch {
      /* not a keypair */
    }
  }
  return out;
}

/**
 * Names of the secrets found in `haystack` (string or Buffer). Values are compared in memory only.
 * @param {string|Buffer} haystack
 * @param {{name:string,value:string}[]} secrets
 */
export function findLeaks(haystack, secrets, seeds = []) {
  const buf = Buffer.isBuffer(haystack) ? haystack : Buffer.from(String(haystack), 'utf8');
  const hits = new Set();
  for (const s of secrets) if (s.value && buf.indexOf(s.value, 0, 'utf8') >= 0) hits.add(s.name);
  for (const s of seeds) if (buf.indexOf(s.bytes) >= 0) hits.add(s.name);
  return [...hits];
}
