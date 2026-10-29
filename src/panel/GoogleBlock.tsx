/**
 * Google's own place content via the Places UI Kit (DESIGN §9): <gmp-place-details> in the panel
 * and <gmp-place-details-compact> in modals. We never build Google content ourselves and never
 * read it: the element renders photos, rating, hours, phone… and its own attribution.
 *
 *  - `await importLibrary('places')` before mounting (defines the custom elements).
 *  - `gmp-load` / `gmp-error` don't bubble → attached on the element via a callback ref.
 *  - Loading: skeleton overlay (min-height 320px), removed on gmp-load with a 200ms fade.
 *  - Error (gmp-error, import failure, or no gmp-load within 8s of being on screen — the element
 *    lazy-loads when it scrolls into view): Try again (re-mount) + Open in Google Maps.
 *  - Only on a Google map (store.provider === 'google'); each mount is a billed request, so the
 *    caller keeps it mounted while switching tabs and unmounts it when the panel closes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { links } from '../config';
import { importLibrary } from '../lib/google';
import { openExternal } from '../lib/nav';
import { Button, Icon, Sk } from '../ui';

type LoadState = 'loading' | 'fading' | 'ready' | 'error';

const LOAD_TIMEOUT_MS = 8000;

/**
 * Run `cb` after `ms` of time during which the element could actually be loading. Google's element
 * waits for an IntersectionObserver callback before it requests anything: it lazy-loads only once it
 * scrolls into view, and those callbacks don't run while a tab is in the background (no frames).
 * So the watchdog only counts rendered frames (rAF deltas, capped so a long pause never counts)
 * while `active` — which callers tie to the slot intersecting the viewport. Time already counted
 * is kept when the slot scrolls out and back in, and reset when `deps` change.
 */
function useRenderedTimeout(active: boolean, ms: number, cb: () => void, deps: readonly unknown[]): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const elapsed = useRef(0);
  useEffect(() => {
    elapsed.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      if (last) elapsed.current += Math.min(250, t - last);
      last = t;
      if (elapsed.current >= ms) {
        cbRef.current();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ms, ...deps]);
}

/** Whether `el` intersects the viewport (clipped by scrolling ancestors such as the panel). */
function useInView(el: HTMLElement | null): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (!el) {
      setInView(false);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) setInView(e.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [el]);
  return inView;
}

/**
 * Load the places library + track gmp-load / gmp-error for one element instance.
 * The CSS class goes on the element as `class` (React 18 writes `className` on custom elements as a
 * literal `classname="…"` attribute, so the `.gmp` styles / --gmp-* variables would never apply).
 */
function useGmpElement(placeId: string, attempt: number) {
  const [lib, setLib] = useState<'idle' | 'ok' | 'error'>('idle');
  const [state, setState] = useState<LoadState>('loading');
  const cleanupRef = useRef<(() => void) | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const inView = useInView(slot);

  useEffect(() => {
    let alive = true;
    setState('loading');
    setLib('idle');
    importLibrary('places')
      .then(() => alive && setLib('ok'))
      .catch(() => {
        if (!alive) return;
        setLib('error');
        setState('error');
      });
    return () => {
      alive = false;
    };
  }, [placeId, attempt]);

  // 8s watchdog while loading and on screen (Google's element lazy-loads; see useRenderedTimeout)
  useRenderedTimeout(state === 'loading' && lib === 'ok' && inView, LOAD_TIMEOUT_MS, () => setState((s) => (s === 'loading' ? 'error' : s)), [placeId, attempt]);

  // fade the skeleton out (200ms) after gmp-load
  useEffect(() => {
    if (state !== 'fading') return;
    const t = setTimeout(() => setState('ready'), 200);
    return () => clearTimeout(t);
  }, [state]);

  useEffect(() => () => cleanupRef.current?.(), []);

  const ref = useCallback((el: HTMLElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!el) return;
    const onLoad = () => setState((s) => (s === 'loading' ? 'fading' : s));
    const onError = () => setState('error');
    el.addEventListener('gmp-load', onLoad);
    el.addEventListener('gmp-error', onError);
    cleanupRef.current = () => {
      el.removeEventListener('gmp-load', onLoad);
      el.removeEventListener('gmp-error', onError);
    };
  }, []);

  return { lib, state, ref, slotRef: setSlot, mountKey: `${placeId}:${attempt}` };
}

