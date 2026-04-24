/**
 * Trip Room V1.2 (2026-04-22) — shared types.
 *
 * These types were lifted verbatim from BESTMAN + MOH plan-types.ts so both
 * repos import the same shape. StoredPlan is imported by reference (handlers
 * take `plan: any`-typed input and the consumer repo narrows it) so the
 * shared package stays repo-agnostic.
 */

export type LockedTier = "weekendWarrior" | "theLegend" | "theKing";

export type PlaceholderDetail =
  | "Dinner"
  | "Lunch"
  | "Brunch"
  | "Activity"
  | "Bar"
  | "Spa"
  | "Downtime"
  | "Other";

export interface PlaceholderItem {
  id: string;
  type: "placeholder";
  detail: PlaceholderDetail;
  /** Required when detail === "Other" — owner-typed label. */
  customLabel?: string;
  dayIdx: number;
  time: string;
  createdAt: string;
}

/**
 * Owner drops 2+ candidate items into the SAME time slot and flips
 * "Put this up for group vote." Participants see the candidates
 * side-by-side and vote for one.
 */
export interface VoteSlot {
  slotId: string;
  /** Paths of the candidate items, e.g. ["theLegend.dining.2", "theLegend.dining.5"]. */
  itemPaths: string[];
  dayIdx: number;
  time: string;
  /** Human title so the card can show "Saturday 7pm dinner" without resolving. */
  label?: string;
  openAt: string;
  closedAt?: string;
  /** Once closed, the winning item path is written here and fills the slot. */
  winnerItemPath?: string;
}

export interface ExternalBooking {
  id: string;
  type: "activity" | "dining" | "lodging" | "bars" | "transport" | "other";
  name: string;
  when?: string;
  where?: string;
  url?: string;
  price?: string;
  participants?: string;
  notes?: string;
  addedBy: string;
  addedAt: string;
}

export type PersonalItemType =
  | "arrival-flight"
  | "departure-flight"
  | "arrival-time"
  | "departure-time"
  | "dietary-note"
  | "custom";

export interface PersonalItem {
  id: string;
  plan_id: string;
  participant_session_hash: string;
  participant_display_name: string | null;
  type: PersonalItemType;
  details: Record<string, unknown>;
  updated_at: string;
}

export interface TripRoomMember {
  session_hash: string;
  display_name: string | null;
  role: string;
  joined_at: string;
}

export interface SlotVoteRow {
  slot_id: string;
  voter_session_hash: string;
  chosen_item_path: string;
  updated_at?: string;
}

/**
 * Shape returned by GET /api/room/state. Owner state + collaborative layer
 * only — never includes the full plan JSON (the page already has that).
 */
export interface TripRoomState {
  sessionHash: string;
  isOwner: boolean;
  isOriginalOwner: boolean;
  stage?: string;
  lockedTier?: LockedTier;
  externalBookings: ExternalBooking[];
  finalCheckIn?: string;
  finalCheckOut?: string;
  finalGuestCount?: number;
  homeAirport?: string;
  slug?: string;
  coOwners: string[];
  members: TripRoomMember[];
  slotVotes: SlotVoteRow[];
  personalItems: PersonalItem[];
  note?: string;
  /**
   * H2.0 — read-time view derived from the canonical storage fields
   * (placeholders, externalBookings, voteSlots, scheduleOverrides, tierPlan).
   * Flag-independent: always populated. Clients gated on
   * NEXT_PUBLIC_UNIVERSAL_SLOT consume this; legacy clients ignore it.
   */
  categoryPools?: CategoryPool[];
  derivedSlots?: Slot[];
}

/**
 * Fields on `StoredPlan.inputs` the room handlers peek at. Left as an
 * open type — callers hand their concrete WizardState and we only read
 * these optional fields defensively.
 */
export interface RoomStoredPlanInputs {
  organizerEmail?: string;
  organizerName?: string;
  bridePersonality?: string;
  groomPersonality?: string;
}

/** StoredPlan subset the handlers rely on — both repos' StoredPlan satisfies this. */
export interface RoomStoredPlan {
  id: string;
  inputs?: RoomStoredPlanInputs;
  coOwners?: string[];
  voteSlots?: VoteSlot[];
  placeholders?: PlaceholderItem[];
  externalBookings?: ExternalBooking[];
  scheduleOverrides?: Record<string, { dayIdx: number; time: string }>;
  stage?: string;
  lockedTier?: LockedTier;
  lockedTierAt?: string;
  lockedBy?: string;
  finalizedAt?: string;
  finalizedBy?: string;
  finalCheckIn?: string;
  finalCheckOut?: string;
  finalGuestCount?: number;
  homeAirport?: string;
  slug?: string;
  /** Destination tiers (budget/mid/premium). Typed defensively — handlers
   *  only read `destinations?.<tier>?.plans?.<tierName>?.tripName`. */
  destinations?: unknown;
  /**
   * H2.0 — additive storage for the universal Slot + Candidate primitive.
   * Written alongside the legacy fields (voteSlots, placeholders,
   * externalBookings, scheduleOverrides) which remain canonical for
   * H2.0. Clients read the derived TripRoomState.categoryPools /
   * derivedSlots view rather than these fields directly.
   */
  candidates?: Candidate[];
  slots?: Slot[];
}

