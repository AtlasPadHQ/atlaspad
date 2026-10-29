/**
 * Seeded demo coins (DESIGN §19.2) — FICTIONAL shops only, never real businesses.
 * OWNED BY RAIL+FEED.
 *
 * 43 invented shops: the 8 DESIGN §19.2 coins around Dalston (exact mock values), 4 more around
 * Shoreditch / Hackney / Hoxton / Stoke Newington, and 31 worldwide. Market caps follow a rough
 * power law ($3.1k → $2.4M); ~25% are owner-verified; fees ≈ CREATOR_FEE_RATE × cumulative
 * volume; every coin has a 48-point 24h history consistent with its 24h change; mints are
 * base58 and end in "pump", launchers are base58 wallets (lib/fakeSolana).
 * Fictional contact data only: `.example` websites and phone numbers from fiction-reserved
 * ranges (see ./fictional.ts).
 *
 * Contract: createMockCoins(solUsd?, now?): Coin[]
 * Extra exports: createDemoPlaces(), getDemoPlace(id, coins?), createMockActivity(coins, now?),
 *                tradeSizeSol(rng), activityPlan(placeId, mcap)
 */
import { CREATOR_FEE_RATE, DEMO_SOL_USD, LIMITS, links, PUMP_SUPPLY } from '../config';
import { categoryEmoji, categoryLabel } from '../lib/categories';
import { fakeSignature, fakeWallet } from '../lib/fakeSolana';
import { bridgeSeries, buildCoin, initialPriceUsd, poolDepthUsd, quoteBuy, quoteSellForSol } from '../lib/market';
import { demoPlaceId } from '../lib/place';
import { createRng, hashString, type Rng } from '../lib/rand';
import type { CategoryKey, Coin, DemoPlaceInfo, FeedEvent, LatLng, LogoSpec, Place, Trade, TradeSide } from '../types';
import { cityDef, fictionalPlaceInfo, GALLERIES, weekHours } from './fictional';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

interface Seed {
  slug: string;
  ticker: string;
  name: string;
  category: CategoryKey;
  emoji: string;
  bg: string;
  city: string;
  at: LatLng;
  /** 24h change in %, ignored for coins younger than a day (derived from the launch price). */
  change: number;
  mcap: number;
  /** Days since launch (fractions allowed: 22 min = 22 / 1440). */
  daysAgo: number;
  fees?: number;
  holders?: number;
  volume?: number;
  claimed?: boolean;
  pending?: boolean;
  /**
   * Launcher-uploaded art (demo: an Unsplash photo). `id` = the images.unsplash.com CDN id
   * ("photo-<id>"); `page` = the photo's id on unsplash.com/photos/<page> (a different id).
   */
  art?: { id: string; page: string };
  /** Explicit listing info (the DESIGN §19.2 shops); otherwise generated from `addr`. */
  demo?: DemoPlaceInfo;
  /** [street, area] for generated listing info. */
  addr?: [string, string];
  allDay?: boolean;
}

const mins = (m: number) => m / 1440;

/* --------------------------------------------------------------------------------- seeds */

