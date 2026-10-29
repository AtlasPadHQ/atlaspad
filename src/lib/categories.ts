/**
 * Categories: keys, labels, chip labels/icons, stickers, and mapping from Google Places (New)
 * types and OSM tags. SHARED (src/lib). Pure.
 */
import type { CategoryKey, ChipFilter } from '../types';

export interface CategoryDef {
  key: CategoryKey;
  /** Coin category label (launch modal `<select>` option, panel meta "<label> coin"). */
  label: string;
  /** Default sticker (first of `stickers`). */
  emoji: string;
  /** The 6 stickers offered in the launch modal (DESIGN §12.2). */
  stickers: readonly string[];
  /** Material Symbols icon used for the chip (if any). */
  icon: string;
}

export const CATEGORIES: readonly CategoryDef[] = [
  { key: 'cafe', label: 'Café', emoji: '☕', stickers: ['☕', '🥐', '🍰', '🧋', '🫖', '🍪'], icon: 'local_cafe' },
  { key: 'barber', label: 'Barber shop', emoji: '💈', stickers: ['💈', '✂️', '🪒', '💇', '🧔', '💅'], icon: 'content_cut' },
  { key: 'kebab', label: 'Kebab shop', emoji: '🥙', stickers: ['🥙', '🌯', '🍢', '🔥', '🧆', '🥗'], icon: 'kebab_dining' },
  { key: 'pizza', label: 'Pizza', emoji: '🍕', stickers: ['🍕', '🧀', '🍅', '🌶️', '🫓', '🍷'], icon: 'local_pizza' },
  { key: 'bakery', label: 'Bakery', emoji: '🥐', stickers: ['🥐', '🍞', '🧁', '🥖', '☕', '🍩'], icon: 'bakery_dining' },
  { key: 'pub', label: 'Pub', emoji: '🍺', stickers: ['🍺', '🍻', '🍷', '🎯', '🥃', '🍟'], icon: 'sports_bar' },
  { key: 'corner', label: 'Corner shop', emoji: '🏪', stickers: ['🏪', '🥤', '🍫', '🧃', '🗞️', '🍬'], icon: 'storefront' },
  // Not in DESIGN's sticker table: restaurant gets food stickers, "Other" uses DESIGN's list.
  { key: 'restaurant', label: 'Restaurant', emoji: '🍽️', stickers: ['🍽️', '🍜', '🍛', '🍝', '🥘', '🍔'], icon: 'storefront' },
  { key: 'other', label: 'Other', emoji: '🏪', stickers: ['🏪', '⭐', '💚', '🛍️', '🔑', '🎉'], icon: 'storefront' },
];

const BY_KEY: Record<CategoryKey, CategoryDef> = Object.fromEntries(CATEGORIES.map((c) => [c.key, c])) as Record<
  CategoryKey,
  CategoryDef
>;

export function categoryDef(key: CategoryKey): CategoryDef {
  return BY_KEY[key] ?? BY_KEY.other;
}

export function categoryLabel(key: CategoryKey): string {
  return categoryDef(key).label;
}

export function categoryEmoji(key: CategoryKey): string {
  return categoryDef(key).emoji;
}

export function isCategoryKey(v: unknown): v is CategoryKey {
  return typeof v === 'string' && v in BY_KEY;
}

/** Launch modal `<select>` options in DESIGN order. */
export const CATEGORY_OPTIONS: readonly { key: CategoryKey; label: string }[] = CATEGORIES.map((c) => ({
  key: c.key,
  label: c.label,
}));

/** Coin colour swatches (DESIGN §12.2), the coin's `--bg`. */
export const COIN_SWATCHES = ['#ffe4cc', '#efe3d6', '#e3e8ff', '#ffe0db', '#fff1c7', '#dff3e6'] as const;

/* --------------------------------------------------------------- chips */

export interface ChipDef {
  filter: ChipFilter;
  label: string;
  /** Material Symbols icon, or undefined when `emoji` is used. */
  icon?: string;
  emoji?: string;
}

