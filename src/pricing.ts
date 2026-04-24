import type { PriceTargets, PricingDestination } from './types';

export const BUDGET_CAPS_PER_PERSON: Record<string, number> = {
  'under-500': 500,
  '500-1000': 1000,
  '1000-1500': 1500,
  '1500-2000': 2000,
  '2000-plus': 4000,
  'no-limit': 999999,
};

export const UNLIMITED_BUDGET_IDS = new Set<string>(['no-limit']);

const NIGHTLIFE_PRICE_MAP: Record<string, number> = {
  $: 40,
  $$: 80,
  $$$: 150,
  $$$$: 250,
};

const DINING_PRICE_MAP: Record<string, number> = {
  $: 30,
  $$: 55,
  $$$: 90,
  $$$$: 140,
};

export function computePriceTargets(
  destination: PricingDestination,
  groupSize: number,
  numberOfDays: number,
  userBudget?: string
): PriceTargets {
  const nights = numberOfDays + 1;
  const gs = Math.max(groupSize, 2);
  const bigNights = Math.min(2, numberOfDays - 1);

  const lodgingByPrice = [...destination.lodging].sort(
    (a, b) =>
      (a.pricePerNight[0] + a.pricePerNight[1]) / 2 -
      (b.pricePerNight[0] + b.pricePerNight[1]) / 2
  );
  const cheapLodging = lodgingByPrice[0]!;
  const expLodging = lodgingByPrice[lodgingByPrice.length - 1]!;
  const midLodging = lodgingByPrice[Math.floor(lodgingByPrice.length / 2)]!;

  const lodgingPP = (l: typeof cheapLodging, useHigh: boolean) => {
    const rate = useHigh ? l.pricePerNight[1] : l.pricePerNight[0];
    return l.perRoom
      ? (rate * nights * Math.ceil(gs / 2)) / gs
      : (rate * nights) / gs;
  };

  const budgetLodgingPP = lodgingPP(cheapLodging, false);
  const midLodgingPP = lodgingPP(midLodging, false);
  const premLodgingPP = lodgingPP(expLodging, true);

  const venuesByPrice = [...destination.nightlife].sort(
    (a, b) =>
      (NIGHTLIFE_PRICE_MAP[a.priceRange] ?? 80) -
      (NIGHTLIFE_PRICE_MAP[b.priceRange] ?? 80)
  );
  const cheapVenues = venuesByPrice.slice(0, Math.max(3, Math.ceil(venuesByPrice.length / 3)));
  const expVenues = venuesByPrice.slice(-Math.max(3, Math.ceil(venuesByPrice.length / 3)));

  const budgetNightlife =
    (cheapVenues.reduce((s, v) => s + (NIGHTLIFE_PRICE_MAP[v.priceRange] ?? 40), 0) /
      Math.max(cheapVenues.length, 1)) *
    bigNights;
  const midNightlife =
    (venuesByPrice.reduce((s, v) => s + (NIGHTLIFE_PRICE_MAP[v.priceRange] ?? 80), 0) /
      Math.max(venuesByPrice.length, 1)) *
    bigNights;
  const premNightlife =
    (expVenues.reduce((s, v) => s + (NIGHTLIFE_PRICE_MAP[v.priceRange] ?? 150), 0) /
      Math.max(expVenues.length, 1)) *
    bigNights;

  const diningSpots = destination.dining;
  const cheapDining = diningSpots.filter(
    (d) => d.priceRange === '$' || d.priceRange === '$$'
  );
  const upscaleDining = diningSpots.filter(
    (d) => d.priceRange === '$$$' || d.priceRange === '$$$$'
  );
  const avgDining = (pool: readonly typeof diningSpots[number][]) =>
    pool.length > 0
      ? pool.reduce((s, d) => s + (DINING_PRICE_MAP[d.priceRange] ?? 60), 0) / pool.length
      : 60;
  const budgetFood =
    Math.round(avgDining(cheapDining.length > 0 ? cheapDining : diningSpots) * 2) * numberOfDays;
  const midFood = Math.round(avgDining(diningSpots) * 2) * numberOfDays;
  const premFood =
    Math.round(avgDining(upscaleDining.length > 0 ? upscaleDining : diningSpots) * 2) * numberOfDays;

  const activities = destination.activities;
  const budgetActivity =
    activities.length > 0
      ? activities.reduce((s, a) => s + a.pricePerPerson[0], 0) / activities.length
      : 50;
  const premActivity =
    activities.length > 0
      ? activities.reduce((s, a) => s + a.pricePerPerson[1], 0) / activities.length
      : 150;
  const midActivity = (budgetActivity + premActivity) / 2;

  const budgetTransport = 40 * numberOfDays;
  let midTransport = 80 * numberOfDays;
  let premTransport = 150 * numberOfDays;
  const partyBus = destination.transport.find((t) => t.type === 'party-bus');
  if (partyBus && gs >= 8) {
    const prices = (partyBus.priceRange.match(/\$[\d,]+/g) ?? []).map((s) =>
      parseInt(s.replace(/[$,]/g, ''), 10)
    );
    const isBlockRate = /for \d+ hours/i.test(partyBus.priceRange);
    const costPerNight =
      isBlockRate && prices.length >= 1
        ? prices[0]!
        : prices.length >= 1
        ? prices[0]! * 5
        : 1000;
    midTransport =
      Math.round((costPerNight * bigNights) / gs) + 40 * Math.max(numberOfDays - bigNights, 0);
    premTransport = Math.round((costPerNight * numberOfDays) / gs);
  }

  const budgetTotal = Math.round(
    budgetLodgingPP + budgetFood + budgetNightlife + budgetActivity + budgetTransport
  );
  const midTotal = Math.round(
    midLodgingPP + midFood + midNightlife + midActivity + midTransport
  );
  const premTotal = Math.round(
    premLodgingPP + premFood + premNightlife + premActivity + premTransport
  );

  const adjustedMid = Math.max(midTotal, Math.round(budgetTotal * 1.2));
  const adjustedPrem = Math.max(premTotal, Math.round(adjustedMid * 1.3));

  const maxBudget = userBudget ? BUDGET_CAPS_PER_PERSON[userBudget] ?? 999999 : 999999;

  let finalBudget = budgetTotal;
  let finalMid = adjustedMid;
  let finalPrem = adjustedPrem;

  if (maxBudget < 999999) {
    finalBudget = Math.min(budgetTotal, Math.round(maxBudget * 0.6));
    finalMid = Math.min(adjustedMid, Math.round(maxBudget * 0.85));
    finalPrem = Math.min(adjustedPrem, maxBudget);
  }

  const fmt = (n: number) => `$${Math.round(n / 50) * 50}`;
  return {
    weekendWarrior: `${fmt(finalBudget * 0.9)}–${fmt(finalBudget * 1.1)}`,
    theLegend: `${fmt(finalMid * 0.9)}–${fmt(finalMid * 1.1)}`,
    theKing: `${fmt(finalPrem * 0.9)}–${fmt(finalPrem * 1.1)}`,
  };
}

