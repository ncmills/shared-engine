import { describe, it, expect } from "vitest";
import type { BookingRail } from "./rail";

export function runBookingRailContract(name: string, makeRail: () => BookingRail): void {
  describe(`BookingRail contract: ${name}`, () => {
    const q = { area: "Testville", dateTime: "2026-08-01T19:00:00Z", partySize: 4 };

    it("search returns slots with required fields", async () => {
      const slots = await makeRail().search(q);
      expect(slots.length).toBeGreaterThan(0);
      for (const s of slots) {
        expect(typeof s.railSlotId).toBe("string");
        expect(typeof s.priceCents).toBe("number");
        expect(s.cancellation).toBeDefined();
      }
    });

    it("hold -> book -> status(confirmed) -> cancel", async () => {
      const rail = makeRail();
      const slot = (await rail.search(q))[0]!;
      const held = await rail.hold(slot.railSlotId, { partySize: 4, dateTime: slot.startsAt });
      expect(held.holdRef).toBeTruthy();
      const booked = await rail.book(held.holdRef, { leadName: "T", leadEmail: "t@e.com" });
      expect(booked.confirmationCode).toBeTruthy();
      expect(await rail.status(booked.railRef)).toBe("confirmed");
      const refund = await rail.cancel(booked.railRef);
      expect(typeof refund.refundAmountCents).toBe("number");
    });

    it("hold -> release (an uncommitted hold can be dropped)", async () => {
      const rail = makeRail();
      const slot = (await rail.search(q))[0]!;
      const held = await rail.hold(slot.railSlotId, { partySize: 4, dateTime: slot.startsAt });
      await expect(rail.release(held.holdRef)).resolves.toBeUndefined();
    });
  });
}
