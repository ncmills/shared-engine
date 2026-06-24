/**
 * deriveLeadFields — pure, brand-agnostic derivation of the scoreable lead
 * scalars from a NORMALIZED wizard input. Zero I/O.
 *
 * Why a normalized input (not a brand WizardState): BMHQ/MOH/TDF wizards have
 * different field shapes (golf vs nightlife; budget-band id vs freeform "$2K
 * per person"; tripYear present vs absent). Rather than branch on brand inside
 * shared code, each repo maps its own WizardState → DeriveInput at the
 * generate-plan call site — which is exactly where the per-brand budget-band
 * parsing already lives. This keeps the derivation logic single-sourced and
 * the brand quirks at the edges.
 *
 * Output shape is consumed verbatim by the (later) wp_leads scalar columns:
 *   event_date, days_to_event, urgency, group_size, est_spend_usd,
 *   spend_tier, vendor_categories[]
 *
 * NOTHING here is PII — it's all coarse trip metadata derived from explicit
 * wizard selections. It is stored on StoredPlan.derived for retroactive
 * read-back at capture time, and is not yet consumed by any selling path.
 */

export type Urgency = "hot" | "warm" | "nurture";
export type SpendTier = "low" | "mid" | "high" | "premium";

/**
 * Normalized, brand-agnostic input. Each repo builds this from its own
 * WizardState. Every field is optional/nullable so a half-filled wizard
 * (auto-pick, abandonment) still derives sanely.
 */
export interface DeriveInput {
  /** 1-12 month the trip happens, or its name ("June"). Null when only a season is known. */
  eventMonth?: number | string | null;
  /** 4-digit year, e.g. 2026. Null → inferred as the next occurrence of eventMonth. */
  eventYear?: number | string | null;
  /** Coarse season ("spring"/"summer"/"fall"/"winter") when no concrete month given. */
  season?: string | null;
  /** Headcount. */
  groupSize?: number | null;
  /**
   * Per-person budget in USD. Each repo parses its own band first:
   *   - BMHQ/MOH: BUDGET_CAPS_PER_PERSON[budgetId]
   *   - TDF: parse the freeform "$2K per person" / "Fat pockets" label
   * Pass the parsed number here (the band CEILING, per-person). Null = unknown.
   */
  perPersonBudgetUsd?: number | null;
  /** Buyer-intent tokens from the wizard's activity/lodging/etc. selections. */
  activityTokens?: string[];
  lodgingTokens?: string[];
  nightlifeTokens?: string[];
  diningTokens?: string[];
  /** TDF-only golf selections (course quality, rounds, must-plays). Empty elsewhere. */
  golfTokens?: string[];
}

export interface DerivedLeadFields {
  /** ISO date (YYYY-MM-DD) of the event's first day, or null when undeterminable. */
  event_date: string | null;
  /** Whole days from `now` to event_date. Null when no date. Clamped ≥0. */
  days_to_event: number | null;
  /** <60d hot, 60–150 warm, else (or unknown) nurture. */
  urgency: Urgency;
  group_size: number | null;
  /** perPersonBudget × group_size; null when either input missing. */
  est_spend_usd: number | null;
  /** Bucketed from est_spend_usd. Defaults "mid" when spend unknown. */
  spend_tier: SpendTier;
  /** De-duped buyer-category tokens mapped from the wizard selections. */
  vendor_categories: string[];
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9,
  sept: 9, oct: 10, nov: 11, dec: 12,
};

// Season → representative month (mid-season) used only when no concrete month.
const SEASON_MONTH: Record<string, number> = {
  winter: 1, spring: 4, summer: 7, fall: 10, autumn: 10,
};

function parseMonth(m: number | string | null | undefined): number | null {
  if (m == null || m === "") return null;
  if (typeof m === "number") return m >= 1 && m <= 12 ? m : null;
  const s = String(m).trim().toLowerCase();
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n >= 1 && n <= 12 ? n : null;
  }
  return MONTHS[s] ?? null;
}

function parseYear(y: number | string | null | undefined): number | null {
  if (y == null || y === "") return null;
  const n = typeof y === "number" ? y : parseInt(String(y).trim(), 10);
  return Number.isFinite(n) && n >= 2000 && n <= 2100 ? n : null;
}

/**
 * Resolve the event's first-day ISO date.
 *  - month + year given → 1st of that month.
 *  - month only → next future occurrence of that month (this year if still
 *    ahead, else next year), 1st of the month.
 *  - season only → representative season month, same next-occurrence logic.
 *  - nothing → null.
 */
function resolveEventDate(input: DeriveInput, now: Date): string | null {
  let month = parseMonth(input.eventMonth);
  if (month == null && input.season) {
    month = SEASON_MONTH[String(input.season).trim().toLowerCase()] ?? null;
  }
  if (month == null) return null;

  let year = parseYear(input.eventYear);
  if (year == null) {
    // Pick the next occurrence: this year if the month is still ahead
    // (treat the current month as "ahead" so an in-progress month counts now),
    // otherwise next year.
    const curMonth = now.getUTCMonth() + 1;
    const curYear = now.getUTCFullYear();
    year = month >= curMonth ? curYear : curYear + 1;
  }
  const mm = String(month).padStart(2, "0");
  return `${year}-${mm}-01`;
}

