import { describe, it, expect } from "vitest";
import { MockRail } from "../concierge/mock-rail";

const q = { area: "Nashville", dateTime: "2026-08-01T14:00:00Z", partySize: 6 };

describe("MockRail paid mode", () => {
  it("returns priced slots with a refundable policy when priceCents > 0", async () => {
    const slots = await new MockRail({ priceCents: 5000 }).search(q);
    expect(slots[0]!.priceCents).toBe(5000);
    expect(slots[0]!.cancellation.refundable).toBe(true);
    expect(slots[0]!.cancellation.freeCancelUntil).not.toBeNull();
  });

  it("book returns the priced amount; cancel refunds it", async () => {
    const rail = new MockRail({ priceCents: 5000 });
    const slot = (await rail.search(q))[0]!;
    const held = await rail.hold(slot.railSlotId, { partySize: 6, dateTime: slot.startsAt });
    const booked = await rail.book(held.holdRef, { leadName: "T", leadEmail: "t@e.com" });
    expect(booked.amountCents).toBe(5000);
    expect((await rail.cancel(booked.railRef)).refundAmountCents).toBe(5000);
  });

  it("holdExpiresAt overrides the hold expiry (past ⇒ simulate expiry)", async () => {
    const rail = new MockRail({ priceCents: 5000, holdExpiresAt: "2000-01-01T00:00:00.000Z" });
    const held = await rail.hold("slot-x", { partySize: 6, dateTime: q.dateTime });
    expect(held.expiresAt).toBe("2000-01-01T00:00:00.000Z");
  });

  it("default (no opts) is unchanged: price 0, free-cancel, far-future hold", async () => {
    const rail = new MockRail();
    const slots = await rail.search(q);
    expect(slots[0]!.priceCents).toBe(0);
    const held = await rail.hold(slots[0]!.railSlotId, { partySize: 6, dateTime: q.dateTime });
    expect(held.expiresAt > q.dateTime).toBe(true);
  });
});
