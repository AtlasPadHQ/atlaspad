/**
 * The Worker API calls the chain flows make (INTEGRATION.md §3.3–§3.5), typed with worker/wire.ts.
 * Abstracted as `ChainBackend` so the Node devnet e2e can swap in a local backend (it co-signs with the devnet
 * attestor key in-process); the browser always uses `httpBackend` (same-origin `/api/*`).
 */
import type {
  ApiErrorBody,
  ClaimConfirmRequest,
  ClaimConfirmResponse,
  ClaimCosignRequest,
  ClaimCosignResponse,
  IndexTxRequest,
  IndexTxResponse,
  LaunchConfirmRequest,
  LaunchConfirmResponse,
  LaunchCosignRequest,
  LaunchCosignResponse,
  LaunchPrepareRequest,
  LaunchPrepareResponse,
  MetadataUploadResponse,
} from '../../worker/wire';
import { ApiError } from './errors';

export interface MetadataUpload {
  name: string;
  symbol: string;
  description: string;
  placeId: string;
  image: Blob;
}

export interface ChainBackend {
  uploadMetadata(m: MetadataUpload): Promise<MetadataUploadResponse>;
  launchPrepare(r: LaunchPrepareRequest): Promise<LaunchPrepareResponse>;
  launchCosign(r: LaunchCosignRequest): Promise<LaunchCosignResponse>;
  /** 200 registered / 202 pending. */
  launchConfirm(r: LaunchConfirmRequest): Promise<LaunchConfirmResponse>;
  claimCosign(r: ClaimCosignRequest): Promise<ClaimCosignResponse>;
  claimConfirm(r: ClaimConfirmRequest): Promise<ClaimConfirmResponse>;
  /** Best effort (the feed shows the trade in ~2 s); never throws. */
  indexTx(r: IndexTxRequest): Promise<IndexTxResponse | null>;
}

const TIMEOUT_MS = 20_000;

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
  let res: Response;
  try {
    res = await fetch(path, { ...init, signal: ctrl?.signal, credentials: 'same-origin' });
  } catch (e) {
    throw new ApiError(0, { error: 'upstream', message: (e as Error)?.name === 'AbortError' ? 'timeout' : 'network' });
  } finally {
    if (timer) clearTimeout(timer);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body && typeof body === 'object' ? body : { error: res.status === 429 ? 'rate_limited' : 'upstream' }) as ApiErrorBody;
    throw new ApiError(res.status, b);
  }
  // 202 bodies ({status:'pending'}) are valid responses for the confirm routes.
  return body as T;
}

function postJson<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}

function extOf(type: string): string {
  return type === 'image/webp' ? 'webp' : type === 'image/jpeg' ? 'jpg' : 'png';
}

export const httpBackend: ChainBackend = {
  uploadMetadata(m) {
    const form = new FormData();
    form.set('name', m.name);
    form.set('symbol', m.symbol);
    form.set('description', m.description);
    form.set('placeId', m.placeId);
    form.set('image', m.image, `coin.${extOf(m.image.type)}`);
    return request<MetadataUploadResponse>('/api/metadata', { method: 'POST', body: form });
  },
  launchPrepare: (r) => postJson('/api/launch/prepare', r),
  launchCosign: (r) => postJson('/api/launch/cosign', r),
  launchConfirm: (r) => postJson('/api/launch/confirm', r),
  claimCosign: (r) => postJson('/api/claim/cosign', r),
  claimConfirm: (r) => postJson('/api/claim/confirm', r),
  async indexTx(r) {
    try {
      return await postJson<IndexTxResponse>('/api/index/tx', r);
    } catch {
      return null;
    }
  },
};