const SEEDS: Seed[] = [
  /* ---- DESIGN §19.2 (exact mock values) ---- */
  {
    slug: 'kebab',
    ticker: 'KEBAB',
    name: 'Bosphorus Grill',
    category: 'kebab',
    emoji: '🥙',
    bg: '#ffe4cc',
    city: 'london',
    at: { lat: 51.54905, lng: -0.07535 },
    change: 12.4,
    mcap: 212_000,
    fees: 1240,
    holders: 1284,
    volume: 48_100,
    daysAgo: 3,
    // "Traditional Turkish meat in a restaurant" by engin akyurt (unsplash.com/photos/Vq995Fnrw4A)
    art: { id: '1639737611208-a01d87b78605', page: 'Vq995Fnrw4A' },
    demo: {
      rating: 4.5,
      reviews: 312,
      price: '££',
      hours: 'Closes 2 am',
      hoursList: weekHours('11 am', '2 am'),
      address: 'Kingsland High St, London E8',
      phone: '020 7946 0123',
      website: 'bosphorusgrill.example',
      photos: [...GALLERIES.grill],
      photoCount: 8,
    },
  },
  {
    slug: 'bean',
    ticker: 'BEAN',
    name: 'Beanstalk Coffee Co.',
    category: 'cafe',
    emoji: '☕',
    bg: '#efe3d6',
    city: 'london',
    at: { lat: 51.55185, lng: -0.06905 },
    change: 4.1,
    mcap: 86_000,
    fees: 420,
    holders: 512,
    volume: 17_400,
    daysAgo: 5,
    demo: {
      rating: 4.7,
      reviews: 204,
      price: '£',
      hours: 'Closes 5 pm',
      hoursList: weekHours('7 am', '5 pm'),
      address: 'Amhurst Rd, London E8',
      phone: '020 7946 0217',
      website: 'beanstalkcoffee.example',
      photos: [...GALLERIES.bakery],
      photoCount: 5,
    },
  },
  {
    slug: 'fade',
    ticker: 'FADE',
    name: 'Fadeaway Barbers',
    category: 'barber',
    emoji: '💈',
    bg: '#e3e8ff',
    city: 'london',
    at: { lat: 51.54445, lng: -0.08055 },
    change: -3.2,
    mcap: 41_000,
    fees: 180,
    holders: 236,
    volume: 6_900,
    daysAgo: 6,
    demo: {
      rating: 4.8,
      reviews: 97,
      price: '££',
      hours: 'Closes 7 pm',
      hoursList: weekHours('9 am', '7 pm'),
      address: 'Ball’s Pond Rd, London N1',
      phone: '020 7946 0342',
      website: 'fadeawaybarbers.example',
      photos: [...GALLERIES.grill],
      photoCount: 4,
    },
  },
  {
    slug: 'pepi',
    ticker: 'PEPI',
    name: "Nonna Pepi's Pizza",
    category: 'pizza',
    emoji: '🍕',
    bg: '#ffe0db',
    city: 'london',
    at: { lat: 51.54525, lng: -0.06565 },
    change: 27.9,
    mcap: 154_000,
    fees: 960,
    holders: 903,
    volume: 39_800,
    daysAgo: 2,
    demo: {
      rating: 4.6,
      reviews: 488,
      price: '££',
      hours: 'Closes 11 pm',
      hoursList: weekHours('12 pm', '11 pm'),
      address: 'Graham Rd, London E8',
      phone: '020 7946 0488',
      website: 'nonnapepi.example',
      photos: [...GALLERIES.grill],
      photoCount: 12,
    },
  },
  {
    slug: 'crow',
    ticker: 'CROW',
    name: 'Kettle & Crow',
    category: 'pub',
    emoji: '🍺',
    bg: '#fff1c7',
    city: 'london',
    at: { lat: 51.55275, lng: -0.07905 },
    change: 1.8,
    mcap: 63_000,
    fees: 3410,
    holders: 377,
    volume: 9_100,
    daysAgo: 9,
    claimed: true,
    demo: {
      rating: 4.4,
      reviews: 640,
      price: '££',
      hours: 'Closes 12 am',
      hoursList: weekHours('12 pm', '12 am'),
      address: 'Stoke Newington Rd, London N16',
      phone: '020 7946 0561',
      website: 'kettleandcrow.example',
      photos: [...GALLERIES.bakery],
      photoCount: 9,
    },
  },
  {
    slug: 'late',
    ticker: 'LATE',
    name: 'Ridley Late Shop',
    category: 'corner',
    emoji: '🏪',
    bg: '#dff3e6',
    city: 'london',
    at: { lat: 51.54215, lng: -0.07215 },
    change: -8.6,
    mcap: 19_000,
    fees: 75,
    holders: 118,
    volume: 4_200,
    daysAgo: 1,
    demo: {
      rating: 4.1,
      reviews: 56,
      price: '£',
      hours: 'Open 24 hours',
      hoursList: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => `${d} Open 24 hours`),
      address: 'Ridley Rd, London E8',
      phone: '020 7946 0614',
      website: 'ridleylate.example',
      photos: [...GALLERIES.bakery],
      photoCount: 3,
    },
  },
  {
    slug: 'noodl',
    ticker: 'NOODL',
    name: 'Lucky Noodle Bar',
    category: 'restaurant',
    emoji: '🍜',
    bg: '#fde2c4',
    city: 'london',
    at: { lat: 51.54925, lng: -0.06235 },
    change: 6.3,
    mcap: 37_000,
    fees: 140,
    holders: 209,
    volume: 5_600,
    daysAgo: 4,
    demo: {
      rating: 4.5,
      reviews: 173,
      price: '££',
      hours: 'Closes 10 pm',
      hoursList: weekHours('12 pm', '10 pm'),
      address: 'Mare St, London E8',
      phone: '020 7946 0739',
      website: 'luckynoodle.example',
      photos: [...GALLERIES.grill],
      photoCount: 6,
    },
  },
  {
    slug: 'simit',
    ticker: 'SIMIT',
    name: 'Simit House',
    category: 'bakery',
    emoji: '🥯',
    bg: '#e2f0ff',
    city: 'london',
    at: { lat: 51.54095, lng: -0.07905 },
    change: 15.2,
    mcap: 92_000,
    fees: 610,
    holders: 548,
    volume: 21_300,
    daysAgo: 7,
    demo: {
      rating: 4.7,
      reviews: 266,
      price: '£',
      hours: 'Closes 8 pm',
      hoursList: weekHours('7 am', '8 pm'),
      address: 'Kingsland Rd, London E8',
      phone: '020 7946 0852',
      website: 'simithouse.example',
      photos: [...GALLERIES.bakery],
      photoCount: 7,
    },
  },

  /* ---- more of East London ---- */
  { slug: 'slate', ticker: 'SLATE', name: 'Slate House Coffee', category: 'cafe', emoji: '☕', bg: '#efe3d6', city: 'london', at: { lat: 51.5258, lng: -0.0784 }, change: -2.4, mcap: 31_000, daysAgo: 12, addr: ['Rivington St', 'Shoreditch'] },
  { slug: 'fern', ticker: 'FERN', name: 'Fernhill Barbers', category: 'barber', emoji: '💈', bg: '#e3e8ff', city: 'london', at: { lat: 51.5455, lng: -0.0561 }, change: 3.9, mcap: 14_000, daysAgo: 8, addr: ['Mare St', 'Hackney Central'] },
  { slug: 'peli', ticker: 'PELI', name: 'Pellicano Slice', category: 'pizza', emoji: '🍕', bg: '#ffe0db', city: 'london', at: { lat: 51.5321, lng: -0.0791 }, change: 0, mcap: 6_200, daysAgo: mins(41), addr: ['Hoxton St', 'Hoxton'] },
  { slug: 'dove', ticker: 'DOVE', name: 'Dovecote Corner Store', category: 'corner', emoji: '🏪', bg: '#dff3e6', city: 'london', at: { lat: 51.5615, lng: -0.0748 }, change: -11.2, mcap: 3_100, daysAgo: 15, addr: ['Church St', 'Stoke Newington'], allDay: true },

  /* ---- New York ---- */
  { slug: 'bodega', ticker: 'BODEGA', name: 'Marigold Bodega', category: 'corner', emoji: '🏪', bg: '#fff1c7', city: 'nyc', at: { lat: 40.7146, lng: -73.9571 }, change: 8.7, mcap: 2_400_000, daysAgo: 34, claimed: true, addr: ['Bedford Ave', 'Williamsburg'], allDay: true },
  { slug: 'slice', ticker: 'SLICE', name: 'Two Bridges Slice Co.', category: 'pizza', emoji: '🍕', bg: '#ffe0db', city: 'nyc', at: { lat: 40.7134, lng: -73.9902 }, change: 21.3, mcap: 640_000, daysAgo: 19, addr: ['Orchard St', 'Lower East Side'] },
  { slug: 'bagl', ticker: 'BAGL', name: 'Fulton Hollow Bagels', category: 'bakery', emoji: '🥯', bg: '#efe3d6', city: 'nyc', at: { lat: 40.7094, lng: -74.0079 }, change: -4.6, mcap: 120_000, daysAgo: 11, addr: ['Fulton St', 'Financial District'] },

  /* ---- Istanbul ---- */
  { slug: 'doner', ticker: 'DONER', name: 'Galata Köz Döner', category: 'kebab', emoji: '🥙', bg: '#ffe4cc', city: 'istanbul', at: { lat: 41.0259, lng: 28.9741 }, change: 14.9, mcap: 880_000, daysAgo: 27, claimed: true, addr: ['Galip Dede Cd', 'Beyoğlu'] },
  { slug: 'cay', ticker: 'CAY', name: 'Mavi Kedi Çay Evi', category: 'cafe', emoji: '🫖', bg: '#e3e8ff', city: 'istanbul', at: { lat: 40.9897, lng: 29.0269 }, change: 2.2, mcap: 54_000, daysAgo: 9, pending: true, addr: ['Moda Cd', 'Kadıköy'] },
  { slug: 'borek', ticker: 'BOREK', name: 'Nar Börek Fırını', category: 'bakery', emoji: '🥧', bg: '#ffe0db', city: 'istanbul', at: { lat: 41.0168, lng: 28.9502 }, change: 6.1, mcap: 210_000, daysAgo: 21, claimed: true, addr: ['Fevzi Paşa Cd', 'Fatih'] },

  /* ---- Berlin ---- */
  { slug: 'wurst', ticker: 'WURST', name: 'Kiezwurst Imbiss', category: 'restaurant', emoji: '🌭', bg: '#fff1c7', city: 'berlin', at: { lat: 52.4994, lng: 13.4189 }, change: -6.8, mcap: 310_000, daysAgo: 24, addr: ['Oranienstraße', 'Kreuzberg'] },
  { slug: 'spati', ticker: 'SPATI', name: 'Späti Sonnenschein', category: 'corner', emoji: '🧃', bg: '#dff3e6', city: 'berlin', at: { lat: 52.4808, lng: 13.4356 }, change: 12.0, mcap: 26_000, daysAgo: 6, addr: ['Weserstraße', 'Neukölln'] },

  /* ---- Paris ---- */
  { slug: 'pigeon', ticker: 'PIGEON', name: 'Boulangerie des Trois Pigeons', category: 'bakery', emoji: '🥐', bg: '#efe3d6', city: 'paris', at: { lat: 48.8593, lng: 2.3605 }, change: 9.4, mcap: 470_000, daysAgo: 30, claimed: true, addr: ['Rue de Bretagne', 'Le Marais'] },
  { slug: 'verte', ticker: 'VERTE', name: 'Café Lanterne Verte', category: 'cafe', emoji: '☕', bg: '#dff3e6', city: 'paris', at: { lat: 48.8718, lng: 2.3655 }, change: -1.3, mcap: 38_000, daysAgo: 5, addr: ['Quai de Valmy', 'Canal Saint-Martin'] },

  /* ---- Lagos ---- */
  { slug: 'suya', ticker: 'SUYA', name: 'Island Flame Suya', category: 'kebab', emoji: '🍢', bg: '#ffe4cc', city: 'lagos', at: { lat: 6.4305, lng: 3.4216 }, change: 33.6, mcap: 150_000, daysAgo: 4, addr: ['Akin Adesola St', 'Victoria Island'] },
  { slug: 'jollof', ticker: 'JOLLOF', name: "Mama Tolu's Jollof Kitchen", category: 'restaurant', emoji: '🍛', bg: '#ffe0db', city: 'lagos', at: { lat: 6.5101, lng: 3.3797 }, change: 5.5, mcap: 95_000, daysAgo: 13, addr: ['Herbert Macaulay Way', 'Yaba'] },

  /* ---- Mexico City ---- */
  { slug: 'taco', ticker: 'TACO', name: 'Taquería El Colibrí Azul', category: 'restaurant', emoji: '🌮', bg: '#fff1c7', city: 'cdmx', at: { lat: 19.4185, lng: -99.1625 }, change: 18.2, mcap: 1_100_000, daysAgo: 26, addr: ['Calle Orizaba', 'Roma Norte'] },
  { slug: 'concha', ticker: 'CONCHA', name: 'Panadería La Luna Dulce', category: 'bakery', emoji: '🍞', bg: '#e3e8ff', city: 'cdmx', at: { lat: 19.3505, lng: -99.1614 }, change: -3.9, mcap: 33_000, daysAgo: 7, addr: ['Calle Allende', 'Coyoacán'] },

  /* ---- Tokyo ---- */
  { slug: 'ramen', ticker: 'RAMEN', name: 'Hoshizora Ramen', category: 'restaurant', emoji: '🍜', bg: '#ffe4cc', city: 'tokyo', at: { lat: 35.6613, lng: 139.6684 }, change: 4.8, mcap: 760_000, daysAgo: 29, claimed: true, addr: ['Ichibangai', 'Shimokitazawa'] },
  { slug: 'kissa', ticker: 'KISSA', name: 'Kissa Tsubame', category: 'cafe', emoji: '☕', bg: '#efe3d6', city: 'tokyo', at: { lat: 35.7054, lng: 139.6493 }, change: 1.1, mcap: 68_000, daysAgo: 16, claimed: true, addr: ['Pal Shōtengai', 'Kōenji'] },

  /* ---- Seoul ---- */
  { slug: 'chimaek', ticker: 'CHIMAEK', name: 'Hangang Night Chicken', category: 'pub', emoji: '🍻', bg: '#fff1c7', city: 'seoul', at: { lat: 37.5558, lng: 126.9024 }, change: 11.7, mcap: 290_000, daysAgo: 18, addr: ['Poeun-ro', 'Mangwon'] },
  { slug: 'dawn', ticker: 'DAWN', name: 'Saebyeok Bakery', category: 'bakery', emoji: '🍩', bg: '#ffe0db', city: 'seoul', at: { lat: 37.5443, lng: 127.0566 }, change: -7.4, mcap: 45_000, daysAgo: 10, addr: ['Yeonmujang-gil', 'Seongsu'] },

  /* ---- Sydney ---- */
  { slug: 'wattle', ticker: 'WATTLE', name: 'Wattlebird Espresso', category: 'cafe', emoji: '☕', bg: '#dff3e6', city: 'sydney', at: { lat: -33.8848, lng: 151.2113 }, change: 3.3, mcap: 180_000, daysAgo: 22, claimed: true, addr: ['Crown St', 'Surry Hills'] },
  { slug: 'swell', ticker: 'SWELL', name: 'Bondi Swell Fish Bar', category: 'restaurant', emoji: '🍟', bg: '#e3e8ff', city: 'sydney', at: { lat: -33.8915, lng: 151.2743 }, change: 7.9, mcap: 22_000, daysAgo: 3, addr: ['Hall St', 'Bondi'] },

  /* ---- Toronto ---- */
  { slug: 'peameal', ticker: 'PEAMEAL', name: 'Augusta Peameal Deli', category: 'restaurant', emoji: '🥪', bg: '#ffe4cc', city: 'toronto', at: { lat: 43.6549, lng: -79.4009 }, change: -2.1, mcap: 130_000, daysAgo: 15, addr: ['Augusta Ave', 'Kensington Market'] },
  { slug: 'clips', ticker: 'CLIPS', name: 'Junction Clippers', category: 'barber', emoji: '💈', bg: '#e3e8ff', city: 'toronto', at: { lat: 43.6655, lng: -79.4708 }, change: 0.6, mcap: 12_000, daysAgo: 2, addr: ['Dundas St W', 'The Junction'] },

  /* ---- Los Angeles ---- */
  { slug: 'birria', ticker: 'BIRRIA', name: 'Sunset Birria Stand', category: 'restaurant', emoji: '🌮', bg: '#ffe0db', city: 'la', at: { lat: 34.0777, lng: -118.2612 }, change: 26.4, mcap: 520_000, daysAgo: 14, addr: ['Sunset Blvd', 'Echo Park'] },
  { slug: 'salt', ticker: 'SALT', name: 'Venice Salt Barbers', category: 'barber', emoji: '💈', bg: '#dff3e6', city: 'la', at: { lat: 33.9909, lng: -118.4662 }, change: -0.8, mcap: 39_000, daysAgo: 20, claimed: true, addr: ['Abbot Kinney Blvd', 'Venice'] },

  /* ---- Mumbai ---- */
  { slug: 'vadapav', ticker: 'VADAPAV', name: 'Monsoon Vada Pav Stall', category: 'restaurant', emoji: '🍔', bg: '#fff1c7', city: 'mumbai', at: { lat: 19.0194, lng: 72.8427 }, change: 16.5, mcap: 340_000, daysAgo: 12, addr: ['Ranade Rd', 'Dadar'] },
  { slug: 'cutting', ticker: 'CUTTING', name: 'Bandra Cutting Chai', category: 'cafe', emoji: '🫖', bg: '#efe3d6', city: 'mumbai', at: { lat: 19.0597, lng: 72.8366 }, change: 4.4, mcap: 28_000, daysAgo: 6, addr: ['Hill Rd', 'Bandra West'] },

  /* ---- Dubai ---- */
  { slug: 'shwrma', ticker: 'SHWRMA', name: 'Karama Shawarma House', category: 'kebab', emoji: '🌯', bg: '#ffe4cc', city: 'dubai', at: { lat: 25.2454, lng: 55.3044 }, change: -5.2, mcap: 410_000, daysAgo: 17, addr: ['Kuwait St', 'Al Karama'] },

  /* ---- São Paulo ---- */
  { slug: 'sabia', ticker: 'SABIA', name: 'Padaria Sabiá', category: 'bakery', emoji: '🥖', bg: '#e3e8ff', city: 'saopaulo', at: { lat: -23.5564, lng: -46.6896 }, change: 2.7, mcap: 76_000, daysAgo: 25, claimed: true, addr: ['Rua Aspicuelta', 'Vila Madalena'] },
  { slug: 'tucano', ticker: 'TUCANO', name: 'Boteco do Tucano', category: 'pub', emoji: '🍺', bg: '#dff3e6', city: 'saopaulo', at: { lat: -23.5674, lng: -46.6925 }, change: 10.3, mcap: 230_000, daysAgo: 23, claimed: true, addr: ['Rua dos Pinheiros', 'Pinheiros'] },

  /* ---- Manchester ---- */
  { slug: 'ember', ticker: 'EMBER', name: 'Ancoats Ember Pizza', category: 'pizza', emoji: '🍕', bg: '#ffe0db', city: 'manchester', at: { lat: 53.4841, lng: -2.2257 }, change: 7.1, mcap: 160_000, daysAgo: 9, addr: ['Blossom St', 'Ancoats'] },
  { slug: 'offy', ticker: 'OFFY', name: 'Tib Street Offy', category: 'corner', emoji: '🏪', bg: '#fff1c7', city: 'manchester', at: { lat: 53.4845, lng: -2.2358 }, change: 0, mcap: 9_000, daysAgo: mins(22), addr: ['Tib St', 'Northern Quarter'], allDay: true },
];

