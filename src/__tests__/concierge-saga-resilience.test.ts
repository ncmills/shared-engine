import { describe, it, expect } from "vitest";
import { Orchestrator, InMemoryBookingStore, type BookingStore } from "../concierge/orchestrator";
import { InMemoryAuditLog } from "../concierge/audit";
import { resolveActivities, DeterministicProposalSource } from "../concierge/resolver";
import { MockRail } from "../concierge/mock-rail";
import type { BookingIntent, BookingRecord } from "../concierge/types";

const lead = { leadName: "Ada", leadEmail: "ada@example.com" };
const now = "2026-08-01T13:30:00.000Z";

const threeIntents: BookingIntent[] = [
  { itemId: "tour-1", category: "activity", query: { area: "Nashville", dateTime: "2026-08-10T14:00:00Z", partySize: 6, maxPriceCents: 20000 } },
  { itemId: "tour-2", category: "activity", query: { area: "Austin", dateTime: "2026-08-11T14:00:00Z", partySize: 6, maxPriceCents: 20000 } },
  { itemId: "tour-3", category: "activity", query: { area: "Denver", dateTime: "2026-08-12T14:00:00Z", partySize: 6, maxPriceCents: 20000 } },
];

const twoIntents: BookingIntent[] = threeIntents.slice(0, 2);

describe("executeSaga resilience (adversarial-review regressions)", () => {
  it("a compensating cancel that throws does not abort the rest of the compensation", async () => {
    // tour-1 + tour-2 book; tour-3 fails ⇒ compensate. cancel(tour-1) throws.
    // The saga must still (a) return a result, (b) cancel tour-2, (c) report tour-1 as a failed compensation.
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await resolveActivities({ tripId: "trip-1", tenant: "moh", intents: threeIntents, rail: probe, proposals: new DeterministicProposalSource() });
    const slot1 = manifest.items[0]!.chosen!.railSlotId;
    const slot3 = manifest.items[2]!.chosen!.railSlotId;

    const rail = new MockRail({ priceCents: 8500, failBookFor: [slot3], failCancelFor: [slot1] });
    const store = new InMemoryBookingStore();
    const audit = new InMemoryAuditLog();
    const saga = await new Orchestrator(rail, store, audit).executeSaga(manifest, { lead, now });

    expect(saga.status).toBe("compensated");
    // tour-2 compensated successfully; tour-1's cancel failed and is surfaced, not swallowed.
    expect(saga.compensations.map((c) => c.itemId)).toContain("tour-2");
    expect(saga.failedCompensations.map((c) => c.itemId)).toContain("tour-1");
    // The successful compensation still flipped tour-2's rail booking off (no orphan for it).
    expect(await rail.status("ref-" + manifest.items[1]!.chosen!.railSlotId)).toBe("cancelled");
    // Forensic completeness: a failed compensation is audited, not silent.
    expect((await audit.entries("trip-1")).some((e) => e.action === "compensate_failed")).toBe(true);
  });

  it("a booking captured on the rail is compensated even if the store write fails right after", async () => {
    // Store.put throws on the first confirmed record ⇒ simulates a DB write failing after book().
    // The rail booking already exists; the saga must still cancel it (no orphan).
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await resolveActivities({ tripId: "trip-1", tenant: "moh", intents: twoIntents, rail: probe, proposals: new DeterministicProposalSource() });

    const inner = new InMemoryBookingStore();
    let threwOnce = false;
    const flakyStore: BookingStore = {
      get: (id) => inner.get(id),
      all: (t) => inner.all(t),
      put: async (rec: BookingRecord) => {
        if (!threwOnce && rec.status === "confirmed") {
          threwOnce = true;
          throw new Error("store write failed");
        }
        return inner.put(rec);
      },
    };

    const rail = new MockRail({ priceCents: 8500 });
    const saga = await new Orchestrator(rail, flakyStore, new InMemoryAuditLog()).executeSaga(manifest, { lead, now });

    expect(saga.status).toBe("compensated");
    // The item whose store write failed was still booked on the rail — it must be cancelled.
    expect(await rail.status("ref-" + manifest.items[0]!.chosen!.railSlotId)).toBe("cancelled");
  });

  it("a still-valid hold on a non-UTC-offset rail is NOT falsely treated as expired", async () => {
    // expiresAt = 12:00:00-04:00 == 16:00Z, 2.5h AFTER now (13:30Z) ⇒ genuinely valid.
    // But its STRING ("...T12:00:00-04:00") sorts BEFORE now ("...T13:30:00.000Z"), so a
    // lexicographic compare would wrongly call `now >= expiresAt` and expire a live hold.
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await resolveActivities({ tripId: "trip-1", tenant: "moh", intents: twoIntents, rail: probe, proposals: new DeterministicProposalSource() });
    const rail = new MockRail({ priceCents: 8500, holdExpiresAt: "2026-08-01T12:00:00-04:00" });
    const saga = await new Orchestrator(rail, new InMemoryBookingStore(), new InMemoryAuditLog()).executeSaga(manifest, { lead, now });
    expect(saga.status).toBe("confirmed");
    expect(saga.results.every((r) => r.status === "confirmed")).toBe(true);
  });
});
