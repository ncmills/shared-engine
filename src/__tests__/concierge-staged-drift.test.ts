import { describe, it, expect } from "vitest";
import { Orchestrator, InMemoryBookingStore } from "../concierge/orchestrator";
import { InMemoryAuditLog } from "../concierge/audit";
import { resolveManifest, DeterministicProposalSource } from "../concierge/resolver";
import { MockRail } from "../concierge/mock-rail";
import type { BookingIntent } from "../concierge/types";

// Phase 2c — price-drift enforcement inside executeStaged.
//
// 2b shipped `checkPriceDrift` as a primitive and proved it against the LiteAPI
// adapter, but the staged loop never called it. The spend-cap gate DOES read the
// locked price, so a drift large enough to breach a cap was caught — but a drift
// that stays UNDER the cap (or a trip with no caps configured at all) committed
// silently at a price higher than the one the guest was quoted. That is the gap
// this suite closes: every held item must be drift-checked on its own, not only
// in aggregate against a cap.

const lead = { leadName: "Ada", leadEmail: "ada@example.com" };
const now = "2026-07-20T12:00:00.000Z";

const intents: BookingIntent[] = [
  { itemId: "stay-1", category: "lodging", query: { area: "Nashville", dateTime: "2026-08-01T15:00:00Z", partySize: 6, maxPriceCents: 100000 } },
  { itemId: "tour-1", category: "activity", query: { area: "Austin", dateTime: "2026-08-02T14:00:00Z", partySize: 6, maxPriceCents: 100000 } },
];

const manifestFor = (rail: MockRail) =>
  resolveManifest({ tripId: "trip-1", tenant: "moh", intents, rail, proposals: new DeterministicProposalSource() });

describe("executeStaged price-drift enforcement (Phase 2c)", () => {
  it("aborts when the locked price drifts above the quote, even with NO caps set", async () => {
    // Quoted 8,500/item; the rail locks 9,900 at hold time. No caps configured,
    // so the cap gate cannot save us — only the drift check can.
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await manifestFor(probe);
    const rail = new MockRail({ priceCents: 8500, holdPriceCents: 9900 });
    const audit = new InMemoryAuditLog();
    const staged = await new Orchestrator(rail, new InMemoryBookingStore(), audit).executeStaged(manifest, { lead, now });

    expect(staged.state).toBe("FAILED");
    expect(staged.error).toMatch(/drift|exceeds quoted/i);
    // Nothing may be booked, and the drifted hold must not leak.
    expect(staged.results.some((r) => r.status === "confirmed")).toBe(false);
    // `releasedHolds` carries rail holdRefs, not itemIds — exactly one hold existed and it was dropped.
    expect(staged.releasedHolds).toHaveLength(1);
    const actions = (await audit.entries("trip-1")).map((e) => e.action);
    expect(actions).not.toContain("book");
    expect(actions).toContain("price_drift_rejected");
  });

  it("aborts under a cap that the drifted price would NOT breach", async () => {
    // 2 × 9,900 = 19,800, comfortably under a 50,000 cap — the cap gate passes,
    // so this fails only if the per-item drift check runs.
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await manifestFor(probe);
    const rail = new MockRail({ priceCents: 8500, holdPriceCents: 9900 });
    const staged = await new Orchestrator(rail, new InMemoryBookingStore()).executeStaged(manifest, { lead, now, caps: { totalCapCents: 50000 } });

    expect(staged.state).toBe("FAILED");
    expect(staged.error).toMatch(/drift|exceeds quoted/i);
  });

  it("releases the drifted hold itself, not just the holds taken before it", async () => {
    // The failing item's own hold is taken and must be released too — otherwise
    // we leak a live prebook on the rail every time drift trips.
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await manifestFor(probe);
    const rail = new MockRail({ priceCents: 8500, holdPriceCents: 9900 });
    const audit = new InMemoryAuditLog();
    const staged = await new Orchestrator(rail, new InMemoryBookingStore(), audit).executeStaged(manifest, { lead, now });

    // Drift trips on the FIRST item, so exactly one hold exists — and its own holdRef is what gets
    // released. If the implementation released only PRIOR holds this would be 0, and a live prebook
    // would leak on every drift abort.
    const holdRefs = (await audit.entries("trip-1")).filter((e) => e.action === "hold").map((e) => e.externalRef);
    expect(holdRefs).toHaveLength(1);
    expect(staged.releasedHolds).toEqual(holdRefs);
    expect((await audit.entries("trip-1")).filter((e) => e.action === "release")).toHaveLength(1);
  });

  it("proceeds when the drift is within an explicitly configured tolerance", async () => {
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await manifestFor(probe);
    const rail = new MockRail({ priceCents: 8500, holdPriceCents: 8600 }); // +100
    const staged = await new Orchestrator(rail, new InMemoryBookingStore()).executeStaged(manifest, {
      lead,
      now,
      driftTolerance: { toleranceCents: 150 },
    });

    expect(staged.state).toBe("CONFIRMED");
    expect(staged.results.every((r) => r.status === "confirmed")).toBe(true);
  });

  it("proceeds when the locked price is CHEAPER than quoted", async () => {
    const probe = new MockRail({ priceCents: 8500 });
    const manifest = await manifestFor(probe);
    const rail = new MockRail({ priceCents: 8500, holdPriceCents: 7000 });
    const staged = await new Orchestrator(rail, new InMemoryBookingStore()).executeStaged(manifest, { lead, now });

    expect(staged.state).toBe("CONFIRMED");
  });

  it("still CONFIRMS a normal single-price rail (no regression, strict by default)", async () => {
    const rail = new MockRail({ priceCents: 8500 });
    const staged = await new Orchestrator(rail, new InMemoryBookingStore()).executeStaged(await manifestFor(rail), { lead, now });

    expect(staged.state).toBe("CONFIRMED");
  });
});
