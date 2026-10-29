/**
 * Search dropdown model (DESIGN §6.2 "Dropdown order"). OWNED BY SEARCH. Pure — unit tested.
 *
 *  1. Link row only, when the input is a Google Maps link.
 *  2. `Coins` + up to 3 coin rows (ticker / coin name — our data only).
 *  3. `Places` + the category row ("<b>Kebab</b> shops near …") + up to 5 place rows
 *     (2 skeleton rows while loading).
 *  Empty input: `Recent` (last 5 opened coins/places) + the link tip (tip first when requested).
 *  States: no results row · "Search is unavailable" row (offline / Places error; coins still work).
 *  Mobile + Google results: a `Google Maps` credit row. Max 8 actionable rows in total.
 */
import type { Bounds, Coin, MapProvider, Place, PlaceSuggestion } from '../types';
import { matchCoins } from './actions';
import type { PlaceChip } from './searchState';

export type Row =
  | { kind: 'link'; key: string }
  | { kind: 'coin'; key: string; coin: Coin }
  /** `count` = how many shops the row's list holds (null until known: no count is shown). */
  | { kind: 'query'; key: string; filter: PlaceChip; count: number | null }
  | { kind: 'place'; key: string; s: PlaceSuggestion; coin?: Coin; place?: Place };

export type Block =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'row'; row: Row }
  | { kind: 'skeleton'; key: string }
  | { kind: 'tip'; key: string }
  | { kind: 'empty'; key: string; q: string }
  | { kind: 'offline'; key: string }
  | { kind: 'credit'; key: string };

export interface PlacesState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Query the items belong to (or are loading for). */
  q: string;
  items: PlaceSuggestion[];
}

export interface DropdownInput {
  open: boolean;
  /** Trimmed input text. */
  q: string;
  isLink: boolean;
  tipFirst: boolean;
  recent: readonly string[];
  coins: Record<string, Coin>;
  places: PlacesState;
  queryFilter: PlaceChip | null;
  /**
   * Shops in the list the category row opens (search/actions categoryResultCount — the same
   * coins + places), or null while unknown. Never a different number from what the row opens.
   */
  queryCount?: number | null;
  online: boolean;
  mobile: boolean;
  provider: MapProvider;
  viewportBounds: Bounds | null | undefined;
  /** Session-known place for a recent id (never persisted Google data). */
  recentPlace: (id: string) => Place | undefined;
  /** A recent id whose name is being fetched (search/SearchBar → places getRecentPlace): a skeleton row. */
  recentPending?: (id: string) => boolean;
}

export const MAX_ROWS = 8;
const MAX_COINS = 3;
const MAX_PLACES = 5;
const MAX_RECENT = 5;

export function buildDropdown(i: DropdownInput): { blocks: Block[]; rows: Row[] } {
  const blocks: Block[] = [];
  const rows: Row[] = [];
  const push = (row: Row) => {
    rows.push(row);
    blocks.push({ kind: 'row', row });
  };
  if (!i.open) return { blocks, rows };

  if (i.isLink) {
    push({ kind: 'link', key: 'link' });
    return { blocks, rows };
  }

  if (!i.q) {
    if (i.tipFirst) blocks.push({ kind: 'tip', key: 'tip' });
    const recentRows: (Row | { kind: 'pending'; key: string })[] = [];
    for (const id of i.recent) {
      if (recentRows.length >= MAX_RECENT) break;
      const coin = i.coins[id];
      if (coin) {
        recentRows.push({ kind: 'coin', key: `r-${id}`, coin });
        continue;
      }
      const place = i.recentPlace(id);
      if (place?.name) {
        recentRows.push({
          kind: 'place',
          key: `r-${id}`,
          place,
          s: { kind: 'place', id, source: place.source, main: place.name, secondary: place.address ?? place.city, location: place.location },
        });
      } else if (i.recentPending?.(id)) {
        recentRows.push({ kind: 'pending', key: `r-${id}` });
      }
    }
    if (recentRows.length) {
      blocks.push({ kind: 'header', key: 'h-recent', label: 'Recent' });
      for (const r of recentRows) {
        if (r.kind === 'pending') blocks.push({ kind: 'skeleton', key: `sk-${r.key}` });
        else push(r);
      }
    }
    if (!i.tipFirst) blocks.push({ kind: 'tip', key: 'tip' });
    return { blocks, rows };
  }

  const coinList = Object.values(i.coins);
  const coinRows = matchCoins(coinList, i.q, MAX_COINS);
  if (coinRows.length) {
    blocks.push({ kind: 'header', key: 'h-coins', label: 'Coins' });
    coinRows.forEach((coin) => push({ kind: 'coin', key: `c-${coin.placeId}`, coin }));
  }

  const budget = Math.max(0, Math.min(MAX_PLACES, MAX_ROWS - coinRows.length - (i.queryFilter ? 1 : 0)));
  const items = i.places.q === i.q || i.places.status === 'loading' ? i.places.items : [];
  const shown = items.filter((s) => !coinRows.some((c) => c.placeId === s.id)).slice(0, budget);
  const loading = i.places.status === 'loading' && shown.length === 0 && i.q.length >= 2;
  const failed = !i.online || (i.places.status === 'error' && i.places.q === i.q);

  if (i.queryFilter || shown.length || loading) {
    blocks.push({ kind: 'header', key: 'h-places', label: 'Places' });
    if (i.queryFilter) {
      push({ kind: 'query', key: `q-${i.queryFilter}`, filter: i.queryFilter, count: i.queryCount ?? null });
    }
    shown.forEach((s) => push({ kind: 'place', key: `p-${s.id}`, s, coin: i.coins[s.id] }));
    if (loading) {
      blocks.push({ kind: 'skeleton', key: 'sk1' });
      blocks.push({ kind: 'skeleton', key: 'sk2' });
    }
  }

  if (failed && i.q.length >= 2) blocks.push({ kind: 'offline', key: 'offline' });
  else if (rows.length === 0 && i.q.length >= 2 && i.places.status === 'ready' && i.places.q === i.q) {
    blocks.push({ kind: 'empty', key: 'empty', q: i.q });
  }
  if (rows.length === 0 && i.q.length < 2) blocks.push({ kind: 'tip', key: 'tip' });

  if (i.mobile && i.provider === 'google' && shown.some((s) => s.source === 'google')) {
    blocks.push({ kind: 'credit', key: 'credit' });
  }
  return { blocks, rows };
}