/** "About this place" + the full Places UI Kit element (Overview tab). */
export function GooglePlaceBlock({ placeId }: { placeId: string }) {
  const [attempt, setAttempt] = useState(0);
  const { lib, state, ref, slotRef, mountKey } = useGmpElement(placeId, attempt);
  const showElement = lib === 'ok' && state !== 'error';

  return (
    <section className="gplace" aria-label="About this place">
      <div className="sec-title">
        <span>About this place</span>
      </div>
      <div ref={slotRef} className={['gmp-slot', state === 'loading' || state === 'fading' ? 'is-loading' : ''].filter(Boolean).join(' ')} aria-busy={state === 'loading' || undefined}>
        {showElement ? (
          <gmp-place-details key={mountKey} ref={ref} class="gmp">
            <gmp-place-details-place-request place={placeId} />
            <gmp-place-content-config>
              <gmp-place-media lightbox-preferred="" />
              <gmp-place-rating />
              <gmp-place-type />
              <gmp-place-price />
              <gmp-place-accessible-entrance-icon />
              <gmp-place-open-now-status />
              <gmp-place-address />
              <gmp-place-opening-hours />
              <gmp-place-website />
              <gmp-place-phone-number />
              <gmp-place-attribution light-scheme-color="gray" dark-scheme-color="white" />
            </gmp-place-content-config>
          </gmp-place-details>
        ) : null}
        {state === 'loading' || state === 'fading' ? (
          <div className={['gmp-sk', state === 'fading' ? 'out' : ''].filter(Boolean).join(' ')} aria-hidden="true">
            <div className="gmp-sk-media">
              <Sk h="100%" r={0} className="m1" />
              <Sk h="100%" r={0} />
              <Sk h="100%" r={0} />
            </div>
            <div className="gmp-sk-text">
              <Sk w="60%" h={22} />
              <Sk w="40%" h={14} />
              <Sk w="70%" h={14} />
            </div>
            <div className="gmp-sk-rows">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="gmp-sk-row">
                  <Sk w={24} h={24} r="50%" />
                  <Sk w="60%" h={14} />
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {state === 'error' ? (
          <div className="gmp-err" role="status">
            <Icon name="error" />
            <p className="gmp-err-t">Couldn't load details for this place</p>
            <p className="gmp-err-s">Your coin info above still works.</p>
            <div className="gmp-err-actions">
              <Button variant="text" icon="refresh" onClick={() => setAttempt((a) => a + 1)}>
                Try again
              </Button>
              <Button variant="text" icon="open_in_new" onClick={() => openExternal(links.googleMapsPlace(placeId))}>
                Open in Google Maps
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Compact element for modals (DESIGN §9.5): launch Review, claim Verify. */
export function GooglePlaceCompact({ placeId }: { placeId: string }) {
  const { lib, state, ref, slotRef, mountKey } = useGmpElement(placeId, 0);
  const showElement = lib === 'ok' && state !== 'error';
  return (
    <div ref={slotRef} className={['gmpc-slot', state === 'loading' || state === 'fading' ? 'is-loading' : ''].filter(Boolean).join(' ')}>
      {showElement ? (
        <gmp-place-details-compact key={mountKey} ref={ref} class="gmp-compact" orientation="horizontal" truncation-preferred="">
          <gmp-place-details-place-request place={placeId} />
          <gmp-place-content-config>
            <gmp-place-media />
            <gmp-place-rating />
            <gmp-place-type />
            <gmp-place-address />
            <gmp-place-attribution light-scheme-color="gray" dark-scheme-color="white" />
          </gmp-place-content-config>
        </gmp-place-details-compact>
      ) : null}
      {state === 'loading' || state === 'fading' ? (
        <Sk h={72} r={12} className={['gmpc-sk', state === 'fading' ? 'out' : ''].filter(Boolean).join(' ')} />
      ) : null}
      {state === 'error' ? (
        <p className="gmpc-err">
          Place details unavailable ·{' '}
          <a href={links.googleMapsPlace(placeId)} target="_blank" rel="noopener noreferrer">
            Open in Google Maps
          </a>
        </p>
      ) : null}
    </div>
  );
}
