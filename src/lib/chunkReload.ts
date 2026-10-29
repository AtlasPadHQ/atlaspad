/**
 * A tab opened before a deploy asks for lazy chunks that no longer exist (the Worker answers with index.html), so a
 * dynamic import fails and Vite fires `vite:preloadError`. Reload ONCE to pick up the new index.html. A sessionStorage
 * flag makes a second failure surface as the normal error instead of a reload loop; it is cleared only after a boot
 * that ran CHUNK_RELOAD_SETTLE_MS without a chunk failure, so a later deploy can reload this tab again.
 * No sessionStorage (private mode, blocked): never reload, since nothing could stop a loop. SHARED (src/lib).
 */

export const CHUNK_RELOAD_KEY = 'cs_chunk_reload';
export const CHUNK_RELOAD_SETTLE_MS = 10_000;

type FlagStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface ChunkReloadEnv {
  target: EventTarget;
  /** May throw (storage blocked). */
  storage: () => FlagStore;
  reload: () => void;
  /** True while the browser is offline (navigator.onLine false). */
  offline?: () => boolean;
}

const browserEnv = (): ChunkReloadEnv => ({
  target: window,
  storage: () => window.sessionStorage,
  reload: () => window.location.reload(),
  offline: () => typeof navigator !== 'undefined' && navigator.onLine === false,
});

export function installChunkReload(env: ChunkReloadEnv = browserEnv()): void {
  let failed = false;
  env.target.addEventListener('vite:preloadError', (e) => {
    failed = true;
    if (env.offline?.()) return; // a network blip, not a deploy: the caller's retry handles it, a reload would lose state
    try {
      const s = env.storage();
      if (s.getItem(CHUNK_RELOAD_KEY)) return; // reloaded for this already: let the error show
      s.setItem(CHUNK_RELOAD_KEY, '1');
    } catch {
      return;
    }
    e.preventDefault();
    env.reload();
  });
  setTimeout(() => {
    if (failed) return;
    try {
      env.storage().removeItem(CHUNK_RELOAD_KEY);
    } catch {
      /* nothing to clear */
    }
  }, CHUNK_RELOAD_SETTLE_MS);
}
