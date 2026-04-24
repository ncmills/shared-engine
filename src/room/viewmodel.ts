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
  schedule?: Array<TierEventLike>;
  lodging?: TierItemLike;
}

export interface TierEventLike {
  path?: string;
  title?: string;
  name?: string;
  description?: string;
  time?: string;
  dayIdx?: number;
  category?: string;
  imageUrl?: string;
  image?: string;
  price?: string;
  url?: string;
}

export interface TierItemLike {
  name?: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  image?: string;
  price?: string;
  url?: string;
}

/** Alternate candidate shape — caller pre-computes by walking the
 *  destination catalog (same lookup /api/swap uses). */
export interface AlternateCandidate {
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  image?: string;
  price?: string;
  url?: string;
}

export interface BuildPoolsOptions {
  /** Keyed by the primary AI tierPath (e.g. "lodging",
   *  "theLegend.dining.2"). Each value is an array of up to 4–10
   *  destination-catalog alternates that get emitted as additional AI
   *  Candidates in the same pool, replacing the current Swap drawer. */
  alternatesByPath?: Record<string, AlternateCandidate[]>;
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
 * omitted (renderable from derivedSlots + tierPlan).
 */
export function buildPoolsAndSlots(
  plan: RoomStoredPlan,
  tierPlan: TierPlanLike | null | undefined,
  options: BuildPoolsOptions = {}
): { pools: CategoryPool[]; slots: Slot[] } {
  const seededAt =
    plan.lockedTierAt ?? (plan as { createdAt?: string }).createdAt ?? "";

  const candidates: Candidate[] = [];

  // 1. AI-seeded candidates from tierPlan + alternates.
  if (tierPlan) {
    candidates.push(...buildAiCandidates(tierPlan, options.alternatesByPath ?? {}, seededAt));
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
  alternatesByPath: Record<string, AlternateCandidate[]>,
  seededAt: string
): Candidate[] {
  const out: Candidate[] = [];

  // ── Lodging — 1 primary + alternates from catalog ──
  if (tierPlan.lodging) {
    out.push({
      id: "cand_ai_lodging",
      category: "lodging",
      source: "ai",
      tierPath: "lodging",
      title: tierPlan.lodging.name ?? tierPlan.lodging.title,
      description: tierPlan.lodging.description,
      imageUrl: tierPlan.lodging.imageUrl ?? tierPlan.lodging.image,
      price: tierPlan.lodging.price,
      url: tierPlan.lodging.url,
      addedBy: "ai",
      addedAt: seededAt,
    });
    const lodgingAlts = alternatesByPath["lodging"] ?? [];
    lodgingAlts.forEach((alt, i) => {
      out.push(alternateToCandidate(alt, "lodging", `lodging.alt.${i}`, seededAt));
    });
  }

  // ── Schedule items — primary + per-item alternates ──
  for (const ev of tierPlan.schedule ?? []) {
    const path = ev.path;
    if (!path) continue;
    const category = classifyEventCategory(ev);
    out.push({
      id: `cand_ai_${path}`,
      category,
      source: "ai",
      tierPath: path,
      title: ev.title ?? ev.name,
      description: ev.description,
      imageUrl: ev.imageUrl ?? ev.image,
      price: ev.price,
      url: ev.url,
      addedBy: "ai",
      addedAt: seededAt,
    });
    const alts = alternatesByPath[path] ?? [];
    alts.forEach((alt, i) => {
      out.push(alternateToCandidate(alt, category, `${path}.alt.${i}`, seededAt));
    });
  }

  return out;
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
    description: alt.description,
    imageUrl: alt.imageUrl ?? alt.image,
    price: alt.price,
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

/** Classify a tierPlan schedule event into a CandidateCategory. Reads
 *  `ev.category` when set; else parses the second segment of
 *  `theLegend.dining.2`-style paths; else falls back to activities. */
export function classifyEventCategory(ev: TierEventLike): CandidateCategory {
  const raw = (ev.category ?? "").toLowerCase();
  if (raw === "lodging") return "lodging";
  if (raw === "dining" || raw === "food") return "dining";
  if (raw === "bars" || raw === "nightlife" || raw === "bar") return "bars";
  if (raw === "activities" || raw === "activity") return "activities";
  if (raw === "flights" || raw === "flight") return "flights";
  if (raw === "transport" || raw === "transportation") return "transport";

  // Fallback: parse path segment (e.g. "theLegend.dining.2")
  const seg = ev.path?.split(".")[1]?.toLowerCase();
  if (seg === "dining") return "dining";
  if (seg === "bars" || seg === "nightlife") return "bars";
  if (seg === "activities") return "activities";
  if (seg === "lodging") return "lodging";

  return "activities";
}

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
  const voteSlotSlotIds = new Set<string>();
  for (const vs of plan.voteSlots ?? []) {
    voteSlotSlotIds.add(vs.slotId);
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
