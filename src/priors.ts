import type { BrandId } from './types.js';

/**
 * Tier-2 fallback priors — "what most crews / ladies pick" for each field,
 * used by the Surprise Me button when there's no personalized signal yet.
 *
 * These are seed values informed by field defaults + common sense. A future
 * offline prior-builder job can recompute them from historical Redis plans
 * and overwrite this file. Keep brand voice considered: BESTMAN leans rowdy,
 * MOH leans elevated.
 *
 * Each entry is a weighted list. The Surprise Me endpoint picks one at
 * random (weighted); "confidence" returned is the mode's weight share.
 */

export interface WeightedChoice<T> {
  value: T;
  weight: number;
}

export type FieldPrior =
  | { kind: 'single-enum'; choices: WeightedChoice<string>[] }
  | { kind: 'multi-enum'; choices: WeightedChoice<string>[]; pickCount: [number, number] }
  | { kind: 'boolean'; choices: WeightedChoice<boolean>[] }
  | { kind: 'number'; choices: WeightedChoice<number>[] }
  | { kind: 'string-suggestions'; choices: WeightedChoice<string>[] };

export type BrandFieldPriors = Record<string, FieldPrior>;

const BESTMAN_PRIORS: BrandFieldPriors = {
  nightlifePreference: {
    kind: 'multi-enum',
    pickCount: [1, 3],
    choices: [
      { value: 'bar-crawl', weight: 35 },
      { value: 'dive-bars', weight: 20 },
      { value: 'club-bottle', weight: 15 },
      { value: 'casino-night', weight: 12 },
      { value: 'house-party', weight: 10 },
      { value: 'comedy-entertainment', weight: 8 },
    ],
  },
  activityIntensity: {
    kind: 'single-enum',
    choices: [
      { value: 'moderate', weight: 55 },
      { value: 'send-it', weight: 30 },
      { value: 'chill', weight: 15 },
    ],
  },
  vibeTags: {
    kind: 'multi-enum',
    pickCount: [2, 4],
    choices: [
      { value: 'vegas-style', weight: 25 },
      { value: 'outdoorsy', weight: 18 },
      { value: 'beach-party', weight: 15 },
      { value: 'sports-heavy', weight: 12 },
      { value: 'foodie-tour', weight: 10 },
      { value: 'mountain-escape', weight: 10 },
      { value: 'lake-house', weight: 10 },
    ],
  },
  venueQuality: {
    kind: 'single-enum',
    choices: [
      { value: 'mid-range', weight: 55 },
      { value: 'premium', weight: 25 },
      { value: 'budget', weight: 15 },
      { value: 'luxury', weight: 5 },
    ],
  },
  lodging: {
    kind: 'single-enum',
    choices: [
      { value: 'One big house', weight: 55 },
      { value: 'Luxury resort', weight: 20 },
      { value: 'Hotel block', weight: 15 },
      { value: 'Cabin', weight: 10 },
    ],
  },
  dining: {
    kind: 'multi-enum',
    pickCount: [1, 3],
    choices: [
      { value: 'steakhouse', weight: 30 },
      { value: 'casual-bbq', weight: 22 },
      { value: 'sports-bar', weight: 18 },
      { value: 'cook-at-house', weight: 15 },
      { value: 'upscale-splurge', weight: 15 },
    ],
  },
  activities: {
    kind: 'multi-enum',
    pickCount: [2, 4],
    choices: [
      { value: 'golf', weight: 25 },
      { value: 'brewery-tour', weight: 18 },
      { value: 'poker', weight: 12 },
      { value: 'shooting-range', weight: 12 },
      { value: 'water-sports', weight: 12 },
      { value: 'sports-event', weight: 10 },
      { value: 'cigar-bar', weight: 6 },
      { value: 'helicopter', weight: 5 },
    ],
  },
  budgetPriorities: {
    kind: 'multi-enum',
    pickCount: [1, 2],
    choices: [
      { value: 'lodging', weight: 30 },
      { value: 'nightlife', weight: 28 },
      { value: 'activities', weight: 22 },
      { value: 'dining', weight: 20 },
    ],
  },
  honoringMomentPreference: {
    kind: 'single-enum',
    choices: [
      { value: 'toast_round', weight: 40 },
      { value: 'roast', weight: 30 },
      { value: 'slideshow', weight: 15 },
      { value: 'low_key', weight: 10 },
      { value: 'skip', weight: 5 },
    ],
  },
  downtimePreference: {
    kind: 'single-enum',
    choices: [
      { value: 'balanced', weight: 60 },
      { value: 'packed', weight: 25 },
      { value: 'chill', weight: 15 },
    ],
  },
  dietaryRestrictions: {
    kind: 'multi-enum',
    pickCount: [0, 0],
    choices: [{ value: 'none', weight: 100 }],
  },
  soberAttendees: {
    kind: 'number',
    choices: [
      { value: 0, weight: 65 },
      { value: 1, weight: 25 },
      { value: 2, weight: 10 },
    ],
  },
  newMembers: {
    kind: 'boolean',
    choices: [
      { value: false, weight: 75 },
      { value: true, weight: 25 },
    ],
  },
  mixedGenerations: {
    kind: 'boolean',
    choices: [
      { value: false, weight: 85 },
      { value: true, weight: 15 },
    ],
  },
  recoveringInjury: {
    kind: 'boolean',
    choices: [
      { value: false, weight: 92 },
      { value: true, weight: 8 },
    ],
  },
  groomFavoriteMusic: {
    kind: 'string-suggestions',
    choices: [
      { value: 'Country', weight: 25 },
      { value: 'Hip-hop', weight: 22 },
      { value: 'Rock', weight: 18 },
      { value: 'EDM', weight: 15 },
      { value: 'Classic rock', weight: 12 },
      { value: 'Pop', weight: 8 },
    ],
  },
  groomFavoriteDrink: {
    kind: 'string-suggestions',
    choices: [
      { value: 'Bourbon', weight: 25 },
      { value: 'IPA', weight: 22 },
      { value: 'Tequila', weight: 18 },
      { value: 'Old Fashioned', weight: 15 },
      { value: 'Vodka soda', weight: 12 },
      { value: 'Light beer', weight: 8 },
    ],
  },
  groomFavoriteFood: {
    kind: 'string-suggestions',
    choices: [
      { value: 'Steak', weight: 30 },
      { value: 'BBQ', weight: 22 },
      { value: 'Burgers', weight: 18 },
      { value: 'Pizza', weight: 15 },
      { value: 'Tacos', weight: 10 },
      { value: 'Sushi', weight: 5 },
    ],
  },
};

