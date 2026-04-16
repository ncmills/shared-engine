/**
 * Itemized Budget System (2026-04-16)
 *
 * Computes a fully itemized per-person budget from the generated plan data,
 * replacing Claude's guessed estimate with a deterministic bottom-up total.
 *
 * Each dining/bar/activity/lodging item gets a price tag with provenance
 * tracking ("data" | "claude" | "tier-default" | "clamped") so the UI can
 * show a $ badge on every card and a category breakdown at the bottom.
 */

export type BudgetTierKey = "weekendWarrior" | "theLegend" | "theKing";
export type BudgetItemCategory = "lodging" | "dining" | "bars" | "activities" | "transport" | "tips";
export type BudgetItemSource = "data" | "claude" | "tier-default" | "clamped";

export interface BudgetLineItem {
  category: BudgetItemCategory;
  name: string;
  estimatedCostPerPerson: number;
  source: BudgetItemSource;
}

export interface ItemizedBudget {
  items: BudgetLineItem[];
  subtotals: Record<string, number>;
  grandTotalPerPerson: number;
  numberOfDays: number;
  tier: string;
}

// ── Tier-based defaults ──
const TIER_DEFAULTS = {
  weekendWarrior: {
    breakfast: [15, 25] as const,
    lunch: [15, 30] as const,
    dinner: [30, 50] as const,
    barNight: [30, 50] as const,
    transportPerDay: [15, 25] as const,
    tipsPerDay: 10,
    activityDefault: [40, 80] as const,
  },
  theLegend: {
    breakfast: [25, 45] as const,
    lunch: [30, 50] as const,
    dinner: [60, 100] as const,
    barNight: [60, 100] as const,
    transportPerDay: [30, 50] as const,
    tipsPerDay: 20,
    activityDefault: [80, 150] as const,
  },
  theKing: {
    breakfast: [45, 80] as const,
    lunch: [50, 90] as const,
    dinner: [100, 175] as const,
    barNight: [100, 175] as const,
    transportPerDay: [60, 100] as const,
    tipsPerDay: 35,
    activityDefault: [150, 300] as const,
  },
} as const;

// Price range → per-person cost mapping for dining
const DINING_PRICE_MAP: Record<string, [number, number]> = {
  "$": [15, 25],
  "$$": [25, 50],
  "$$$": [50, 100],
  "$$$$": [100, 175],
};

// Price range → per-person cost mapping for bars
const BAR_PRICE_MAP: Record<string, [number, number]> = {
  "$": [20, 35],
  "$$": [35, 65],
  "$$$": [65, 120],
  "$$$$": [120, 200],
};

function midpoint(range: readonly [number, number]): number {
  return Math.round((range[0] + range[1]) / 2);
}

/** Parse "$XX" or "$XX-$YY" or "$XX/person" into a number. Returns NaN on failure. */
function parseDollarAmount(s: string | undefined | null): number {
  if (!s) return NaN;
  const nums = s.match(/[\d,]+/g)?.map((n) => parseInt(n.replace(/,/g, ""), 10)) ?? [];
  if (nums.length === 0) return NaN;
  return nums.length === 1 ? nums[0]! : Math.round((nums[0]! + nums[nums.length - 1]!) / 2);
}

/** Detect the price range symbol from a string like "$$$" or "$$" */
function detectPriceRange(pr: string | undefined): string | undefined {
  if (!pr) return undefined;
  const match = pr.match(/^\$+/);
  return match ? match[0] : undefined;
}

/**
 * Clamp a Claude-provided price if it's outside 50-200% of the tier default.
 * Returns the original if within range, or the clamped value.
 */
function clampToTier(
  claudePrice: number,
  tierDefault: number,
): { price: number; clamped: boolean } {
  const lo = tierDefault * 0.5;
  const hi = tierDefault * 2.0;
  if (claudePrice >= lo && claudePrice <= hi) {
    return { price: claudePrice, clamped: false };
  }
  return { price: Math.round(Math.min(hi, Math.max(lo, claudePrice))), clamped: true };
}

// ── Minimal plan shape so we don't depend on repo-specific GeneratedPlan ──
interface MinimalDining {
  name: string;
  priceRange?: string;
  estimatedCostPerPerson?: number;
}