/** The kebab mint from DESIGN §19.2 (other mints are generated deterministically). */
const KEBAB_MINT = 'BkT7yM3cQ9xX1rLqTzF4nH8pVwJdUe2sGa5KcR6tpump';

/** The DESIGN §19.2 Dalston shops — the simulator never claims these (they must match the mock). */
export const MOCK_PARITY_IDS: ReadonlySet<string> = new Set(
  ['kebab', 'bean', 'fade', 'pepi', 'crow', 'late', 'noodl', 'simit'].map((s) => demoPlaceId(s)),
);

/* --------------------------------------------------------------------------------- helpers */

function logoFor(s: Seed): LogoSpec {
  if (s.art) {
    return {
      kind: 'upload',
      dataUrl: links.unsplashPhoto(s.art.id, 816, 480),
      emoji: s.emoji,
      bg: s.bg,
      credit: { text: 'Uploaded by launcher · Photo: Unsplash', href: links.unsplashPage(s.art.page) },
    };
  }
  return { kind: 'sticker', emoji: s.emoji, bg: s.bg };
}

function infoFor(s: Seed): DemoPlaceInfo {
  if (s.demo) return s.demo;
  const [street, area] = s.addr ?? ['High St', cityDef(s.city).city];
  return fictionalPlaceInfo({
    name: s.name,
    category: s.category,
    cityKey: s.city,
    spot: { at: s.at, area, street },
    n: hashString(`phone:${s.slug}`) % 1000,
    allDay: s.allDay,
  });
}

