/**
 * Fictional-shop building blocks for the demo data and the live simulator (RAIL+FEED).
 *
 * Everything here is INVENTED: shop names are made-up combinations, websites use the reserved
 * `.example` TLD and phone numbers come only from ranges reserved for fiction:
 *   - London     Ofcom drama range   020 7946 0000–0999
 *   - Manchester Ofcom drama range   0161 496 0000–0999
 *   - US/Canada  NANP fictional      555-0100–0199
 *   - Sydney     ACMA fictional      (02) 5550 0000–9999
 * Countries without a reserved fictional range get no phone number at all ('' — the listing
 * "has no phone", which exercises the claim modal's other verification routes).
 * Street / neighbourhood names are real places so pins land somewhere sensible; no real
 * business is ever named or implied.
 */
import { categoryEmoji } from '../lib/categories';
import { distanceM } from '../lib/geo';
import type { Rng } from '../lib/rand';
import { sanitizeTicker, tickerFromName } from '../lib/ticker';
import type { CategoryKey, DemoPlaceInfo, LatLng } from '../types';

/* ------------------------------------------------------------------ cities */

export type CountryCode = 'GB' | 'US' | 'CA' | 'AU' | 'TR' | 'DE' | 'FR' | 'NG' | 'MX' | 'JP' | 'KR' | 'IN' | 'AE' | 'BR';

export interface CitySpot {
  at: LatLng;
  /** Neighbourhood, e.g. "Dalston". */
  area: string;
  /** A real street in that neighbourhood (the shops on it are fictional). */
  street: string;
}

export interface CityDef {
  key: string;
  /** Display city (never Google-derived). */
  city: string;
  cc: CountryCode;
  /** Postcode-ish suffix for addresses, e.g. "London E8". */
  locality: string;
  spots: readonly CitySpot[];
}

