/**
 * Trip Room — framework-agnostic fetch helpers.
 *
 * Every call is a thin wrapper around the canonical /api/room/* route
 * shape. The helpers return the raw JSON payload from the server (or
 * throw if the response is non-OK with a best-effort error message).
 *
 * Used from per-brand hooks in ./index.ts + consumed directly by
 * TripRoomClient in both MOH + BESTMAN.
 */

import type {
  CandidateCategory,
  ExternalBooking,
  LockedTier,
  PlaceholderDetail,
  PersonalItemType,
  RoomStoredPlan,
  TripRoomState,
} from "../types";

async function parseError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    if (data && typeof data.error === "string") return data.error;
  } catch {}
  return fallback;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = await parseError(res, `${url} failed`);
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

async function del<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) {
    const msg = await parseError(res, `${url} failed`);
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export interface PlanResponse { ok: boolean; plan: RoomStoredPlan }

export const roomApi = {
  fetchState(planId: string): Promise<TripRoomState> {
    return fetch(`/api/room/state?planId=${planId}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(await parseError(res, "state fetch failed"));
        return (await res.json()) as TripRoomState;
      });
  },

  lock(args: {
    planId: string;
    tier: LockedTier;
    finalCheckIn?: string;
    finalCheckOut?: string;
    finalGuestCount?: number;
    homeAirport?: string;
  }): Promise<PlanResponse> {
    return postJson<PlanResponse>("/api/room/lock", args);
  },

  finalize(planId: string): Promise<PlanResponse> {
    return postJson<PlanResponse>("/api/room/finalize", { planId });
  },

  unfinalize(planId: string): Promise<PlanResponse> {
    return postJson<PlanResponse>("/api/room/unfinalize", { planId });
  },

  updateSchedule(args: {
    planId: string;
    itemPath: string;
    dayIdx?: number;
    time?: string;
    unset?: boolean;
  }): Promise<{ ok: boolean; scheduleOverrides: RoomStoredPlan["scheduleOverrides"] }> {
    return postJson("/api/room/schedule", args);
  },

  openVote(args: {
    planId: string;
    slotId: string;
    itemPaths: string[];
    dayIdx: number;
    time: string;
    label?: string;
  }): Promise<PlanResponse> {
    return postJson<PlanResponse>("/api/room/slot/open-vote", args);
  },

  castVote(args: {
    planId: string;
    slotId: string;
    chosenItemPath: string;
    displayName?: string;
  }): Promise<{ ok: boolean }> {
    return postJson("/api/room/slot/vote", args);
  },

  closeVote(args: {
    planId: string;
    slotId: string;
    winnerItemPath?: string;
  }): Promise<PlanResponse> {
    return postJson<PlanResponse>("/api/room/slot/close", args);
  },

  addPlaceholder(args: {
    planId: string;
    detail: PlaceholderDetail;
    customLabel?: string;
    dayIdx: number;
    time?: string;
  }): Promise<PlanResponse> {
    return postJson<PlanResponse>("/api/room/placeholder", args);
  },

  deletePlaceholder(args: { planId: string; placeholderId: string }): Promise<PlanResponse> {
    return del<PlanResponse>(
      `/api/room/placeholder?planId=${args.planId}&placeholderId=${args.placeholderId}`
    );
  },

  upsertPersonalItem(args: {
    planId: string;
    type: PersonalItemType;
    details: Record<string, unknown>;
    displayName?: string;
  }): Promise<{ ok: boolean; item?: unknown }> {
    return postJson("/api/room/personal-item", args);
  },

  deletePersonalItem(args: { planId: string; itemId: string }): Promise<{ ok: boolean }> {
    return del(`/api/room/personal-item?planId=${args.planId}&itemId=${args.itemId}`);
  },

  addExternalBooking(args: {
    planId: string;
    booking: Omit<ExternalBooking, "id" | "addedBy" | "addedAt">;
  }): Promise<{ ok: boolean; booking: ExternalBooking; externalBookings: ExternalBooking[] }> {
    return postJson("/api/room/external-booking", args);
  },

  deleteExternalBooking(args: { planId: string; bookingId: string }): Promise<{
    ok: boolean;
    externalBookings: ExternalBooking[];
  }> {
    return del(
      `/api/room/external-booking?planId=${args.planId}&bookingId=${args.bookingId}`
    );
  },

  inviteCoOwner(args: { planId: string; email: string; note?: string }): Promise<{
    ok: boolean;
    mailed: boolean;
    claimUrl: string;
  }> {
    return postJson("/api/room/invite-coowner", args);
  },

  updateTripSlug(args: { planId: string; newSlug: string }): Promise<{
    ok: boolean;
    slug: string;
  }> {
    return postJson("/api/trip/slug", args);
  },

  // ── H2.0 Category Pools ──────────────────────────────────────────────

  addCandidate(args: {
    planId: string;
    category: CandidateCategory;
    source: "link" | "text" | "email";
    title?: string;
    url?: string;
    price?: string;
    description?: string;
    imageUrl?: string;
    providerName?: string;
    notes?: string;
    displayName?: string;
  }): Promise<PlanResponse> {
    return postJson<PlanResponse>("/api/room/pool/candidate", args);
  },

  bindSlot(args: {
    planId: string;
    candidateId: string;
    dayIdx?: number;
    time?: string;
    closeVoteSlotId?: string;
  }): Promise<PlanResponse> {
    return postJson<PlanResponse>("/api/room/pool/bind", args);
  },

  openCategoryVote(args: {
    planId: string;
    category: CandidateCategory;
    candidateIds: string[];
    dayIdx?: number;
    time?: string;
    label?: string;
  }): Promise<PlanResponse & { slotId: string }> {
    return postJson("/api/room/pool/vote", args);
  },

  openSlotForIdeas(args: {
    planId: string;
    category: CandidateCategory;
    dayIdx: number;
    time?: string;
    label?: string;
  }): Promise<PlanResponse & { slotId: string }> {
    return postJson("/api/room/pool/open", args);
  },
};
