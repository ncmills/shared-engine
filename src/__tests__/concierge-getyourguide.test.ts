import { describe, it, expect, vi } from "vitest";
import { GetYourGuideAdapter } from "../concierge/getyourguide-adapter";
import { runBookingRailContract } from "../concierge/rail-contract";

function fakeFetch(): typeof fetch {
  return vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/tours") && (!init || init.method === undefined || init.method === "GET")) {
      return json({ tours: [{ id: "tour-1", title: "Sunset Kayak", price_cents: 8500, start_time: "2026-08-01T14:00:00Z", cancellation: { refundable: true, free_until: "2026-07-30T00:00:00Z", refund_cents: 8500 } }] });
    }
    if (u.includes("/reservations") && init?.method === "POST") return json({ reservation_id: "gyg-res-1", expires_at: "2026-08-01T13:30:00Z", price_cents: 8500 });
    if (u.includes("/bookings") && init?.method === "POST") return json({ booking_id: "gyg-book-1", voucher_code: "GYG-XYZ", amount_cents: 8500 });
    if (u.includes("/bookings/") && init?.method === "DELETE") return json({ refund_cents: 8500 });
    if (u.includes("/bookings/")) return json({ status: "confirmed" });
    return json({});
  }) as unknown as typeof fetch;
}

const make = () => new GetYourGuideAdapter({ baseUrl: "https://sandbox.getyourguide.test", token: "t", fetchImpl: fakeFetch() });

describe("GetYourGuideAdapter (mocked)", () => {
  it("maps search response to priced RailSlot[] with a real cancellation policy", async () => {
    const slots = await make().search({ area: "Nashville", dateTime: "2026-08-01T14:00:00Z", partySize: 6 });
    expect(slots[0]!.railSlotId).toBe("tour-1");
    expect(slots[0]!.priceCents).toBe(8500);
    expect(slots[0]!.cancellation.refundable).toBe(true);
    expect(slots[0]!.cancellation.freeCancelUntil).toBe("2026-07-30T00:00:00Z");
  });

  it("book returns a non-zero amount and a confirmation code", async () => {
    const rail = make();
    const held = await rail.hold("tour-1", { partySize: 6, dateTime: "2026-08-01T14:00:00Z" });
    const booked = await rail.book(held.holdRef, { leadName: "T", leadEmail: "t@e.com" });
    expect(booked.railRef).toBe("gyg-book-1");
    expect(booked.confirmationCode).toBe("GYG-XYZ");
    expect(booked.amountCents).toBe(8500);
  });

  it("release DELETEs the reservation (the hold, not the booking)", async () => {
    const spy = fakeFetch();
    const rail = new GetYourGuideAdapter({ baseUrl: "https://sandbox.getyourguide.test", token: "t", fetchImpl: spy });
    await rail.release("gyg-res-1");
    const call = (spy as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls.find(([u]) => String(u).includes("/reservations/gyg-res-1"));
    expect(call).toBeTruthy();
    expect(call![1]!.method).toBe("DELETE");
  });
});

runBookingRailContract("GetYourGuideAdapter(mock fetch)", make);