export const CITIES: readonly CityDef[] = [
  {
    key: 'london',
    city: 'London',
    cc: 'GB',
    locality: 'London',
    spots: [
      { at: { lat: 51.5469, lng: -0.0712 }, area: 'Dalston', street: 'Kingsland High St' },
      { at: { lat: 51.5262, lng: -0.0779 }, area: 'Shoreditch', street: 'Rivington St' },
      { at: { lat: 51.5452, lng: -0.0556 }, area: 'Hackney Central', street: 'Mare St' },
      { at: { lat: 51.5612, lng: -0.0742 }, area: 'Stoke Newington', street: 'Church St' },
      { at: { lat: 51.5318, lng: -0.0793 }, area: 'Hoxton', street: 'Hoxton St' },
    ],
  },
  {
    key: 'manchester',
    city: 'Manchester',
    cc: 'GB',
    locality: 'Manchester',
    spots: [
      { at: { lat: 53.4838, lng: -2.2262 }, area: 'Ancoats', street: 'Blossom St' },
      { at: { lat: 53.4842, lng: -2.2361 }, area: 'Northern Quarter', street: 'Tib St' },
    ],
  },
  {
    key: 'nyc',
    city: 'New York',
    cc: 'US',
    locality: 'New York, NY',
    spots: [
      { at: { lat: 40.7144, lng: -73.9566 }, area: 'Williamsburg', street: 'Bedford Ave' },
      { at: { lat: 40.7139, lng: -73.9899 }, area: 'Lower East Side', street: 'Orchard St' },
      { at: { lat: 40.7091, lng: -74.0086 }, area: 'Financial District', street: 'Fulton St' },
      { at: { lat: 40.6782, lng: -73.9442 }, area: 'Crown Heights', street: 'Nostrand Ave' },
    ],
  },
  {
    key: 'la',
    city: 'Los Angeles',
    cc: 'US',
    locality: 'Los Angeles, CA',
    spots: [
      { at: { lat: 34.0781, lng: -118.2606 }, area: 'Echo Park', street: 'Sunset Blvd' },
      { at: { lat: 33.9905, lng: -118.4658 }, area: 'Venice', street: 'Abbot Kinney Blvd' },
    ],
  },
  {
    key: 'toronto',
    city: 'Toronto',
    cc: 'CA',
    locality: 'Toronto, ON',
    spots: [
      { at: { lat: 43.6546, lng: -79.4006 }, area: 'Kensington Market', street: 'Augusta Ave' },
      { at: { lat: 43.6652, lng: -79.4702 }, area: 'The Junction', street: 'Dundas St W' },
    ],
  },
  {
    key: 'sydney',
    city: 'Sydney',
    cc: 'AU',
    locality: 'Sydney NSW',
    spots: [
      { at: { lat: -33.8852, lng: 151.2108 }, area: 'Surry Hills', street: 'Crown St' },
      { at: { lat: -33.8912, lng: 151.2748 }, area: 'Bondi', street: 'Hall St' },
    ],
  },
  {
    key: 'istanbul',
    city: 'Istanbul',
    cc: 'TR',
    locality: 'İstanbul',
    spots: [
      { at: { lat: 41.0256, lng: 28.9744 }, area: 'Beyoğlu', street: 'Galip Dede Cd' },
      { at: { lat: 40.9903, lng: 29.0277 }, area: 'Kadıköy', street: 'Moda Cd' },
      { at: { lat: 41.0171, lng: 28.9497 }, area: 'Fatih', street: 'Fevzi Paşa Cd' },
    ],
  },
  {
    key: 'berlin',
    city: 'Berlin',
    cc: 'DE',
    locality: 'Berlin',
    spots: [
      { at: { lat: 52.4991, lng: 13.4181 }, area: 'Kreuzberg', street: 'Oranienstraße' },
      { at: { lat: 52.4811, lng: 13.4351 }, area: 'Neukölln', street: 'Weserstraße' },
    ],
  },
  {
    key: 'paris',
    city: 'Paris',
    cc: 'FR',
    locality: 'Paris',
    spots: [
      { at: { lat: 48.8591, lng: 2.3601 }, area: 'Le Marais', street: 'Rue de Bretagne' },
      { at: { lat: 48.8721, lng: 2.3651 }, area: 'Canal Saint-Martin', street: 'Quai de Valmy' },
    ],
  },
  {
    key: 'lagos',
    city: 'Lagos',
    cc: 'NG',
    locality: 'Lagos',
    spots: [
      { at: { lat: 6.4302, lng: 3.4211 }, area: 'Victoria Island', street: 'Akin Adesola St' },
      { at: { lat: 6.5098, lng: 3.3802 }, area: 'Yaba', street: 'Herbert Macaulay Way' },
    ],
  },
  {
    key: 'cdmx',
    city: 'Mexico City',
    cc: 'MX',
    locality: 'Ciudad de México',
    spots: [
      { at: { lat: 19.4182, lng: -99.1621 }, area: 'Roma Norte', street: 'Calle Orizaba' },
      { at: { lat: 19.3502, lng: -99.1618 }, area: 'Coyoacán', street: 'Calle Allende' },
    ],
  },
  {
    key: 'tokyo',
    city: 'Tokyo',
    cc: 'JP',
    locality: 'Tokyo',
    spots: [
      { at: { lat: 35.6616, lng: 139.668 }, area: 'Shimokitazawa', street: 'Ichibangai' },
      { at: { lat: 35.7051, lng: 139.6497 }, area: 'Kōenji', street: 'Pal Shōtengai' },
    ],
  },
  {
    key: 'seoul',
    city: 'Seoul',
    cc: 'KR',
    locality: 'Seoul',
    spots: [
      { at: { lat: 37.5561, lng: 126.9019 }, area: 'Mangwon', street: 'Poeun-ro' },
      { at: { lat: 37.5446, lng: 127.0561 }, area: 'Seongsu', street: 'Yeonmujang-gil' },
    ],
  },
  {
    key: 'mumbai',
    city: 'Mumbai',
    cc: 'IN',
    locality: 'Mumbai',
    spots: [
      { at: { lat: 19.0191, lng: 72.8431 }, area: 'Dadar', street: 'Ranade Rd' },
      { at: { lat: 19.0601, lng: 72.8362 }, area: 'Bandra West', street: 'Hill Rd' },
    ],
  },
  {
    key: 'dubai',
    city: 'Dubai',
    cc: 'AE',
    locality: 'Dubai',
    spots: [{ at: { lat: 25.2451, lng: 55.3049 }, area: 'Al Karama', street: 'Kuwait St' }],
  },
  {
    key: 'saopaulo',
    city: 'São Paulo',
    cc: 'BR',
    locality: 'São Paulo',
    spots: [
      { at: { lat: -23.5561, lng: -46.6901 }, area: 'Vila Madalena', street: 'Rua Aspicuelta' },
      { at: { lat: -23.5671, lng: -46.6929 }, area: 'Pinheiros', street: 'Rua dos Pinheiros' },
    ],
  },
];

