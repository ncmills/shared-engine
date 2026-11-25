import { describe, it, expect } from "vitest";
import { MockRail } from "../concierge/mock-rail";

const lead = { leadName: "Ada", leadEmail: "ada@example.com" };

describe("MockRail", () => {
  it("search is deterministic for identical queries", async () => {
    const rail = new MockRail();
    const q = { area: "Nashville", dateTime: "2026-08-01T19:00:00Z", partySize: 8 };
    const a = await rail.search(q);
    const b = await rail.search(q);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
    expect(a[0]!.priceCents).toBe(0);
  });

  it("hold then book yields a confirmation", async () => {
    const rail = new MockRail();
    const slot = (await rail.search({ area: "Austin", dateTime: "2026-08-01T19:00:00Z", partySize: 6 }))[0]!;
    const held = await rail.hold(slot.railSlotId, { partySize: 6, dateTime: slot.startsAt });
    const booked = await rail.book(held.holdRef, lead);
    expect(booked.confirmationCode).toMatch(/^MOCK-/);
    expect(await rail.status(booked.railRef)).toBe("confirmed");
  });

  it("book fails for slots flagged to fail", async () => {
    const rail = new MockRail({ failBookFor: ["FAILME"] });
    const held = await rail.hold("FAILME", { partySize: 2, dateTime: "2026-08-01T19:00:00Z" });
    await expect(rail.book(held.holdRef, lead)).rejects.toThrow();
  });
});
