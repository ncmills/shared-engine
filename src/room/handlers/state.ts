import { NextResponse } from "next/server";
import type { RoomContext } from "../context";
import { isOwnerForPlan } from "../auth";
import { TABLES } from "../tables";
import { buildPoolsAndSlots } from "../viewmodel";
import type { CategoryPool, Slot } from "../types";

/**
 * GET /api/room/state?planId=xxx
 *
 * V1.2: returns live collaborative state — members, slot-vote tallies,
 * personal items — plus `isOwner` + `isOriginalOwner` + stage flags.
 */
export async function handleStateGet(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const url = new URL(req.url);
  const planId = url.searchParams.get("planId");
  if (!planId) {
    return NextResponse.json({ error: "planId required" }, { status: 400 });
  }

  const plan = await ctx.kv.getPlan(planId);
  if (!plan) return NextResponse.json({ error: "not found" }, { status: 404 });

  const sessionHash = ctx.computeSessionId(req);
  const email = await ctx.auth.getSessionEmail();
  const { isOwner, isOriginalOwner } = isOwnerForPlan(plan, email);

  // H2.0 — when the repo has wired buildPoolsInputs, derive pools + slots
  // and attach to the response. Flag-independent: clients gated on
  // NEXT_PUBLIC_UNIVERSAL_SLOT consume it, others ignore the extra fields.
  let categoryPools: CategoryPool[] | undefined;
  let derivedSlots: Slot[] | undefined;
  if (ctx.buildPoolsInputs) {
    try {
      const { tierPlan, alternatesByPath } = ctx.buildPoolsInputs(plan);
      const derived = buildPoolsAndSlots(plan, tierPlan, { alternatesByPath });
      categoryPools = derived.pools;
      derivedSlots = derived.slots;
    } catch (err) {
      // Never fail the state route because of a viewmodel bug — flag-off
      // clients must stay healthy. Log + leave pools undefined.
      console.warn("[room/state] buildPoolsInputs threw:", err);
    }
  }

  const baseResponse = {
    sessionHash,
    isOwner,
    isOriginalOwner,
    stage: plan.stage,
    lockedTier: plan.lockedTier,
    externalBookings: plan.externalBookings ?? [],
    finalCheckIn: plan.finalCheckIn,
    finalCheckOut: plan.finalCheckOut,
    finalGuestCount: plan.finalGuestCount,
    homeAirport: plan.homeAirport,
    slug: plan.slug,
    coOwners: plan.coOwners ?? [],
    categoryPools,
    derivedSlots,
  };

  if (!ctx.supabase) {
    return NextResponse.json({
      ...baseResponse,
      members: [],
      slotVotes: [],
      personalItems: [],
      note: "supabase not configured",
    });
  }

  const [membersRes, slotVotesRes, personalItemsRes] = await Promise.allSettled([
    ctx.supabase
      .from(TABLES.members)
      .select("session_hash, display_name, role, joined_at, user_email")
      .eq("plan_id", planId)
      .order("joined_at", { ascending: true }),
    ctx.supabase
      .from(TABLES.slotVotes)
      .select("slot_id, voter_session_hash, user_email, chosen_item_path, updated_at")
      .eq("plan_id", planId),
    ctx.supabase
      .from(TABLES.personalItems)
      .select("id, participant_session_hash, participant_display_name, type, details, updated_at")
      .eq("plan_id", planId)
      .order("updated_at", { ascending: false }),
  ]);

  return NextResponse.json({
    ...baseResponse,
    members:
      membersRes.status === "fulfilled" ? membersRes.value.data ?? [] : [],
    slotVotes:
      slotVotesRes.status === "fulfilled" ? slotVotesRes.value.data ?? [] : [],
    personalItems:
      personalItemsRes.status === "fulfilled"
        ? personalItemsRes.value.data ?? []
        : [],
  });
}