/** Round to 3 significant figures. */
function sig3(v: number): number {
  if (!(v > 0)) return 0;
  const p = 10 ** (Math.floor(Math.log10(v)) - 2);
  return Math.round(v / p) * p;
}

/** Volume, holders and fees consistent with a seed's market cap and age. */
function economics(s: Seed): { volume: number; holders: number; fees: number } {
  const rng = createRng(`econ:${s.slug}`);
  const days = Math.max(s.daysAgo, mins(10));
  const volume = s.volume ?? sig3(s.mcap * rng.range(0.1, 0.3) * Math.min(1, days * 4));
  const holders = s.holders ?? Math.max(3, Math.round(1284 * (s.mcap / 212_000) ** 0.62 * rng.range(0.85, 1.15)));
  // cumulative volume decays with age: ~45–75% of (24h volume × days live)
  const cumulative = volume * Math.max(days, 0.05) * rng.range(0.45, 0.75);
  const fees = s.fees ?? Math.round(cumulative * CREATOR_FEE_RATE * 100) / 100;
  return { volume, holders, fees };
}

/** 48-point history for a coin younger than 24h: flat at the launch price, then a bridge to `price`. */
function youngHistory(slug: string, ageMs: number, price: number, solUsd: number): number[] {
  const n = LIMITS.history;
  const start = initialPriceUsd(solUsd);
  const step = DAY / (n - 1);
  const live = Math.max(2, Math.min(n, Math.ceil(ageMs / step) + 1));
  const bridge = bridgeSeries(`young:${slug}`, start, price, live, 0.04);
  const out = [...Array.from({ length: n - live }, () => start), ...bridge];
  out[out.length - 1] = price;
  return out;
}

