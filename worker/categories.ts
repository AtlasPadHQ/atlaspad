/**
 * Google Places (New) type → CORNERSHOP category (prefill only; the launcher picks). A copy of the small table in
 * src/lib/categories.ts (categoryFromGoogle), which the Worker cannot import (DOM-typed app code). Keep in sync;
 * worker/categories.test.ts compares both.
 */
import type { CategoryKey } from './wire';

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


export function categoryFromGoogle(primaryType?: string | null, types?: readonly string[] | null): CategoryKey {
  const primary = primaryType ? categoryFromGoogleType(primaryType) : null;
  if (primary) return primary;
  for (const t of types ?? []) {
    const k = t ? categoryFromGoogleType(t) : null;
    if (k) return k;
  }
  return 'other';
}

export const CATEGORY_KEYS: readonly CategoryKey[] = ['cafe', 'barber', 'kebab', 'pizza', 'bakery', 'pub', 'corner', 'restaurant', 'other'];