const MOH_PRIORS: BrandFieldPriors = {
  nightlifePreference: {
    kind: 'multi-enum',
    pickCount: [1, 3],
    choices: [
      { value: 'bar-crawl', weight: 28 },
      { value: 'club-bottle', weight: 22 },
      { value: 'comedy-entertainment', weight: 15 },
      { value: 'house-party', weight: 15 },
      { value: 'dive-bars', weight: 10 },
      { value: 'casino-night', weight: 10 },
    ],
  },
  activityIntensity: {
    kind: 'single-enum',
    choices: [
      { value: 'balanced', weight: 55 },
      { value: 'unhinged', weight: 25 },
      { value: 'chill', weight: 20 },
    ],
  },
  vibeTags: {
    kind: 'multi-enum',
    pickCount: [2, 4],
    choices: [
      { value: 'boho-goddess', weight: 20 },
      { value: 'coastal-grandmother', weight: 18 },
      { value: 'vegas-style', weight: 18 },
      { value: 'wine-country', weight: 15 },
      { value: 'beach-party', weight: 12 },
      { value: 'spa-retreat', weight: 10 },
      { value: 'nashville-bach', weight: 7 },
    ],
  },
  venueQuality: {
    kind: 'single-enum',
    choices: [
      { value: 'mid-range', weight: 50 },
      { value: 'premium', weight: 28 },
      { value: 'luxury', weight: 12 },
      { value: 'budget', weight: 10 },
    ],
  },
  lodging: {
    kind: 'single-enum',
    choices: [
      { value: 'One big house', weight: 50 },
      { value: 'Luxury resort', weight: 25 },
      { value: 'Boutique hotel', weight: 15 },
      { value: 'Beach house', weight: 10 },
    ],
  },
  dining: {
    kind: 'multi-enum',
    pickCount: [1, 3],
    choices: [
      { value: 'brunch', weight: 30 },
      { value: 'upscale-splurge', weight: 22 },
      { value: 'cook-at-house', weight: 18 },
      { value: 'wine-tasting', weight: 18 },
      { value: 'casual-cafe', weight: 12 },
    ],
  },
  activities: {
    kind: 'multi-enum',
    pickCount: [2, 4],
    choices: [
      { value: 'spa-day', weight: 22 },
      { value: 'wine-tour', weight: 20 },
      { value: 'pool-day', weight: 15 },
      { value: 'dance-class', weight: 12 },
      { value: 'drag-brunch', weight: 10 },
      { value: 'boudoir', weight: 8 },
      { value: 'pole-class', weight: 8 },
      { value: 'yoga', weight: 5 },
    ],
  },
  budgetPriorities: {
    kind: 'multi-enum',
    pickCount: [1, 2],
    choices: [
      { value: 'lodging', weight: 32 },
      { value: 'dining', weight: 25 },
      { value: 'activities', weight: 23 },
      { value: 'nightlife', weight: 20 },
    ],
  },
  honoringMomentPreference: {
    kind: 'single-enum',
    choices: [
      { value: 'toast_round', weight: 38 },
      { value: 'slideshow', weight: 25 },
      { value: 'speech_circle', weight: 22 },
      { value: 'low_key', weight: 10 },
      { value: 'skip', weight: 5 },
    ],
  },
  downtimePreference: {
    kind: 'single-enum',
    choices: [
      { value: 'balanced', weight: 62 },
      { value: 'chill', weight: 22 },
      { value: 'packed', weight: 16 },
    ],
  },
  dietaryRestrictions: {
    kind: 'multi-enum',
    pickCount: [0, 1],
    choices: [
      { value: 'none', weight: 70 },
      { value: 'vegetarian', weight: 12 },
      { value: 'gluten-free', weight: 10 },
      { value: 'pescatarian', weight: 8 },
    ],
  },
  anySober: {
    kind: 'boolean',
    choices: [
      { value: false, weight: 70 },
      { value: true, weight: 30 },
    ],
  },
  anyPregnant: {
    kind: 'boolean',
    choices: [
      { value: false, weight: 78 },
      { value: true, weight: 22 },
    ],
  },
  anyMobilityLimited: {
    kind: 'boolean',
    choices: [
      { value: false, weight: 92 },
      { value: true, weight: 8 },
    ],
  },
  newMembers: {
    kind: 'boolean',
    choices: [
      { value: false, weight: 68 },
      { value: true, weight: 32 },
    ],
  },
  strictDiet: {
    kind: 'boolean',
    choices: [
      { value: false, weight: 85 },
      { value: true, weight: 15 },
    ],
  },
  brideFavoriteMusic: {
    kind: 'string-suggestions',
    choices: [
      { value: 'Pop', weight: 25 },
      { value: 'Country', weight: 22 },
      { value: 'Taylor Swift', weight: 18 },
      { value: 'R&B', weight: 15 },
      { value: 'Hip-hop', weight: 12 },
      { value: 'Indie', weight: 8 },
    ],
  },
  brideFavoriteDrink: {
    kind: 'string-suggestions',
    choices: [
      { value: 'Rosé', weight: 25 },
      { value: 'Espresso martini', weight: 20 },
      { value: 'Tequila soda', weight: 18 },
      { value: 'Champagne', weight: 15 },
      { value: 'Aperol spritz', weight: 12 },
      { value: 'White wine', weight: 10 },
    ],
  },
  brideFavoriteFood: {
    kind: 'string-suggestions',
    choices: [
      { value: 'Sushi', weight: 25 },
      { value: 'Pasta', weight: 22 },
      { value: 'Brunch', weight: 18 },
      { value: 'Charcuterie', weight: 15 },
      { value: 'Tacos', weight: 12 },
      { value: 'Thai', weight: 8 },
    ],
  },
};

/**
 * Runtime overlay registry. Consumers (sites) call `registerPriorOverlay`
 * to inject JSON-sourced popularity data built by `scripts/build-priors.ts`.
 * Only fields with sufficient sample count (enforced by the builder script)
 * land here; everything else falls back to static defaults above.
 */
const PRIOR_OVERLAYS: Record<BrandId, Partial<BrandFieldPriors>> = {
  bestman: {},
  moh: {},
};

export function registerPriorOverlay(brand: BrandId, overlay: Partial<BrandFieldPriors>): void {
  PRIOR_OVERLAYS[brand] = { ...overlay };
}

export function priorsForBrand(brand: BrandId): BrandFieldPriors {
  const base = brand === 'bestman' ? BESTMAN_PRIORS : MOH_PRIORS;
  const overlay = PRIOR_OVERLAYS[brand];
  if (!overlay || Object.keys(overlay).length === 0) return base;
  return { ...base, ...overlay } as BrandFieldPriors;
}
