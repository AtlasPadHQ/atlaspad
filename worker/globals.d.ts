/**
 * Compile-time constants injected by wrangler `define` (wrangler.jsonc, per environment; INTEGRATION.md §1.3).
 *
 *  __CS_CLUSTER__        "demo" (top level, the Phase-1 Worker) | "devnet" | "mainnet"
 *  __CS_DEV_ENDPOINTS__  true only in env.devnet. Every devnet-only code path (/api/dev/*, the on-screen phone
 *                        verifier, dev origins, synthetic test places) is guarded INLINE with
 *                        `if (__CS_DEV_ENDPOINTS__) { … await import('./dev/…') }` so esbuild drops it from the
 *                        mainnet bundle (scripts/check-bundle.mjs greps the dry-run bundle to prove it).
 *
 * Unit tests (vitest, no define) set `globalThis.__CS_CLUSTER__` / `globalThis.__CS_DEV_ENDPOINTS__` themselves.
 */
declare const __CS_CLUSTER__: 'demo' | 'devnet' | 'mainnet';
declare const __CS_DEV_ENDPOINTS__: boolean;
