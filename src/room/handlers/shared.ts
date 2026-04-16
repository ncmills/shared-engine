/**
 * Trip Room handler plumbing — shared helpers.
 */

import { NextResponse } from "next/server";
import type { RoomContext } from "../context";
import type { RoomStoredPlan } from "../types";
import { isOwnerForPlan } from "../auth";

export interface RoomAuthorized {
  ok: true;
  plan: RoomStoredPlan;
  sessionHash: string;
  isOwner: boolean;
  isOriginalOwner: boolean;
  email: string | null;
}

export type RoomAuthResult =
  | RoomAuthorized
  | { ok: false; response: Response };

/**
 * Load the plan, resolve the current session, and return the normalized
 * auth result. Thin drop-in for the old `authorizeRoomAction(...)` helper.
 */
export async function authorizeRoomAction(
  ctx: RoomContext,
  req: Request,
  planId: string
): Promise<RoomAuthResult> {
  const plan = await ctx.kv.getPlan(planId);
  if (!plan) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Plan not found" }, { status: 404 }),
    };
  }

  const sessionHash = ctx.computeSessionId(req);
  const email = await ctx.auth.getSessionEmail();
  const { isOwner, isOriginalOwner } = isOwnerForPlan(plan, email);

  return {
    ok: true,
    plan,
    sessionHash,
    isOwner,
    isOriginalOwner,
    email,
  };
}

export function ownerOnly(auth: RoomAuthorized): Response | null {
  if (!auth.isOwner) {
    return NextResponse.json({ error: "owner only" }, { status: 403 });
  }
  return null;
}

export function originalOwnerOnly(
  auth: RoomAuthorized,
  message = "Only the original owner can invite co-owners."
): Response | null {
  if (!auth.isOriginalOwner) {
    return NextResponse.json({ error: message }, { status: 403 });
  }
  return null;
}

export async function readBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