const CITY_BY_KEY: Record<string, CityDef> = Object.fromEntries(CITIES.map((c) => [c.key, c]));

export function cityDef(key: string): CityDef {
  return CITY_BY_KEY[key] ?? (CITIES[0] as CityDef);
}

/** The closest city (within `maxM` metres) to a point, or null. */
export function nearestCity(p: LatLng, maxM = 60_000): CityDef | null {
  let best: CityDef | null = null;
  let bestD = Infinity;
  for (const c of CITIES) {
    for (const s of c.spots) {
      const d = distanceM(p, s.at);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
  }
  return bestD <= maxM ? best : null;
}

/* ------------------------------------------------------------------ phones (fiction ranges only) */

/**
 * A phone number from a range reserved for fiction, or '' where no such range exists.
 * `n` picks the number inside the range deterministically.
 */
export function fictionalPhone(cityKey: string, n: number): string {
  const k = Math.abs(Math.floor(n));
  const pad = (v: number, w: number) => String(v).padStart(w, '0');
  switch (cityKey) {
    case 'london':
      return `020 7946 0${pad(k % 1000, 3)}`;
    case 'manchester':
      return `0161 496 0${pad(k % 1000, 3)}`;
    case 'nyc':
      return `(212) 555-01${pad(k % 100, 2)}`;
    case 'la':
      return `(213) 555-01${pad(k % 100, 2)}`;
    case 'toronto':
      return `(416) 555-01${pad(k % 100, 2)}`;
    case 'sydney':
      return `(02) 5550 ${pad(k % 10000, 4)}`;
    default:
      return '';
  }
}

/* ------------------------------------------------------------------ listing info */

/** Unsplash photo ids for the fictional info block's collage (food / shop interiors). */
export const GALLERIES = {
  grill: ['1530469912745-a215c6b256ea', '1529006557810-274b9b2fc783', '1756362847925-71c792d6729c'],
  bakery: ['1711672284661-bd70e38f31b2', '1788600284392-733dc1d5253a', '1787276694528-93d3c38b2d03'],
} as const;

const HOURS: Record<CategoryKey, [string, string]> = {
  cafe: ['7 am', '5 pm'],
  barber: ['9 am', '7 pm'],
  kebab: ['11 am', '2 am'],
  pizza: ['12 pm', '11 pm'],
  bakery: ['7 am', '6 pm'],
  pub: ['12 pm', '12 am'],
  corner: ['7 am', '11 pm'],
  restaurant: ['12 pm', '10 pm'],
  other: ['9 am', '6 pm'],
};

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function weekHours(open: string, close: string): string[] {
  return DAYS.map((d) => `${d} ${open}–${close}`);
}

/** `.example` host from a shop name: "Wren & Thistle Bakery" → "wrenandthistle.example". */
export function exampleHost(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\b(the|bakery|coffee|cafe|café|co|barbers?|pizza|pub)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24);
  return `${slug || 'shop'}.example`;
}

export interface InfoInput {
  name: string;
  category: CategoryKey;
  cityKey: string;
  spot: CitySpot;
  /** Deterministic number used for the phone, rating, reviews. */
  n: number;
  rating?: number;
  reviews?: number;
  price?: string;
  open?: string;
  close?: string;
  /** Open 24 hours (corner shops). */
  allDay?: boolean;
}

/** Fictional lookalike-listing data for a demo shop (DESIGN §9.6 `.gblock`). */
export function fictionalPlaceInfo(i: InfoInput): DemoPlaceInfo {
  const city = cityDef(i.cityKey);
  const [o, c] = HOURS[i.category];
  const open = i.open ?? o;
  const close = i.close ?? c;
  const gallery = i.category === 'bakery' || i.category === 'cafe' || i.category === 'corner' ? GALLERIES.bakery : GALLERIES.grill;
  return {
    rating: i.rating ?? Math.round((4.1 + ((i.n % 9) / 10) * 0.9) * 10) / 10,
    reviews: i.reviews ?? 24 + ((i.n * 37) % 700),
    price: i.price ?? (i.category === 'restaurant' || i.category === 'pub' || i.category === 'pizza' ? '££' : '£'),
    hours: i.allDay ? 'Open 24 hours' : `Closes ${close}`,
    hoursList: i.allDay ? DAYS.map((d) => `${d} Open 24 hours`) : weekHours(open, close),
    address: `${i.spot.street}, ${i.spot.area}, ${city.locality}`,
    phone: fictionalPhone(i.cityKey, i.n),
    website: exampleHost(i.name),
    photos: [...gallery],
    photoCount: 3 + (i.n % 9),
  };
}

