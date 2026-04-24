/**
 * Trip Room H2.0 — read-time viewmodel that projects legacy storage
 * fields (voteSlots, placeholders, externalBookings, scheduleOverrides,
 * tierPlan) into the unified Candidate / CategoryPool / Slot model.
 *
 *   Legacy is canonical: all writes flow through handlers/pool.ts which
 *   update legacy fields in lockstep. This viewmodel is pure and
 *   side-effect-free. `/api/room/state` handlers call
 *   buildPoolsAndSlots(...) and attach the result to the response.
 *
 *   TierPlan shape (per plan-types.ts + schedule-utils.ts):
 *     - lodging            — 1 primary lodging item
 *     - activities[]       — flat activity candidates, path `{tier}.activities.{i}`
 *     - dining[]           — flat dining candidates, path `{tier}.dining.{i}`
 *     - bars[]             — flat bar candidates, path `{tier}.bars.{i}`
 *     - schedule[].items[] — daily narrative, NOT candidates in H2.0
 *
 *   Approved plan: ~/.claude/plans/ask-me-anyquesitons-here-happy-dream.md
 *   Full design:   ~/.claude/plans/h2-0-category-pools-design.md
 */

import type {
  Candidate,
  CandidateCategory,
  CategoryPool,
  ExternalBooking,
  PlaceholderDetail,
  PlaceholderItem,
  RoomStoredPlan,
  Slot,
  VoteSlot,
} from "./types";

/** Narrow shape the viewmodel reads off tierPlan. Defensive — both BMHQ
 *  and MOH have extra fields; we only touch these. */
export interface TierPlanLike {
  lodging?: TierItemLike;
  activities?: TierItemLike[];
  dining?: TierItemLike[];
  bars?: TierItemLike[];
}

export interface TierItemLike {
  name?: string;
  title?: string;
  description?: string;
  rationale?: string;
  highlight?: string;
  imageUrl?: string;
  image?: string;
  price?: string;
  costPerNight?: string;
  costPerPerson?: string;
  priceRange?: string;
  url?: string;
}

/** Alternate candidate shape — caller pre-computes by walking the
 *  destination catalog (same lookup /api/swap uses). */
export interface AlternateCandidate {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  highlight?: string;
  imageUrl?: string;
  image?: string;
  price?: string;
  priceRange?: string;
  url?: string;
}

export interface BuildPoolsOptions {
  /** Destination-catalog alternates bucketed by category. Emitted as
   *  additional AI candidates in each pool. Replaces the legacy Swap
   *  drawer — the user's "Replace Swap" decision. Typical payload:
   *  ~4–6 alternates per category with a primary in that category. */
  alternatesByCategory?: Partial<Record<CandidateCategory, AlternateCandidate[]>>;

  /** Tier key used to build `{tier}.dining.{i}` paths. When omitted,
   *  falls back to "tier" so paths are stable but not legacy-compatible.
   *  BMHQ/MOH pass plan.lockedTier (e.g. "theLegend"). */
  tierKey?: string;
}

const CATEGORIES: readonly CandidateCategory[] = [
  "lodging",
  "activities",
  "dining",
  "bars",
  "flights",
  "transport",
] as const;

// ────────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────────

/**
 * Derive the pool + slot view from canonical storage fields. Pure + sync.
 *
 * Emits 6 pools (one per category) even when empty, so the client can
 * render 6 cards without null-handling. `slots` contains entries for
 * every bound/voting/proposed position — positions with no activity are
 * omitted.
 */
export function buildPoolsAndSlots(
  plan: RoomStoredPlan,
  tierPlan: TierPlanLike | null | undefined,
  options: BuildPoolsOptions = {}
): { pools: CategoryPool[]; slots: Slot[] } {
  const seededAt =
    plan.lockedTierAt ?? (plan as { createdAt?: string }).createdAt ?? "";
  const tierKey = options.tierKey ?? "tier";

  const candidates: Candidate[] = [];

  // 1. AI-seeded candidates from tierPlan flat arrays + alternates.
  if (tierPlan) {
    candidates.push(
      ...buildAiCandidates(
        tierPlan,
        options.alternatesByCategory ?? {},
        seededAt,
        tierKey
      )
    );
  }

  // 2. User candidates migrated from externalBookings.
  for (const eb of plan.externalBookings ?? []) {
    candidates.push(externalBookingToCandidate(eb));
  }

  // 3. User candidates migrated from placeholders (owner's TBD markers).
  for (const ph of plan.placeholders ?? []) {
    candidates.push(placeholderToCandidate(ph));
  }

  // 4. Bucket into 6 pools. Always emit all 6 even when empty.
  const candidatesByCategory = new Map<CandidateCategory, Candidate[]>();
  for (const cat of CATEGORIES) candidatesByCategory.set(cat, []);
  for (const c of candidates) {
    candidatesByCategory.get(c.category)?.push(c);
  }
  const pools: CategoryPool[] = CATEGORIES.map((category) => ({
    category,
    candidates: (candidatesByCategory.get(category) ?? []).sort(aiFirstThenInsertionOrder),
  }));

  // 5. Derive slots from legacy fields + scheduleOverrides.
  const slots = deriveSlotsFromLegacyFields(plan, tierPlan ?? null, candidates);

  return { pools, slots };
}

