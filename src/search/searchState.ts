/**
 * Search module UI state (OWNED BY SEARCH): the search box text and where the current results
 * list came from (Enter, a category chip, a search link) so the results panel can title itself,
 * retry, and the chip / clear button can close the list they opened. Not persisted.
 */
import { create } from 'zustand';
import type { ChipFilter, LatLng, SearchBias } from '../types';

/** Chips that run a nearby place search (everything but the coin-only 'live' / 'fees' filters). */
export type PlaceChip = Exclude<ChipFilter, 'live' | 'fees'>;

export type ResultsOrigin =
  | { kind: 'text'; query: string; near?: SearchBias }
  | { kind: 'link'; query: string; near?: SearchBias }
  | { kind: 'chip'; filter: PlaceChip; label: string; center: LatLng; radiusM: number };

interface SearchUiState {
  /** Text in the search box (SearchBar is the only writer besides clear/close actions). */
  text: string;
  origin: ResultsOrigin | null;
  setText(text: string): void;
  setOrigin(origin: ResultsOrigin | null): void;
}

export const useSearchUi = create<SearchUiState>()((set) => ({
  text: '',
  origin: null,
  setText: (text) => set({ text }),
  setOrigin: (origin) => set({ origin }),
}));
