/**
 * Media-query hooks and helpers (breakpoints per DESIGN §4). SHARED (src/lib).
 *  - mobile:  max-width 767px
 *  - tablet:  768–1023px (desktop structure + compact overrides)
 *  - desktop: min-width 1024px
 */
import { useSyncExternalStore } from 'react';
import { BP } from '../config';

export const MQ = {
  mobile: `(max-width: ${BP.mobileMax}px)`,
  tablet: `(min-width: ${BP.mobileMax + 1}px) and (max-width: ${BP.desktopMin - 1}px)`,
  desktop: `(min-width: ${BP.desktopMin}px)`,
  reducedMotion: '(prefers-reduced-motion: reduce)',
  coarse: '(pointer: coarse)',
} as const;

export function matches(query: string): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** Subscribe to a media query (SSR-safe, tear-free). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined') return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => matches(query),
    () => false,
  );
}

/** True below 768px. */
export function useIsMobile(): boolean {
  return useMediaQuery(MQ.mobile);
}

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

export function useBreakpoint(): Breakpoint {
  const mobile = useMediaQuery(MQ.mobile);
  const desktop = useMediaQuery(MQ.desktop);
  return mobile ? 'mobile' : desktop ? 'desktop' : 'tablet';
}

export function isMobileNow(): boolean {
  return matches(MQ.mobile);
}

/** Respect `prefers-reduced-motion` (DESIGN §14): no pans, no flashes, static spinners. */
export function prefersReducedMotion(): boolean {
  return matches(MQ.reducedMotion);
}

export function useReducedMotion(): boolean {
  return useMediaQuery(MQ.reducedMotion);
}
