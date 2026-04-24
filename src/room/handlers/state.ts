import { NextResponse } from "next/server";
import type { RoomContext } from "../context";
import { isOwnerForPlan } from "../auth";
import { TABLES } from "../tables";
import { buildPoolsAndSlots } from "../viewmodel";
import type { CategoryPool, Expense, Slot } from "../types";

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
      const inputs = ctx.buildPoolsInputs(plan);
      const derived = buildPoolsAndSlots(plan, inputs.tierPlan, {
        alternatesByCategory: inputs.alternatesByCategory,
        tierKey: inputs.tierKey,
      });
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

  const [membersRes, slotVotesRes, personalItemsRes, expensesRes] = await Promise.allSettled([
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
    // H2.5 — expense ledger rows; crew sees verified only, owners see all.
    ctx.supabase
      .from("wp_trip_room_expenses")
      .select("*")
      .eq("plan_id", planId)
      .order("created_at", { ascending: true }),
  ]);

  let expenses: Expense[] | undefined;
  if (expensesRes.status === "fulfilled") {
    const rows = (expensesRes.value.data ?? []) as Array<{
      id: string; plan_id: string; source: "slot" | "manual";
      slot_id: string | null; candidate_id: string | null; label: string;
      amount_cents: number; suggested_cents: number | null;
      payer_email: string; split_emails: string[] | null;
      status: "proposed" | "verified"; per_person_hint: boolean;
      created_at: string; updated_at: string;
    }>;
    const all: Expense[] = rows.map(r => ({
      id: r.id,
      planId: r.plan_id,
      source: r.source,
      slotId: r.slot_id,
      candidateId: r.candidate_id,
      label: r.label,
      amountCents: r.amount_cents,
      suggestedCents: r.suggested_cents,
      payerEmail: r.payer_email,
      splitEmails: r.split_emails ?? [],
      status: r.status,
      perPersonHint: r.per_person_hint,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    // Crew sees only verified rows; owner/co-owner gets all.
    expenses = isOwner ? all : all.filter(e => e.status === "verified");
  }

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
    expenses,
  });
}
