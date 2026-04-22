import { NextResponse } from "next/server";
import type { RoomContext } from "../context";
import { authorizeRoomAction, originalOwnerOnly, readBody } from "./shared";
import { TABLES } from "../tables";

interface KickBody {
  planId?: string;
  /** Supabase `session_hash` of the member row to delete. Stable identifier
   *  since E4 wave — see wp_trip_room_members schema. */
  sessionHash?: string;
}

/**
 * POST /api/room/kick
 *
 * Remove a crew member from the board. Only the original owner can kick —
 * co-owners cannot kick each other, and co-owners cannot kick crew (to
 * avoid drama loops). Also deletes any co-owner entry for the same email
 * so a kicked member can't slip back in via an old magic link.
 *
 * Body: { planId, sessionHash }
 */
export async function handleMemberKick(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const body = await readBody<KickBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, sessionHash } = body;
  if (!planId || !sessionHash) {
    return NextResponse.json({ error: "planId + sessionHash required" }, { status: 400 });
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = originalOwnerOnly(
    auth,
    "Only the original owner can remove a member."
  );
  if (block) return block;

  if (!ctx.supabase) {
    return NextResponse.json({ error: "supabase not configured" }, { status: 503 });
  }

  // Look up the row first so we can clean up any co-owner reference by email.
  const { data: memberRow } = await ctx.supabase
    .from(TABLES.members)
    .select("user_email")
    .eq("plan_id", planId)
    .eq("session_hash", sessionHash)
    .maybeSingle();

  const kickedEmail = (memberRow?.user_email as string | null)?.toLowerCase() || null;

  // Guardrails: refuse to kick the original owner; refuse to kick self.
  const organizerEmail = (auth.plan.inputs?.organizerEmail || "").toLowerCase();
  if (kickedEmail && kickedEmail === organizerEmail) {
    return NextResponse.json(
      { error: "Can't remove the original owner." },
      { status: 400 }
    );
  }
  if (kickedEmail && auth.email && kickedEmail === auth.email.toLowerCase()) {
    return NextResponse.json(
      { error: "Use account settings to leave your own board." },
      { status: 400 }
    );
  }

  // Delete by (plan_id, session_hash) — the canonical unique key on the table.
  // Also sweep any same-email rows in case the member has logged in from
  // multiple devices (each device writes a distinct session_hash on join).
  const { error: delByHashErr } = await ctx.supabase
    .from(TABLES.members)
    .delete()
    .eq("plan_id", planId)
    .eq("session_hash", sessionHash);

  if (delByHashErr) {
    return NextResponse.json(
      { error: "failed to remove member", detail: delByHashErr.message },
      { status: 500 }
    );
  }

  if (kickedEmail) {
    await ctx.supabase
      .from(TABLES.members)
      .delete()
      .eq("plan_id", planId)
      .eq("user_email", kickedEmail);
  }

  // Strip any co-owner entry for the kicked email so a leaked magic link
  // can't be replayed to rejoin with elevated privileges.
  if (kickedEmail && Array.isArray(auth.plan.coOwners)) {
    const next = auth.plan.coOwners.filter(
      (e) => (e || "").toLowerCase() !== kickedEmail
    );
    if (next.length !== auth.plan.coOwners.length) {
      auth.plan.coOwners = next;
      await ctx.kv.storePlan(auth.plan);
    }
  }

  return NextResponse.json({ ok: true });
}
