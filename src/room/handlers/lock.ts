import { NextResponse } from "next/server";
import type { RoomContext } from "../context";
import type { LockedTier } from "../types";
import { authorizeRoomAction, ownerOnly, readBody } from "./shared";

const VALID_TIERS: LockedTier[] = ["weekendWarrior", "theLegend", "theKing"];

interface LockBody {
  planId?: string;
  tier?: string;
  finalCheckIn?: string;
  finalCheckOut?: string;
  finalGuestCount?: number;
  homeAirport?: string;
}

/** POST /api/room/lock */
export async function handleLock(req: Request, ctx: RoomContext): Promise<Response> {
  const body = await readBody<LockBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, tier, finalCheckIn, finalCheckOut, finalGuestCount, homeAirport } = body;
  if (!planId || !tier) {
    return NextResponse.json({ error: "planId + tier required" }, { status: 400 });
  }
  if (!VALID_TIERS.includes(tier as LockedTier)) {
    return NextResponse.json({ error: "invalid tier" }, { status: 400 });
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = ownerOnly(auth);
  if (block) return block;

  // B1 — freeze at finalize. Once the trip is finalized, the date/guest
  // fields feeding Trip Terms math are no longer editable. Owner must
  // unfinalize first if they genuinely need to change these.
  if (auth.plan.stage === "finalized") {
    return NextResponse.json(
      { error: "Trip is finalized. Unlock it before changing dates, guest count, or tier." },
      { status: 409 }
    );
  }

  const plan = auth.plan;
  plan.lockedTier = tier as LockedTier;
  plan.lockedTierAt = new Date().toISOString();
  plan.lockedBy = auth.sessionHash;
  plan.stage = "locked";
  if (finalCheckIn) plan.finalCheckIn = finalCheckIn;
  if (finalCheckOut) plan.finalCheckOut = finalCheckOut;
  if (typeof finalGuestCount === "number") plan.finalGuestCount = finalGuestCount;
  if (homeAirport) plan.homeAirport = homeAirport.toUpperCase().slice(0, 3);
  await ctx.kv.storePlan(plan);

  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "plan_locked",
    tier,
  });

  return NextResponse.json({ ok: true, plan });
}

/** POST /api/room/finalize */
export async function handleFinalize(req: Request, ctx: RoomContext): Promise<Response> {
  const body = await readBody<{ planId?: string }>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId } = body;
  if (!planId) return NextResponse.json({ error: "planId required" }, { status: 400 });

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = ownerOnly(auth);
  if (block) return block;

  const plan = auth.plan;
  if (plan.stage !== "locked" && plan.stage !== "finalized") {
    return NextResponse.json(
      { error: "plan must be locked before it can be finalized" },
      { status: 400 }
    );
  }

  plan.stage = "finalized";
  plan.finalizedAt = new Date().toISOString();
  plan.finalizedBy = auth.sessionHash;
  await ctx.kv.storePlan(plan);

  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "plan_finalized",
  });

  return NextResponse.json({ ok: true, plan });
}

/** POST /api/room/unfinalize */
export async function handleUnfinalize(req: Request, ctx: RoomContext): Promise<Response> {
  const body = await readBody<{ planId?: string }>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId } = body;
  if (!planId) return NextResponse.json({ error: "planId required" }, { status: 400 });

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = ownerOnly(auth);
  if (block) return block;

  const plan = auth.plan;
  plan.stage = "locked";
  await ctx.kv.storePlan(plan);

  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "plan_unfinalized",
  });

  return NextResponse.json({ ok: true, plan });
}
