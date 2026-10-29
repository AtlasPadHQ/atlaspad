/**
 * Google Maps JS loader: a typed, faithful port of Google's official inline "dynamic library
 * import" bootstrap (https://developers.google.com/maps/documentation/javascript/load-maps-js-api),
 * with v=weekly, language en-GB, region GB, and failure handling:
 *   - rejects when there is no key,
 *   - rejects when the script fails to load (network / blocked),
 *   - rejects on `window.gm_authFailure` (bad key / referrer / API not enabled),
 *   - rejects a single import after a timeout.
 * SHARED (src/lib). Browser-only.
 *
 * Usage:
 *   const { Map, OverlayView } = await importLibrary('maps');
 *   const { Place, AutocompleteSuggestion } = await importLibrary('places');
 *   onGoogleFailure((err) => useStore.getState().setProvider('demo', 'load-failed'));
 *
 * The bootstrap is the async loader (equivalent to `loading=async` on a script tag).
 * Never use the legacy Places services (PlacesService / AutocompleteService): they throw
 * LegacyApiNotActivatedMapError on new projects (research/google.md §1).
 */
import { GOOGLE_KEY, MAP_LANGUAGE, MAP_REGION } from '../config';
import type { Unsubscribe } from '../types';

export type GoogleLibraryMap = google.maps.ImportLibraryMap;
export type GoogleFailureCode = 'no-key' | 'script' | 'auth' | 'timeout';

export class GoogleMapsError extends Error {
  constructor(
    public readonly code: GoogleFailureCode,
    message?: string,
  ) {
    super(message ?? `Google Maps unavailable (${code})`);
    this.name = 'GoogleMapsError';
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

let installed = false;
let failure: GoogleMapsError | null = null;
const failureListeners = new Set<(err: GoogleMapsError) => void>();

/** Mark Google as permanently failed for this page (auth failure, no key). */
function fail(err: GoogleMapsError): void {
  if (failure) return;
  failure = err;
  for (const cb of [...failureListeners]) {
    try {
      cb(err);
    } catch {
      /* listener errors must not break others */
    }
  }
}

type LooseMaps = Record<string, unknown> & {
  importLibrary?: (name: string, ...rest: unknown[]) => Promise<unknown>;
  __ib__?: () => void;
};

/**
 * Install the official bootstrap once. It defines `google.maps.importLibrary`, which loads
 * the Maps JS script on first use (libraries accumulate) and then delegates to the real loader.
 */
/** Set by the inline script in index.html, which starts the Maps JS download before the app bundle runs (LCP). */
interface EarlyBoot {
  __csMapsBoot?: Promise<void>;
  __csMapsAuthFailed?: boolean;
}

function installBootstrap(params: Record<string, string>): void {
  const w = window as unknown as { google?: { maps?: LooseMaps } } & EarlyBoot;
  const g = (w.google ??= {});
  const d: LooseMaps = (g.maps ??= {});
  const label = 'The Google Maps JavaScript API';
  if (d.importLibrary) {
    // the early download (index.html) already finished: the real importLibrary is in place
    if (!w.__csMapsBoot) console.warn(`${label} only loads once. Ignoring:`, params);
    return;
  }
  const libraries = new Set<string>();
  const search = new URLSearchParams();
  let loading: Promise<void> | undefined;
  const early = (): Promise<void> | undefined => {
    const p = w.__csMapsBoot;
    if (!p) return undefined;
    w.__csMapsBoot = undefined; // one use: a failed early download falls back to a normal (retryable) load
    return p.catch(() => {
      loading = undefined;
      throw new GoogleMapsError('script', `${label} could not load.`);
    });
  };
  const load = (): Promise<void> =>
    (loading ??= early() ?? new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      search.set('libraries', [...libraries].join(','));
      for (const [k, v] of Object.entries(params)) {
        search.set(k.replace(/[A-Z]/g, (t) => `_${t[0]?.toLowerCase() ?? ''}`), v);
      }
      search.set('callback', 'google.maps.__ib__');
      script.src = `https://maps.googleapis.com/maps/api/js?${search.toString()}`;
      d.__ib__ = resolve;
      script.onerror = () => {
        loading = undefined; // allow a retry, like the official snippet
        reject(new GoogleMapsError('script', `${label} could not load.`));
      };
      script.nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce ?? '';
      document.head.append(script);
    }));
  const bootstrapImport = (name: string, ...rest: unknown[]): Promise<unknown> => {
    libraries.add(name);
    return load().then(() => {
      // After the script loads, google.maps.importLibrary is the real implementation.
      const real = d.importLibrary;
      if (!real || real === bootstrapImport) throw new GoogleMapsError('script', `${label} did not initialise.`);
      return real(name, ...rest);
    });
  };
  d.importLibrary = bootstrapImport;
}

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  if (!GOOGLE_KEY) {
    fail(new GoogleMapsError('no-key'));
    return;
  }
  // Google calls this global when the key is rejected (invalid, referrer not allowed, API disabled).
  if ((window as unknown as EarlyBoot).__csMapsAuthFailed) {
    fail(new GoogleMapsError('auth', 'Google Maps rejected the API key.'));
    return;
  }
  const previous = window.gm_authFailure;
  window.gm_authFailure = () => {
    fail(new GoogleMapsError('auth', 'Google Maps rejected the API key.'));
    previous?.();
  };
  installBootstrap({ key: GOOGLE_KEY, v: 'weekly', language: MAP_LANGUAGE, region: MAP_REGION });
}

