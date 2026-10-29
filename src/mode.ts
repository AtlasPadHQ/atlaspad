/**
 * Build + runtime mode. CONTRACT FILE (INTEGRATION.md §1.3): APP owns it; CHAIN and every other module may import it.
 * Changes only through the integrator. Pure module: no imports, safe in the initial bundle.
 *
 *   Build-time  VITE_CLUSTER = 'devnet' | 'mainnet' | '' (empty = demo-only build, the Phase-1 `cornershop` Worker)
 *               VITE_TEST_WALLET = '1' only in devnet builds (build:devnet). Never set it for mainnet.
 *   Runtime     ?mode=demo   forces the Phase-1 demo (remembered for the tab in sessionStorage `cs_mode`)
 *               ?mode=real   clears that flag again
 *
 * Tree-shaking rule: code that must vanish from mainnet builds is guarded INLINE at the call site with the raw
 * `import.meta.env.VITE_TEST_WALLET === '1' && import.meta.env.VITE_CLUSTER === 'devnet'` comparison (Vite replaces
 * both per module, so the dead branch and its dynamic import are dropped). Do not rely on TEST_WALLET_BUILD for
 * that: cross-module constant folding is not guaranteed. `scripts/check-bundle.mjs` verifies the result.
 */

export type Cluster = 'devnet' | 'mainnet';
export type AppMode = 'demo' | 'real';

const RAW_CLUSTER: string = String(import.meta.env.VITE_CLUSTER ?? '');

/** The cluster this bundle was built for; null for a demo-only build. */
export const BUILD_CLUSTER: Cluster | null =
  RAW_CLUSTER === 'devnet' || RAW_CLUSTER === 'mainnet' ? RAW_CLUSTER : null;

/** Informational only (see the tree-shaking rule above). */
export const TEST_WALLET_BUILD: boolean =
  String(import.meta.env.VITE_TEST_WALLET ?? '') === '1' && RAW_CLUSTER === 'devnet';

const MODE_KEY = 'cs_mode';

function demoForced(): boolean {
  try {
    const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '').get('mode');
    if (q === 'demo') {
      sessionStorage.setItem(MODE_KEY, 'demo');
      return true;
    }
    if (q === 'real') {
      sessionStorage.removeItem(MODE_KEY);
      return false;
    }
    return sessionStorage.getItem(MODE_KEY) === 'demo';
  } catch {
    return false;
  }
}

/** 'real' = chain + D1 registry, no simulator, no demo coins. 'demo' = the Phase-1 prototype, unchanged. */
export const APP_MODE: AppMode = BUILD_CLUSTER !== null && !demoForced() ? 'real' : 'demo';
export const IS_REAL: boolean = APP_MODE === 'real';
/** The cluster the app talks to; null in demo mode (demo mode never touches the chain). */
export const CLUSTER: Cluster | null = IS_REAL ? BUILD_CLUSTER : null;

/** Throws unless the app is in real mode. Call before ANY signing or chain write (CHAIN, wallet signing). */
export function assertRealMode(what: string): void {
  if (!IS_REAL) throw new Error(`${what} is not available in demo mode`);
}
