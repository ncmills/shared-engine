import { describe, it, expect } from "vitest";
import { Orchestrator, InMemoryBookingStore } from "../concierge/orchestrator";
import { InMemoryAuditLog } from "../concierge/audit";
import { resolveActivities, DeterministicProposalSource } from "../concierge/resolver";
import { MockRail } from "../concierge/mock-rail";
import type { BookingIntent } from "../concierge/types";

const lead = { leadName: "Ada", leadEmail: "ada@example.com" };
const now = "2026-07-20T12:00:00.000Z";
const intents: BookingIntent[] = [
  { itemId: "tour-1", category: "activity", query: { area: "Nashville", dateTime: "2026-08-01T14:00:00Z", partySize: 6, maxPriceCents: 20000 } },
  { itemId: "tour-2", category: "activity", query: { area: "Austin", dateTime: "2026-08-02T14:00:00Z", partySize: 6, maxPriceCents: 20000 } },
];

const manifestFor = (rail: MockRail) =>
  resolveActivities({ tripId: "trip-1", tenant: "moh", intents, rail, proposals: new DeterministicProposalSource() });

describe("Orchestrator.executeSaga", () => {
  it("books every item and logs a hold+book audit entry per item", async () => {
    const rail = new MockRail({ priceCents: 8500 });
    const audit = new InMemoryAuditLog();
    const saga = await new Orchestrator(rail, new InMemoryBookingStore(), audit).executeSaga(await manifestFor(rail), { lead, now });
    expect(saga.status).toBe("confirmed");
    expect(saga.results.every((r) => r.status === "confirmed")).toBe(true);
    const actions = (await audit.entries("trip-1")).map((e) => e.action);
    expect(actions.filter((a) => a === "hold")).toHaveLength(2);
    expect(actions.filter((a) => a === "book")).toHaveLength(2);
  });

  it("compensates already-booked items when a later item fails (no orphans)", async () => {
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await manifestFor(probe);
    const failingSlot = manifest.items[1]!.chosen!.railSlotId; // tour-2 fails to book
    const rail = new MockRail({ priceCents: 8500, failBookFor: [failingSlot] });
    const store = new InMemoryBookingStore();
    const audit = new InMemoryAuditLog();
    const saga = await new Orchestrator(rail, store, audit).executeSaga(manifest, { lead, now });

    expect(saga.status).toBe("compensated");
    expect(saga.compensations.map((c) => c.itemId)).toEqual(["tour-1"]); // the booked one got cancelled
    expect(saga.compensations[0]!.refundAmountCents).toBe(8500);
    // No-orphan invariant: the previously-booked item is now cancelled in the store...
    const rec1 = await store.get("trip-1:tour-1:mock");
    expect(rec1!.status).toBe("cancelled");
    // ...and the rail has no live booking for it.
    expect(await rail.status("ref-" + manifest.items[0]!.chosen!.railSlotId)).toBe("cancelled");
    // Audit records the compensating cancel.
    expect((await audit.entries("trip-1")).some((e) => e.action === "compensate")).toBe(true);
  });

  it("treats an expired hold as a first-class failure and compensates", async () => {
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await manifestFor(probe);
    // Every hold is already expired ⇒ the saga must not confirm any booking.
    const rail = new MockRail({ priceCents: 8500, holdExpiresAt: "2000-01-01T00:00:00.000Z" });
    const store = new InMemoryBookingStore();
    const saga = await new Orchestrator(rail, store, new InMemoryAuditLog()).executeSaga(manifest, { lead, now });
    expect(saga.status).toBe("compensated");
    expect(saga.error).toMatch(/expired/i);
    expect(saga.results.some((r) => r.status === "confirmed")).toBe(false);
  });

  it("is idempotent — re-running a confirmed saga does not double-book", async () => {
    const rail = new MockRail({ priceCents: 8500 });
    const store = new InMemoryBookingStore();
    const orch = new Orchestrator(rail, store, new InMemoryAuditLog());
    const manifest = await manifestFor(rail);
    await orch.executeSaga(manifest, { lead, now });
    const second = await orch.executeSaga(manifest, { lead, now });
    expect(second.status).toBe("confirmed");
    expect((await store.all("trip-1")).length).toBe(2); // not 4
  });
});