/**
 * Deterministic activity plan for a coin (shared by createMockCoins → lastTradeAt and
 * createMockActivity → backfill), so the "Live coins" chip and the feed agree on first load.
 */
export function activityPlan(placeId: string, mcap: number): { firstAgoMs: number; count: number; gap: [number, number] } {
  const rng = createRng(`activity:${placeId}`);
  if (mcap >= 100_000) return { firstAgoMs: rng.int(5, 70) * 1000, count: 8, gap: [20_000, 240_000] };
  if (mcap >= 15_000) return { firstAgoMs: rng.int(20, 420) * 1000, count: 6, gap: [60_000, 900_000] };
  return { firstAgoMs: rng.int(9, 48) * MIN, count: 3, gap: [8 * MIN, 40 * MIN] };
}

/**
 * Simulated trade size in SOL (0.05–25, fat tail): mostly log-normal around 0.35 SOL with a
 * ~3% Pareto "whale" tail from 3 SOL. Rounded like a human would type it.
 */
export function tradeSizeSol(rng: Rng): number {
  let sol = rng.chance(0.03) ? 3 * (1 - rng.next()) ** (-1 / 1.3) : Math.exp(Math.log(0.35) + rng.normal() * 1.0);
  sol = Math.min(25, Math.max(0.05, sol));
  return roundSol(sol);
}