/* ------------------------------------------------------------------ simulator launch pool */

export interface LaunchCandidate {
  name: string;
  ticker: string;
  category: CategoryKey;
  emoji: string;
  cityKey: string;
}

/**
 * Invented shops the simulator "launches" over time (FICTIONAL — never real businesses).
 * When the pool runs out the simulator generates more with `generateCandidate`.
 */
export const LAUNCH_POOL: readonly LaunchCandidate[] = [
  { name: 'Wren & Thistle Bakery', ticker: 'WREN', category: 'bakery', emoji: '🥐', cityKey: 'london' },
  { name: 'Kiln Lane Coffee', ticker: 'KILN', category: 'cafe', emoji: '☕', cityKey: 'london' },
  { name: 'Halfmoon Grill House', ticker: 'HALFMOON', category: 'kebab', emoji: '🥙', cityKey: 'london' },
  { name: 'Tallow Street Barbers', ticker: 'TALLOW', category: 'barber', emoji: '💈', cityKey: 'london' },
  { name: 'The Sleepy Heron', ticker: 'HERON', category: 'pub', emoji: '🍺', cityKey: 'london' },
  { name: 'Pocket Corner Store', ticker: 'POCKET', category: 'corner', emoji: '🏪', cityKey: 'london' },
  { name: 'Basil & Brick Pizza', ticker: 'BASIL', category: 'pizza', emoji: '🍕', cityKey: 'london' },
  { name: 'Moth Hour Noodles', ticker: 'MOTH', category: 'restaurant', emoji: '🍜', cityKey: 'london' },
  { name: 'Corner Comet Deli', ticker: 'COMET', category: 'corner', emoji: '🥤', cityKey: 'nyc' },
  { name: 'Little Ferry Espresso', ticker: 'FERRY', category: 'cafe', emoji: '☕', cityKey: 'nyc' },
  { name: 'Hudson Pine Pizza', ticker: 'PINE', category: 'pizza', emoji: '🍕', cityKey: 'nyc' },
  { name: 'Simitçi Martı', ticker: 'MARTI', category: 'bakery', emoji: '🥯', cityKey: 'istanbul' },
  { name: 'Köşe Ocakbaşı', ticker: 'OCAK', category: 'kebab', emoji: '🍢', cityKey: 'istanbul' },
  { name: 'Kiez Kaffee Rabe', ticker: 'RABE', category: 'cafe', emoji: '☕', cityKey: 'berlin' },
  { name: 'Döner Mondschein', ticker: 'MOND', category: 'kebab', emoji: '🥙', cityKey: 'berlin' },
  { name: 'Fournil des Moineaux', ticker: 'MOINEAU', category: 'bakery', emoji: '🥖', cityKey: 'paris' },
  { name: 'Coiffeur Lune Rousse', ticker: 'LUNE', category: 'barber', emoji: '💈', cityKey: 'paris' },
  { name: 'Gidi Grills Corner', ticker: 'GIDI', category: 'kebab', emoji: '🍢', cityKey: 'lagos' },
  { name: 'Ọja Fresh Mart', ticker: 'OJA', category: 'corner', emoji: '🧃', cityKey: 'lagos' },
  { name: 'Tacos La Garza', ticker: 'GARZA', category: 'restaurant', emoji: '🌮', cityKey: 'cdmx' },
  { name: 'Café Cenzontle', ticker: 'CENZO', category: 'cafe', emoji: '☕', cityKey: 'cdmx' },
  { name: 'Yakitori Hotaru', ticker: 'HOTARU', category: 'restaurant', emoji: '🍢', cityKey: 'tokyo' },
  { name: 'Kōhī Usagi', ticker: 'USAGI', category: 'cafe', emoji: '🫖', cityKey: 'tokyo' },
  { name: 'Pocha Dalbit', ticker: 'DALBIT', category: 'pub', emoji: '🍻', cityKey: 'seoul' },
  { name: 'Byeol Bread Lab', ticker: 'BYEOL', category: 'bakery', emoji: '🍩', cityKey: 'seoul' },
  { name: 'Magpie Corner Café', ticker: 'MAGPIE', category: 'cafe', emoji: '☕', cityKey: 'sydney' },
  { name: 'Loon Lake Bagels', ticker: 'LOON', category: 'bakery', emoji: '🥯', cityKey: 'toronto' },
  { name: 'Jacaranda Taquería', ticker: 'JACA', category: 'restaurant', emoji: '🌮', cityKey: 'la' },
  { name: 'Kesar Chai Tapri', ticker: 'KESAR', category: 'cafe', emoji: '🫖', cityKey: 'mumbai' },
  { name: 'Al Noor Karak Corner', ticker: 'KARAK', category: 'cafe', emoji: '🫖', cityKey: 'dubai' },
  { name: 'Pastelaria Bem-te-vi', ticker: 'BEMTEVI', category: 'restaurant', emoji: '🥟', cityKey: 'saopaulo' },
  { name: 'Mill Chimney Pies', ticker: 'CHIMNEY', category: 'bakery', emoji: '🥧', cityKey: 'manchester' },
];