// ────────────────────────────────────────────────────────────────────────
// H2.0 — Universal Slot + CategoryPool primitive
// ────────────────────────────────────────────────────────────────────────
// The Candidate + Slot model unifies four previously disjoint primitives
// (PlaceholderItem, ExternalBooking, VoteSlot, scheduleOverrides) under
// one pool-based UX. Storage stays backwards-compat: these types layer on
// top of the existing fields, with read-time derivation in viewmodel.ts
// and write-through to the legacy fields in handlers/pool.ts.
//
// Full design doc: ~/.claude/plans/h2-0-category-pools-design.md
// Approved plan:   ~/.claude/plans/ask-me-anyquesitons-here-happy-dream.md

export type CandidateCategory =
  | "lodging"
  | "activities"
  | "dining"
  | "bars"
  | "flights"
  | "transport";

export type CandidateSource = "ai" | "link" | "text" | "email";

/**
 * A Candidate is anything that can fill a Slot. One shape regardless of
 * where it came from. `source` is the provenance; attribution is always
 * `addedBy` + optional `addedByName`.
 *
 * AI-seeded candidates are virtualized views of items already in
 * `tierPlan.schedule[]` / `tierPlan.lodging` (+ destination-catalog
 * alternates pre-computed by the caller). They carry a `tierPath`
 * pointer and do NOT duplicate the underlying event data — the viewmodel
 * resolves `tierPath` → full event at render time.
 *
 * Non-AI candidates store their data inline; they have no `tierPath`.
 */
export interface Candidate {
  id: string;
  category: CandidateCategory;
  source: CandidateSource;

  /** AI-seeded only: points to a path in the locked tierPlan or a
   *  caller-provided alternate (e.g. "theLegend.dining.2" or
   *  "lodging.alt.0"). */
  tierPath?: string;

  /** Display fields — optional because the viewmodel fills them for AI
   *  rows from the referenced tierPath. */
  title?: string;
  description?: string;
  imageUrl?: string;
  url?: string;
  price?: string;
  providerName?: string;

  /** Attribution. `addedBy === "ai"` is the sentinel for engine-seeded. */
  addedBy: string;
  addedByName?: string;
  addedAt: string;

  /** Free-text only: the author's intent. */
  notes?: string;

  /** Ephemeral UI hint — carried on the object so it survives polls.
   *  Set while an OG scrape is mid-fetch. Never persisted to Redis. */
  draft?: boolean;
}

/**
 * A CategoryPool is the set of Candidates the crew is considering for a
 * single category. Pools are DERIVED at read-time (see viewmodel.ts),
 * not stored — the storage field `RoomStoredPlan.candidates` is a flat
 * list, and the viewmodel buckets into pools.
 */
export interface CategoryPool {
  category: CandidateCategory;
  candidates: Candidate[];
}

/**
 * A Slot is a position on the itinerary that binds one Candidate.
 *
 * Scope is encoded via optional fields:
 *   - Lodging → { scope: "trip" }                    1 per trip
 *   - Activity/Dining/Bar → { scope: "day-time",
 *                             dayIdx, time }          many per trip
 *   - Flight → { scope: "per-person",
 *                ownerEmail, direction }              H3 reserved
 *   - Transport → { scope: "leg", legKey }            H3 reserved
 */
export type SlotScope = "trip" | "day-time" | "per-person" | "leg";

export type SlotStatus =
  | "empty"        // no binding, no vote open
  | "proposed"     // owner opened for ideas; candidates accumulating
  | "voting"       // owner opened a vote; closes on owner action
  | "locked"       // a Candidate is bound; itinerary renders it
  | "booked";      // post-finalize (H3.3 state machine)

export interface Slot {
  id: string;
  category: CandidateCategory;
  scope: SlotScope;

  /** scope: "day-time" */
  dayIdx?: number;
  time?: string;

  /** scope: "per-person" (H3 reserved) */
  ownerEmail?: string;
  direction?: "outbound" | "return";

  /** scope: "leg" (H3 reserved) */
  legKey?: string;

  /** Label shown on the card when no binding yet, e.g.
   *  "Saturday 7 PM dinner". */
  label?: string;

  status: SlotStatus;

  /** Set when status === "locked" | "booked". */
  boundCandidateId?: string;

  /** Set when status === "voting" (or kept historical if closed+locked). */
  voteCandidateIds?: string[];
  voteOpenedAt?: string;
  voteClosedAt?: string;

  createdBy: string;
  createdAt: string;
}
