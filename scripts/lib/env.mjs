/**
 * Server-only environment (`.env.server`, gitignored) parsed into memory. Values never leave the process except
 * through stdin pipes to `wrangler secret put|bulk` (secretPut.mjs), and as in-memory needles for leak scans
 * (secrets.mjs). Local scripts never call a provider with these keys (rpc.mjs uses public endpoints).
 * Nothing here prints a value.
 *
 * Recognised names (see .env.example): GOOGLE_SERVER_KEY, ALCHEMY_API_KEY (+ optional ALCHEMY_API_KEY_DEVNET /
 * ALCHEMY_API_KEY_MAINNET for a separate AtlasPad Alchemy app per cluster), TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
 * TWILIO_VERIFY_SID, TURNSTILE_SITE_KEY (public), TURNSTILE_SECRET_KEY, JUPITER_API_KEY, ALERT_WEBHOOK_URL,
 * ALERT_EMAIL_TO (the owner-alert email recipient: an address verified in Cloudflare Email Routing; a secret, it never
 * goes in a committed file), PRIVY_APP_ID (public). The RPC provider is Alchemy (INTEGRATION.md header, 2026-10-08);
 * Helius is superseded.
 */
import { existsSync, readFileSync } from 'node:fs';
import { ENV_LOCAL, ENV_SERVER } from './paths.mjs';

/** Parse dotenv text (KEY=VALUE, optional quotes, `#` comments, optional `export`). */
export function parseDotenv(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      v = v.slice(1, -1);
    } else {
      const hash = v.indexOf(' #');
      if (hash >= 0) v = v.slice(0, hash);
      v = v.trim();
    }
    out.set(m[1], v);
  }
  return out;
}

let cached;
/** `.env.server` as a Map (empty Map when the file is missing). Cached per process. */
export function envServer() {
  if (!cached) cached = existsSync(ENV_SERVER) ? parseDotenv(readFileSync(ENV_SERVER, 'utf8')) : new Map();
  return cached;
}

/** A non-empty value from `.env.server`, or undefined. */
export function envValue(name) {
  const v = envServer().get(name);
  return v && v.length ? v : undefined;
}

/** Names (never values) of `.env.server` entries that are missing or empty. */
export function missingEnv(names) {
  return names.filter((n) => !envValue(n));
}

/**
 * The `.env.server` NAME whose value becomes the Worker secret ALCHEMY_API_KEY for a cluster: a cluster-specific
 * ALCHEMY_API_KEY_DEVNET / ALCHEMY_API_KEY_MAINNET when present (a separate AtlasPad app), else ALCHEMY_API_KEY.
 * Returns a name only.
 */
export function alchemySourceName(cluster) {
  const specific = cluster === 'mainnet' ? 'ALCHEMY_API_KEY_MAINNET' : 'ALCHEMY_API_KEY_DEVNET';
  return envValue(specific) ? specific : 'ALCHEMY_API_KEY';
}

/**
 * Whether `v` is one plain email address (`name@example.com`: no display name, spaces, commas or line breaks), by the
 * same rule as the Worker (worker/email.ts cleanAddress), which ignores anything else in ALERT_EMAIL_TO. Never prints.
 */
export function isPlainEmailAddress(v) {
  const a = String(v ?? '').trim();
  if (a.length > 254 || /[\r\n]/.test(a)) return false;
  if (!/^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(a)) return false;
  const local = a.slice(0, a.indexOf('@'));
  return !(local.startsWith('.') || local.endsWith('.') || local.includes('..'));
}

/** `.env.local` (browser key, VITE_*). The browser key is public by design, but scripts still never print it. */
export function envLocal() {
  return existsSync(ENV_LOCAL) ? parseDotenv(readFileSync(ENV_LOCAL, 'utf8')) : new Map();
}

/** Names in .env.server whose values are secret (everything except the public ones). */
export const PUBLIC_ENV_NAMES = new Set(['TURNSTILE_SITE_KEY', 'PRIVY_APP_ID']);
