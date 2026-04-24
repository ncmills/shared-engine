/**
 * Trip Room H2.0 — pool handlers.
 *
 * Four new handlers behind /api/room/pool/{candidate,bind,vote,open}:
 *
 *   - handleAddCandidate        any authed member can add a candidate
 *   - handleBindSlot            owner/co-owner binds a candidate → slot
 *   - handleOpenCategoryVote    owner-only opens a 2+ candidate vote
 *   - handleOpenSlotForIdeas    owner-only opens a slot for crew ideas
 *
 * All four write through to the canonical legacy fields
 * (externalBookings, scheduleOverrides, voteSlots, placeholders) in the
 * same atomic storePlan() call that updates plan.candidates[] /
 * plan.slots[]. The viewmodel (viewmodel.ts) reads only legacy today.
 *
 * Approved plan: ~/.claude/plans/ask-me-anyquesitons-here-happy-dream.md
 */

import { NextResponse } from "next/server";
import type { RoomContext } from "../context";
import type {
  Candidate,
  CandidateCategory,
  CandidateSource,
  ExternalBooking,
  PlaceholderDetail,
  PlaceholderItem,
  RoomStoredPlan,
  Slot,
  VoteSlot,
} from "../types";
import {
  authorizeRoomAction,
  ownerOnly,
  readBody,
  type RoomAuthorized,
} from "./shared";

const VALID_CATEGORIES: CandidateCategory[] = [
  "lodging",
  "activities",
  "dining",
  "bars",
  "flights",
  "transport",
];

// ────────────────────────────────────────────────────────────────────────
// POST /api/room/pool/candidate — handleAddCandidate
// ────────────────────────────────────────────────────────────────────────

interface AddCandidateBody {
  planId?: string;
  category?: string;
  source?: string;
  title?: string;
  url?: string;
  price?: string;
  description?: string;
  imageUrl?: string;
  providerName?: string;
  notes?: string;
  displayName?: string;
}

export async function handleAddCandidate(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const body = await readBody<AddCandidateBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, category, source, title, url, price, description, imageUrl, providerName, notes, displayName } = body;
  if (!planId || !category || !source) {
    return NextResponse.json(
      { error: "planId + category + source required" },
      { status: 400 }
    );
  }
  if (!VALID_CATEGORIES.includes(category as CandidateCategory)) {
    return NextResponse.json({ error: "invalid category" }, { status: 400 });
  }
  if (source === "ai") {
    return NextResponse.json(
      { error: "ai candidates are viewmodel-only — cannot add via handler" },
      { status: 400 }
    );
  }
  if (source !== "link" && source !== "text" && source !== "email") {
    return NextResponse.json({ error: "invalid source" }, { status: 400 });
  }
  if (source === "link" && !url) {
    return NextResponse.json({ error: "url required when source === 'link'" }, { status: 400 });
  }
  if (source === "text" && !title?.trim()) {
    return NextResponse.json({ error: "title required when source === 'text'" }, { status: 400 });
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  // Any authed session can add a Candidate (plan §3.5). Authentication is
  // implicit via authorizeRoomAction + the session-cookie flow upstream.

  const plan = auth.plan;
  const now = new Date().toISOString();
  const id = `cand_${crypto.randomUUID()}`;
  const candidate: Candidate = {
    id,
    category: category as CandidateCategory,
    source: source as CandidateSource,
    title: title?.trim() || undefined,
    description: description?.trim() || undefined,
    imageUrl: imageUrl?.trim() || undefined,
    url: url?.trim() || undefined,
    price: price?.trim() || undefined,
    providerName: providerName?.trim() || undefined,
    addedBy: auth.email ?? auth.sessionHash,
    addedByName: displayName?.trim() || undefined,
    addedAt: now,
    notes: notes?.trim() || undefined,
  };

  // Legacy write-through: mirror into externalBookings[] so the HandoffKit
  // + legacy UI sees the entry. The viewmodel re-derives from this in H2.0.
  const externalBooking: ExternalBooking = {
    id,
    type: categoryToExternalBookingType(candidate.category),
    name: candidate.title ?? "(untitled)",
    url: candidate.url,
    price: candidate.price,
    notes: candidate.notes,
    addedBy: candidate.addedBy,
    addedAt: now,
  };

  plan.candidates = [...(plan.candidates ?? []), candidate];
  plan.externalBookings = [...(plan.externalBookings ?? []), externalBooking];
  await ctx.kv.storePlan(plan);

  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "candidate_added",
    category: candidate.category,
    source: candidate.source,
  });

  return NextResponse.json({ ok: true, candidate, plan });
}

