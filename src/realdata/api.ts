/**
 * Typed fetchers for the Worker's real-mode API (INTEGRATION.md §3, shapes in worker/wire.ts).
 * Every call goes to our own origin (`/api/*`) — never a Helius or public RPC URL (H3).
 *
 * Errors: every failure becomes an `ApiError` with the HTTP status (0 = network / timeout / not
 * JSON) and an `ApiErrorBody` (`unavailable` when the Worker didn't send one), so callers can map
 * codes to copy without guessing.
 */
import type {
  ApiErrorBody,
  ApiErrorCode,
  ClaimCallRequest,
  ClaimCallResponse,
  ClaimCheckRequest,
  ClaimCheckResponse,
  ClaimStatusResponse,
  ClaimWebsiteRequest,
  ClaimWebsiteResponse,
  CoinDetailResponse,
  CoinsResponse,
  ConfigResponse,
  EligibilityResponse,
  FeedResponse,
  MarketResponse,
  PlaceResponse,
  ReportRequest,
  TopResponse,
} from '../../worker/wire';
import { waitFor } from '../lib/format';

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message ?? body.error);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
  get code(): ApiErrorCode {
    return this.body.error;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

const DEFAULT_TIMEOUT_MS = 10_000;

interface FetchOpts {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Accept 202 as success (launch/claim confirm "pending"). */
  accept202?: boolean;
}

function isErrorBody(v: unknown): v is ApiErrorBody {
  return !!v && typeof v === 'object' && typeof (v as { error?: unknown }).error === 'string';
}

/** One JSON request to our Worker. Throws ApiError. */
export async function apiFetch<T>(path: string, opts: FetchOpts = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      headers: opts.body !== undefined && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : undefined,
      body: opts.body === undefined ? undefined : opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body),
      signal: ctrl.signal,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, { error: 'unavailable', message: opts.signal?.aborted ? 'aborted' : "We couldn't reach AtlasPad." });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.ok && (res.status !== 202 || opts.accept202)) {
    if (data === null) throw new ApiError(res.status, { error: 'upstream', message: 'Empty response.' });
    return data as T;
  }
  if (isErrorBody(data)) {
    const retry = Number(res.headers.get('retry-after'));
    const body: ApiErrorBody = { ...data };
    if (body.retryAfterSec == null && Number.isFinite(retry) && retry > 0) body.retryAfterSec = retry;
    throw new ApiError(res.status, body);
  }
  throw new ApiError(res.status, { error: res.status === 429 ? 'rate_limited' : res.status === 404 ? 'not_found' : 'unavailable' });
}

const q = encodeURIComponent;

/* ------------------------------------------------------------------ reads */

