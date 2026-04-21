import { NextResponse } from "next/server";
import type { RoomContext } from "../context";
import type { PersonalItemType } from "../types";
import { anonDisplayName } from "../auth";
import { TABLES } from "../tables";
import { authorizeRoomAction, readBody } from "./shared";

const VALID_TYPES: PersonalItemType[] = [
  "arrival-flight",
  "departure-flight",
  "arrival-time",
  "departure-time",
  "dietary-note",
  "custom",
];

interface PersonalItemPostBody {
  planId?: string;
  type?: string;
  details?: Record<string, unknown>;
  displayName?: string;
}

/** POST /api/room/personal-item */
export async function handlePersonalItemPost(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const body = await readBody<PersonalItemPostBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, type, details, displayName } = body;
  if (!planId || !type) {
    return NextResponse.json({ error: "planId + type required" }, { status: 400 });
  }
  if (!VALID_TYPES.includes(type as PersonalItemType)) {
    return NextResponse.json({ error: "invalid type" }, { status: 400 });
  }
  if (!details || typeof details !== "object") {
    return NextResponse.json({ error: "details must be an object" }, { status: 400 });
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;

  // Wave E5 (2026-04-22) — member-level actions require an authed email.
  // Owners bypass. Non-owners without a session cookie get 403 + the client
  // surfaces the JoinBoardPrompt modal.
  if (!auth.isOwner && !auth.email) {
    return NextResponse.json(
      { error: "Sign in to add your details to this board.", code: "AUTH_REQUIRED" },
      { status: 403 }
    );
  }

  const author = (displayName || anonDisplayName(auth.sessionHash)).slice(0, 80);

  if (!ctx.supabase) {
    return NextResponse.json({ ok: true, note: "supabase not configured" });
  }

  try {
    await ctx.supabase.from(TABLES.members).upsert(
      {
        plan_id: planId,
        session_hash: auth.sessionHash,
        user_email: auth.email ?? null,
        display_name: author,
        brand: ctx.brand,
        role: auth.isOwner ? "owner" : "member",
        last_active_at: new Date().toISOString(),
      },
      { onConflict: "plan_id,session_hash", ignoreDuplicates: false }
    );

    const { data, error } = await ctx.supabase
      .from(TABLES.personalItems)
      .upsert(
        {
          plan_id: planId,
          participant_session_hash: auth.sessionHash,
          participant_display_name: author,
          user_email: auth.email ?? null,
          type,
          details,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "plan_id,participant_session_hash,type" }
      )
      .select()
      .single();

    if (error) {
      console.warn("[room/personal-item] upsert failed:", error);
      return NextResponse.json({ ok: false, error: "write failed" }, { status: 500 });
    }

    ctx.logSignal(req, "trip_room_activity", {
      brand: ctx.brand,
      planId,
      event: "personal_item_added",
      type,
    });

    return NextResponse.json({ ok: true, item: data });
  } catch (err) {
    console.warn("[room/personal-item] write failed:", err);
    return NextResponse.json({ ok: false, error: "write failed" }, { status: 500 });
  }
}

/** DELETE /api/room/personal-item?planId=X&itemId=Y */
export async function handlePersonalItemDelete(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const url = new URL(req.url);
  const planId = url.searchParams.get("planId");
  const itemId = url.searchParams.get("itemId");
  if (!planId || !itemId) {
    return NextResponse.json({ error: "planId + itemId required" }, { status: 400 });
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;

  if (!ctx.supabase) {
    return NextResponse.json({ ok: true, note: "supabase not configured" });
  }

  // session_hash enforcement: filter on id AND participant_session_hash
  // so a different session can't delete someone else's row.
  const { error } = await ctx.supabase
    .from(TABLES.personalItems)
    .delete()
    .eq("id", itemId)
    .eq("plan_id", planId)
    .eq("participant_session_hash", auth.sessionHash);

  if (error) {
    console.warn("[room/personal-item] delete failed:", error);
    return NextResponse.json({ ok: false, error: "delete failed" }, { status: 500 });
  }

  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "personal_item_removed",
    itemId,
  });

  return NextResponse.json({ ok: true });
}
