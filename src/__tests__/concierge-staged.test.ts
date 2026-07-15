import { describe, it, expect } from "vitest";
import { Orchestrator, InMemoryBookingStore } from "../concierge/orchestrator";
import { InMemoryAuditLog } from "../concierge/audit";
import { resolveManifest, DeterministicProposalSource } from "../concierge/resolver";
import { MockRail } from "../concierge/mock-rail";
import type { BookingIntent } from "../concierge/types";

const lead = { leadName: "Ada", leadEmail: "ada@example.com" };
const now = "2026-07-20T12:00:00.000Z";

const intents: BookingIntent[] = [
  { itemId: "stay-1", category: "lodging", query: { area: "Nashville", dateTime: "2026-08-01T15:00:00Z", partySize: 6, maxPriceCents: 100000 } },
  { itemId: "tour-1", category: "activity", query: { area: "Austin", dateTime: "2026-08-02T14:00:00Z", partySize: 6, maxPriceCents: 100000 } },
];

const manifestFor = (rail: MockRail) =>
  resolveManifest({ tripId: "trip-1", tenant: "moh", intents, rail, proposals: new DeterministicProposalSource() });

describe("Orchestrator.executeStaged", () => {
  it("holds all then commits all → CONFIRMED, with hold+book audit per item", async () => {
    const rail = new MockRail({ priceCents: 8500 });
    const audit = new InMemoryAuditLog();
    const staged = await new Orchestrator(rail, new InMemoryBookingStore(), audit).executeStaged(await manifestFor(rail), { lead, now });
    expect(staged.state).toBe("CONFIRMED");
    expect(staged.results.every((r) => r.status === "confirmed")).toBe(true);
    const actions = (await audit.entries("trip-1")).map((e) => e.action);
    expect(actions.filter((a) => a === "hold")).toHaveLength(2);
    expect(actions.filter((a) => a === "book")).toHaveLength(2);
  });

  it("commits shortest-hold-TTL-first regardless of manifest order", async () => {
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await manifestFor(probe);
    const staySlot = manifest.items[0]!.chosen!.railSlotId; // manifest order: stay-1 first
    const tourSlot = manifest.items[1]!.chosen!.railSlotId;
    // Give the SECOND manifest item (tour-1) the sooner expiry ⇒ it must commit first.
    const rail = new MockRail({
      priceCents: 8500,
      holdExpiresBySlot: { [staySlot]: "2026-08-01T00:00:00.000Z", [tourSlot]: "2026-07-25T00:00:00.000Z" },
    });
    const staged = await new Orchestrator(rail, new InMemoryBookingStore()).executeStaged(manifest, { lead, now });
    expect(staged.state).toBe("CONFIRMED");
    expect(staged.committedOrder).toEqual(["tour-1", "stay-1"]);
  });

  it("aborts at PENDING_CONFIRM when spend caps are exceeded, releasing every hold (nothing booked)", async () => {
    const rail = new MockRail({ priceCents: 8500 }); // 2 items × 8500 = 17000 total
    const audit = new InMemoryAuditLog();
    const staged = await new Orchestrator(rail, new InMemoryBookingStore(), audit).executeStaged(await manifestFor(rail), { lead, now, caps: { totalCapCents: 10000 } });
    expect(staged.state).toBe("FAILED");
    expect(staged.error).toMatch(/total/i);
    expect(staged.results.some((r) => r.status === "confirmed")).toBe(false);
    expect(staged.releasedHolds).toHaveLength(2); // both holds released
    expect((await audit.entries("trip-1")).filter((e) => e.action === "release")).toHaveLength(2);
  });

  it("on a commit failure, compensates committed items AND releases still-uncommitted holds", async () => {
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await manifestFor(probe);
    const staySlot = manifest.items[0]!.chosen!.railSlotId;
    const tourSlot = manifest.items[1]!.chosen!.railSlotId;
    // tour-1 commits first (sooner expiry) and succeeds; stay-1 fails to book ⇒ tour-1 compensated.
    const rail = new MockRail({
      priceCents: 8500,
      holdExpiresBySlot: { [staySlot]: "2026-08-01T00:00:00.000Z", [tourSlot]: "2026-07-25T00:00:00.000Z" },
      failBookFor: [staySlot],
    });
    const staged = await new Orchestrator(rail, new InMemoryBookingStore()).executeStaged(manifest, { lead, now });
    expect(staged.state).toBe("FAILED");
    expect(staged.committedOrder).toEqual(["tour-1"]); // only tour-1 committed before the failure
    expect(staged.compensations.map((c) => c.itemId)).toEqual(["tour-1"]); // then compensated
    expect(await rail.status("ref-" + tourSlot)).toBe("cancelled"); // no orphan
  });

  it("treats an expired hold at commit time as a failure and unwinds", async () => {
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await manifestFor(probe);
    const rail = new MockRail({ priceCents: 8500, holdExpiresAt: "2000-01-01T00:00:00.000Z" });
    const staged = await new Orchestrator(rail, new InMemoryBookingStore()).executeStaged(manifest, { lead, now });
    expect(staged.state).toBe("FAILED");
    expect(staged.error).toMatch(/expired/i);
    expect(staged.results.some((r) => r.status === "confirmed")).toBe(false);
  });
});