// ────────────────────────────────────────────────────────────────────────
// POST /api/room/pool/bind — handleBindSlot
// ────────────────────────────────────────────────────────────────────────

interface BindSlotBody {
  planId?: string;
  candidateId?: string;
  /** Optional: specify a day-time target. Omitted for lodging (trip-scope). */
  dayIdx?: number;
  time?: string;
  /** Optional: close an active voteSlot atomically. Rarely needed — binding
   *  by (dayIdx, time) closes any colliding vote automatically. */
  closeVoteSlotId?: string;
}

export async function handleBindSlot(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const body = await readBody<BindSlotBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, candidateId, dayIdx, time, closeVoteSlotId } = body;
  if (!planId || !candidateId) {
    return NextResponse.json(
      { error: "planId + candidateId required" },
      { status: 400 }
    );
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = ownerOnly(auth);
  if (block) return block;

  const plan = auth.plan;
  const candidate = resolveCandidate(plan, candidateId);
  if (!candidate) {
    return NextResponse.json({ error: "candidate not found" }, { status: 404 });
  }

  const now = new Date().toISOString();

  // Lodging has trip-scope; binding is a no-op on scheduleOverrides but we
  // still record a Slot entry in plan.slots[] so H2.1 readers see the
  // binding. For H2.0 viewmodel derivation the "most recent lodging
  // ExternalBooking wins" rule already handles user-bound lodging.
  if (candidate.category === "lodging") {
    upsertSlot(plan, {
      id: "slot_lodging",
      category: "lodging",
      scope: "trip",
      status: "locked",
      boundCandidateId: candidate.id,
      createdBy: auth.email ?? auth.sessionHash,
      createdAt: now,
    });
    await ctx.kv.storePlan(plan);
    logBind(req, ctx, planId, candidate);
    return NextResponse.json({ ok: true, plan });
  }

  // Day-time scope — write scheduleOverrides. Synthetic path for
  // user-added candidates uses candidate.id (the viewmodel maps both).
  if (typeof dayIdx !== "number" || !time) {
    return NextResponse.json(
      { error: "dayIdx + time required for non-lodging bindings" },
      { status: 400 }
    );
  }

  const path = candidate.tierPath ?? candidate.id;
  // Swap-unschedule: clear any existing override that claims this
  // (dayIdx, time) position so the legacy viewmodel doesn't render two
  // items on top of each other. Without this, binding B to A's slot
  // leaves A's override intact and A still appears scheduled there.
  const existingOverrides = plan.scheduleOverrides ?? {};
  const nextOverrides: typeof existingOverrides = {};
  for (const [k, v] of Object.entries(existingOverrides)) {
    if (k === path) continue;
    if (v && v.dayIdx === dayIdx && v.time === time) continue;
    nextOverrides[k] = v;
  }
  nextOverrides[path] = { dayIdx, time };
  plan.scheduleOverrides = nextOverrides;

  // Atomically close any open vote that covered this candidate at this
  // (dayIdx, time) — binding a winner implicitly closes the vote.
  closeCollidingVotes(plan, candidate, dayIdx, time, closeVoteSlotId, now);

  upsertSlot(plan, {
    id: `slot_bound_${path}`,
    category: candidate.category,
    scope: "day-time",
    dayIdx,
    time,
    status: "locked",
    boundCandidateId: candidate.id,
    createdBy: auth.email ?? auth.sessionHash,
    createdAt: now,
  });

  await ctx.kv.storePlan(plan);
  logBind(req, ctx, planId, candidate);
  return NextResponse.json({ ok: true, plan });
}

// ────────────────────────────────────────────────────────────────────────
// POST /api/room/pool/vote — handleOpenCategoryVote
// ────────────────────────────────────────────────────────────────────────

interface OpenCategoryVoteBody {
  planId?: string;
  category?: string;
  candidateIds?: string[];
  dayIdx?: number;
  time?: string;
  label?: string;
}

