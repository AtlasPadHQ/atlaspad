/**
 * Lazy entry to the heavy chain layer (INTEGRATION.md §4.1). LIGHT module: it may be imported statically anywhere.
 *
 *   loadChain()    memoised `import('./index')` (web3.js + shop-vault client + the chain code; ≈ the "chain core" chunk)
 *   prefetchChain() warms that chunk on idle (wallet connected, launch/trade UI opened)
 *   prefetchPump()  also warms the pump SDK chunk (its own chunk; launch Details → Continue, trade box focus)
 *
 * `typeof import('./index')` below is type-only: it does not pull the heavy code into the importing chunk.
 */
export type ChainModule = typeof import('./index');

let pending: Promise<ChainModule> | null = null;

/** Load the heavy chain module once. A failed load (offline, deploy race) can be retried. */
export function loadChain(): Promise<ChainModule> {
  pending ??= import('./index').catch((e: unknown) => {
    pending = null;
    throw e;
  });
  return pending;
}

type IdleWindow = { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };

function whenIdle(run: () => void): void {
  const w = (typeof window !== 'undefined' ? window : undefined) as IdleWindow | undefined;
  if (w?.requestIdleCallback) w.requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 200);
}

/** Warm the chain core chunk while the browser is idle. Never throws. */
export function prefetchChain(): void {
  whenIdle(() => {
    void loadChain().catch(() => {});
  });
}

/** Warm the chain core AND the pump SDK chunk (plus pump Global/FeeConfig) while idle. Never throws. */
export function prefetchPump(): void {
  whenIdle(() => {
    void loadChain()
      .then((m) => m.preloadPump())
      .catch(() => {});
  });
}