/**
 * Import a Maps JS library. Rejects with GoogleMapsError('no-key' | 'script' | 'auth' | 'timeout').
 * A 'script' or 'timeout' rejection does not mark Google failed globally (a retry may work);
 * 'no-key' and 'auth' do (see onGoogleFailure).
 */
export async function importLibrary<K extends keyof GoogleLibraryMap>(
  name: K,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<GoogleLibraryMap[K]> {
  ensureInstalled();
  if (failure) throw failure;
  let cleanup = () => {};
  const failed = new Promise<never>((_, reject) => {
    const cb = (err: GoogleMapsError) => reject(err);
    failureListeners.add(cb);
    const timer = window.setTimeout(() => reject(new GoogleMapsError('timeout')), timeoutMs);
    cleanup = () => {
      failureListeners.delete(cb);
      window.clearTimeout(timer);
    };
  });
  try {
    const maps = (window as unknown as { google: { maps: LooseMaps } }).google.maps;
    const loader = maps.importLibrary as (n: K) => Promise<GoogleLibraryMap[K]>;
    const pending = loader(name);
    pending.catch(() => {}); // a late rejection after a timeout must not surface as unhandled
    return await Promise.race([pending, failed]);
  } finally {
    cleanup();
  }
}

/** Subscribe to a permanent Google failure ('no-key' or 'auth'). Fires immediately if already failed. */
export function onGoogleFailure(cb: (err: GoogleMapsError) => void): Unsubscribe {
  if (failure) {
    queueMicrotask(() => cb(failure as GoogleMapsError));
    return () => {};
  }
  failureListeners.add(cb);
  return () => failureListeners.delete(cb);
}

/** The permanent failure, if any. */
export function googleFailure(): GoogleMapsError | null {
  return failure;
}

/** True once the Maps JS script has loaded (`google.maps.version` is set). */
export function isGoogleLoaded(): boolean {
  const g = (window as unknown as { google?: { maps?: { version?: string } } }).google;
  return typeof g?.maps?.version === 'string';
}

/** Report a permanent failure detected elsewhere (e.g. the map adapter sees an auth error overlay). */
export function reportGoogleFailure(code: GoogleFailureCode, message?: string): void {
  fail(new GoogleMapsError(code, message));
}
