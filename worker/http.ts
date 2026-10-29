/**
 * HTTP helpers for the Phase-2 API (INTEGRATION.md §3.0): JSON responses, the ApiErrorBody status map, body limits,
 * the Origin rule and cache headers. Handlers `throw new ApiErr(...)`; the router turns it into a response.
 */
import type { ApiErrorBody, ApiErrorCode } from './wire';

export const STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  forbidden_origin: 403,
  not_found: 404,
  not_enabled: 404,
  method_not_allowed: 405,
  taken: 409,
  reserved: 409,
  claim_active: 409,
  claim_pending: 409,
  already_owner: 409,
  reservation_expired: 410,
  claim_expired: 410,
  payload_too_large: 413,
  unsupported_media: 415,
  not_launchable: 422,
  policy_violation: 422,
  moderation: 422,
  place_opted_out: 422,
  no_phone: 422,
  premium: 422,
  not_own_domain: 422,
  wrong_owner: 422,
  no_coin: 422,
  claim_not_verified: 422,
  not_confirmed: 422,
  launches_paused: 423,
  rate_limited: 429,
  too_many_attempts: 429,
  faucet_cap: 429,
  region_blocked: 451,
  place_region_blocked: 451,
  wallet_blocked: 451,
  upstream: 502,
  unavailable: 503,
  not_configured: 503,
  chain_mismatch: 503,
  faucet_empty: 503,
};

/** A typed API failure. `extra` adds the optional ApiErrorBody fields (violations, existing, reason, …). */
export class ApiErr extends Error {
  readonly status: number;
  constructor(
    readonly code: ApiErrorCode,
    message?: string,
    readonly extra: Omit<ApiErrorBody, 'error' | 'message'> = {},
  ) {
    super(message ?? code);
    this.status = STATUS[code];
  }
  get body(): ApiErrorBody {
    return { error: this.code, ...(this.message && this.message !== this.code ? { message: this.message } : {}), ...this.extra };
  }
}

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export const CACHE = {
  none: 'no-store',
  config: 'public, max-age=30',
  coins: 'public, max-age=5, stale-while-revalidate=25',
  top: 'public, max-age=15',
  market: 'public, max-age=2',
  feed: 'public, max-age=3',
  coin: 'public, max-age=5',
  immutable: 'public, max-age=31536000, immutable',
} as const;

export function json(body: unknown, status = 200, cache: string = CACHE.none, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, 'cache-control': cache, ...headers } });
}

export function errorResponse(e: ApiErr): Response {
  const h: Record<string, string> = {};
  if (e.extra.retryAfterSec) h['retry-after'] = String(Math.max(1, Math.ceil(e.extra.retryAfterSec)));
  return json(e.body, e.status, CACHE.none, h);
}

/** Reads a JSON object body of at most `maxBytes` (16 KB default). */
export async function readJsonObject(request: Request, maxBytes = 16_384): Promise<Record<string, unknown>> {
  const len = Number(request.headers.get('content-length') ?? '0');
  if (len > maxBytes) throw new ApiErr('payload_too_large', 'Request too large');
  const ct = request.headers.get('content-type') ?? '';
  if (ct && !ct.includes('application/json') && !ct.includes('text/plain')) throw new ApiErr('unsupported_media', 'Send JSON');
  const buf = await readLimited(request, maxBytes);
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder().decode(buf) || '{}');
  } catch {
    throw new ApiErr('bad_request', 'Invalid JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ApiErr('bad_request', 'Expected a JSON object');
  return v as Record<string, unknown>;
}

/** Reads the raw body, refusing more than `maxBytes` even when content-length lies or is absent. */
export async function readLimited(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new ApiErr('payload_too_large', 'Request too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

export const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:8787', 'http://localhost:8787'];

/**
 * Origin rule (§3.0): when an Origin header is present it must be PUBLIC_ORIGIN, or a local dev origin when the
 * build has dev endpoints. Absent Origin (same-origin GETs, server scripts) passes.
 */
export function originAllowed(request: Request, publicOrigin: string, devOrigins: boolean): boolean {
  const o = request.headers.get('origin');
  if (o === null) return true;
  if (o === publicOrigin) return true;
  return devOrigins && DEV_ORIGINS.includes(o);
}

/* ------------------------------------------------------------------------------------------- field validation */

export function str(body: Record<string, unknown>, key: string, max = 200): string {
  const v = body[key];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new ApiErr('bad_request', `Invalid ${key}`);
  return v;
}

export function optStr(body: Record<string, unknown>, key: string, max = 200): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max) throw new ApiErr('bad_request', `Invalid ${key}`);
  return v;
}

/** Random id: 128 bits, base64url. */
export function randomId(bytes = 16): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
