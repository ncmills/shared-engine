import { NextResponse } from "next/server";
import type { RoomContext } from "../context";

export interface DevLoginExtras {
  /** Repo-specific session-cookie name ("moh-session", "pmp-session"). */
  sessionCookieName: string;
  /** Create a session tied to the given email, returning the session id. */
  createSession(email: string): Promise<string>;
}

/**
 * DEV-ONLY: GET /api/dev/login-as-organizer?planId=<id>
 *
 * The wrapper route MUST short-circuit with a 404 in production before
 * calling this handler. The handler itself is env-check-free because the
 * wrapper carries the responsibility (auditors should see a single place
 * where production gating lives).
 */
export async function handleDevLoginAsOrganizer(
  req: Request,
  ctx: RoomContext,
  extras: DevLoginExtras
): Promise<Response> {
  const url = new URL(req.url);
  const planId = url.searchParams.get("planId");
  const redirect = url.searchParams.get("redirect");
  const asJson = url.searchParams.get("json") === "1";

  if (!planId) {
    return NextResponse.json({ error: "planId required" }, { status: 400 });
  }

  const plan = await ctx.kv.getPlan(planId);
  if (!plan) {
    return NextResponse.json({ error: "plan not found" }, { status: 404 });
  }

  const organizerEmail = (plan.inputs?.organizerEmail || "").trim().toLowerCase();
  if (!organizerEmail) {
    return NextResponse.json(
      { error: "plan has no organizerEmail — cannot impersonate" },
      { status: 400 }
    );
  }

  const sessionId = await extras.createSession(organizerEmail);

  const destination =
    redirect && redirect.startsWith("/")
      ? redirect
      : plan.slug
        ? `/trip/${plan.slug}`
        : "/";

  const res = asJson
    ? NextResponse.json({ ok: true, email: organizerEmail, redirect: destination })
    : NextResponse.redirect(new URL(destination, req.url));

  res.cookies.set(extras.sessionCookieName, sessionId, {
    httpOnly: true,
    secure: false, // dev only
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });

  return res;
}
