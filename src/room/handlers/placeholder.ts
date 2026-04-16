import { NextResponse } from "next/server";
import type { RoomContext } from "../context";
import type { PlaceholderDetail, PlaceholderItem } from "../types";
import { authorizeRoomAction, ownerOnly, readBody } from "./shared";

const VALID_DETAILS: PlaceholderDetail[] = [
  "Dinner", "Lunch", "Brunch", "Activity", "Bar", "Spa", "Downtime", "Other",
];

interface PlaceholderPostBody {
  planId?: string;
  detail?: string;
  customLabel?: string;
  dayIdx?: number;
  time?: string;
}

interface PlaceholderPutBody extends PlaceholderPostBody {
  placeholderId?: string;
}

function defaultTime(detail: PlaceholderDetail): string {
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

/** POST /api/room/placeholder */
export async function handlePlaceholderPost(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const body = await readBody<PlaceholderPostBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, detail, customLabel, dayIdx, time } = body;
  if (!planId || !detail || typeof dayIdx !== "number") {
    return NextResponse.json(
      { error: "planId + detail + dayIdx required" },
      { status: 400 }
    );
  }
  if (!VALID_DETAILS.includes(detail as PlaceholderDetail)) {
    return NextResponse.json({ error: "invalid detail value" }, { status: 400 });
  }
  if (detail === "Other" && !customLabel?.trim()) {
    return NextResponse.json({ error: "customLabel required when detail === 'Other'" }, { status: 400 });
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = ownerOnly(auth);
  if (block) return block;

  const plan = auth.plan;
  const placeholder: PlaceholderItem = {
    id: crypto.randomUUID(),
    type: "placeholder",
    detail: detail as PlaceholderDetail,
    customLabel: customLabel?.trim() || undefined,
    dayIdx,
    time: time || defaultTime(detail as PlaceholderDetail),
    createdAt: new Date().toISOString(),
  };
  plan.placeholders = [...(plan.placeholders ?? []), placeholder];
  await ctx.kv.storePlan(plan);

  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "placeholder_added",
    detail: placeholder.detail,
  });

  return NextResponse.json({ ok: true, plan });
}

/**
 * PUT /api/room/placeholder
 *
 * Edit an existing placeholder in place — owner-only. Not currently wired in
 * either repo's route.ts (the swap-modal re-creates placeholders), but
 * the handler is exposed for future use so we don't paint ourselves into a
 * corner later.
 */
export async function handlePlaceholderPut(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const body = await readBody<PlaceholderPutBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, placeholderId, detail, customLabel, dayIdx, time } = body;
  if (!planId || !placeholderId) {
    return NextResponse.json({ error: "planId + placeholderId required" }, { status: 400 });
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = ownerOnly(auth);
  if (block) return block;

  const plan = auth.plan;
  const placeholders = plan.placeholders ?? [];
  const idx = placeholders.findIndex((p) => p.id === placeholderId);
  if (idx === -1) {
    return NextResponse.json({ error: "placeholder not found" }, { status: 404 });
  }

  if (detail && !VALID_DETAILS.includes(detail as PlaceholderDetail)) {
    return NextResponse.json({ error: "invalid detail value" }, { status: 400 });
  }

  const existing = placeholders[idx];
  if (!existing) {
    return NextResponse.json({ error: "placeholder not found" }, { status: 404 });
  }
  placeholders[idx] = {
    ...existing,
    detail: (detail as PlaceholderDetail) ?? existing.detail,
    customLabel: customLabel?.trim() || existing.customLabel,
    dayIdx: typeof dayIdx === "number" ? dayIdx : existing.dayIdx,
    time: time ?? existing.time,
  };
  plan.placeholders = placeholders;
  await ctx.kv.storePlan(plan);

  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "placeholder_edited",
    placeholderId,
  });

  return NextResponse.json({ ok: true, plan });
}

/** DELETE /api/room/placeholder?planId=X&placeholderId=Y */
export async function handlePlaceholderDelete(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const url = new URL(req.url);
  const planId = url.searchParams.get("planId");
  const placeholderId = url.searchParams.get("placeholderId");
  if (!planId || !placeholderId) {
    return NextResponse.json({ error: "planId + placeholderId required" }, { status: 400 });
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = ownerOnly(auth);
  if (block) return block;

  const plan = auth.plan;
  plan.placeholders = (plan.placeholders ?? []).filter((p) => p.id !== placeholderId);
  await ctx.kv.storePlan(plan);

  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "placeholder_removed",
    placeholderId,
  });

  return NextResponse.json({ ok: true, plan });
}
