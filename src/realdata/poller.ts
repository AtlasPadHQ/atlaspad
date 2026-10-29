/**
 * A tiny polling loop (INTEGRATION.md §5.2): runs `run`, then waits `every()` ms (null = only on
 * demand). Paused while the tab is hidden or the browser is offline; `kick()` runs it now (resume,
 * own tx, panel opened). Never runs twice at once: a kick during a run queues one more run.
 */
export function pageActive(): boolean {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  return true;
}

export class Poller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private queued = false;
  private stopped = false;
  /** ms of the last successful run (0 = never). */
  lastOk = 0;
  /** Consecutive failures (drives a gentle back-off). */
  failures = 0;

  constructor(
    private readonly run: () => Promise<void>,
    private readonly every: () => number | null,
    private readonly opts: { backoff?: boolean } = {},
  ) {}

  /** Run as soon as possible (after `delayMs`). */
  kick(delayMs = 0): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  /**
   * Resume after the tab became visible / came back online: run now unless a run is in flight or just finished (the
   * boot run and a `visibilitychange` right after load must not fetch the same thing twice).
   */
  resume(freshMs = 2_000): void {
    if (this.stopped || this.running) return;
    if (this.lastOk > 0 && Date.now() - this.lastOk < freshMs) return;
    this.kick(0);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    // The first load always runs (a tab opened in the background still boots with data); after
    // that, polling pauses while hidden / offline and resumes from the visibility / online listener.
    if (this.lastOk > 0 && !pageActive()) return;
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    try {
      await this.run();
      this.lastOk = Date.now();
      this.failures = 0;
    } catch {
      this.failures++;
    } finally {
      this.running = false;
    }
    if (this.stopped) return;
    if (this.queued) {
      this.queued = false;
      this.kick(0);
      return;
    }
    const base = this.every();
    if (base == null) return;
    const backoff = this.opts.backoff && this.failures > 0 ? Math.min(60_000, base * 2 ** Math.min(4, this.failures - 1)) : base;
    this.kick(Math.max(base, backoff));
  }
}