export function roundSol(sol: number): number {
  if (sol < 1) return Math.max(0.01, Math.round(sol * 100) / 100);
  if (sol < 10) return Math.round(sol * 10) / 10;
  return Math.round(sol);
}

/** Largest simulated trade (SOL) a coin's virtual pool takes without absurd price impact. */
export function maxTradeSol(coin: Pick<Coin, 'marketCapUsd'>, solUsd: number): number {
  return (poolDepthUsd(coin.marketCapUsd) * 0.1) / Math.max(1, solUsd);
}

/* --------------------------------------------------------------------------------- exports */

/** The 43 seeded demo coins (8 in Dalston exactly as the mock, 35 more). */
export function createMockCoins(solUsd: number = DEMO_SOL_USD, now: number = Date.now()): Coin[] {
  return SEEDS.map((s) => {
    const placeId = demoPlaceId(s.slug);
    const city = cityDef(s.city);
    const { volume, holders, fees } = economics(s);
    const rng = createRng(`seed:${s.slug}`);
    const young = s.daysAgo < 1;
    const ageMs = s.daysAgo * DAY;
    // DESIGN §19.2 coins keep the stub's launch offsets; others get a little jitter.
    const launchedAt = young ? now - ageMs : now - ageMs - (MOCK_PARITY_IDS.has(placeId) ? (s.slug.length * HOUR) / 2 : rng.int(1, 20) * HOUR);
    const owner = s.claimed ? fakeWallet(`owner:${s.slug}`) : undefined;
    const price = s.mcap / PUMP_SUPPLY;
    const history = young ? youngHistory(s.slug, ageMs, price, solUsd) : undefined;
    const change = young ? (price / initialPriceUsd(solUsd) - 1) * 100 : s.change;
    const plan = activityPlan(placeId, s.mcap);
    // Kettle & Crow: "Claimed by the owner on 2 Oct 2026" in the mock (5 days before the demo date).
    const claimedAt = !s.claimed
      ? undefined
      : s.slug === 'crow'
        ? now - 5 * DAY
        : Math.min(now - HOUR, launchedAt + rng.range(0.3, 0.8) * (now - launchedAt));
    return buildCoin(
      {
        placeId,
        place: { id: placeId, source: 'demo', location: s.at, category: s.category, emoji: s.emoji, city: city.city, demo: infoFor(s) },
        ticker: s.ticker,
        name: s.name,
        logo: logoFor(s),
        launchedAt,
        mint: s.slug === 'kebab' ? KEBAB_MINT : undefined,
        launcher: fakeWallet(`launcher:${s.slug}`),
        marketCapUsd: s.mcap,
        change24h: change,
        history,
        historyAt: now,
        volume24h: volume,
        holders,
        feesEarnedUsd: fees,
        claimed: !!s.claimed,
        ownerVerified: !!s.claimed,
        claimPending: s.pending ? true : undefined,
        claimedAt,
        owner,
        payoutWallet: owner,
        lastTradeAt: Math.max(launchedAt, now - plan.firstAgoMs),
        isDemoSeed: true,
      },
      solUsd,
    );
  });
}

