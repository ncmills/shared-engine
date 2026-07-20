import { describe, it, expect, vi } from "vitest";
import { LiteAPIAdapter } from "../concierge/liteapi-adapter";
import { runBookingRailContract } from "../concierge/rail-contract";

/** Deterministic LiteAPI sandbox. NOTE: the prebook price (46500) DRIFTS UP from the search price
 *  (45000) — 2b's whole point is that a real rail locks a different price at prebook than it quoted. */
function liteApiFakeFetch(over?: { bookingId?: unknown; bookAmount?: unknown; prebookCurrency?: string }): typeof fetch {
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
          // A NON-USD rate MUST be excluded, never scaled as USD cents (currency silently ignored bug).
          { offerId: "off-3", name: "Euro Villa", price: { amount: 450.0, currency: "EUR" }, checkin: "2026-08-01T15:00:00Z", refundable: true, freeCancelUntil: "2026-07-28T00:00:00Z" },
          // A $0 "free" lodging rate is garbage — excluded (never a valid stay).
          { offerId: "off-4", name: "Free Villa", price: { amount: 0, currency: "USD" }, checkin: "2026-08-01T15:00:00Z", refundable: true, freeCancelUntil: "2026-07-28T00:00:00Z" },
        ],
      });
    }
    if (u.endsWith("/rates/prebook") && m === "POST") {
      return json({ prebookId: "pre-1", price: { amount: 465.0, currency: over?.prebookCurrency ?? "USD" }, expiresAt: "2026-07-25T00:00:00Z" });
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
  it("maps priced USD offers and EXCLUDES un-priced / non-USD / $0 offers (never ?? 0, never scale a foreign currency)", async () => {
    const slots = await make().search({ area: "Nashville", dateTime: "2026-08-01T15:00:00Z", partySize: 6 });
    expect(slots.map((s) => s.railSlotId)).toEqual(["off-1"]); // off-2(null) / off-3(EUR) / off-4($0) all dropped
    expect(slots[0]!.priceCents).toBe(45000);
    expect(slots[0]!.cancellation.refundable).toBe(true);
    expect(slots[0]!.cancellation.freeCancelUntil).toBe("2026-07-28T00:00:00Z");
  });

  it("hold THROWS on a non-USD prebook price (never scale a foreign currency as USD cents)", async () => {
    const rail = new LiteAPIAdapter({ baseUrl: "https://sandbox.liteapi.test", apiKey: "k", fetchImpl: liteApiFakeFetch({ prebookCurrency: "EUR" }) });
    await expect(rail.hold("off-1", { partySize: 6, dateTime: "2026-08-01T15:00:00Z" })).rejects.toThrow(/usable|USD|price/i);
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

  it("book RETURNS the live ref (never orphans a paid booking) even when the amount is unparseable", async () => {
    // Once a bookingId exists the stay is booked+charged — throwing over a bad amount would discard
    // the ref and orphan it. We keep the ref; the amount degrades to a best-effort 0 for reconciliation.
    const rail = new LiteAPIAdapter({ baseUrl: "https://sandbox.liteapi.test", apiKey: "k", fetchImpl: liteApiFakeFetch({ bookAmount: "oops" }) });
    const booked = await rail.book("pre-1", { leadName: "T", leadEmail: "t@e.com" });
    expect(booked.railRef).toBe("book-1");
    expect(booked.amountCents).toBe(0);
  });

  it("release resolves without a network call (prebooks are transient — they expire)", async () => {
    const spy = liteApiFakeFetch();
    const rail = new LiteAPIAdapter({ baseUrl: "https://sandbox.liteapi.test", apiKey: "k", fetchImpl: spy });
    await expect(rail.release("pre-1")).resolves.toBeUndefined();
    expect((spy as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });
});

runBookingRailContract("LiteAPIAdapter(mock fetch)", make);
