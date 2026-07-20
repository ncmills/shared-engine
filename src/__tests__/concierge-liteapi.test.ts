import { describe, it, expect, vi } from "vitest";
import { LiteAPIAdapter } from "../concierge/liteapi-adapter";
import { runBookingRailContract } from "../concierge/rail-contract";

/** Deterministic LiteAPI sandbox. NOTE: the prebook price (46500) DRIFTS UP from the search price
 *  (45000) — 2b's whole point is that a real rail locks a different price at prebook than it quoted. */
function liteApiFakeFetch(over?: { bookingId?: unknown; bookAmount?: unknown }): typeof fetch {
  return vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    const m = init?.method ?? "GET";
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    if (u.endsWith("/rates") && m === "POST") {
      return json({
        offers: [
          { offerId: "off-1", name: "Nashville Villa", price: { amount: 450.0, currency: "USD" }, checkin: "2026-08-01T15:00:00Z", refundable: true, freeCancelUntil: "2026-07-28T00:00:00Z" },
          // An un-priced offer MUST be excluded, never mapped to price 0.
          { offerId: "off-2", name: "Broken Rate", price: null, checkin: "2026-08-01T15:00:00Z", refundable: true, freeCancelUntil: "2026-07-28T00:00:00Z" },
        ],
      });
    }
    if (u.endsWith("/rates/prebook") && m === "POST") {
      return json({ prebookId: "pre-1", price: { amount: 465.0, currency: "USD" }, expiresAt: "2026-07-25T00:00:00Z" });
    }
    if (u.endsWith("/rates/book") && m === "POST") {
      return json({ bookingId: over && "bookingId" in over ? over.bookingId : "book-1", confirmation: "LITE-XYZ", price: { amount: over?.bookAmount ?? 465.0, currency: "USD" } });
    }
    if (u.includes("/bookings/") && m === "PUT") return json({ refund: { amount: 465.0, currency: "USD" } });
    if (u.includes("/bookings/") && m === "GET") return json({ status: "CONFIRMED" });
    return json({});
  }) as unknown as typeof fetch;
}

const make = () => new LiteAPIAdapter({ baseUrl: "https://sandbox.liteapi.test", apiKey: "k", fetchImpl: liteApiFakeFetch() });

describe("LiteAPIAdapter (mocked)", () => {
  it("maps priced offers to RailSlot[] and EXCLUDES un-priced offers (never ?? 0)", async () => {
    const slots = await make().search({ area: "Nashville", dateTime: "2026-08-01T15:00:00Z", partySize: 6 });
    expect(slots).toHaveLength(1); // off-2 (price:null) dropped
    expect(slots[0]!.railSlotId).toBe("off-1");
    expect(slots[0]!.priceCents).toBe(45000);
    expect(slots[0]!.cancellation.refundable).toBe(true);
    expect(slots[0]!.cancellation.freeCancelUntil).toBe("2026-07-28T00:00:00Z");
  });

  it("hold(prebook) locks the PREBOOK price into slot.priceCents even when it drifts from search", async () => {
    const held = await make().hold("off-1", { partySize: 6, dateTime: "2026-08-01T15:00:00Z" });
    expect(held.holdRef).toBe("pre-1");
    expect(held.expiresAt).toBe("2026-07-25T00:00:00Z");
    expect(held.slot.priceCents).toBe(46500); // 465.00 locked, NOT the 450.00 search price
  });

  it("book returns a non-zero amount + confirmation code", async () => {
    const rail = make();
    const held = await rail.hold("off-1", { partySize: 6, dateTime: "2026-08-01T15:00:00Z" });
    const booked = await rail.book(held.holdRef, { leadName: "T", leadEmail: "t@e.com" });
    expect(booked.railRef).toBe("book-1");
    expect(booked.confirmationCode).toBe("LITE-XYZ");
    expect(booked.amountCents).toBe(46500);
  });

  it("book THROWS on a null/empty bookingId (a null railRef would enable a double-book)", async () => {
    const rail = new LiteAPIAdapter({ baseUrl: "https://sandbox.liteapi.test", apiKey: "k", fetchImpl: liteApiFakeFetch({ bookingId: null }) });
    await expect(rail.book("pre-1", { leadName: "T", leadEmail: "t@e.com" })).rejects.toThrow(/booking id|bookingId|missing/i);
  });

  it("book THROWS on a non-finite amount (never record a phantom 0)", async () => {
    const rail = new LiteAPIAdapter({ baseUrl: "https://sandbox.liteapi.test", apiKey: "k", fetchImpl: liteApiFakeFetch({ bookAmount: "oops" }) });
    await expect(rail.book("pre-1", { leadName: "T", leadEmail: "t@e.com" })).rejects.toThrow(/amount/i);
  });

  it("release resolves without a network call (prebooks are transient — they expire)", async () => {
    const spy = liteApiFakeFetch();
    const rail = new LiteAPIAdapter({ baseUrl: "https://sandbox.liteapi.test", apiKey: "k", fetchImpl: spy });
    await expect(rail.release("pre-1")).resolves.toBeUndefined();
    expect((spy as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });
});

runBookingRailContract("LiteAPIAdapter(mock fetch)", make);
