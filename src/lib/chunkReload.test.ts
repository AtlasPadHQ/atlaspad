// A stale tab whose lazy chunk is gone after a deploy reloads ONCE; the sessionStorage flag can never let it loop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_RELOAD_KEY, CHUNK_RELOAD_SETTLE_MS, installChunkReload } from './chunkReload';

class MemStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

/** One page load: a fresh event target sharing the tab's sessionStorage. */
function boot(session: MemStorage | (() => never), offline = false) {
  const target = new EventTarget();
  const reload = vi.fn();
  installChunkReload({ target, storage: typeof session === 'function' ? session : () => session, reload, offline: () => offline });
  const fail = () => {
    const e = new Event('vite:preloadError', { cancelable: true });
    target.dispatchEvent(e);
    return e.defaultPrevented;
  };
  return { reload, fail };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('installChunkReload', () => {
  it('reloads once for a missing chunk, then lets a second failure in a row surface instead of looping', () => {
    const session = new MemStorage();
    const stale = boot(session);
    expect(stale.fail()).toBe(true); // handled: Vite does not rethrow
    expect(stale.reload).toHaveBeenCalledTimes(1);
    expect(session.getItem(CHUNK_RELOAD_KEY)).toBe('1');

    // the reloaded page fails again (a genuinely broken deploy): no reload, the error propagates
    const again = boot(session);
    expect(again.fail()).toBe(false);
    expect(again.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CHUNK_RELOAD_SETTLE_MS);
    expect(session.getItem(CHUNK_RELOAD_KEY)).toBe('1'); // a failed boot never clears the flag
  });

  it('clears the flag after a clean boot, so a later deploy can reload this tab again', () => {
    const session = new MemStorage();
    boot(session).fail();
    const fresh = boot(session);
    vi.advanceTimersByTime(CHUNK_RELOAD_SETTLE_MS - 1);
    expect(session.getItem(CHUNK_RELOAD_KEY)).toBe('1'); // still settling: a failure now must not reload
    expect(fresh.fail()).toBe(false);

    const clean = boot(session);
    vi.advanceTimersByTime(CHUNK_RELOAD_SETTLE_MS);
    expect(session.getItem(CHUNK_RELOAD_KEY)).toBeNull();
    expect(clean.fail()).toBe(true);
    expect(clean.reload).toHaveBeenCalledTimes(1);
  });

  it('offline, a failed import is a network blip: no reload, no flag, the caller retries', () => {
    const session = new MemStorage();
    const off = boot(session, true);
    expect(off.fail()).toBe(false);
    expect(off.reload).not.toHaveBeenCalled();
    expect(session.getItem(CHUNK_RELOAD_KEY)).toBeNull();
  });

  it('never reloads without sessionStorage (nothing could stop a loop)', () => {
    const blocked = boot(() => {
      throw new Error('SecurityError');
    });
    expect(blocked.fail()).toBe(false);
    expect(blocked.reload).not.toHaveBeenCalled();
    expect(() => vi.advanceTimersByTime(CHUNK_RELOAD_SETTLE_MS)).not.toThrow();
  });
});