export async function handleOpenCategoryVote(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const body = await readBody<OpenCategoryVoteBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, category, candidateIds, dayIdx, time, label } = body;
  if (!planId || !category || !Array.isArray(candidateIds) || candidateIds.length < 2) {
    return NextResponse.json(
      { error: "planId + category + candidateIds[≥2] required" },
      { status: 400 }
    );
  }
  if (!VALID_CATEGORIES.includes(category as CandidateCategory)) {
    return NextResponse.json({ error: "invalid category" }, { status: 400 });
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = ownerOnly(auth);
  if (block) return block;

  const plan = auth.plan;

  // Resolve candidates + validate shared category.
  const resolved: Candidate[] = [];
  for (const id of candidateIds) {
    const c = resolveCandidate(plan, id);
    if (!c) {
      return NextResponse.json({ error: `candidate not found: ${id}` }, { status: 404 });
    }
    if (c.category !== category) {
      return NextResponse.json(
        { error: `candidate ${id} is not in category ${category}` },
        { status: 400 }
      );
    }
    resolved.push(c);
  }

  // Lodging vote is trip-scope; day-time votes need dayIdx + time.
  const isLodging = category === "lodging";
  if (!isLodging && (typeof dayIdx !== "number" || !time)) {
    return NextResponse.json(
      { error: "dayIdx + time required for non-lodging votes" },
      { status: 400 }
    );
  }

  const slotId = `slot_vote_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const itemPaths = resolved.map((c) => c.tierPath ?? c.id);

  // Legacy write-through — append to voteSlots[] so slot.ts handlers
  // (handleSlotVote, handleSlotClose) keep working unchanged.
  const legacyVoteSlot: VoteSlot = {
    slotId,
    itemPaths,
    dayIdx: isLodging ? -1 : (dayIdx as number),
    time: isLodging ? "" : (time as string),
    label,
    openAt: now,
  };
  plan.voteSlots = [...(plan.voteSlots ?? []), legacyVoteSlot];

  upsertSlot(plan, {
    id: slotId,
    category: category as CandidateCategory,
    scope: isLodging ? "trip" : "day-time",
    dayIdx: isLodging ? undefined : dayIdx,
    time: isLodging ? undefined : time,
    label,
    status: "voting",
    voteCandidateIds: resolved.map((c) => c.id),
    voteOpenedAt: now,
    createdBy: auth.email ?? auth.sessionHash,
    createdAt: now,
  });

  await ctx.kv.storePlan(plan);

  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "category_vote_opened",
    category,
    candidateCount: resolved.length,
  });

  return NextResponse.json({ ok: true, slotId, plan });
}

// ────────────────────────────────────────────────────────────────────────
// POST /api/room/pool/open — handleOpenSlotForIdeas
// ────────────────────────────────────────────────────────────────────────

interface OpenSlotForIdeasBody {
  planId?: string;
  category?: string;
  dayIdx?: number;
  time?: string;
  label?: string;
}

export async function handleOpenSlotForIdeas(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const body = await readBody<OpenSlotForIdeasBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, category, dayIdx, time, label } = body;
  if (!planId || !category) {
    return NextResponse.json(
      { error: "planId + category required" },
      { status: 400 }
    );
  }
  if (!VALID_CATEGORIES.includes(category as CandidateCategory)) {
    return NextResponse.json({ error: "invalid category" }, { status: 400 });
  }
  if (typeof dayIdx !== "number") {
    return NextResponse.json({ error: "dayIdx required" }, { status: 400 });
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = ownerOnly(auth);
  if (block) return block;

  const plan = auth.plan;
  const now = new Date().toISOString();
  const placeholderId = crypto.randomUUID();

  // Legacy write-through — placeholders are owner's TBD markers today.
  // Map category → placeholder detail for render compatibility.
  const detail = categoryToPlaceholderDetail(category as CandidateCategory);
  const legacyPlaceholder: PlaceholderItem = {
    id: placeholderId,
    type: "placeholder",
    detail,
    customLabel: label?.trim() || undefined,
    dayIdx,
    time: time ?? defaultTimeForPlaceholder(detail),
    createdAt: now,
  };
  plan.placeholders = [...(plan.placeholders ?? []), legacyPlaceholder];

  const slotId = `slot_proposed_${placeholderId}`;
  upsertSlot(plan, {
    id: slotId,
    category: category as CandidateCategory,
    scope: "day-time",
    dayIdx,
    time: legacyPlaceholder.time,
    label: label?.trim() || undefined,
    status: "proposed",
    createdBy: auth.email ?? auth.sessionHash,
    createdAt: now,
  });

  await ctx.kv.storePlan(plan);

  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "slot_opened_for_ideas",
    category,
    dayIdx,
  });

  return NextResponse.json({ ok: true, slotId, plan });
}

// ────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────

function resolveCandidate(
  plan: RoomStoredPlan,
  candidateId: string
): Candidate | null {
  // H2.0: plan.candidates is populated by handlers; AI candidates live
  // only in viewmodel. An AI candidate's id is `cand_ai_{tierPath}` so
  // we can synthesize one from its id alone for binding purposes —
  // downstream readers don't need full candidate data for AI rows.
  const stored = (plan.candidates ?? []).find((c) => c.id === candidateId);
  if (stored) return stored;

  if (candidateId.startsWith("cand_ai_")) {
    const tierPath = candidateId.slice("cand_ai_".length);
    return {
      id: candidateId,
      category: inferCategoryFromTierPath(tierPath),
      source: "ai",
      tierPath,
      addedBy: "ai",
      addedAt: plan.lockedTierAt ?? "",
    };
  }

  return null;
}

function inferCategoryFromTierPath(tierPath: string): CandidateCategory {
  if (tierPath === "lodging" || tierPath.startsWith("lodging.")) return "lodging";
  const seg = tierPath.split(".")[1]?.toLowerCase();
  if (seg === "dining") return "dining";
  if (seg === "bars" || seg === "nightlife") return "bars";
  if (seg === "activities") return "activities";
  if (seg === "lodging") return "lodging";
  return "activities";
}

function upsertSlot(plan: RoomStoredPlan, slot: Slot): void {
  const slots = plan.slots ?? [];
  const idx = slots.findIndex((s) => s.id === slot.id);
  if (idx >= 0) {
    slots[idx] = slot;
  } else {
    slots.push(slot);
  }
  plan.slots = slots;
}

function closeCollidingVotes(
  plan: RoomStoredPlan,
  candidate: Candidate,
  dayIdx: number,
  time: string,
  explicitSlotId: string | undefined,
  now: string
): void {
  const voteSlots = plan.voteSlots ?? [];
  const path = candidate.tierPath ?? candidate.id;
  for (const vs of voteSlots) {
    if (vs.closedAt) continue;
    const matchesExplicit = explicitSlotId && vs.slotId === explicitSlotId;
    const matchesPosition = vs.dayIdx === dayIdx && vs.time === time;
    if (!matchesExplicit && !matchesPosition) continue;
    vs.closedAt = now;
    if (vs.itemPaths.includes(path)) {
      vs.winnerItemPath = path;
    }
  }
  plan.voteSlots = voteSlots;
}

function logBind(
  req: Request,
  ctx: RoomContext,
  planId: string,
  candidate: Candidate
): void {
  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "candidate_bound",
    category: candidate.category,
    source: candidate.source,
  });
}

function categoryToExternalBookingType(
  category: CandidateCategory
): ExternalBooking["type"] {
  switch (category) {
    case "lodging": return "lodging";
    case "activities": return "activity";
    case "dining": return "dining";
    case "bars": return "bars";
    case "transport": return "transport";
    case "flights":
    default:
      return "other";
  }
}

function categoryToPlaceholderDetail(
  category: CandidateCategory
): PlaceholderDetail {
  switch (category) {
    case "dining": return "Dinner";
    case "bars": return "Bar";
    case "activities": return "Activity";
    case "lodging":
    case "flights":
    case "transport":
    default:
      return "Other";
  }
}

function defaultTimeForPlaceholder(detail: PlaceholderDetail): string {
  switch (detail) {
    case "Brunch": return "10:00 AM";
    case "Lunch": return "12:00 PM";
    case "Dinner": return "7:00 PM";
    case "Bar": return "9:00 PM";
    case "Spa": return "2:00 PM";
    case "Activity": return "10:00 AM";
    case "Downtime": return "3:00 PM";
    default: return "12:00 PM";
  }
}

// Silences unused-import warning for future use.
export type { RoomAuthorized };
