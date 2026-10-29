/**
 * Error boundaries. SHARED (src/ui).
 *
 * React unmounts the whole tree when a render / commit throws and nothing catches it, which
 * blanks the page. App wraps every independent region (map, panel, search, chrome, each modal)
 * in its own boundary so one failure never takes the map and the rest of the chrome with it;
 * main.tsx adds a last-resort root boundary with a recoverable "Reload" screen.
 *
 *  - `fallback`: what to show instead (default: nothing). A function gets `reset` (re-mounts).
 *  - `resetKey`: when it changes, a failed boundary re-mounts its children (e.g. another place).
 *  - Errors are logged with the region name; `onError` lets a region clean up (close a modal…).
 *  - `autoRetry`: re-mount on its own after a moment (chrome regions such as toasts or the search
 *    bar come back instead of staying blank); gives up after 3 failures in a minute.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useStore } from '../store';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Icon } from './Icons';

export interface ErrorBoundaryProps {
  /** Region name for the console. */
  name: string;
  children?: ReactNode;
  fallback?: ReactNode | ((p: { error: Error; reset: () => void }) => ReactNode);
  resetKey?: unknown;
  onError?: (error: Error) => void;
  /** Re-mount automatically after 1s (max 3 times a minute). */
  autoRetry?: boolean;
}

interface ErrorBoundaryState {
  error: Error | null;
  resetKey: unknown;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    return { resetKey: props.resetKey, error: null };
  }

  private failures: number[] = [];
  private retryTimer = 0;

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[atlaspad] ${this.props.name} failed`, error, info.componentStack);
    try {
      this.props.onError?.(error);
    } catch {
      /* the clean-up must never throw out of the boundary */
    }
    if (!this.props.autoRetry) return;
    const t = Date.now();
    this.failures = [...this.failures.filter((x) => t - x < 60_000), t];
    if (this.failures.length > 3) return;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(this.reset, 1000);
  }

  override componentWillUnmount(): void {
    window.clearTimeout(this.retryTimer);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children ?? null;
    const { fallback } = this.props;
    if (typeof fallback === 'function') return fallback({ error, reset: this.reset });
    return fallback ?? null;
  }
}

/** Panel content fallback: keeps the panel (and its Close / handle) usable. */
export function PanelCrash({ reset }: { reset: () => void }) {
  const closePanel = useStore((s) => s.closePanel);
  return (
    <div className="pp-error" data-sheet-drag>
      <EmptyState icon="error" title="Something went wrong" body="This panel hit a problem. The map still works.">
        <Button variant="outline" icon="refresh" onClick={reset}>
          Try again
        </Button>
        <Button variant="text" onClick={closePanel}>
          Close
        </Button>
      </EmptyState>
    </div>
  );
}

/**
 * Boundary for one modal flow: a crash closes the modal (so the scrim never traps the page) and
 * says so in a toast; the next modal mounts fresh.
 */
export function ModalBoundary({ name, children }: { name: string; children: ReactNode }) {
  const modal = useStore((s) => s.modal);
  return (
    <ErrorBoundary
      name={name}
      resetKey={modal}
      onError={() => {
        const st = useStore.getState();
        st.closeModal();
        st.toast('Something went wrong. Please try again.', 'error');
      }}
    >
      {children}
    </ErrorBoundary>
  );
}

/** Last-resort screen (root boundary): the app can't render at all. */
export function AppCrash() {
  return (
    <div className="app-crash" role="alert">
      <EmptyState icon="error" title="Something went wrong" body="AtlasPad hit a problem it couldn't recover from. Reloading usually fixes it.">
        <Button variant="primary" icon="refresh" onClick={() => location.reload()}>
          Reload
        </Button>
      </EmptyState>
    </div>
  );
}

/**
 * Map region fallback: the rest of the chrome keeps working. Same card as MapView's own
 * "couldn't load" state (src/map/map.css), inside the usual #mapwrap box.
 */
export function MapCrash({ reset }: { reset: () => void }) {
  return (
    <div id="mapwrap">
      <div className="map-fail" role="alert">
        <div className="map-fail-card">
          <Icon name="error" className="map-fail-ic" />
          <p className="map-fail-t">The map hit a problem</p>
          <p className="map-fail-s">Search, the coin lists and your wallet still work.</p>
          <Button variant="text" icon="refresh" onClick={reset}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
