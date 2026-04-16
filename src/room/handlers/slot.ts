import { NextResponse } from "next/server";
import type { RoomContext } from "../context";
import type { VoteSlot } from "../types";
import { TABLES } from "../tables";
import { authorizeRoomAction, ownerOnly, readBody } from "./shared";

interface OpenVoteBody {
  planId?: string;
  slotId?: string;
  itemPaths?: string[];
  dayIdx?: number;
  time?: string;
  label?: string;
}

/** POST /api/room/slot/open-vote */
export async function handleSlotOpenVote(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const body = await readBody<OpenVoteBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, slotId, itemPaths, dayIdx, time, label } = body;
  if (!planId || !slotId || !Array.isArray(itemPaths) || itemPaths.length < 2) {
    return NextResponse.json(
      { error: "planId, slotId, itemPaths[≥2] required" },
      { status: 400 }
    );
  }
  if (typeof dayIdx !== "number" || typeof time !== "string") {
    return NextResponse.json({ error: "dayIdx + time required" }, { status: 400 });
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = ownerOnly(auth);
  if (block) return block;

  const plan = auth.plan;
  const voteSlots: VoteSlot[] = plan.voteSlots ?? [];
  const existingIdx = voteSlots.findIndex((v) => v.slotId === slotId);
  const next: VoteSlot = {
    slotId,
    itemPaths,
    dayIdx,
    time,
    label,
    openAt: new Date().toISOString(),
  };
  if (existingIdx >= 0) {
    voteSlots[existingIdx] = next;
  } else {
    voteSlots.push(next);
  }
  plan.voteSlots = voteSlots;
  await ctx.kv.storePlan(plan);

  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "slot_vote_opened",
    slotId,
    itemPathCount: itemPaths.length,
  });

  return NextResponse.json({ ok: true, plan });
}

interface VoteBody {
  planId?: string;
  slotId?: string;
  chosenItemPath?: string;
  displayName?: string;
}

/** POST /api/room/slot/vote */
export async function handleSlotVote(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const body = await readBody<VoteBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, slotId, chosenItemPath, displayName } = body;
  if (!planId || !slotId || !chosenItemPath) {
    return NextResponse.json(
      { error: "planId, slotId, chosenItemPath required" },
      { status: 400 }
    );
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;

  const voteSlot = (auth.plan.voteSlots ?? []).find((v) => v.slotId === slotId);
  if (!voteSlot) {
    return NextResponse.json({ error: "vote slot not found" }, { status: 404 });
  }
  if (voteSlot.closedAt) {
    return NextResponse.json({ error: "vote closed" }, { status: 400 });
  }
  if (!voteSlot.itemPaths.includes(chosenItemPath)) {
    return NextResponse.json({ error: "choice not a candidate" }, { status: 400 });
  }

  if (!ctx.supabase) {
    return NextResponse.json({ ok: true, note: "supabase not configured" });
  }

  try {
    await ctx.supabase.from(TABLES.members).upsert(
      {
        plan_id: planId,
        session_hash: auth.sessionHash,
        display_name: displayName || null,
        brand: ctx.brand,
        role: auth.isOwner ? "owner" : "participant",
        last_active_at: new Date().toISOString(),
      },
      { onConflict: "plan_id,session_hash", ignoreDuplicates: false }
    );

    await ctx.supabase.from(TABLES.slotVotes).upsert(
      {
        plan_id: planId,
        slot_id: slotId,
        voter_session_hash: auth.sessionHash,
        chosen_item_path: chosenItemPath,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "slot_id,voter_session_hash" }
    );

    ctx.logSignal(req, "trip_room_activity", {
      brand: ctx.brand,
      planId,
      event: "slot_vote_cast",
      slotId,
      chosenItemPath,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.warn("[room/slot/vote] write failed:", err);
    return NextResponse.json({ ok: false, error: "write failed" }, { status: 500 });
  }
}

interface CloseVoteBody {
  planId?: string;
  slotId?: string;
  winnerItemPath?: string;
}

/** POST /api/room/slot/close */
export async function handleSlotClose(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const body = await readBody<CloseVoteBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, slotId, winnerItemPath } = body;
  if (!planId || !slotId) {
    return NextResponse.json({ error: "planId + slotId required" }, { status: 400 });
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = ownerOnly(auth);
  if (block) return block;

  const plan = auth.plan;
  const voteSlots = plan.voteSlots ?? [];
  const vs = voteSlots.find((v) => v.slotId === slotId);
  if (!vs) {
    return NextResponse.json({ error: "vote slot not found" }, { status: 404 });
  }
  if (winnerItemPath && !vs.itemPaths.includes(winnerItemPath)) {
    return NextResponse.json({ error: "winner not among candidates" }, { status: 400 });
  }

  vs.closedAt = new Date().toISOString();
  if (winnerItemPath) {
    vs.winnerItemPath = winnerItemPath;
    const overrides = { ...(plan.scheduleOverrides ?? {}) };
    for (const path of vs.itemPaths) {
      if (path !== winnerItemPath) {
        delete overrides[path];
      }
    }
    plan.scheduleOverrides = overrides;
  }

  await ctx.kv.storePlan(plan);

  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "slot_vote_closed",
    slotId,
    winnerItemPath: winnerItemPath ?? null,
  });

  return NextResponse.json({ ok: true, plan });
}
