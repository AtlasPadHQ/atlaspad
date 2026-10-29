/**
 * Demo-data bridge (INTEGRATION.md §5.1): the fictional demo shops, seeded coins and the market
 * simulator (`src/data/**`) are only ever loaded by a dynamic `import()`, so real mode never ships
 * them in its initial chunk. Modules that need a demo place synchronously (search, places, My coins,
 * the claim modal) read it through this bridge; before the demo module has loaded — and always in
 * real mode — the getters return nothing, which is exactly "there are no demo shops here".
 * SHARED (src/lib). Browser + node (tests call loadDemoData() first).
 */
import type { Coin, Place } from '../types';

type DemoModule = typeof import('../data/mockCoins');

let mod: DemoModule | null = null;
let loading: Promise<DemoModule> | null = null;

/** Load (once) the demo data module. Demo mode awaits this before seeding and starting the router. */
export function loadDemoData(): Promise<DemoModule> {
  loading ??= import('../data/mockCoins').then((m) => {
    mod = m;
    return m;
  });
  return loading;
}

/** True once loadDemoData() resolved. */
export function demoDataLoaded(): boolean {
  return mod !== null;
}

/** A fictional demo shop by id (`demo-…`), or null (not loaded / unknown / real mode). */
export function getDemoPlace(id: string, coins?: Record<string, Coin>): Place | null {
  return mod ? mod.getDemoPlace(id, coins) : null;
}

/** Every fictional demo shop (empty until the demo module loaded). */
export function createDemoPlaces(): Place[] {
  return mod ? mod.createDemoPlaces() : [];
}