/** Chips row, in order (DESIGN §6.3). */
export const CHIPS: readonly ChipDef[] = [
  { filter: 'live', label: 'Live coins', emoji: '🔥' },
  { filter: 'cafe', label: 'Cafés', icon: 'local_cafe' },
  { filter: 'barber', label: 'Barbers', icon: 'content_cut' },
  { filter: 'kebab', label: 'Kebab', icon: 'kebab_dining' },
  { filter: 'pizza', label: 'Pizza', icon: 'local_pizza' },
  { filter: 'bakery', label: 'Bakeries', icon: 'bakery_dining' },
  { filter: 'pub', label: 'Pubs', icon: 'sports_bar' },
  { filter: 'corner', label: 'Corner shops', icon: 'storefront' },
  { filter: 'fees', label: 'Fees waiting', emoji: '💰' },
];

/** Words that make a search query "look like a category" (for the `<b>Kebab</b> shops near …` row). */
export const CATEGORY_QUERY_WORDS: Record<Exclude<ChipFilter, 'live' | 'fees'>, readonly string[]> = {
  cafe: ['cafe', 'café', 'cafes', 'cafés', 'coffee', 'coffee shop', 'tea'],
  barber: ['barber', 'barbers', 'barber shop', 'hairdresser', 'haircut', 'salon'],
  kebab: ['kebab', 'kebabs', 'doner', 'döner', 'shawarma', 'gyros'],
  pizza: ['pizza', 'pizzas', 'pizzeria'],
  bakery: ['bakery', 'bakeries', 'bakers', 'bread', 'patisserie'],
  pub: ['pub', 'pubs', 'bar', 'bars', 'beer'],
  corner: ['corner shop', 'corner shops', 'off licence', 'off-licence', 'newsagent', 'convenience', 'offy'],
};

/** Trailing words that keep a query a category query: "kebab", "kebab shops", "kebab near me", "pizza in Hackney". */
const CATEGORY_QUERY_TAIL = /^(?:| shop| shops| places| nearby| near| near .+| in .+| around .+)$/;

/**
 * Map a free-text query to a chip category when the query *is* a category ("kebab", "coffee
 * shops", "pizza near me", "pub in Hackney") — not when a category word only starts a venue name
 * ("Pizza Pilgrims Shoreditch"). While typing, a prefix of a category word also counts ("keb"),
 * unless `exact` is set (then only a complete category phrase matches).
 */
export function chipFromQuery(query: string, opts: { exact?: boolean } = {}): Exclude<ChipFilter, 'live' | 'fees'> | null {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (q.length < 3) return null;
  const entries = Object.entries(CATEGORY_QUERY_WORDS) as [Exclude<ChipFilter, 'live' | 'fees'>, readonly string[]][];
  // 1) a whole category phrase, optionally followed by "shops" / "near …" / "in …"
  for (const [key, words] of entries) {
    if (words.some((w) => q.startsWith(w) && CATEGORY_QUERY_TAIL.test(q.slice(w.length)))) return key;
  }
  if (opts.exact) return null;
  // 2) prefix while typing ("keb" → kebab)
  for (const [key, words] of entries) {
    if (words.some((w) => w.startsWith(q))) return key;
  }
  return null;
}

/* --------------------------------------------------------------- Google mapping */

