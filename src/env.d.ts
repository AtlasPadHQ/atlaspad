/// <reference types="vite/client" />
/**
 * Ambient declarations. SHARED file (scaffold / integrator only).
 */
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

declare global {
  interface ImportMetaEnv {
    /** Google Maps browser key (referrer-restricted). Empty → demo map provider. */
    readonly VITE_GOOGLE_MAPS_KEY?: string;
    /** Real-mode cluster (INTEGRATION.md §1.3). Empty/unset → demo-only build. Read through src/mode.ts. */
    readonly VITE_CLUSTER?: 'devnet' | 'mainnet' | '';
    /** '1' only in devnet builds: includes the devnet test wallet (H6). build:mainnet forces it empty. */
    readonly VITE_TEST_WALLET?: '1' | '';
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    /** Called by the Maps JS API when the key is rejected (see src/lib/google.ts). */
    gm_authFailure?: () => void;
  }
}

/**
 * JSX typing for Google's Places UI Kit custom elements (DESIGN §9).
 * React 18 passes props on custom elements through as literal attributes (string values), so
 * `className` would become a `classname="…"` attribute and never style the element. Use `class`
 * (typed below) for the CSS class. Boolean attributes are written as `lightbox-preferred=""` /
 * `truncation-preferred=""`. `gmp-load` / `gmp-error` do not bubble: attach them with
 * ref.current.addEventListener.
 */
type GmpElementProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  /** CSS class on a custom element (React 18 does not map `className` for custom elements). */
  class?: string;
  place?: string;
  orientation?: 'horizontal' | 'vertical';
  'truncation-preferred'?: string;
  'lightbox-preferred'?: string;
  'light-scheme-color'?: string;
  'dark-scheme-color'?: string;
};

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'gmp-place-details': GmpElementProps;
      'gmp-place-details-compact': GmpElementProps;
      'gmp-place-details-place-request': GmpElementProps;
      'gmp-place-content-config': GmpElementProps;
      'gmp-place-media': GmpElementProps;
      'gmp-place-rating': GmpElementProps;
      'gmp-place-type': GmpElementProps;
      'gmp-place-price': GmpElementProps;
      'gmp-place-accessible-entrance-icon': GmpElementProps;
      'gmp-place-open-now-status': GmpElementProps;
      'gmp-place-address': GmpElementProps;
      'gmp-place-opening-hours': GmpElementProps;
      'gmp-place-website': GmpElementProps;
      'gmp-place-phone-number': GmpElementProps;
      'gmp-place-attribution': GmpElementProps;
    }
  }
}

export {};