export const api = {
  config: (signal?: AbortSignal) => apiFetch<ConfigResponse>('/api/config', { signal }),

  coinsInBbox: (bbox: string, limit = 300, signal?: AbortSignal) =>
    apiFetch<CoinsResponse>(`/api/coins?bbox=${q(bbox)}&limit=${limit}`, { signal }),
  coinsByMints: (mints: readonly string[], signal?: AbortSignal) =>
    apiFetch<CoinsResponse>(`/api/coins?mints=${mints.slice(0, 100).map(q).join(',')}`, { signal }),
  coinsByLauncher: (addr: string, signal?: AbortSignal) => apiFetch<CoinsResponse>(`/api/coins?launcher=${q(addr)}`, { signal }),
  coinsByOwner: (addr: string, signal?: AbortSignal) => apiFetch<CoinsResponse>(`/api/coins?owner=${q(addr)}`, { signal }),
  newestCoins: (limit = 50, signal?: AbortSignal) => apiFetch<CoinsResponse>(`/api/coins?sort=new&limit=${limit}`, { signal }),

  coin: (mint: string, fresh = false, signal?: AbortSignal) =>
    apiFetch<CoinDetailResponse>(`/api/coins/${q(mint)}${fresh ? '?fresh=1' : ''}`, { signal }),

  market: (mints: readonly string[], signal?: AbortSignal) =>
    apiFetch<MarketResponse>(`/api/market?mints=${mints.slice(0, 100).map(q).join(',')}`, { signal }),

  top: (by: 'mcap' | 'fees', limit = 20, bbox?: string, signal?: AbortSignal) =>
    apiFetch<TopResponse>(`/api/top?by=${by}&limit=${limit}${bbox ? `&bbox=${q(bbox)}` : ''}`, { signal }),

  feed: (p: { limit?: number; since?: number; before?: number } = {}, signal?: AbortSignal) => {
    const parts = [`limit=${p.limit ?? 50}`];
    if (p.since) parts.push(`since=${p.since}`);
    if (p.before) parts.push(`before=${p.before}`);
    return apiFetch<FeedResponse>(`/api/feed?${parts.join('&')}`, { signal });
  },

  place: (placeId: string, signal?: AbortSignal) => apiFetch<PlaceResponse>(`/api/place/${q(placeId)}`, { signal }),
  eligibility: (placeId: string, signal?: AbortSignal) => apiFetch<EligibilityResponse>(`/api/place/${q(placeId)}/eligibility`, { signal }),

  /* ---------------------------------------------------------------- claims */
  claimStatus: (placeId: string, signal?: AbortSignal) => apiFetch<ClaimStatusResponse>(`/api/claim/status?placeId=${q(placeId)}`, { signal }),
  claimCall: (body: ClaimCallRequest) => apiFetch<ClaimCallResponse>('/api/claim/call', { method: 'POST', body, timeoutMs: 20_000 }),
  claimCheck: (body: ClaimCheckRequest) => apiFetch<ClaimCheckResponse>('/api/claim/check', { method: 'POST', body }),
  claimWebsite: (body: ClaimWebsiteRequest) => apiFetch<ClaimWebsiteResponse>('/api/claim/website', { method: 'POST', body, timeoutMs: 20_000 }),

  /* ---------------------------------------------------------------- misc */
  /**
   * Report a coin / business opt-out / manual claim review (204). `manual_claim` is the INTEGRATION.md
   * §7.5 manual-review route (wire.ts ReportRequest.kind gains it — see sharedChangesNeeded).
   */
  report: (body: Omit<ReportRequest, 'kind'> & { kind: ReportRequest['kind'] | 'manual_claim' }) =>
    apiFetch<unknown>('/api/report', { method: 'POST', body }).catch((e: unknown) => {
      // 204 has no JSON body: apiFetch reports it as an empty response, which is a success here
      if (isApiError(e) && e.status >= 200 && e.status < 300) return null;
      throw e;
    }),
};

/* ------------------------------------------------------------------ error copy */

/**
 * 429 copy: the Worker's own reason (first sentence, e.g. "Too many calls to this number today.") plus the real wait
 * from `retryAfterSec`, e.g. "… Try again in 11 hours." Never a made-up wait.
 */
export function limitMessage(e: ApiError): string {
  const retry = e.body.retryAfterSec;
  const raw = (e.body.message ?? '').trim();
  // keep the reason, drop the server's own "Try again …" / "Wait …" clause (the wait below is exact)
  const reason = raw
    .replace(/\s*(Try again|Wait)\b[^.]*\.?\s*$/i, '')
    .trim()
    .replace(/([^.!?])$/, '$1.');
  const head = reason && reason.length <= 120 && reason !== '.' ? reason : e.code === 'rate_limited' ? 'Too many requests.' : 'Too many attempts.';
  if (!retry || retry <= 0) return `${head} Try again later.`;
  if (retry <= 15) return `${head} Wait a few seconds and try again.`;
  return `${head} Try again in ${waitFor(retry)}.`;
}

/** Short human copy for an API failure (DESIGN tone). */
export function apiErrorMessage(e: unknown, fallback = "Something went wrong. Try again."): string {
  if (!isApiError(e)) return fallback;
  switch (e.code) {
    case 'rate_limited':
    case 'too_many_attempts':
      return limitMessage(e);
    case 'unavailable':
    case 'upstream':
      return e.status === 0 ? "We couldn't reach AtlasPad. Check your connection and try again." : 'This is unavailable right now. Try again in a minute.';
    case 'not_enabled':
    case 'not_configured':
      return "This isn't available yet.";
    case 'chain_mismatch':
      return 'The network is misconfigured right now. Try again later.';
    // sanctions (worker/geo.ts, worker/sanctions.ts)
    case 'region_blocked':
      return "AtlasPad isn't available in your region.";
    case 'place_region_blocked':
      return e.body.message && e.body.message.length < 160 ? e.body.message : "AtlasPad isn't available for businesses in this region.";
    case 'wallet_blocked':
      return "This wallet can't be used on AtlasPad.";
    default:
      return e.body.message && e.body.message.length < 160 ? e.body.message : fallback;
  }
}
