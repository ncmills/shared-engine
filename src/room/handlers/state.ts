import { NextResponse } from "next/server";
import type { RoomContext } from "../context";
import { isOwnerForPlan } from "../auth";
import { TABLES } from "../tables";

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