// ────────────────────────────────────────────────────────────────────────
// AI-candidate seeding
// ────────────────────────────────────────────────────────────────────────

function buildAiCandidates(
  tierPlan: TierPlanLike,
  alternatesByCategory: Partial<Record<CandidateCategory, AlternateCandidate[]>>,
  seededAt: string,
  tierKey: string
): Candidate[] {
  const out: Candidate[] = [];

  // ── Lodging — 1 primary ──
  if (tierPlan.lodging) {
    out.push({
      id: "cand_ai_lodging",
      category: "lodging",
      source: "ai",
      tierPath: "lodging",
      title: tierPlan.lodging.name ?? tierPlan.lodging.title,
      description: tierPlan.lodging.description ?? tierPlan.lodging.rationale,
      imageUrl: tierPlan.lodging.imageUrl ?? tierPlan.lodging.image,
      price: tierPlan.lodging.costPerNight ?? tierPlan.lodging.priceRange ?? tierPlan.lodging.price,
      url: tierPlan.lodging.url,
      addedBy: "ai",
      addedAt: seededAt,
    });
  }

  // ── Flat-array candidates: activities / dining / bars ──
  pushFlatArray(out, tierPlan.activities, "activities", tierKey, seededAt);
  pushFlatArray(out, tierPlan.dining, "dining", tierKey, seededAt);
  pushFlatArray(out, tierPlan.bars, "bars", tierKey, seededAt);

  // ── Category-level alternates from destination catalog ──
  for (const category of CATEGORIES) {
    const alts = alternatesByCategory[category] ?? [];
    alts.forEach((alt, i) => {
      const syntheticPath =
        category === "lodging"
          ? `lodging.alt.${i}`
          : `${tierKey}.${category}.alt.${i}`;
      out.push(alternateToCandidate(alt, category, syntheticPath, seededAt));
    });
  }

  return out;
}

function pushFlatArray(
  out: Candidate[],
  arr: TierItemLike[] | undefined,
  category: CandidateCategory,
  tierKey: string,
  seededAt: string
): void {
  (arr ?? []).forEach((item, i) => {
    out.push({
      id: `cand_ai_${tierKey}.${category}.${i}`,
      category,
      source: "ai",
      tierPath: `${tierKey}.${category}.${i}`,
      title: item.name ?? item.title,
      description: item.description ?? item.rationale ?? item.highlight,
      imageUrl: item.imageUrl ?? item.image,
      price: item.priceRange ?? item.costPerPerson ?? item.costPerNight ?? item.price,
      url: item.url,
      addedBy: "ai",
      addedAt: seededAt,
    });
  });
}

