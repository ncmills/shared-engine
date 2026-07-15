import { describe, it, expect } from "vitest";
import { Orchestrator, InMemoryBookingStore } from "../concierge/orchestrator";
import { resolveDining, DeterministicProposalSource } from "../concierge/resolver";
import { MockRail } from "../concierge/mock-rail";
import type { BookingIntent } from "../concierge/types";

const lead = { leadName: "Ada", leadEmail: "ada@example.com" };
const intents: BookingIntent[] = [
  { itemId: "dinner-1", category: "dining", query: { area: "Nashville", dateTime: "2026-08-01T19:00:00Z", partySize: 8 } },
  { itemId: "dinner-2", category: "dining", query: { area: "Austin", dateTime: "2026-08-02T19:00:00Z", partySize: 8 } },
];

async function manifestFor(rail: MockRail) {
  return resolveDining({ tripId: "trip-1", tenant: "moh", intents, rail, proposals: new DeterministicProposalSource() });
}

describe("Orchestrator", () => {
  it("books every chosen item and records confirmations", async () => {
    const rail = new MockRail();
    const store = new InMemoryBookingStore();
    const results = await new Orchestrator(rail, store).execute(await manifestFor(rail), { lead });
    expect(results.every((r) => r.status === "confirmed")).toBe(true);
    expect((await store.all("trip-1")).length).toBe(2);
  });

  it("is idempotent — re-running does not double-book", async () => {
    const rail = new MockRail();
    const store = new InMemoryBookingStore();
    const orch = new Orchestrator(rail, store);
    const manifest = await manifestFor(rail);
    await orch.execute(manifest, { lead });
    await orch.execute(manifest, { lead });
    expect((await store.all("trip-1")).length).toBe(2); // not 4
  });

  it("isolates a single failure without aborting the run", async () => {
    // Force dinner-1's chosen slot to fail booking.
    const rail = new MockRail();
    const manifest = await manifestFor(rail);
    const failingSlot = manifest.items[0]!.chosen!.railSlotId;
    const failingRail = new MockRail({ failBookFor: [failingSlot] });
    const store = new InMemoryBookingStore();
    const results = await new Orchestrator(failingRail, store).execute(manifest, { lead });
    const byId = Object.fromEntries(results.map((r) => [r.itemId, r.status]));
    expect(byId["dinner-1"]).toBe("failed");
    expect(byId["dinner-2"]).toBe("confirmed");
  });
});
