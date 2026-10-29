/**
 * Worker environment: bindings, vars and secrets (wrangler.jsonc, INTEGRATION.md §1.4-§1.6), plus the build/runtime
 * cluster gates (H4-H6).
 *
 * SECRETS (never logged, never in a response, never in a URL the browser sees):
 *   ALCHEMY_API_KEY      only worker/solana.ts → rpcUrl() reads it
 *   ATTESTOR_SECRET      only worker/attestor.ts reads it
 *   CRANK_SECRET         only worker/crank.ts reads it
 *   DEV_FAUCET_SECRET    only worker/dev/airdrop.ts reads it (compiled out of mainnet)
 *   HMAC_KEY             only worker/hmac.ts reads it
 *   GOOGLE_SERVER_KEY    worker/google.ts and the Phase-1 worker/api.ts
 *   TWILIO_*             only worker/twilio.ts reads them
 *   TURNSTILE_SECRET_KEY only worker/turnstile.ts reads it
 *   ALERT_WEBHOOK_URL    only worker/webhook.ts reads it
 *   ALERT_EMAIL_TO       only worker/email.ts reads it (the owner's address: never in wrangler.jsonc, code or docs)
 */
import type { Cluster } from './wire';

export interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;

  RL_READ?: RateLimit;
  RL_FRESH?: RateLimit;
  RL_GOOGLE?: RateLimit;
  RL_RPC?: RateLimit;
  RL_SEND?: RateLimit;
  RL_WRITE?: RateLimit;
  RL_CLAIM?: RateLimit;

  /** 'devnet' | 'mainnet'; unset = the Phase-1 demo Worker (every Phase-2 route → 404 not_enabled). */
  CLUSTER?: string;
  PUBLIC_ORIGIN?: string;
  PROGRAM_ID?: string;
  ALT_ADDRESS?: string;
  MAX_DEV_BUY_LAMPORTS?: string;
  PRIORITY_FEE_DEFAULT?: string;
  TURNSTILE_SITE_KEY?: string;
  PRIVY_APP_ID?: string;
  FEATURE_WEBSITE_VERIFY?: string;
  /** '1' / '0' opens / closes the manual-review claim route; unset = on for devnet, off for mainnet (manualReviewEnabled). */
  FEATURE_MANUAL_REVIEW?: string;
  BUILD_ID?: string;
  /**
   * '0' disables the second (reference) co-sign gate — the shop-vault client's checker over web3.js — leaving the
   * stricter worker/policy.ts gate alone. Default on. Only for the Workers Free CPU limit (web3.js module init on the
   * first co-sign of an isolate); never needed on Workers Paid.
   */
  POLICY_REFERENCE?: string;
  /** Geo-blocking (worker/geo.ts): 'off' disables it; unset = on for devnet and mainnet. */
  GEO_BLOCK?: string;
  /** CSV of ISO 3166-1 alpha-2 codes; unset = the worker/geo.ts defaults. */
  BLOCKED_COUNTRIES?: string;
  /** CSV of ISO 3166-2 codes (`UA-43`); unset = the worker/geo.ts defaults. */
  BLOCKED_REGIONS?: string;
  /** The alert email's sender (worker/email.ts): an address on atlaspad.online or the PUBLIC_ORIGIN host; unset = alerts@atlaspad.online. */
  ALERT_EMAIL_FROM?: string;

  /**
   * Cloudflare Email Routing `send_email` binding (wrangler.jsonc env.devnet / env.mainnet, unrestricted: it can only
   * send to the account's verified destination addresses). Absent = no alert email.
   */
  ALERT_EMAIL?: SendEmail;

  GOOGLE_SERVER_KEY?: string;
  ALCHEMY_API_KEY?: string;
  ATTESTOR_SECRET?: string;
  CRANK_SECRET?: string;
  HMAC_KEY?: string;
  DEV_FAUCET_SECRET?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_VERIFY_SID?: string;
  TURNSTILE_SECRET_KEY?: string;
  JUPITER_API_KEY?: string;
  ALERT_WEBHOOK_URL?: string;
  /** The alert email's recipient: a verified destination address in Cloudflare Email Routing. */
  ALERT_EMAIL_TO?: string;
}

/** Names of every secret binding (logger scrubbing, tests). */
export const SECRET_NAMES = [
  'GOOGLE_SERVER_KEY',
  'ALCHEMY_API_KEY',
  'ATTESTOR_SECRET',
  'CRANK_SECRET',
  'HMAC_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_VERIFY_SID',
  'TURNSTILE_SECRET_KEY',
  'JUPITER_API_KEY',
  'ALERT_WEBHOOK_URL',
  'ALERT_EMAIL_TO',
] as const satisfies readonly (keyof Env)[];

/** Secret values that exist only in dev builds (kept out of SECRET_NAMES so mainnet bundles never name them). */
export function devSecretValues(env: Env): string[] {
  if (__CS_DEV_ENDPOINTS__) return [env.DEV_FAUCET_SECRET ?? ''];
  return [];
}

/**
 * The compile-time cluster (`define.__CS_CLUSTER__`). 'demo' when the constant is missing (unit tests without
 * `define`, or the top-level Phase-1 config).
 */
export function buildCluster(): 'demo' | 'devnet' | 'mainnet' {
  try {
    return __CS_CLUSTER__;
  } catch {
    return 'demo';
  }
}

/**
 * The runtime cluster: `vars.CLUSTER`, but only when it agrees with the compile-time cluster. A demo-compiled bundle
 * never runs real routes, and a mainnet bundle can never be pointed at devnet by a var (or the other way round).
 * Tests (no define → 'demo' build) opt in by setting `globalThis.__CS_CLUSTER__`.
 */
export function realCluster(env: Env): Cluster | null {
  const c = env.CLUSTER;
  if (c !== 'devnet' && c !== 'mainnet') return null;
  return buildCluster() === c ? c : null;
}

export function publicOrigin(env: Env, cluster: Cluster | null): string {
  const o = env.PUBLIC_ORIGIN?.trim();
  if (o && /^https:\/\/[a-z0-9.-]+$/.test(o)) return o;
  if (cluster === 'devnet') return 'https://cornershop-devnet.tiejiucai.workers.dev';
  return cluster === 'mainnet' ? 'https://atlaspad.online' : 'https://cornershop.tiejiucai.workers.dev';
}

/** The shop-vault program id (vars.PROGRAM_ID, same on both clusters). */
export function programIdOf(env: Env): string {
  const p = env.PROGRAM_ID?.trim();
  return p && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p) ? p : '6t4zkDgNkFZdGcrxCxrDwqa7CPhSgYXT8ai48UW4BV8x';
}

/**
 * The manual-review claim route (POST /api/claim/manual, /api/report kind manual_claim). Off on mainnet until the
 * review tooling exists; `FEATURE_MANUAL_REVIEW` overrides the per-cluster default either way.
 */
export function manualReviewEnabled(env: Env, cluster: Cluster): boolean {
  const v = env.FEATURE_MANUAL_REVIEW?.trim();
  if (v === '1') return true;
  if (v === '0') return false;
  return cluster === 'devnet';
}

export function hasSecret(v: string | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
