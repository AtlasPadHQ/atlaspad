/**
 * Mount/unmount with exit animations: keeps a component rendered for `exitMs` after `open`
 * turns false, exposing a `state` for CSS (`data-state="open|closing"`). SHARED (src/ui).
 */
import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../lib/media';

export type PresenceState = 'open' | 'closing' | 'closed';

export function usePresence(open: boolean, exitMs: number): { mounted: boolean; state: PresenceState } {
  const [state, setState] = useState<PresenceState>(open ? 'open' : 'closed');
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (open) {
      setState('open');
      return;
    }
    if (stateRef.current === 'closed') return;
    if (prefersReducedMotion() || exitMs <= 0) {
      setState('closed');
      return;
    }
    setState('closing');
    const t = setTimeout(() => setState('closed'), exitMs);
    return () => clearTimeout(t);
  }, [open, exitMs]);

  const effective: PresenceState = open ? 'open' : state;
  return { mounted: effective !== 'closed', state: effective };
}

/** Keep the last non-null value while a component animates out. */
export function useLatest<T>(value: T | null | undefined): T | null {
  const ref = useRef<T | null>(value ?? null);
  if (value != null) ref.current = value;
  return ref.current;
}
