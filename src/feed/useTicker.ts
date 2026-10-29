/**
 * Small time helpers for live UI (relative times, feed health). OWNED BY RAIL+FEED.
 *  - useTicker(ms): re-render every `ms` while the page is visible (stops when hidden, resumes
 *    with an immediate re-render on return). Read `Date.now()` in render after calling it.
 *  - usePageHidden(): document.visibilityState === 'hidden', reactive.
 */
import { useEffect, useReducer, useSyncExternalStore } from 'react';

export function useTicker(ms: number): void {
  const [, bump] = useReducer((n: number) => (n + 1) % 1_000_000, 0);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let id: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (id == null) id = setInterval(bump, ms);
    };
    const stop = () => {
      if (id != null) clearInterval(id);
      id = undefined;
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') stop();
      else {
        bump();
        start();
      }
    };
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [ms]);
}

function subscribeVisibility(cb: () => void): () => void {
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
}

export function usePageHidden(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === 'hidden',
    () => false,
  );
}