/** Unlaunched FICTIONAL demo place (DESIGN §19.2 "crumb") used by the `?state=unlaunched` QA state. */
export function createDemoPlaces(): Place[] {
  const category: CategoryKey = 'bakery';
  return [
    {
      id: demoPlaceId('crumb'),
      source: 'demo',
      name: 'Crumb & Co. Bakery',
      category,
      categoryLabel: categoryLabel(category),
      emoji: categoryEmoji(category),
      city: 'London',
      location: { lat: 51.54655, lng: -0.06985 },
      demo: {
        rating: 4.7,
        reviews: 188,
        price: '£',
        hours: 'Closes 6 pm',
        hoursList: weekHours('7 am', '6 pm'),
        address: 'Dalston Ln, London E8',
        phone: '020 7946 0456',
        website: 'crumbandco.example',
        photos: [...GALLERIES.bakery],
        photoCount: 6,
      },
    },
  ];
}

/** Look up a demo place (unlaunched demo place, seeded coin or simulator launch) by id. */
export function getDemoPlace(id: string, coins?: Record<string, Coin>): Place | null {
  const fromPlaces = createDemoPlaces().find((p) => p.id === id);
  if (fromPlaces) return fromPlaces;
  const coin = coins?.[id];
  if (!coin || coin.place.source !== 'demo') return null;
  return {
    id: coin.placeId,
    source: 'demo',
    name: coin.name,
    category: coin.place.category,
    categoryLabel: categoryLabel(coin.place.category),
    emoji: coin.place.emoji,
    city: coin.place.city,
    location: coin.place.location,
    demo: coin.place.demo,
  };
}