const GOOGLE_TYPE_MAP: Record<string, CategoryKey> = {
  cafe: 'cafe',
  coffee_shop: 'cafe',
  tea_house: 'cafe',
  cat_cafe: 'cafe',
  internet_cafe: 'cafe',
  barber_shop: 'barber',
  hair_salon: 'barber',
  hair_care: 'barber',
  beauty_salon: 'barber',
  nail_salon: 'barber',
  kebab_shop: 'kebab',
  turkish_restaurant: 'kebab',
  middle_eastern_restaurant: 'kebab',
  lebanese_restaurant: 'kebab',
  afghani_restaurant: 'kebab',
  falafel_restaurant: 'kebab',
  pizza_restaurant: 'pizza',
  pizza_delivery: 'pizza',
  bakery: 'bakery',
  bagel_shop: 'bakery',
  donut_shop: 'bakery',
  pastry_shop: 'bakery',
  cake_shop: 'bakery',
  pub: 'pub',
  bar: 'pub',
  irish_pub: 'pub',
  sports_bar: 'pub',
  wine_bar: 'pub',
  brewpub: 'pub',
  beer_garden: 'pub',
  cocktail_bar: 'pub',
  gastropub: 'pub',
  convenience_store: 'corner',
  grocery_store: 'corner',
  liquor_store: 'corner',
  food_store: 'corner',
  market: 'corner',
  supermarket: 'corner',
  asian_grocery_store: 'corner',
  restaurant: 'restaurant',
  meal_takeaway: 'restaurant',
  meal_delivery: 'restaurant',
  fast_food_restaurant: 'restaurant',
  food_court: 'restaurant',
  diner: 'restaurant',
};

/** One Google type → category: mapped types, then any other `*_restaurant` → restaurant. */
function categoryFromGoogleType(t: string): CategoryKey | null {
  return GOOGLE_TYPE_MAP[t] ?? (t.endsWith('_restaurant') ? 'restaurant' : null);
}

/**
 * Category from Google Places (New) `primaryType` / `types` (prefill only; the launcher picks).
 * The primary type decides when it maps to anything (including the `*_restaurant` fallback), so an
 * `indian_restaurant` that also lists `cafe` / `bar` among its secondary types stays a Restaurant.
 * Only when the primary type says nothing useful do the other `types` count, in Google's order
 * (most specific first), each with the same `*_restaurant` fallback.
 */
export function categoryFromGoogle(primaryType?: string | null, types?: readonly string[] | null): CategoryKey {
  const primary = primaryType ? categoryFromGoogleType(primaryType) : null;
  if (primary) return primary;
  for (const t of types ?? []) {
    const k = t ? categoryFromGoogleType(t) : null;
    if (k) return k;
  }
  return 'other';
}

/* --------------------------------------------------------------- OSM mapping */

/**
 * Category from OSM / OpenMapTiles fields. `cls`/`subclass` are OpenMapTiles `poi` layer
 * `class`/`subclass` (or Photon `osm_key`/`osm_value`); `name` refines fast food
 * ("Kebab", "Pizza" in the name) because cuisine tags aren't in the tiles.
 */
export function categoryFromOsm(cls?: string | null, subclass?: string | null, name?: string | null): CategoryKey {
  const c = (cls ?? '').toLowerCase();
  const s = (subclass ?? '').toLowerCase();
  const n = (name ?? '').toLowerCase();
  const nameHints = (): CategoryKey | null => {
    if (/(kebab|döner|doner|shawarma|gyro)/.test(n)) return 'kebab';
    if (/(pizza|pizzeria)/.test(n)) return 'pizza';
    if (/(bakery|bakers|boulangerie|patisserie)/.test(n)) return 'bakery';
    if (/(barber|hair)/.test(n)) return 'barber';
    if (/(coffee|café|cafe|espresso)/.test(n)) return 'cafe';
    return null;
  };
  const v = s || c;
  switch (v) {
    case 'cafe':
    case 'coffee':
    case 'coffee_shop':
    case 'tea':
      return 'cafe';
    case 'hairdresser':
    case 'barber':
    case 'beauty':
      return 'barber';
    case 'bakery':
    case 'pastry':
    case 'confectionery':
      return 'bakery';
    case 'pub':
    case 'bar':
    case 'biergarten':
    case 'beer':
    case 'nightclub':
      return 'pub';
    case 'convenience':
    case 'kiosk':
    case 'newsagent':
    case 'grocery':
    case 'alcohol':
    case 'off_licence':
    case 'supermarket':
    case 'greengrocer':
      return 'corner';
    case 'pizza':
      return 'pizza';
    case 'kebab':
      return 'kebab';
    case 'fast_food':
    case 'food_court':
    case 'restaurant':
      return nameHints() ?? 'restaurant';
    default:
      return nameHints() ?? (c === 'shop' ? 'corner' : 'other');
  }
}
