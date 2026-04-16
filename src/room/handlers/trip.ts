import { NextResponse } from "next/server";
import type { RoomContext } from "../context";
import { resolveSlug, updateSlug, validateSlug } from "../slug";
import { authorizeRoomAction, ownerOnly, readBody } from "./shared";

/** GET /api/trip/resolve?slug=<slug> → { planId, slug } | 404. */
export async function handleTripResolve(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const slug = new URL(req.url).searchParams.get("slug");
  if (!slug) {
    return NextResponse.json({ error: "slug required" }, { status: 400 });
  }
  const planId = await resolveSlug(ctx.brand, slug, ctx.redis);
  if (!planId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ planId, slug });
}

interface TripSlugBody {
  planId?: string;
  newSlug?: string;
}

/** POST /api/trip/slug */
export async function handleTripSlugUpdate(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const body = await readBody<TripSlugBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, newSlug } = body;
  if (!planId || !newSlug) {
    return NextResponse.json({ error: "planId and newSlug required" }, { status: 400 });
  }

  const validation = validateSlug(newSlug);
  if (!validation.valid) {
    return NextResponse.json({ error: validation.reason }, { status: 400 });
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = ownerOnly(auth);
  if (block) return block;

  const plan = auth.plan;
  try {
    const finalSlug = await updateSlug(ctx.brand, plan.slug, newSlug, planId, ctx.redis);
    plan.slug = finalSlug;
    await ctx.kv.storePlan(plan);
    return NextResponse.json({ ok: true, slug: finalSlug });
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : "slug update failed",
    }, { status: 400 });
  }
}
