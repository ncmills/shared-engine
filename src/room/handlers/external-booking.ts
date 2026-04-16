import { NextResponse } from "next/server";
import type { RoomContext } from "../context";
import type { ExternalBooking } from "../types";
import { authorizeRoomAction, ownerOnly, readBody } from "./shared";

interface ExternalBookingPostBody {
  planId?: string;
  booking?: Partial<ExternalBooking> & { name?: string; type?: string };
}

/** POST /api/room/external-booking */
export async function handleExternalBookingPost(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const body = await readBody<ExternalBookingPostBody>(req);
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const { planId, booking } = body;
  if (!planId || !booking || !booking.name || !booking.type) {
    return NextResponse.json(
      { error: "planId + booking.name + booking.type required" },
      { status: 400 }
    );
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = ownerOnly(auth);
  if (block) return block;

  const plan = auth.plan;
  const next: ExternalBooking = {
    id: crypto.randomUUID(),
    type: booking.type as ExternalBooking["type"],
    name: booking.name,
    when: booking.when,
    where: booking.where,
    url: booking.url,
    price: booking.price,
    participants: booking.participants,
    notes: booking.notes,
    addedBy: auth.sessionHash,
    addedAt: new Date().toISOString(),
  };

  plan.externalBookings = [...(plan.externalBookings ?? []), next];
  await ctx.kv.storePlan(plan);

  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "external_booking_added",
    bookingName: next.name,
    bookingType: next.type,
  });

  return NextResponse.json({
    ok: true,
    booking: next,
    externalBookings: plan.externalBookings,
  });
}

/** DELETE /api/room/external-booking?planId=X&bookingId=Y */
export async function handleExternalBookingDelete(
  req: Request,
  ctx: RoomContext
): Promise<Response> {
  const url = new URL(req.url);
  const planId = url.searchParams.get("planId");
  const bookingId = url.searchParams.get("bookingId");
  if (!planId || !bookingId) {
    return NextResponse.json({ error: "planId + bookingId required" }, { status: 400 });
  }

  const auth = await authorizeRoomAction(ctx, req, planId);
  if (!auth.ok) return auth.response;
  const block = ownerOnly(auth);
  if (block) return block;

  const plan = auth.plan;
  plan.externalBookings = (plan.externalBookings ?? []).filter((b) => b.id !== bookingId);
  await ctx.kv.storePlan(plan);

  ctx.logSignal(req, "trip_room_activity", {
    brand: ctx.brand,
    planId,
    event: "external_booking_removed",
    bookingId,
  });

  return NextResponse.json({
    ok: true,
    externalBookings: plan.externalBookings,
  });
}