/**
 * Deterministic backfill for seeded coins: recent trades per coin (+ their feed events), launch
 * events for coins launched in the last 6 hours and claim events for owner-verified shops.
 */
export function createMockActivity(coins: Coin[], now: number = Date.now()): { trades: Trade[]; feed: FeedEvent[] } {
  const trades: Trade[] = [];
  const feed: FeedEvent[] = [];
  for (const coin of coins) {
    const base = { placeId: coin.placeId, ticker: coin.ticker, name: coin.name, emoji: coin.logo.emoji, bg: coin.logo.bg };
    const plan = activityPlan(coin.placeId, coin.marketCapUsd);
    const rng = createRng(`activity-trades:${coin.placeId}`);
    let ts = now - plan.firstAgoMs;
    for (let i = 0; i < plan.count && ts > coin.launchedAt; i++) {
      const side: TradeSide = rng.chance(0.62) ? 'buy' : 'sell';
      const sol = Math.min(tradeSizeSol(rng), roundSol(maxTradeSol(coin, DEMO_SOL_USD)));
      const q = side === 'buy' ? quoteBuy(coin, sol, DEMO_SOL_USD) : quoteSellForSol(coin, sol, DEMO_SOL_USD);
      const wallet = fakeWallet(`${coin.placeId}:t${i}`);
      const id = `seed_${coin.placeId}_${i}`;
      trades.push({ id, placeId: coin.placeId, ticker: coin.ticker, side, usd: q.usd, sol: q.sol, tokens: q.tokens, wallet, ts, signature: fakeSignature(id) });
      feed.push({ id: `ev_${id}`, ts, kind: 'trade', ...base, side, sol: q.sol, usd: q.usd, wallet });
      ts -= rng.int(plan.gap[0], plan.gap[1]);
    }
    if (now - coin.launchedAt <= 6 * HOUR) {
      feed.push({ id: `ev_launch_${coin.placeId}`, ts: coin.launchedAt, kind: 'launch', ...base, wallet: coin.launcher });
    }
    if (coin.claimed && coin.claimedAt && coin.owner) {
      // A claim made in this browser carries the amount actually paid out (store applyClaim →
      // claimedUsd); only the fictional seeds' own past claims use a simulated share of their fees.
      const usd = coin.claimedUsd ?? Math.round(coin.feesEarnedUsd * 0.7);
      feed.push({ id: `ev_claim_${coin.placeId}`, ts: coin.claimedAt, kind: 'claim', ...base, usd, wallet: coin.owner });
    }
  }
  return { trades, feed };
}