interface MinimalBar {
  name: string;
  vibe?: string;
  estimatedCostPerPerson?: number;
}

interface MinimalActivity {
  name: string;
  costPerPerson?: string;
  estimatedCostPerPerson?: number;
}

interface MinimalLodging {
  name: string;
  costPerNight?: string;
}

interface MinimalScheduleDay {
  day: number;
  items: Array<{ type?: string }>;
}

interface MinimalPlan {
  dining?: MinimalDining[];
  bars?: MinimalBar[];
  activities?: MinimalActivity[];
  lodging?: MinimalLodging;
  schedule?: MinimalScheduleDay[];
  numberOfDays?: number;
  groupSize?: number;
}

export function computeItemizedBudget(
  plan: MinimalPlan,
  tierKey: BudgetTierKey,
  groupSize: number,
  numberOfDays: number,
): ItemizedBudget {
  const tier = TIER_DEFAULTS[tierKey];
  const items: BudgetLineItem[] = [];
  const gs = Math.max(groupSize, 2);
  const days = Math.max(numberOfDays, 2);

  // ── 1. Lodging ──
  if (plan.lodging) {
    const totalPerNight = parseDollarAmount(plan.lodging.costPerNight);
    const nights = days; // lodging for N days = N nights (check-in day 1, out day N+1)
    if (!isNaN(totalPerNight) && totalPerNight > 0) {
      const perPerson = Math.round((totalPerNight * nights) / gs);
      items.push({
        category: "lodging",
        name: plan.lodging.name,
        estimatedCostPerPerson: perPerson,
        source: "claude",
      });
    } else {
      // Fallback: use tier-appropriate lodging estimate
      const lodgingDefaults: Record<BudgetTierKey, number> = {
        weekendWarrior: 80,
        theLegend: 150,
        theKing: 300,
      };
      const perPerson = lodgingDefaults[tierKey] * nights;
      items.push({
        category: "lodging",
        name: plan.lodging.name || "Lodging",
        estimatedCostPerPerson: perPerson,
        source: "tier-default",
      });
    }
  }

  // ── 2. Dining ──
  const scheduledMealCount = (plan.dining ?? []).length;
  for (const d of plan.dining ?? []) {
    const priceSymbol = detectPriceRange(d.priceRange);
    const tierDefault = midpoint(tier.dinner); // default to dinner range

    if (typeof d.estimatedCostPerPerson === "number" && d.estimatedCostPerPerson > 0) {
      // Claude provided a price — validate against tier
      const { price, clamped } = clampToTier(d.estimatedCostPerPerson, tierDefault);
      items.push({
        category: "dining",
        name: d.name,
        estimatedCostPerPerson: price,
        source: clamped ? "clamped" : "claude",
      });
    } else if (priceSymbol && DINING_PRICE_MAP[priceSymbol]) {
      // Use price range from data
      items.push({
        category: "dining",
        name: d.name,
        estimatedCostPerPerson: midpoint(DINING_PRICE_MAP[priceSymbol]),
        source: "data",
      });
    } else {
      // Tier default
      items.push({
        category: "dining",
        name: d.name,
        estimatedCostPerPerson: tierDefault,
        source: "tier-default",
      });
    }
  }

  // Fill in unaccounted meals (2 meals/day assumed; subtract scheduled ones)
  const totalExpectedMeals = days * 2; // breakfast + lunch or lunch + dinner
  const unaccountedMeals = Math.max(0, totalExpectedMeals - scheduledMealCount);
  if (unaccountedMeals > 0) {
    // Split evenly between breakfast-type and lunch-type
    const breakfastCount = Math.ceil(unaccountedMeals / 2);
    const lunchCount = unaccountedMeals - breakfastCount;
    if (breakfastCount > 0) {
      items.push({
        category: "dining",
        name: `Light breakfasts (${breakfastCount} meals)`,
        estimatedCostPerPerson: midpoint(tier.breakfast) * breakfastCount,
        source: "tier-default",
      });
    }
    if (lunchCount > 0) {
      items.push({
        category: "dining",
        name: `Casual lunches (${lunchCount} meals)`,
        estimatedCostPerPerson: midpoint(tier.lunch) * lunchCount,
        source: "tier-default",
      });
    }
  }

  // ── 3. Bars ──
  for (const b of plan.bars ?? []) {
    const tierDefault = midpoint(tier.barNight);

    if (typeof b.estimatedCostPerPerson === "number" && b.estimatedCostPerPerson > 0) {
      const { price, clamped } = clampToTier(b.estimatedCostPerPerson, tierDefault);
      items.push({
        category: "bars",
        name: b.name,
        estimatedCostPerPerson: price,
        source: clamped ? "clamped" : "claude",
      });
    } else {
      items.push({
        category: "bars",
        name: b.name,
        estimatedCostPerPerson: tierDefault,
        source: "tier-default",
      });
    }
  }

  // ── 4. Activities ──
  for (const a of plan.activities ?? []) {
    const claudePrice = parseDollarAmount(a.costPerPerson);
    const tierDefault = midpoint(tier.activityDefault);

    if (typeof a.estimatedCostPerPerson === "number" && a.estimatedCostPerPerson > 0) {
      const { price, clamped } = clampToTier(a.estimatedCostPerPerson, tierDefault);
      items.push({
        category: "activities",
        name: a.name,
        estimatedCostPerPerson: price,
        source: clamped ? "clamped" : "claude",
      });
    } else if (!isNaN(claudePrice) && claudePrice > 0) {
      // Parse from costPerPerson string
      const { price, clamped } = clampToTier(claudePrice, tierDefault);
      items.push({
        category: "activities",
        name: a.name,
        estimatedCostPerPerson: price,
        source: clamped ? "clamped" : "data",
      });
    } else {
      items.push({
        category: "activities",
        name: a.name,
        estimatedCostPerPerson: tierDefault,
        source: "tier-default",
      });
    }
  }

  // ── 5. Transport ──
  const transportPerDay = midpoint(tier.transportPerDay);
  items.push({
    category: "transport",
    name: `Transport (${days} days)`,
    estimatedCostPerPerson: transportPerDay * days,
    source: "tier-default",
  });

  // ── 6. Tips / incidentals ──
  items.push({
    category: "tips",
    name: `Tips & incidentals (${days} days)`,
    estimatedCostPerPerson: tier.tipsPerDay * days,
    source: "tier-default",
  });

  // ── Compute subtotals + grand total ──
  const subtotals: Record<string, number> = {};
  for (const item of items) {
    subtotals[item.category] = (subtotals[item.category] ?? 0) + item.estimatedCostPerPerson;
  }

  const grandTotalPerPerson = items.reduce((sum, item) => sum + item.estimatedCostPerPerson, 0);

  return {
    items,
    subtotals,
    grandTotalPerPerson,
    numberOfDays: days,
    tier: tierKey,
  };
}