function daysBetween(fromISO: string, now: Date): number {
  const target = new Date(`${fromISO}T00:00:00.000Z`).getTime();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.round((target - today) / 86_400_000));
}

function urgencyForDays(days: number | null): Urgency {
  if (days == null) return "nurture";
  if (days < 60) return "hot";
  if (days <= 150) return "warm";
  return "nurture";
}

function spendTierForUsd(est: number | null): SpendTier {
  if (est == null) return "mid";
  if (est < 6_000) return "low";
  if (est < 15_000) return "mid";
  if (est < 40_000) return "high";
  return "premium";
}

/**
 * Map raw wizard selection tokens → coarse buyer-category tokens that a lead
 * buyer (party-bus operator, steakhouse, golf course, etc.) would filter on.
 * Conservative substring matching, case-insensitive. Keep the vocabulary
 * small + stable for v1 — it's stored, not yet consumed.
 */
function mapVendorCategories(input: DeriveInput): string[] {
  const out = new Set<string>();
  const has = (tokens: string[] | undefined, ...needles: string[]): boolean => {
    if (!tokens || tokens.length === 0) return false;
    const hay = tokens.join(" ").toLowerCase();
    return needles.some((n) => hay.includes(n));
  };

  // Lodging
  if (has(input.lodgingTokens, "big", "house", "mansion", "estate", "villa"))
    out.add("big_house");
  if (has(input.lodgingTokens, "hotel", "resort", "suite")) out.add("hotel");
  if (has(input.lodgingTokens, "chef", "private-chef")) out.add("private_chef");
  if (has(input.lodgingTokens, "pool")) out.add("pool_house");
  if (has(input.lodgingTokens, "hot-tub", "hot tub")) out.add("hot_tub");

  // Transport / nightlife
  if (
    has(input.nightlifeTokens, "party-bus", "party bus", "bus") ||
    has(input.activityTokens, "party-bus", "party bus")
  )
    out.add("party_bus");
  if (has(input.nightlifeTokens, "club", "bottle", "vip")) out.add("nightclub");
  if (has(input.nightlifeTokens, "bar", "crawl", "pub", "dive")) out.add("bar_crawl");
  if (has(input.nightlifeTokens, "casino")) out.add("casino");
  if (has(input.nightlifeTokens, "comedy")) out.add("comedy");

  // Dining
  if (has(input.diningTokens, "steak", "steakhouse")) out.add("steakhouse");
  if (has(input.diningTokens, "nice", "upscale", "fine", "chef")) out.add("fine_dining");
  if (has(input.diningTokens, "brunch")) out.add("brunch");
  if (has(input.diningTokens, "bourbon", "whiskey", "distillery")) out.add("distillery");

  // Activities
  if (has(input.activityTokens, "spa", "massage")) out.add("spa");
  if (has(input.activityTokens, "winery", "wine", "vineyard")) out.add("winery");
  if (has(input.activityTokens, "brewery", "beer")) out.add("brewery");
  if (has(input.activityTokens, "boat", "yacht", "lake", "cruise", "pontoon"))
    out.add("boat_charter");
  if (has(input.activityTokens, "golf", "tee")) out.add("tee_times");
  if (has(input.activityTokens, "kart", "go-kart", "racing", "track")) out.add("karting");
  if (has(input.activityTokens, "shoot", "range", "clay", "gun")) out.add("shooting_range");
  if (has(input.activityTokens, "atv", "off-road", "adventure", "rafting", "zip"))
    out.add("adventure_outfitter");

  // Golf (TDF) — always tee_times, plus course-quality nuance.
  if (input.golfTokens && input.golfTokens.length > 0) {
    out.add("tee_times");
    if (has(input.golfTokens, "premium", "championship", "bucket", "top", "endorsed"))
      out.add("premium_golf");
    if (has(input.golfTokens, "caddie", "caddy")) out.add("caddie_service");
  }

  return [...out];
}

/**
 * Pure derivation. `now` is injected for testability + deterministic
 * server-side computation.
 */
export function deriveLeadFields(input: DeriveInput, now: Date): DerivedLeadFields {
  const event_date = resolveEventDate(input, now);
  const days_to_event = event_date ? daysBetween(event_date, now) : null;
  const urgency = urgencyForDays(days_to_event);

  const group_size =
    input.groupSize != null && Number.isFinite(input.groupSize) && input.groupSize > 0
      ? Math.round(input.groupSize)
      : null;

  const perPerson =
    input.perPersonBudgetUsd != null && Number.isFinite(input.perPersonBudgetUsd)
      ? input.perPersonBudgetUsd
      : null;

  const est_spend_usd =
    perPerson != null && group_size != null ? Math.round(perPerson * group_size) : null;

  const spend_tier = spendTierForUsd(est_spend_usd);
  const vendor_categories = mapVendorCategories(input);

  return {
    event_date,
    days_to_event,
    urgency,
    group_size,
    est_spend_usd,
    spend_tier,
    vendor_categories,
  };
}
