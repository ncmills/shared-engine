import { NextResponse } from "next/server";
import type { RoomContext } from "../context";
import { authorizeRoomAction, ownerOnly, readBody } from "./shared";

interface ScheduleBody {
  planId?: string;
  itemPath?: string;
  dayIdx?: number;
  time?: string;
  unset?: boolean;
}

/**
 * POST /api/room/schedule
 *
 * Owner-only. Writes to `plan.scheduleOverrides[itemPath]` without touching
 * the engine-generated `plan.schedule` array — that stays immutable so the
 * original tiering survives edits.
 */
export async function handleScheduleUpdate(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const body = await readBody<ScheduleBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, itemPath, dayIdx, time, unset } = body;
  if (!planId || !itemPath) {
    return NextResponse.json({ error: "planId + itemPath required" }, { status: 400 });
  }
  if (!unset) {
    if (typeof dayIdx !== "number" || dayIdx < 0 || dayIdx > 30) {
      return NextResponse.json({ error: "dayIdx must be a number 0-30" }, { status: 400 });
    }
    if (!time || typeof time !== "string") {
      return NextResponse.json({ error: "time required" }, { status: 400 });
    }
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = ownerOnly(auth);
  if (block) return block;

  const plan = auth.plan;
  const overrides = { ...(plan.scheduleOverrides ?? {}) };

  if (unset) {
    delete overrides[itemPath];
  } else {
    overrides[itemPath] = { dayIdx: dayIdx as number, time: time as string };
  }
  plan.scheduleOverrides = overrides;
  await ctx.kv.storePlan(plan);

  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "schedule_edited",
    itemPath,
    dayIdx: unset ? undefined : dayIdx,
    time: unset ? undefined : time,
    unset: unset ?? false,
  });

  return NextResponse.json({
    ok: true,
    scheduleOverrides: plan.scheduleOverrides,
  });
}
