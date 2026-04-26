import { NextResponse } from "next/server";
import type { RoomContext } from "../context";
import { authorizeRoomAction, ownerOnly, readBody } from "./shared";

interface ScheduleBody {
  planId?: string;
  itemPath?: string;
  dayIdx?: number;
  time?: string;
  unset?: boolean;
  /**
   * When true, append `itemPath` to plan.removedItems so the day board
   * hides it. When explicitly false, restore (filter out of removedItems).
   * Independent from `unset` (which only clears a scheduleOverride).
   */
  remove?: boolean;
}

/**
 * POST /api/room/schedule
 *
 * Owner-only. Writes to `plan.scheduleOverrides[itemPath]` without touching
 * the engine-generated `plan.schedule` array — that stays immutable so the
 * original tiering survives edits.
 *
 * Also handles owner-initiated remove/restore via `remove: true|false`,
 * which mutates `plan.removedItems` (separate field, separate UX). When
 * `remove` is present, dayIdx/time are ignored.
 */
export async function handleScheduleUpdate(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const body = await readBody<ScheduleBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, itemPath, dayIdx, time, unset, remove } = body;
  if (!planId || !itemPath) {
    return NextResponse.json({ error: "planId + itemPath required" }, { status: 400 });
  }
  if (typeof remove !== "boolean" && !unset) {
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

  if (typeof remove === "boolean") {
    const current = new Set(plan.removedItems ?? []);
    if (remove) current.add(itemPath);
    else current.delete(itemPath);
    plan.removedItems = Array.from(current);
    // Removing an item should also drop any stale schedule override so
    // a future restore lands at the engine-default position.
    if (remove && plan.scheduleOverrides && plan.scheduleOverrides[itemPath]) {
      const overrides = { ...plan.scheduleOverrides };
      delete overrides[itemPath];
      plan.scheduleOverrides = overrides;
    }
    await ctx.kv.storePlan(plan);

    ctx.logSignal(req, "trip_room_activity", {
      brand: ctx.brand,
      planId,
      event: remove ? "item_removed" : "item_restored",
      itemPath,
    });

    return NextResponse.json({
      ok: true,
      scheduleOverrides: plan.scheduleOverrides ?? {},
      removedItems: plan.removedItems,
    });
  }

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