function alternateToCandidate(
  alt: AlternateCandidate,
  category: CandidateCategory,
  syntheticPath: string,
  seededAt: string
): Candidate {
  return {
    id: `cand_ai_${syntheticPath}`,
    category,
    source: "ai",
    tierPath: syntheticPath,
    title: alt.title ?? alt.name,
    description: alt.description ?? alt.highlight,
    imageUrl: alt.imageUrl ?? alt.image,
    price: alt.priceRange ?? alt.price,
    url: alt.url,
    addedBy: "ai",
    addedAt: seededAt,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Legacy → Candidate migration
// ────────────────────────────────────────────────────────────────────────

function externalBookingToCandidate(eb: ExternalBooking): Candidate {
  const category = externalBookingTypeToCategory(eb.type);
  return {
    id: eb.id,
    category,
    // url present → treat as link-sourced; otherwise text-typed
    source: eb.url ? "link" : "text",
    title: eb.name,
    url: eb.url,
    price: eb.price,
    addedBy: eb.addedBy,
    addedAt: eb.addedAt,
    notes: eb.notes,
  };
}

function placeholderToCandidate(ph: PlaceholderItem): Candidate {
  return {
    id: ph.id,
    category: placeholderDetailToCategory(ph.detail),
    source: "text",
    title: ph.customLabel || ph.detail,
    addedBy: "owner",
    addedAt: ph.createdAt,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Category classification
// ────────────────────────────────────────────────────────────────────────

export function placeholderDetailToCategory(
  detail: PlaceholderDetail
): CandidateCategory {
  switch (detail) {
    case "Dinner":
    case "Lunch":
    case "Brunch":
      return "dining";
    case "Bar":
      return "bars";
    case "Activity":
    case "Spa":
    case "Downtime":
    case "Other":
    default:
      return "activities";
  }
}

export function externalBookingTypeToCategory(
  type: ExternalBooking["type"]
): CandidateCategory {
  switch (type) {
    case "lodging":
      return "lodging";
    case "dining":
      return "dining";
    case "bars":
      return "bars";
    case "activity":
      return "activities";
    case "transport":
      return "transport";
    case "other":
    default:
      return "activities";
  }
}

// ────────────────────────────────────────────────────────────────────────
// Slot derivation
// ────────────────────────────────────────────────────────────────────────

/** Sort comparator: AI-seeded candidates first (primary before alts),
 *  then insertion order by addedAt ascending. */
export function aiFirstThenInsertionOrder(a: Candidate, b: Candidate): number {
  const aAi = a.source === "ai";
  const bAi = b.source === "ai";
  if (aAi && !bAi) return -1;
  if (!aAi && bAi) return 1;
  // Within AI: primary (no .alt.) before alternates
  if (aAi && bAi) {
    const aIsAlt = a.tierPath?.includes(".alt.") ?? false;
    const bIsAlt = b.tierPath?.includes(".alt.") ?? false;
    if (!aIsAlt && bIsAlt) return -1;
    if (aIsAlt && !bIsAlt) return 1;
  }
  return (a.addedAt ?? "").localeCompare(b.addedAt ?? "");
}

/**
 * Project legacy voteSlots + scheduleOverrides + placeholders into the
 * unified Slot[] view.
 *
 * Lodging is always a single trip-scoped slot when tierPlan.lodging
 * exists. Day-time slots emerge wherever voteSlots are open, bindings
 * exist via scheduleOverrides, or placeholders mark "proposed"
 * positions.
 */
export function deriveSlotsFromLegacyFields(
  plan: RoomStoredPlan,
  tierPlan: TierPlanLike | null,
  candidates: Candidate[]
): Slot[] {
  const out: Slot[] = [];
  const candidateByTierPath = new Map<string, Candidate>();
  const candidateById = new Map<string, Candidate>();
  for (const c of candidates) {
    if (c.tierPath) candidateByTierPath.set(c.tierPath, c);
    candidateById.set(c.id, c);
  }

  // ── Lodging trip-scoped slot ──
  if (tierPlan?.lodging) {
    // Owner may have bound a user-added lodging externalBooking; treat
    // the most recent lodging ExternalBooking as the bound candidate if
    // present, else the AI primary.
    const userLodging = (plan.externalBookings ?? [])
      .filter((eb) => eb.type === "lodging")
      .sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? ""))[0];
    const boundId = userLodging?.id ?? "cand_ai_lodging";
    out.push({
      id: "slot_lodging",
      category: "lodging",
      scope: "trip",
      status: "locked",
      boundCandidateId: boundId,
      createdBy: "ai",
      createdAt: plan.lockedTierAt ?? "",
    });
  }

  // ── Day-time slots from voteSlots (open + closed) ──
  for (const vs of plan.voteSlots ?? []) {
    const slot = voteSlotToSlot(vs, candidateByTierPath, candidateById);
    if (slot) out.push(slot);
  }

  // ── Day-time slots from scheduleOverrides for bound AI items that
  //    don't have an active vote. Represents "owner moved/locked this
  //    AI item to a specific day/time." ──
  const overrides = plan.scheduleOverrides ?? {};
  for (const [tierPath, pos] of Object.entries(overrides)) {
    if (pos.dayIdx < 0) continue; // unscheduled
    const cand =
      candidateByTierPath.get(tierPath) ?? candidateById.get(tierPath);
    if (!cand) continue;
    if (cand.category === "lodging") continue;
    // Skip if this candidate is already represented by an open vote
    if (isInOpenVote(cand, plan.voteSlots ?? [], candidateByTierPath)) continue;
    out.push({
      id: `slot_override_${tierPath}`,
      category: cand.category,
      scope: "day-time",
      dayIdx: pos.dayIdx,
      time: pos.time,
      status: "locked",
      boundCandidateId: cand.id,
      createdBy: "owner",
      createdAt: cand.addedAt,
    });
  }

  // ── Placeholder-derived proposed slots ──
  for (const ph of plan.placeholders ?? []) {
    out.push({
      id: `slot_proposed_${ph.id}`,
      category: placeholderDetailToCategory(ph.detail),
      scope: "day-time",
      dayIdx: ph.dayIdx,
      time: ph.time,
      label: ph.customLabel || ph.detail,
      status: "proposed",
      createdBy: "owner",
      createdAt: ph.createdAt,
    });
  }

  return out;
}

function voteSlotToSlot(
  vs: VoteSlot,
  candidateByTierPath: Map<string, Candidate>,
  candidateById: Map<string, Candidate>
): Slot | null {
  const voteCandidateIds: string[] = [];
  let category: CandidateCategory | null = null;
  for (const itemPath of vs.itemPaths) {
    const cand =
      candidateByTierPath.get(itemPath) ?? candidateById.get(itemPath);
    if (cand) {
      voteCandidateIds.push(cand.id);
      if (!category) category = cand.category;
    }
  }
  if (!category) return null;

  const isClosed = !!vs.closedAt;
  let boundCandidateId: string | undefined;
  if (isClosed && vs.winnerItemPath) {
    const winner =
      candidateByTierPath.get(vs.winnerItemPath) ??
      candidateById.get(vs.winnerItemPath);
    boundCandidateId = winner?.id;
  }

  return {
    id: `slot_vote_${vs.slotId}`,
    category,
    scope: "day-time",
    dayIdx: vs.dayIdx,
    time: vs.time,
    label: vs.label,
    status: isClosed ? "locked" : "voting",
    boundCandidateId,
    voteCandidateIds,
    voteOpenedAt: vs.openAt,
    voteClosedAt: vs.closedAt,
    createdBy: "owner",
    createdAt: vs.openAt,
  };
}

function isInOpenVote(
  cand: Candidate,
  voteSlots: VoteSlot[],
  candidateByTierPath: Map<string, Candidate>
): boolean {
  for (const vs of voteSlots) {
    if (vs.closedAt) continue;
    for (const itemPath of vs.itemPaths) {
      const resolved = candidateByTierPath.get(itemPath);
      if (resolved?.id === cand.id) return true;
      if (itemPath === cand.id) return true;
    }
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────
// H3.3 — Trip stage machine
// ────────────────────────────────────────────────────────────────────────
// Derives a richer lifecycle state than the stored `plan.stage` field.
// `live` + `archived` are computed from `now` against check-in/check-out
// dates, and only surface once the owner has locked or finalized the trip
// (never from preview). The consumer UI branches on this to promote
// Map/HappeningNow (live) or MemoriesSection (archived). Pure + sync +
// injectable clock so tests/goldens stay deterministic.

export type TripStage =
  | "preview"
  | "locked"
  | "finalized"
  | "live"
  | "archived";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Grace window after check-out before a trip flips to archived. Lets
 *  crew upload memories while the weekend is still fresh. */
const ARCHIVE_GRACE_DAYS = 3;

export function computeTripStage(
  plan: RoomStoredPlan,
  now: Date = new Date()
): TripStage {
  const base: TripStage =
    plan.stage === "finalized"
      ? "finalized"
      : plan.stage === "locked"
      ? "locked"
      : "preview";

  // Preview never escalates to live/archived.
  if (base === "preview") return "preview";

  // Prefer the owner-confirmed finalCheck* fields; fall back to
  // wizard-provided `inputs.checkIn/checkOut` (open-type shape).
  const wizardInputs = plan.inputs as
    | { checkIn?: string; checkOut?: string }
    | undefined;
  const checkIn = parseTripDate(plan.finalCheckIn ?? wizardInputs?.checkIn);
  const checkOut = parseTripDate(plan.finalCheckOut ?? wizardInputs?.checkOut);

  if (!checkIn || !checkOut) return base;

  // Trip "ends" at the end of the check-out day; add 1 day so a `now`
  // anywhere during checkOut still counts as live.
  const endOfCheckOut = new Date(checkOut.getTime() + DAY_MS);
  const archiveBoundary = new Date(
    endOfCheckOut.getTime() + ARCHIVE_GRACE_DAYS * DAY_MS
  );

  if (now >= archiveBoundary) return "archived";
  if (now >= checkIn && now < endOfCheckOut) return "live";
  return base;
}

function parseTripDate(input: string | undefined | null): Date | null {
  if (!input) return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}