const ADJ = ['Copper', 'Velvet', 'Bramble', 'Morning', 'Quiet', 'Lucky', 'Juniper', 'Saffron', 'Marigold', 'Clover', 'Pebble', 'Hazel', 'Brass', 'Paper', 'Fig', 'Lantern', 'Willow', 'Amber'];
const NOUN = ['Fox', 'Heron', 'Kettle', 'Anchor', 'Moth', 'Thistle', 'Otter', 'Badger', 'Plum', 'Ivy', 'Rook', 'Finch', 'Acorn', 'Pigeon', 'Hare', 'Lark', 'Comet', 'Tulip'];
const KIND: Record<CategoryKey, string[]> = {
  cafe: ['Coffee', 'Café', 'Espresso Bar'],
  barber: ['Barbers', 'Barber Co.'],
  kebab: ['Grill', 'Kebab House'],
  pizza: ['Pizza', 'Slice Shop'],
  bakery: ['Bakery', 'Bakehouse'],
  pub: ['Tavern', 'Ale House'],
  corner: ['Corner Shop', 'Late Shop'],
  restaurant: ['Noodle Bar', 'Kitchen', 'Canteen'],
  other: ['Store'],
};
const GEN_CATEGORIES: CategoryKey[] = ['cafe', 'cafe', 'barber', 'kebab', 'pizza', 'bakery', 'pub', 'corner', 'restaurant'];

/**
 * Generate an invented shop when the launch pool is exhausted: "Juniper Otter Café".
 * The ticker avoids `taken` (case-insensitive) by falling back to the second word or a digit.
 */
export function generateCandidate(rng: Rng, cityKey: string, taken: (ticker: string) => boolean): LaunchCandidate {
  const category = rng.pick(GEN_CATEGORIES);
  const a = rng.pick(ADJ);
  const b = rng.pick(NOUN);
  const name = `${a} ${b} ${rng.pick(KIND[category])}`;
  // ticker candidates: first word, second word, then initials + a number
  const options = [tickerFromName(name), sanitizeTicker(b)];
  let ticker = options.find((t) => t.length >= 2 && !taken(t)) ?? '';
  for (let i = 0; !ticker && i < 500; i++) {
    const t = sanitizeTicker(`${a[0]}${b[0]}${rng.int(10, 999)}`);
    if (!taken(t)) ticker = t;
  }
  if (!ticker) ticker = `CS${rng.int(1000, 9999)}`;
  const stickers: Partial<Record<CategoryKey, string[]>> = {
    cafe: ['☕', '🧋', '🫖'],
    kebab: ['🥙', '🌯', '🍢'],
    restaurant: ['🍜', '🍛', '🥘'],
    corner: ['🏪', '🥤', '🍬'],
  };
  const emoji = stickers[category] ? rng.pick(stickers[category] as string[]) : categoryEmoji(category);
  return { name, ticker, category, emoji, cityKey };
}

/** Move a point by `meters` in a random direction (for placing fictional shops near a spot). */
export function jitter(p: LatLng, rng: Rng, minM: number, maxM: number): LatLng {
  const d = rng.range(minM, maxM);
  const a = rng.range(0, Math.PI * 2);
  const dLat = (d * Math.cos(a)) / 111_320;
  const dLng = (d * Math.sin(a)) / (111_320 * Math.max(0.2, Math.cos((p.lat * Math.PI) / 180)));
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}