export type ArchiveTier = 'basic' | 'premium' | 'lux';

// Archive-display buckets used by /looking-back on both sites. Semantics
// match the user-facing labels (Under $800 / $800–$1,500 / $1,500+) so a
// trip priced exactly at a boundary lands where the label says it should.
// Accepts a scalar, a [lo, hi] tuple, or a { low, high } object; ranges
// bucket on the average.
export function tierForPrice(
  input: number | { low: number; high: number } | [number, number] | null | undefined
): ArchiveTier {
  if (input == null) return 'basic';
  let price: number;
  if (typeof input === 'number') {
    price = input;
  } else if (Array.isArray(input)) {
    price = (input[0] + input[1]) / 2;
  } else {
    price = (input.low + input.high) / 2;
  }
  if (!Number.isFinite(price) || price <= 0) return 'basic';
  if (price < 800) return 'basic';
  if (price < 1500) return 'premium';
  return 'lux';
}

// Single helper for every "$X/person" rendering. Prevents the concat
// footgun where a caller tacks "/person" onto a value that already
// ends in "/person". Returns "" for missing or non-positive input so
// the caller can decide on a fallback.
export function formatPricePerPerson(
  input: number | { low: number; high: number } | [number, number] | null | undefined
): string {
  if (input == null) return '';
  const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) return '';
    return `${usd(input)}/person`;
  }
  const [lo, hi] = Array.isArray(input) ? input : [input.low, input.high];
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return '';
  if (lo <= 0 && hi <= 0) return '';
  if (Math.round(lo) === Math.round(hi)) return `${usd(lo)}/person`;
  return `${usd(lo)}–${usd(hi)}/person`;
}

// ─────────────────────────────────────────────────────────────────────
//  Expense price parser (H2.5 Splitwise ledger)
//  Pulls a cents integer out of the messy price strings that AI + scraped
//  Candidates carry. Used at bind-time to auto-propose an expense row.
// ─────────────────────────────────────────────────────────────────────

export interface ParsedPrice {
  cents: number;
  perPersonHint: boolean;
}

const MONEY_RE = /\$?\s*([\d,]+(?:\.\d{2})?)/;
const PER_PERSON_RE = /(\/\s*pp|per\s*person|\/\s*person|\bpp\b|\beach\b|\bea\.)/i;

export function parseCentsFromPriceString(input: string | null | undefined): ParsedPrice | null {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  const m = s.match(MONEY_RE);
  if (!m || !m[1]) return { cents: 0, perPersonHint: PER_PERSON_RE.test(s) };
  const raw = m[1].replace(/,/g, "");
  const dollars = Number(raw);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  const cents = Math.round(dollars * 100);
  return { cents, perPersonHint: PER_PERSON_RE.test(s) };
}
