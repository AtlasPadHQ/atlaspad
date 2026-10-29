/**
 * In-memory launch drafts per place (never persisted): reopening the launch modal restores what the
 * launcher typed, and the launchable panel header shows the draft ticker as `.ticker.ghost`
 * (DESIGN §8.4). Cleared after a successful launch.
 */
import { useSyncExternalStore } from 'react';
import type { CategoryKey } from '../types';

export interface LaunchDraftState {
  name: string;
  ticker: string;
  tickerEdited: boolean;
  nameEdited: boolean;
  description: string;
  category: CategoryKey;
  emoji: string;
  bg: string;
  upload: string | null;
  devBuy: string;
}

const drafts = new Map<string, LaunchDraftState>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of [...listeners]) l();
}

export function getDraft(placeId: string): LaunchDraftState | undefined {
  return drafts.get(placeId);
}

export function saveDraft(placeId: string, d: LaunchDraftState): void {
  drafts.set(placeId, d);
  emit();
}

export function clearDraft(placeId: string): void {
  if (drafts.delete(placeId)) emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The ticker the user typed for this place (only once they edited the form). */
export function useDraftTicker(placeId: string | null | undefined): string | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      const d = placeId ? drafts.get(placeId) : undefined;
      return d && (d.tickerEdited || d.nameEdited) && d.ticker ? d.ticker : null;
    },
    () => null,
  );
}
