import { describe, expect, it } from 'vitest';
import { categoryFromGoogle, chipFromQuery } from './categories';

describe('categoryFromGoogle', () => {
  it('lets a *_restaurant primary type win over secondary cafe/bar types', () => {
    // Dishoom Shoreditch (Places API New, 2026-10)
    const types = ['indian_restaurant', 'vegetarian_restaurant', 'halal_restaurant', 'cafe', 'restaurant', 'food', 'bar', 'point_of_interest', 'establishment'];
    expect(categoryFromGoogle('indian_restaurant', types)).toBe('restaurant');
  });

  it('uses a mapped primary type', () => {
    expect(categoryFromGoogle('pizza_restaurant', ['pizza_restaurant', 'italian_restaurant', 'bar'])).toBe('pizza');
    expect(categoryFromGoogle('turkish_restaurant', ['turkish_restaurant', 'cafe'])).toBe('kebab');
    expect(categoryFromGoogle('cafe', ['cafe', 'bakery', 'restaurant'])).toBe('cafe');
    expect(categoryFromGoogle('barber_shop', [])).toBe('barber');
  });

  it('falls back to the other types in order when the primary type says nothing', () => {
    expect(categoryFromGoogle('food', ['food', 'thai_restaurant', 'bar'])).toBe('restaurant');
    expect(categoryFromGoogle(null, ['point_of_interest', 'bakery', 'cafe'])).toBe('bakery');
    expect(categoryFromGoogle(undefined, ['point_of_interest', 'establishment'])).toBe('other');
    expect(categoryFromGoogle('', null)).toBe('other');
  });
});

describe('chipFromQuery', () => {
  it('matches category phrases', () => {
    expect(chipFromQuery('kebab')).toBe('kebab');
    expect(chipFromQuery('Kebab shops')).toBe('kebab');
    expect(chipFromQuery('pizza near me')).toBe('pizza');
    expect(chipFromQuery('pub in Hackney')).toBe('pub');
    expect(chipFromQuery('coffee shop')).toBe('cafe');
  });
  it('does not match venue names that start with a category word', () => {
    expect(chipFromQuery('Pizza Pilgrims Shoreditch')).toBeNull();
    expect(chipFromQuery('Bar Italia')).toBeNull();
    expect(chipFromQuery('kebabish original')).toBeNull();
  });
  it('matches prefixes while typing unless exact', () => {
    expect(chipFromQuery('keb')).toBe('kebab');
    expect(chipFromQuery('keb', { exact: true })).toBeNull();
    expect(chipFromQuery('kebab', { exact: true })).toBe('kebab');
  });
});
