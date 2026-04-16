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
}

/** StoredPlan subset the handlers rely on — both repos' StoredPlan satisfies this. */
export interface RoomStoredPlan {
  id: string;
  inputs?: {
    organizerEmail?: string;
    organizerName?: string;
    bridePersonality?: string;
    groomPersonality?: string;
    [k: string]: unknown;
  };
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
  destinations?: Record<string, {
    city?: string;
    state?: string;
    plans?: Record<string, { tripName?: string }>;
  }>;
  [k: string]: unknown;
}