/**
 * Stamp estimatedCostPerPerson onto every dining/bar/activity item in-place.
 * Called as a post-processor AFTER Claude generation so every card has a price badge.
 */
export function stampItemPrices(
  plan: MinimalPlan,
  tierKey: BudgetTierKey,
): void {
  const tier = TIER_DEFAULTS[tierKey];

  for (const d of (plan.dining ?? []) as MinimalDining[]) {
    if (typeof d.estimatedCostPerPerson === "number" && d.estimatedCostPerPerson > 0) continue;
    const priceSymbol = detectPriceRange(d.priceRange);
    if (priceSymbol && DINING_PRICE_MAP[priceSymbol]) {
      d.estimatedCostPerPerson = midpoint(DINING_PRICE_MAP[priceSymbol]);
    } else {
      d.estimatedCostPerPerson = midpoint(tier.dinner);
    }
  }

  for (const b of (plan.bars ?? []) as MinimalBar[]) {
    if (typeof b.estimatedCostPerPerson === "number" && b.estimatedCostPerPerson > 0) continue;
    b.estimatedCostPerPerson = midpoint(tier.barNight);
  }

  for (const a of (plan.activities ?? []) as MinimalActivity[]) {
    if (typeof a.estimatedCostPerPerson === "number" && a.estimatedCostPerPerson > 0) continue;
    const parsed = parseDollarAmount(a.costPerPerson);
    if (!isNaN(parsed) && parsed > 0) {
      a.estimatedCostPerPerson = parsed;
    } else {
      a.estimatedCostPerPerson = midpoint(tier.activityDefault);
    }
  }
}
