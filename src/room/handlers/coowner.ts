import { NextResponse } from "next/server";
import type { RoomContext } from "../context";
import { authorizeRoomAction, originalOwnerOnly, readBody } from "./shared";

interface InviteBody {
  planId?: string;
  email?: string;
  note?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function deriveBaseUrl(req: Request, ctx: RoomContext): string {
  const envBase = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (envBase) return envBase;
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto") || "https";
    return `${proto}://${host}`;
  }
  return ctx.devBaseUrl;
}

/** POST /api/room/invite-coowner */
export async function handleCoOwnerInvite(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const body = await readBody<InviteBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, email, note } = body;
  if (!planId || !email) {
    return NextResponse.json({ error: "planId + email required" }, { status: 400 });
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalizedEmail)) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = originalOwnerOnly(auth);
  if (block) return block;

  const plan = auth.plan;
  if (!plan.coOwners) plan.coOwners = [];
  if (!plan.coOwners.includes(normalizedEmail)) {
    plan.coOwners.push(normalizedEmail);
  }
  await ctx.kv.storePlan(plan);

  // Create a claim token that maps → { email, planId, role }.
  // Reuses the magic-token storage (SET magic:<token> → email, 15-min TTL);
  // we stuff a separate `claim:<token>` key with the plan + role context.
  const token = await ctx.auth.createMagicToken(normalizedEmail);
  await ctx.redis.set(
    `claim:${token}`,
    JSON.stringify({ planId, role: "co-owner" }),
    "EX",
    60 * 15
  );

  const baseUrl = deriveBaseUrl(req, ctx);
  const claimUrl = `${baseUrl}/auth/claim?token=${token}&planId=${planId}&role=co-owner`;

  let mailed = false;
  if (process.env.RESEND_API_KEY && ctx.email) {
    try {
      const fromEmail = auth.email || plan.inputs?.organizerEmail || "";
      const fromName =
        plan.inputs?.organizerName ||
        (fromEmail
          ? (ctx.auth.getUserName
              ? (await ctx.auth.getUserName(fromEmail)) || ctx.defaultFromName
              : ctx.defaultFromName)
          : ctx.defaultFromName);
      const honoreeField = ctx.honoreeFieldKey;
      const honoree =
        (plan.inputs?.[honoreeField] as string | undefined) || ctx.defaultHonoree;
      const dests = plan.destinations as {
        budget?: { plans?: { weekendWarrior?: { tripName?: string } } };
        mid?: { plans?: { theLegend?: { tripName?: string } } };
        premium?: { plans?: { theKing?: { tripName?: string } } };
      } | undefined;
      const tripName =
        dests?.mid?.plans?.theLegend?.tripName ||
        dests?.budget?.plans?.weekendWarrior?.tripName ||
        dests?.premium?.plans?.theKing?.tripName ||
        ctx.tripNameFallback(honoree);
      await ctx.email.sendCoOwnerInviteEmail({
        toEmail: normalizedEmail,
        fromName,
        honoree,
        tripName,
        note,
        claimUrl,
      });
      mailed = true;
    } catch (err) {
      console.warn("[room/invite-coowner] email send failed:", err);
    }
  }

  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "coowner_invited",
    invitedEmail: normalizedEmail,
    mailed,
  });

  return NextResponse.json({ ok: true, mailed, claimUrl });
}

/**
 * Magic-link claim helper. Not wired to a route.ts in either repo today
 * (claims are consumed by `/auth/claim` page via redis read). Exposed here
 * so the plan's promised `handleMagicLinkClaim` has a canonical owner.
 */
export async function handleMagicLinkClaim(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "token required" }, { status: 400 });
  }
  const raw = await ctx.redis.get(`claim:${token}`);
  if (!raw) {
    return NextResponse.json({ error: "invalid or expired token" }, { status: 404 });
  }
  try {
    const parsed = JSON.parse(raw) as { planId: string; role: string };
    ctx.logSignal(req, "trip_room_activity", {
      brand: ctx.brand,
      planId: parsed.planId,
      event: "coowner_claim_resolved",
      role: parsed.role,
    });
    return NextResponse.json({ ok: true, ...parsed });
  } catch {
    return NextResponse.json({ error: "malformed claim" }, { status: 500 });
  }
}
