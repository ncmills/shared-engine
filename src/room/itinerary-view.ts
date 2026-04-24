/**
 * Trip Room H3.2 — itinerary view model.
 *
 * Flattens plan + tierPlan + scheduleOverrides + bound slots into a
 * single normalized `ItineraryItem[]` that all three H3.2 views
 * (Calendar, List, Map) consume. Pure function — caller supplies the
 * raw shapes, we hand back the normalized rows.
 *
 * Design note: we mirror the read-time derivation pattern used in
 * H2.0 `viewmodel.ts`. The canonical truth stays in
 * `plan.tierPlan.schedule[]` + `plan.scheduleOverrides` + `plan.slots[]`
 * — this helper doesn't write anything.
 */
import type { CandidateCategory, RoomStoredPlan } from "./types";

export type TripViewKey = "map" | "calendar" | "list" | "pools";

export interface ItineraryItem {
  /** Stable key per render: the tierPath or a user-bound candidate id. */
  itemPath: string;
  /** Short human label. */
  title: string;
  category: CandidateCategory;
  /** 0-based day index; null = unscheduled (e.g. trip-scope lodging). */
  dayIdx: number | null;
  /** Human-readable time ("7:00 PM"); null = unscheduled / trip-scope. */
  time: string | null;
  /** Optional venue detail (e.g. "Dinner at FIG"). */
  subtitle?: string;
  /** External booking URL if known (for ListView cell + Map info). */
  url?: string;
  /** Display price string, e.g. "$125 / pp". */
  price?: string;
  /** Source of the item — for Map/List filter affordances. */
  source: "ai" | "link" | "text" | "email" | "schedule";
  /** City where the venue lives — powers Map city-center fallback + geocoding. */
  cityLabel?: string;
}

export interface BuildItineraryInput {
  plan: RoomStoredPlan;
  /** tierPlan shape is repo-local — caller passes narrowed slice. */
  tierPlan?: TierPlanShape | null;
  /** Default time by placeholder detail, repo may override. */
  defaultTimeFor?: (detail: string) => string;
}

interface TierPlanShape {
  schedule?: Array<{
    dayIdx: number;
    title?: string;
    time?: string;
    detail?: string;
    category?: string;
    url?: string;
    price?: string;
    itemPath?: string;
  }>;
  lodging?: {
    name?: string;
    url?: string;
    price?: string;
    nights?: number;
  };
  destination?: {
    city?: string;
    state?: string;
  };
}

/**
 * Produce a flat list of itinerary rows from the canonical storage.
 * Applies plan.scheduleOverrides to reposition tierPlan schedule items
 * by their itemPath (matches DayScheduleView's buildSchedule pattern).
 */
export function buildItineraryItems(
  input: BuildItineraryInput
): ItineraryItem[] {
  const { plan, tierPlan } = input;
  const overrides = plan.scheduleOverrides ?? {};
  const cityLabel = tierPlan?.destination?.city
    ? [tierPlan.destination.city, tierPlan.destination.state].filter(Boolean).join(", ")
    : undefined;
  const rows: ItineraryItem[] = [];

  // 1) tierPlan.schedule[] — the AI-generated backbone.
  for (const evt of tierPlan?.schedule ?? []) {
    const path = evt.itemPath ?? `tier.${evt.dayIdx}.${evt.title ?? ""}`;
    const ov = overrides[path];
    const category = normalizeCategory(evt.category ?? evt.detail);
    rows.push({
      itemPath: path,
      title: (evt.title ?? "Scheduled event").slice(0, 140),
      category,
      dayIdx: ov?.dayIdx ?? evt.dayIdx,
      time: ov?.time ?? evt.time ?? null,
      subtitle: evt.detail,
      url: evt.url,
      price: evt.price,
      source: "schedule",
      cityLabel,
    });
  }

  // 2) tierPlan.lodging — trip-scope (no day/time).
  if (tierPlan?.lodging?.name) {
    rows.push({
      itemPath: "tierPlan.lodging",
      title: tierPlan.lodging.name,
      category: "lodging",
      dayIdx: null,
      time: null,
      url: tierPlan.lodging.url,
      price: tierPlan.lodging.price,
      source: "schedule",
      cityLabel,
    });
  }

  // 3) User-added Candidates that have been bound to a day-time or trip-scope.
  const boundSlots = (plan.slots ?? []).filter((s) => s.status === "locked");
  for (const slot of boundSlots) {
    const cand = (plan.candidates ?? []).find((c) => c.id === slot.boundCandidateId);
    if (!cand) continue;
    // Skip AI slots — they map back to tierPlan schedule rows already added above
    // (handled via scheduleOverrides on the AI path).
    if (cand.source === "ai") continue;
    rows.push({
      itemPath: cand.id,
      title: cand.title ?? "(untitled)",
      category: cand.category,
      dayIdx: slot.dayIdx ?? null,
      time: slot.time ?? null,
      subtitle: cand.description,
      url: cand.url,
      price: cand.price,
      source: cand.source,
      cityLabel,
    });
  }

  return rows;
}

/**
 * Build the set of distinct venue queries that `/api/room/geocode`
 * should resolve for a set of itinerary items. Deduped by
 * `${title} ${cityLabel}` so we hit Places only once per venue.
 */
export function buildGeocodeQueries(items: ItineraryItem[]): Array<{
  key: string;
  title: string;
  cityLabel?: string;
}> {
  const seen = new Set<string>();
  const out: Array<{ key: string; title: string; cityLabel?: string }> = [];
  for (const it of items) {
    const key = `${it.title.toLowerCase()}|${(it.cityLabel ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, title: it.title, cityLabel: it.cityLabel });
  }
  return out;
}

function normalizeCategory(raw?: string): CandidateCategory {
  if (!raw) return "activities";
  const r = raw.toLowerCase();
  if (r.includes("lodg") || r.includes("hotel") || r.includes("rental")) return "lodging";
  if (r.includes("din") || r.includes("food") || r.includes("brunch") || r.includes("lunch")) return "dining";
  if (r.includes("bar") || r.includes("nightlife") || r.includes("club")) return "bars";
  if (r.includes("flight") || r.includes("air")) return "flights";
  if (r.includes("transp") || r.includes("uber") || r.includes("shuttle")) return "transport";
  return "activities";
}
